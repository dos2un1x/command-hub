cluster-api
===

用Kubernetes资源声明式管理集群生命周期的官方子项目

## 补充说明

**Cluster API**(简称 CAPI)是 Kubernetes SIG Cluster Lifecycle 维护的子项目。它把「创建、升级、伸缩、销毁一个 Kubernetes 集群」这件事本身变成了 **Kubernetes 资源**:用一个集群(management cluster)去声明式地管理一批集群(workload cluster)。

它要解决的问题是:**集群本身也该有 GitOps**。手工跑 `kubeadm init` 建出来的集群,版本、节点数、网络参数散落在各台机器上;而用 CAPI 描述之后,集群的定义就是一份 YAML,可以进 Git、可以 review、可以 diff,扩缩容和升级都变成改字段。

CAPI 并不是「装 Kubernetes 的工具」,而是**一套编排框架**。真正去调云 API 创建虚拟机的,是各个厂商自己实现的 provider。

### 核心概念

```shell
management cluster   管理集群:跑 CAPI 控制器的地方,通常是一个长期存在的小集群
workload cluster     工作负载集群:被管理集群,CAPI 负责它的创建与生命周期
bootstrap cluster    引导集群:一次性的临时集群,用来生成 management cluster 自身

provider             提供者,分四类:
  Core               核心控制器,由 sigs.k8s.io/cluster-api 提供
  Bootstrap          生成节点加入集群所需的 cloud-init,官方实现是 Kubeadm
  Control Plane      管理控制平面节点,官方实现是 KubeadmControlPlane(KCP)
  Infrastructure     真正创建机器,由各家厂商实现(AWS/Azure/vSphere/Docker/Metal3…)
```

对应的资源对象:

```shell
Cluster             一个集群的整体描述
Machine             一台机器(一台虚拟机或裸金属)
MachineSet          一组同构机器,类似 ReplicaSet
MachineDeployment   声明式管理 MachineSet,类似 Deployment
MachineHealthCheck  节点健康检查,不健康自动重建
ClusterClass        集群模板,把「怎么建」固化下来,实现一份 YAML 建任意多集群
```

一个关键约定:**CAPI 的控制器都运行在 management cluster 上,而 workload cluster 里只有一个 agent(`cluster-api-agent`)负责接收指令**。因此 workload cluster 的 API Server 挂掉时,依然可以通过管理集群来修复它。

### 安装 clusterctl

```shell
# macOS / Linux (Homebrew)
brew install clusterctl

# 官方二进制
curl -L https://github.com/kubernetes-sigs/cluster-api/releases/download/v1.14.1/clusterctl-linux-amd64 \
  -o clusterctl
sudo install -o root -g root -m 0755 clusterctl /usr/local/bin/clusterctl

# macOS (Apple Silicon)
curl -L https://github.com/kubernetes-sigs/cluster-api/releases/download/v1.14.1/clusterctl-darwin-arm64 \
  -o clusterctl && chmod +x clusterctl && sudo mv clusterctl /usr/local/bin/

clusterctl version
```

**clusterctl 应始终使用最新的补丁版本**,它会用自身的版本去驱动其他组件的升级。

### 初始化管理集群

```shell
# 准备一个已有的 Kubernetes 集群作为 management cluster
export KUBECONFIG=~/.kube/management.kubeconfig

# 启用 ClusterClass 所需的实验特性(拓扑管理)
export CLUSTER_TOPOLOGY=true

# 安装核心组件 + Docker 基础设施 provider(仅用于本地验证)
clusterctl init --infrastructure docker

# 安装到真实云环境
clusterctl init --infrastructure aws
clusterctl init --infrastructure azure
clusterctl init --infrastructure vsphere
clusterctl init --infrastructure openstack
```

也可以锁定每个组件的版本:

```shell
clusterctl init \
  --core cluster-api:v1.14.1 \
  --bootstrap kubeadm:v1.14.1 \
  --control-plane kubeadm:v1.14.1 \
  --infrastructure aws:v2.9.0
```

查看当前已安装的 provider:

```shell
clusterctl config repositories
kubectl get pods -A | grep -E 'capi|cap[a-z]'
kubectl get providers -A
```

### 创建 workload cluster

```shell
# 生成集群清单(模板由 infrastructure provider 提供)
clusterctl generate cluster capi-quickstart \
  --flavor development \
  --kubernetes-version v1.37.0 \
  --control-plane-machine-count=3 \
  --worker-machine-count=3 \
  > capi-quickstart.yaml

# 查看模板里有哪些可填变量
clusterctl generate cluster capi-quickstart \
  --infrastructure docker --list-variables

# 应用清单
kubectl apply -f capi-quickstart.yaml
```

生成的清单里会包含 `Cluster`、`MachineDeployment`、`KubeadmControlPlane` 等对象。**控制平面会一直处于 NotReady 状态,直到你安装 CNI 插件** —— 这与 kubeadm 的行为一致。

```shell
# 观察创建进度
clusterctl describe cluster capi-quickstart
kubectl get cluster,machine -A
kubectl get kubeadmcontrolplane

# 取出 workload cluster 的 kubeconfig
clusterctl get kubeconfig capi-quickstart > capi-quickstart.kubeconfig
export KUBECONFIG=./capi-quickstart.kubeconfig
kubectl get nodes
```

### 用 ClusterClass 做集群模板

`ClusterClass` 把集群的定义拆成「模板」与「实例」,适合一个平台统一交付多种规格的集群:

```shell
apiVersion: cluster.x-k8s.io/v1beta2
kind: Cluster
metadata:
  name: prod-01
spec:
  topology:
    class: quick-start
    version: v1.37.0
    controlPlane:
      replicas: 3
    workers:
      machineDeployments:
        - class: default-worker
          name: md-0
          replicas: 5
```

集群实例只需要写「要什么」,不再关心「怎么建」。版本升级也只需改一个字段:

```shell
kubectl patch cluster prod-01 --type=merge \
  -p '{"spec":{"topology":{"version":"v1.38.0"}}}'
```

### 升级与迁移

```shell
# 升级管理集群上的 provider 组件
clusterctl upgrade plan
clusterctl upgrade apply --management-group capi-system

# 把 CAPI 管理的对象从一个管理集群搬到另一个(灾难恢复、迁移)
clusterctl move --to-kubeconfig=~/.kube/new-management.kubeconfig

# 查看某类 provider 的可用版本
clusterctl config repositories
```

### 注意

1. **management cluster 与 workload cluster 是两个概念,不要混用**。初学者最常见的错误是把业务直接跑到 management cluster 上。管理集群应当尽量干净、稳定、有备份,因为所有 workload cluster 的「大脑」都在它上面;它挂了并不影响已有 workload cluster 继续运行,但所有变更操作都会停摆。
2. **Docker provider(CAPD)只能用于开发验证**。它把节点跑成 Docker 容器,没有高可用、没有真实网络隔离,官方明确不建议用于生产。生产请选择对应云厂商或裸金属的 provider。
3. **provider 的选择决定了你的迁移成本**。`Cluster` 这类资源是通用的,但 `AWSMachineTemplate`、`VSphereMachineTemplate` 是厂商专属的。选型时要想清楚是否会跨云,跨云意味着资源清单要重写。
4. **`v1beta1` 已废弃**。自 CAPI v1.11 起 `v1beta1` 进入废弃状态,并计划在 **v1.16(约 2027 年 4 月)停止服务**。所有清单都应迁移到 `v1beta2`,provider 也必须实现新契约版本。provider 的版本号不需要与 CAPI 版本号一致,但契约版本必须匹配。
5. **创建完集群后不装 CNI,节点会一直是 NotReady**。这一点和 kubeadm 完全一样,CAPI 不负责 CNI,需要自己 `kubectl apply` 网络插件。
6. **删除集群要删 `Cluster` 对象,而不是删除 YAML 文件**。`kubectl delete -f capi-quickstart.yaml` 可能因为顺序问题留下未被清理的云资源,正确做法是 `kubectl delete cluster capi-quickstart`,让控制器按依赖顺序回收。
7. **Cluster API 不是 CNCF 项目,而是 Kubernetes SIG 项目**。它的治理、发布节奏跟随 Kubernetes 社区,没有商业支持合同可买;企业级支持通常通过各家 provider 的厂商获得。
8. **Talos 的 CAPI provider 已转为社区维护**。Sidero Labs 结束了 CABPT(Talos Bootstrap)与 CACPPT(Talos Control Plane)的开发与商业支持,把仓库移交给 kubernetes-sigs 下的社区维护。已有的支持合同会被履行,但后续节奏取决于社区。选型 Talos + CAPI 的团队需要评估这一点。
9. **CAPI 的学习成本主要在 provider 与模板**。核心概念本身不多,但每个 provider 都有自己的 flavor、变量与前置条件(权限、网络、镜像),实际落地的时间大多花在这里。
10. **升级顺序有讲究**。永远是先升 clusterctl,再用它升 management cluster 上的 provider,最后才动 workload cluster 的 Kubernetes 版本;反过来做容易出现版本矩阵不兼容。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kubeadm` — CAPI 的 Kubeadm provider 底层调用的工具
- `rancher` — 内置 CAPI 集成的多集群管理平台
- `karmada` — 面向多集群应用调度的方案
- `kind` — 常用于搭建 CAPI 的本地管理集群

### 参考链接

- [Cluster API 官方文档](https://cluster-api.sigs.k8s.io/)
- [clusterctl 快速开始](https://cluster-api.sigs.k8s.io/user/quick-start)
- [Cluster API 版本支持矩阵](https://cluster-api.sigs.k8s.io/reference/versions)
- [Cluster API GitHub 仓库](https://github.com/kubernetes-sigs/cluster-api)
- [Talos CAPI provider 转社区维护公告](https://www.siderolabs.com/blog/talos-linux-capi-community-maintenance)
