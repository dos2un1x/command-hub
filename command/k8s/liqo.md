liqo
===

跨集群资源联邦:把远端集群的剩余算力变成一个可调度的虚拟节点

## 补充说明

**Liqo**(Liquid Computing)是一个开源的跨集群资源联邦项目,由**都灵理工大学(Politecnico di Torino)** 发起,采用 Apache-2.0 许可,当前最新版本为 **v1.2.0(2026-07-03)**,项目仍在活跃开发(仓库每日都有提交)。

> **一点澄清**:Liqo 常被误标为「CNCF Sandbox 项目」。它的实现基于 CNCF 的 Virtual Kubelet 项目,社区也活跃在 CNCF 生态中,但**官方仓库与站点并未标注 CNCF 成熟度级别**,引用时不要想当然地写成 CNCF 项目。

Liqo 要解决的问题与 Karmada 不同。Karmada 问的是「应用的副本怎么分发到多个集群」,Liqo 问的是**「怎么把别的集群的闲置算力借过来用」**:

```shell
Karmada    应用分发:副本拆分、差异化配置、故障迁移,应用需要感知多集群
Liqo       资源联邦:远端集群变成一个虚拟节点,应用完全无感
```

在 Liqo 里,消费者集群(consumer)会把提供者集群(provider)的容量聚合成一个 **VirtualNode**,原生的 Kubernetes 调度器可以直接往上调度 Pod;被调度到虚拟节点上的 Pod 会**真正运行在远端集群的节点上**。

### 四个能力

```shell
Peering         两个集群自动协商建立对等关系,无需手工配 VPN 与证书
Offloading      把命名空间「卸载」到远端,Pod 落到虚拟节点上
Network Fabric  跨集群的 Pod-to-Pod / Pod-to-Service 连通,与底层 CNI 无关
Storage Fabric  远端执行有状态工作负载,倾向「数据不动、计算动」
```

### 关键资源

```shell
ForeignCluster           discovery.liqo.io/v1alpha1    对端集群的抽象,记录 peering 状态
NamespaceOffloading      offloading.liqo.io/v1beta1   命名空间的卸载策略
VirtualNode              以节点形式暴露远端容量(标签 liqo.io/type=virtual-node)
ResourceSlice            authentication.liqo.io/v1beta1  资源申请与授权
Tenant                   authentication.liqo.io/v1beta1  在 provider 侧代表一个 consumer
GatewayServer/Client     networking.liqo.io/v1beta1    网关配置模板与实例
TunnelEndpoint           net.liqo.io                  集群间隧道的落点信息
```

`ForeignCluster` 是理解 Liqo 的入口 —— 它代表「另一个集群」,其 status 里会汇总 peering、网络、认证各模块的状态:

```shell
kubectl get foreignclusters
kubectl get foreignclusters -o wide

# 虚拟节点
kubectl get nodes -l liqo.io/type=virtual-node
kubectl describe node liqo-<cluster-id>
```

### 安装

```shell
# 安装 liqoctl(macOS / Linux 二进制见 release 页面)
liqoctl version

# 在集群上安装 Liqo(按发行版选择子命令)
liqoctl install k3s --kubeconfig cluster-a.config
liqoctl install kind --kubeconfig cluster-a.config
liqoctl install eks --eks-cluster-name my-cluster --region eu-west-1
liqoctl install aks / gke / openshift

# 查看状态
liqoctl status
kubectl get pods -n liqo
```

### 建立 Peering

两种方式,取决于能否同时访问两个集群的 kubeconfig:

```shell
# in-band:一条命令,同时访问两个集群(最简单)
liqoctl peer in-band --context=consumer --remote-context=provider

# in-band 双向(两端互相可用)
liqoctl peer in-band --context=consumer --remote-context=provider --bidirectional

# out-of-band:两端网络不通、靠人工传递凭证时使用
# 在 provider 侧生成命令
liqoctl generate peer-command
# 在 consumer 侧执行生成的命令
liqoctl peer out-of-band <cluster-name> \
  --auth-url <url> --cluster-id <id> --auth-token <token>

# 断开
liqoctl unpeer in-band --context=consumer --remote-context=provider
liqoctl unpeer out-of-band
```

peering 成功后,consumer 侧会多出一个虚拟节点,以及一个 `ResourceSlice` 记录从 provider 申请到的资源量。

### 卸载命名空间

**默认情况下虚拟节点不参与调度** —— 只有明确卸载的命名空间,其 Pod 才会落到远端:

```shell
# 命令行方式
liqoctl offload namespace demo
liqoctl unoffload namespace demo
```

声明式方式:

```shell
apiVersion: offloading.liqo.io/v1beta1
kind: NamespaceOffloading
metadata:
  name: offloading
  namespace: demo
spec:
  namespaceMappingStrategy: DefaultName     # 或 EnforceSameName
  podOffloadingStrategy: LocalAndRemote     # 或 Local / Remote
  clusterSelector:
    nodeSelectorTerms: []
```

字段含义:

```shell
podOffloadingStrategy: LocalAndRemote   本地与远端都可调度(默认)
podOffloadingStrategy: Local            只调度到本地节点
podOffloadingStrategy: Remote           只调度到远端虚拟节点
namespaceMappingStrategy: DefaultName   provider 侧的命名空间名会加后缀,避免冲突
namespaceMappingStrategy: EnforceSameName 要求两侧同名,适合已经约定好命名的场景
```

`NamespaceOffloading` 的 status 里可以看到每个远端集群的 `offloadingPhase`(`Ready` / `NoClusterSelected` / `SomeFailed` / `AllFailed`)。

### 网络

```shell
liqo-gateway            每个集群一个,负责跨集群隧道
liqo-ipam               IP 地址管理与映射
WireGuard / Geneve      隧道封装方式(v1.2 起 liqo-gateway 内嵌 wireguard-go)
internal fabric         更轻量的集群内互联模式
```

网络模块会为每个对端生成网关与隧道配置,并在必要时做地址映射,使得即使两侧的 CNI 不同、Pod CIDR 规划不同,Pod 之间也能互通。

### 资源申请与资源插件

provider 共享多少资源是可以定制的。默认行为是「共享当前可用资源的一个可配置比例」,需要更精细的控制时用资源插件:

```shell
fixed-resources          按固定量共享,例如 --resource=cpu=2000m --resource=memory=2G --resource=pods=10
node-labels-resources    按节点标签决定共享哪些节点的资源
```

插件通过安装参数接入:

```shell
liqoctl install k3s \
  --set controllerManager.config.resourcePluginAddress=<plugin-address>
```

consumer 侧的资源申请以 `ResourceSlice` 表达:`liqoctl peer` 会创建一个默认的 ResourceSlice,后续可以追加更多以申请额外资源。相关开关:

```shell
--create-virtual-node false       只建立 peering 与认证,不创建虚拟节点
--create-resource-slice false     不自动创建 ResourceSlice
--resource-slice-class <class>    指定 ResourceSlice 类别,默认 default
```

v1.2 起还引入了可定制的 ResourceSlice 类别(Custom ResourceSlice classes),用于把资源按类别区分共享。

### 与 Karmada 的分工

两者常被放在一起比较,实际的差异在「谁感知多集群」:

```shell
维度          Liqo                          Karmada
解决的问题     借算力(资源联邦)              分应用(应用分发)
应用是否感知   不感知,Pod 落到虚拟节点即可    需要 PropagationPolicy 描述分发策略
副本控制       交给原生调度器                 跨集群副本拆分与权重
故障迁移       不做,虚拟节点 NotReady 即止    支持集群失联后的自动迁移
资源归属       远端集群的节点承载 Pod         副本落在成员集群,各自调度
```

一个常见的组合是:Karmada 负责「应用该跑在哪些集群」,Liqo 负责「某个集群算力不够时向外借」。但这两层同时引入会让排障路径变长,小规模场景通常只选其中一层。

### 注意

1. **虚拟节点上的 Pod 真的跑在远端集群**。这带来一连串后果:数据本地性变了、本地 PV 访问不到、镜像要在远端拉取、GPU 型号可能与预期不同。有状态工作负载或对延迟敏感的服务要先评估,不要直接卸载生产业务。
2. **虚拟节点默认不会暴露 provider 的全部容量**。Liqo 默认只共享 provider 当前可用资源的一个**可配置比例**,并通过资源插件(`fixed-resources`、`node-labels-resources`)来定制共享多少。此外虚拟节点带有 taint,需要 Liqo 的 webhook 自动加 toleration 才能被调度。
3. **`NamespaceOffloading` 必须早于 Pod 调度创建**。官方明确警告:如果 Pod 已经在命名空间里被创建后再去开启卸载,这些 Pod 可能永久停在 `Pending`。正确的顺序是先建 `NamespaceOffloading`,再部署工作负载。
4. **虚拟节点不是真节点**。它由 Virtual Kubelet 实现,不具备真实节点的全部语义:DaemonSet 不会在虚拟节点上运行、hostPath 之类的本地卷不可用、部分 volume 类型与节点级特性不支持。把不兼容的工作负载调度上去会表现为 Pod 一直起不来。
5. **Provider 侧需要一个外部可达的入口**。跨集群隧道需要在 provider 上暴露网关端点(通常是 LoadBalancer 或公网 IP);在 EKS 这类环境下还要依赖 GatewayServer 的健康检查能力(相关支持是 v1.2 才完善的)。没有可达入口时 peering 会建立但网络一直不通。
6. **跨版本 peering 不被支持**。官方限定:除 patch 版本外,不同 Liqo 版本之间不能建立 peering。升级集群时要**同时升级所有参与 peering 的集群**,否则需要先 unpeer 再重建。
7. **Pod CIDR 重叠是历史痛点**。Liqo 长期要求各集群地址空间可协调;v1.2 才引入「多个 Pod CIDR」与「可重叠的保留子网(refcount 管理)」等能力来缓解。用更早版本做集群联邦前,必须先确认地址规划。
8. **它不提供应用分发语义**。Liqo 没有副本拆分、集群亲和、故障自动迁移这些策略 —— 那是 Karmada 一类工具的职责。Liqo 里如果 provider 集群挂了,虚拟节点会变成 NotReady,已经调度上去的 Pod 如何收敛取决于工作负载本身,不要指望自动迁移。
9. **要区分「联邦算力」与「多集群编排」的选型**。突发算力、边缘算力回收、跨云借算力这类需求适合 Liqo;需要灰度发布、副本比例控制、地域容灾的需求适合 Karmada。两者可以叠加,但要清楚各自负责哪一层。
10. **API 仍在演进**。资源组版本在 v1.x 期间发生过迁移(`offloading.liqo.io` 从 v1alpha1 到 v1beta1),`Tenant` / `ResourceSlice` 这层模型也在快速调整。把 Liqo 的 CRD 写进生产清单前,先核对目标版本的 API 与字段。
11. **不要把它当成多租户隔离方案**。Liqo 的 Tenant 是「provider 侧代表某个 consumer」的身份抽象,用于资源授权与命名空间映射,不是给同一个集群内多个互不信任团队做隔离的机制。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `karmada` — 多集群应用分发,与 Liqo 互补而非竞争
- `cluster-api` — 集群生命周期管理,可与 Liqo 叠加
- `vcluster` — 虚拟集群,与本地的「虚拟节点」概念不同
- `cilium` — 常见的底层 CNI,Liqo 文档中也有对应的安装说明
- `multi-tenancy` — 单集群内的多租户取舍

### 参考链接

- [Liqo 官方文档](https://docs.liqo.io/en/stable/)
- [卸载(Offloading)特性说明](https://docs.liqo.io/en/v1.2.0/features/offloading.html)
- [Peer two Clusters](https://docs.liqo.io/en/v1.2.0/usage/peer.html)
- [liqoctl peer 命令参考](https://docs.liqo.io/en/v1.0.1/usage/liqoctl/liqoctl_peer.html)
- [Liqo GitHub 仓库](https://github.com/liqotech/liqo)
