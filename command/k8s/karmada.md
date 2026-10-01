karmada
===

CNCF毕业的多集群编排项目,统一调度与故障迁移

## 补充说明

**Karmada**(Kubernetes Armada)是华为开源、现已**从 CNCF 毕业**的多集群管理项目(2026 年 9 月正式毕业,与 v1.19 版本同期发布)。它解决的是这样一个问题:当你有多个 Kubernetes 集群时,如何**用一套 API 把应用分发到多个集群**,并支持副本拆分、差异化配置、故障自动迁移。

Karmada 与 Cluster API 的定位经常被混淆,其实完全不同:

```shell
对比项        Karmada                     Cluster API
解决的问题    多集群上的「应用怎么跑」      集群本身的「创建与生命周期」
关注对象      Deployment / Service 等业务    Cluster / Machine 等基础设施
集群来源      已有集群,纳管进来            由 CAPI 创建出来
调度能力      跨集群副本拆分、故障迁移      无(集群级)
```

简单说:**Cluster API 管「有哪几个集群」,Karmada 管「应用怎么分布到这些集群上」**。两者可以叠加使用。

Karmada 的核心价值在于**不改造应用**:你的 Deployment、Service、ConfigMap 写法与单集群完全一致,只是多写一份 `PropagationPolicy` 说明「要发到哪些集群、副本怎么分」。

### 架构

Karmada 的控制平面**自己就是一套完整的 Kubernetes API Server**,而不是一个普通的 CRD 控制器:

```shell
karmada-apiserver             独立的 API Server,承载多集群相关 CRD
karmada-controller-manager    核心控制器,负责资源分发与状态收集
karmada-scheduler             多集群调度器,决定资源落到哪些集群
karmada-webhook               准入校验
karmada-aggregated-apiserver  聚合 API,提供集群访问代理
kube-controller-manager       复用上游控制器
etcd                          以 StatefulSet 形式运行
```

默认都装在 `karmada-system` 命名空间下。此外每个被纳管的成员集群上会有一个 `karmada-agent`(拉模式)或不需要 agent(推模式)。

两种接入模式:

```shell
Push 模式     Karmada 直接持有成员集群的 kubeconfig,主动下发资源
Pull 模式     成员集群上部署 karmada-agent,由 agent 反向拉取指令
             适合成员集群在防火墙后、或跨云跨边的场景
```

### 安装

```shell
# 方式一:karmadactl(kubectl 插件形式等价,kubectl karmada init)
kubectl karmada init

# 指定数据与 PKI 目录(默认会写 /etc/karmada,需要提权)
kubectl karmada init --karmada-data=/opt/karmada --karmada-pki=/opt/karmada/pki

# 控制平面高可用
kubectl karmada init --karmada-apiserver-replicas 3 --etcd-replicas 3

# 离线环境:指定 CRD 包与镜像
kubectl karmada init --crds=<crds.tar.gz 路径> \
  --karmada-controller-manager-image=<私有仓库地址>

# 指定宿主集群的 kubeconfig
kubectl karmada init --kubeconfig=$HOME/.kube/host.config
```

安装脚本会输出 karmada-apiserver 的 kubeconfig 路径,通常可以直接用:

```shell
export KUBECONFIG=/etc/karmada/karmada-apiserver.config
kubectl get clusters
kubectl get pods -n karmada-system
```

本地开发环境(用 kind 拉起,自动创建成员集群):

```shell
git clone https://github.com/karmada-io/karmada
cd karmada
hack/local-up-karmada.sh

export KUBECONFIG="$HOME/.kube/karmada.config"     # Karmada 控制平面
export KUBECONFIG="$HOME/.kube/members.config"     # 成员集群(member1/2/3)
```

### 纳管成员集群

```shell
# 推模式:注册已有集群
karmadactl join member1 \
  --cluster-kubeconfig=$HOME/.kube/member1.config \
  --cluster-context=member1

# 拉模式:在成员集群侧执行 register
karmadactl register <karmada-apiserver-address> \
  --token=<token> --discovery-token-ca-cert-hash=sha256:<hash>

# 查看成员集群
kubectl get clusters
karmadactl get clusters

# 摘除集群
karmadactl unjoin member1
```

### 分发应用

应用本身不需要任何改动,照常用 Deployment:

```shell
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx
  labels:
    app: nginx
spec:
  replicas: 4
  selector:
    matchLabels:
      app: nginx
  template:
    metadata:
      labels:
        app: nginx
    spec:
      containers:
      - name: nginx
        image: nginx:1.27
```

再写一份 `PropagationPolicy` 说明分发策略:

```shell
apiVersion: policy.karmada.io/v1alpha1
kind: PropagationPolicy
metadata:
  name: nginx-propagation
spec:
  resourceSelectors:
    - apiVersion: apps/v1
      kind: Deployment
      name: nginx
  placement:
    clusterAffinity:
      clusterNames:
        - member1
        - member2
    replicaScheduling:
      replicaDivisionPreference: Weighted
      replicaSchedulingType: Divided
      weightPreference:
        staticWeightList:
          - targetCluster:
              clusterNames:
                - member1
            weight: 3
          - targetCluster:
              clusterNames:
                - member2
            weight: 1
```

关键字段的含义:

```shell
replicaSchedulingType: Duplicated   每个集群都跑完整副本数(默认)
replicaSchedulingType: Divided      总副本数按权重拆分到各集群
replicaDivisionPreference: Weighted / Aggregated
clusterAffinity                     指定集群名单或标签选择器
spreadConstraints                   约束副本在故障域上的分布
```

### 差异化配置

同一个应用分发到不同集群时,镜像地址、副本数、资源配额往往不同,用 `OverridePolicy` 表达:

```shell
apiVersion: policy.karmada.io/v1alpha1
kind: OverridePolicy
metadata:
  name: nginx-override
spec:
  resourceSelectors:
    - apiVersion: apps/v1
      kind: Deployment
      name: nginx
  overrideRules:
    - targetCluster:
        clusterNames:
          - member2
      overriders:
        plaintext:
          - path: /spec/template/spec/containers/0/image
            operator: replace
            value: registry.cn-hangzhou.aliyuncs.com/library/nginx:1.27
```

### 故障迁移

Karmada 会检测成员集群的健康状态,当集群变为 `NotReady` 时自动把工作负载迁移到其他可用集群:

```shell
# 查看集群状态
kubectl get clusters -o wide

# 模拟成员集群失联
kubectl --kubeconfig=$HOME/.kube/members.config \
  --context=member1 scale deploy -n kube-system coredns --replicas=0

# 观察工作负载被重新调度
kubectl --kubeconfig=$HOME/.kube/karmada.config get work -A
```

污点与容忍度可以控制哪些应用允许被迁移:

```shell
spec:
  placement:
    clusterTolerations:
      - key: cluster.karmada.io/not-ready
        operator: Exists
        effect: NoExecute
        tolerationSeconds: 300
```

### 观察分发结果

```shell
# Karmada 把每个资源的分发状态记录在 ResourceBinding 与 Work 中
kubectl get resourcebindings -A
kubectl get works -A
kubectl describe work nginx-propagation-default

# 查看某成员集群上实际生效的清单
kubectl get work <work-name> -n <namespace> -o yaml
```

### 附加能力

```shell
# 启用官方 addon(需 karmadactl)
karmadactl addons enable karmada-search      # 多集群资源检索
karmadactl addons enable karmada-metrics-adapter  # 多集群指标
karmadactl addons enable karmada-scheduler-estimator
karmadactl addons list
```

karmada-search 提供跨集群的资源查询,`karmada-metrics-adapter` 让 `kubectl top` 能跨集群工作,多集群 HPA 则依赖它们。

### 注意

1. **Karmada 的控制平面是独立的 apiserver,不是普通 CRD 控制器**。这意味着它有自己的 etcd、自己的证书体系、自己的 API 端点,运维成本接近多维护一个集群。装上之后要把它当生产组件对待:备份 etcd、监控证书到期。
2. **`kubectl karmada init` 默认要写 `/etc/karmada`**,需要提权。容器化或受限环境里应显式用 `--karmada-data` 与 `--karmada-pki` 指定可写目录。
3. **推模式与拉模式的适用场景不同**。推模式需要 Karmada 能直连成员集群的 apiserver,成员集群在 NAT 后就不可行;此时必须用拉模式,在成员集群里跑 `karmadactl register`。模式选错会表现为集群一直处于 `NotReady`。
4. **`PropagationPolicy` 的默认行为是「每集群全量副本」**。不写 `replicaScheduling` 时,`replicas: 4` 会变成每个集群 4 个副本,总副本数被放大。要做总量控制必须显式写 `replicaSchedulingType: Divided`,这是新手最容易踩的坑。
5. **`PropagationPolicy` 与 `ClusterPropagationPolicy` 作用域不同**。前者是命名空间级的,后者是集群级的;分发 Namespace、ClusterRole 这类集群级资源只能用后者。
6. **资源必须被某个策略选中才会分发**。没写策略时,资源只存在于 Karmada 控制平面,不会出现在任何成员集群上。排查「为什么没分发」第一步就是看 `kubectl get propagationpolicy -A` 有没有覆盖到。
7. **命名冲突**:同名资源在多个成员集群里会带上 Karmada 的注解(`work.karmada.io/...`)用于冲突检测;如果成员集群上已经手工创建了同名资源,Karmada 默认不会覆盖,会报冲突。
8. **故障迁移有自己的阈值**。集群失联后不会立刻迁移,要先经过 `clusterTolerations` 里的 `tolerationSeconds`;没有配置容忍度的应用在集群失联时会停在原地。指望「秒级切换」的团队需要先确认这套参数。
9. **跨集群的 Service 不会自动打通**.Karmada 提供的是多集群 Service 发现的多集群 Service API(`ServiceImport`/`ServiceExport`),但底层网络连通性仍然要靠 Cilium ClusterMesh、Submariner 这类方案解决,Karmada 不负责跨集群的数据面。
10. **版本升级要跟上游节奏**。Karmada 的控制器组件版本号跟随自身的 v1.x,但内置的 `kube-controller-manager`、`kube-apiserver` 用的是上游镜像(例如 v1.30.x 系列)。升级前先查兼容矩阵,不要直接替换镜像。
11. **CNCF 毕业不等于自带商业支持**。Karmada 已于 2026 年 9 月毕业,社区活跃,但仍需自行评估生产运维能力;大规模落地案例集中在互联网公司,传统企业的运维经验相对少。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `cluster-api` — 负责集群生命周期的上游项目
- `kubeadm` — Kubernetes集群安装工具
- `argocd` — 另一种应用分发方案
- `istio` — 跨集群服务网格

### 参考链接

- [Karmada 官方文档](https://karmada.io/docs/)
- [Karmada 安装指南](https://karmada.io/docs/installation/)
- [Karmada 多集群调度](https://karmada.io/docs/userguide/scheduling/resource-propagating)
- [CNCF 宣布 Karmada 毕业](https://www.cncf.io/announcements/2026/09/07/cloud-native-computing-foundation-announces-karmada-graduation/)
- [Karmada GitHub 仓库](https://github.com/karmada-io/karmada)
