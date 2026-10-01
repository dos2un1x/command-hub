k3d
===

用Docker容器运行K3s集群,自带负载均衡器与镜像仓库

## 补充说明

**k3d** 是一个把 **K3s 跑在 Docker 容器里**的轻量工具。名字的含义就是「k3s in Docker」——它本身不是 Kubernetes 发行版,而是一个编排器:每条 `k3d cluster create` 都会拉起若干个容器,每个容器里跑一个 K3s 节点,并在前面自动加一个负载均衡器。

它与 kind 经常被拿来对比,因为两者都是「用容器模拟多节点集群」:

```shell
对比项          k3d                          kind
底层发行版      K3s(k3s-io)                  kubeadm + kubelet(上游)
节点镜像        rancher/k3s                   kindest/node
内置 Ingress    Traefik(K3s 自带)            无,需自行部署
内置负载均衡    有,名为 <cluster>-serverlb    无,需 MetalLB 或 cloud-provider-kind
内置镜像仓库    支持,可一条命令创建           不支持
本地存储        K3s local-path-provisioner   无,需自行安装
启动速度        快                          较快
定位            本地开发、边缘验证、CI         CI、e2e 测试、精确复现上游
```

一句话选择建议:**想让本地集群开箱就有 Ingress、LoadBalancer 和存储,选 k3d;想严格复现上游 Kubernetes 的行为(尤其是给上游项目写 e2e),选 kind。**

k3d 是社区项目(k3d-io 组织)维护,**不是 Rancher/SUSE 的官方产品**,但它被 K3s 官方文档列为推荐的容器化运行方式之一。

### 安装

```shell
# 安装脚本
curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | bash

# 指定版本
curl -s https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh | TAG=v5.9.0 bash

# macOS / Linux (Homebrew)
brew install k3d

# Windows
choco install k3d
scoop install k3d

# 通过 Go 安装(会拿到未发布的最新提交,慎用)
go install github.com/k3d-io/k3d/v5@latest

k3d version
```

前置条件:**Docker v20.10.5 及以上**(runc ≥ v1.0.0-rc93),当前用户有权限访问 Docker 守护进程。

### 语法

```shell
k3d [command]
```

```shell
k3d cluster create       创建集群
k3d cluster list         列出集群
k3d cluster delete       删除集群
k3d cluster stop         停止集群(保留容器与数据)
k3d cluster start        启动集群
k3d cluster edit         修改集群配置
k3d node list            列出节点容器
k3d node create          动态新增节点
k3d kubeconfig merge     把集群的 kubeconfig 合并进本地配置
k3d kubeconfig get       只输出 kubeconfig
k3d image import         把本地镜像导入集群
k3d registry create      创建一个镜像仓库容器
k3d cluster create --config  用配置文件创建集群
k3d version              查看版本
```

### 创建集群

```shell
# 最简:1 个 server 节点
k3d cluster create mycluster

# 3 控制平面 + 2 工作节点
k3d cluster create dev --servers 3 --agents 2

# 指定 Kubernetes 版本
k3d cluster create dev --image rancher/k3s:v1.37.0-k3s1

# 指定 API Server 在宿主机上的端口
k3d cluster create dev --api-port 6550

# 创建后切换 kubectl 上下文
k3d cluster create dev --kubeconfig-switch-context
```

创建完成后,`kubectl` 上下文会自动被写入并切换(cluster 名为 `k3d-<name>`):

```shell
kubectl config get-contexts
kubectl config use-context k3d-dev
kubectl get nodes
```

### 端口映射与负载均衡器

k3d 会为每个集群自动创建一个名为 `k3d-<cluster>-serverlb` 的负载均衡容器,它把宿主机端口转发到各 server 节点。这是它和 kind 最大的差别 —— **LoadBalancer 类型的 Service 不需要 MetalLB 就能拿到地址**。

```shell
# 把宿主机 8080 映射到负载均衡器的 80 端口
k3d cluster create dev -p "8080:80@loadbalancer"

# 同时映射 443
k3d cluster create dev -p "8080:80@loadbalancer" -p "8443:443@loadbalancer"

# 直接映射到某个节点而不是负载均衡器
k3d cluster create dev -p "8080:80@agent:0"

# 查看负载均衡器容器
docker ps --filter "name=k3d-dev-serverlb"
k3d node list
```

Linux 上如果报 `Cannot bind to reserved port 80`,是因为 80 属于特权端口,换成 8080 这类高位端口即可,不要用 sudo 绕过。

### 配置文件

复杂集群用配置文件描述更清晰,写入后 `k3d cluster create --config k3d.yaml`:

```shell
apiVersion: k3d.io/v1alpha5
kind: Simple
metadata:
  name: dev
servers: 3
agents: 2
image: rancher/k3s:v1.37.0-k3s1
ports:
  - port: 8080:80
    nodeFilters:
      - loadbalancer
  - port: 8443:443
    nodeFilters:
      - loadbalancer
options:
  k3s:
    extraArgs:
      - arg: --disable=traefik
        nodeFilters:
          - server:*
  kubeconfig:
    updateDefaultKubeconfig: true
    switchCurrentContext: true
```

`nodeFilters` 常用取值:`server:*`、`server:0`、`agent:*`、`loadbalancer`。

### 本地镜像导入

```shell
# 把宿主机 Docker 中的镜像导入集群所有节点
k3d image import my-app:latest -c dev

# 借助共享镜像仓库(推荐,避免重复导入)
k3d registry create myregistry.localhost --port 5001
k3d cluster create dev --registry-use k3d-myregistry.localhost:5001
docker tag my-app:latest k3d-myregistry.localhost:5001/my-app:latest
docker push k3d-myregistry.localhost:5001/my-app:latest
```

配套的 Pod 拉取策略需要显式设置,否则 kubelet 会去远程仓库找同名镜像:

```shell
spec:
  containers:
  - name: app
    image: k3d-myregistry.localhost:5001/my-app:latest
    imagePullPolicy: IfNotPresent
```

### 日常操作

```shell
# 生命周期
k3d cluster list
k3d cluster stop dev
k3d cluster start dev
k3d cluster delete dev
k3d cluster delete --all

# 节点
k3d node list
k3d node create extra-agent --cluster dev --role agent
k3d node delete k3d-dev-agent-1

# kubeconfig
k3d kubeconfig get dev
k3d kubeconfig merge dev --kubeconfig-switch-context
k3d kubeconfig merge dev --output ./dev-kubeconfig

# 进节点容器(节点本质就是 Docker 容器)
docker exec -it k3d-dev-server-0 sh
kubectl get nodes -o wide
```

### 注意

1. **k3d 依赖 Docker,不依赖系统里的 K3s**。它拉取的是 `rancher/k3s` 镜像,集群跑在容器内。宿主机上同时装过 K3s 时两者互不干扰,但端口可能冲突。
2. **节点就是容器,重启容器等于重启节点**。`docker restart k3d-dev-server-0` 会触发一次节点重启,集群数据虽在容器内持久化,但 Docker 卷被清理时集群即丢失。
3. **`--servers 3` 不等于高可用**。多 server 的 K3s 会用嵌入式 etcd,但所有节点都在同一台宿主机、同一个 Docker 守护进程上,宿主机挂了集群全挂。k3d 只适合本地与测试。
4. **端口映射以创建时为准,事后修改能力有限**。旧版本只能删集群重建(最常见的返工点);较新的 k3d 提供了 `k3d cluster edit --port-add` / `--port-delete`,但可改的字段依然只有端口这一块,节点数、镜像等仍需重建。
5. **Linux 上无法直接映射 80/443**。特权端口需要 root,`-p "80:80@loadbalancer"` 会失败,请改用 8080/8443,或配置 `sysctl net.ipv4.ip_unprivileged_port_start=0`。
6. **`k3d image import` 导入的镜像必须配合 `imagePullPolicy: IfNotPresent` 或 `Never`**。默认的 `Always` 会让 kubelet 无视本地镜像去远程拉取,直接 `ImagePullBackOff`。镜像多、迭代频繁时,建一个 registry 比反复 import 高效得多。
7. **集群命名带 `k3d-` 前缀,别和 kind 混了**。kubeconfig 里的 context 是 `k3d-dev`,节点容器是 `k3d-dev-server-0`,负载均衡器是 `k3d-dev-serverlb`;删集群时用 `k3d cluster delete`,不要直接 `docker rm`,否则残留的 kubeconfig 条目要手工清理。
8. **k3d 不是 SUSE/Rancher 的官方产品**,而是社区项目。它的版本节奏跟随自身而非 K3s,遇到新版 K3s 的镜像标签时需要确认 k3d 是否已适配;安全策略方面,其发布产物没有签名与 provenance,对供应链敏感的团队要评估。
9. **默认使用的是 K3s 的组件**,所以 K3s 的坑在这里同样成立:Traefik 占着 80/443、ServiceLB 在每个节点抢 hostPort、kubeconfig 里 server 地址的写法与上游略有差异。要换成上游风格的集群,请用 kind。
10. **CI 中使用时记得显式删除集群**。`k3d cluster delete --all` 应放在流水线的收尾步骤(或 `always` 块)里,否则宿主机上会堆积大量停止的容器与 Docker 卷。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `k3s` — k3d 底层使用的轻量发行版
- `kind` — 用 Docker 运行上游 Kubernetes 集群
- `minikube` — 本地Kubernetes开发环境
- `k9s` — 终端下的 Kubernetes 管理 UI

### 参考链接

- [k3d 官方文档](https://k3d.io/)
- [k3d 创建集群](https://k3d.io/stable/usage/creating-clusters/)
- [k3d 配置文件参考](https://k3d.io/stable/usage/configfile/)
- [k3d GitHub 仓库](https://github.com/k3d-io/k3d)
