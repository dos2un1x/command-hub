cilium-clustermesh
===

Cilium 原生的多集群网络,让集群间 Pod 直通并提供跨集群的 Global Service

## 补充说明

**Cilium ClusterMesh** 是 Cilium 内建的多集群能力,不是独立项目 —— 只要集群用的是 Cilium 作为 CNI,加上一个 `clustermesh-apiserver` 就能让多个集群互相可见。它提供三件事:

```shell
1. 跨集群的 Pod IP 可达(取决于 datapath 模式与路由前提)
2. Global Service —— 同名 Service 在多个集群之间共享后端并负载均衡
3. 跨集群的网络策略 —— 策略可以对远端集群的 Endpoint 生效
```

与 Submariner 相比,它不需要额外的隧道组件与 IPsec 配置(直接复用 Cilium 自身的数据面与加密能力),但**前提是你已经用 Cilium**;与 Skupper 相比,它是 L3/L4 方案而不是应用层代理。

### 核心概念

```shell
cluster.name        集群的人类可读名称,必须全网格唯一
cluster.id          集群数字 ID(1-255),必须全网格唯一
clustermesh-apiserver   每个集群一个,对外提供本集群状态并拉取远端状态
KVStoreMesh         可选组件,把远端状态缓存到本地,降低对远端 apiserver 的依赖
Global Service      加了 service.cilium.io/global 注解的 Service
```

`clustermesh-apiserver` 通常以 Deployment 形式运行在 `kube-system` 下,每个集群一个,负责在集群之间同步 Service、Endpoint、身份与策略信息。

### 前提条件

这几条是硬性的,不满足就直接连不上:

```shell
1. 所有集群都运行 Cilium,且 datapath 模式一致(native routing 或 tunneling)
2. Cilium 版本之间相差不超过一个 minor 版本
3. 集群名唯一,长度不超过 32 字符,只允许小写字母数字与短横线,且首尾必须是字母或数字
4. 集群 ID 唯一,取值 1-255
5. 各集群的 Pod CIDR 不能重叠(Service CIDR 可以重叠)
6. 各节点之间的 InternalIP 必须互相可达,相关端口按官方防火墙要求放行
```

集群名与 ID 的约束值得单独强调:**名字改起来要谨慎,ID 改了必须重启工作负载**,因为 Cilium 的安全标识(security identity)是基于集群 ID 生成的。

### 开启 ClusterMesh

```shell
# 方式一:安装时就带上集群名与 ID
cilium install --context $CLUSTER1 --set cluster.name=cluster1 --set cluster.id=1
cilium install --context $CLUSTER2 --set cluster.name=cluster2 --set cluster.id=2

# 方式二:对已有集群开启(同样要保证 name/id 已正确设置)
cilium clustermesh enable --context $CLUSTER1
cilium clustermesh enable --context $CLUSTER2

# 查看开启进度
cilium clustermesh status --context $CLUSTER1 --wait
```

对应的 Helm values:

```shell
cluster:
  name: cluster1
  id: 1

clustermesh:
  useAPIServer: true          # 使用 clustermesh-apiserver 模式
  apiserver:
    replicas: 2               # 生产环境建议至少 2 副本
  config:
    enabled: true             # 在 agent 中启用 clustermesh 配置
```

### 连接集群

```shell
# 只需要单向执行一次,两个集群即互相可见
cilium clustermesh connect --context $CLUSTER1 --destination-context $CLUSTER2

# 校验
cilium clustermesh status --context $CLUSTER1 --wait
cilium clustermesh status --context $CLUSTER2 --wait

# 连通性测试(会跑一套多集群用例)
cilium connectivity test --context $CLUSTER1 --multi-cluster $CLUSTER2

# 断开
cilium clustermesh disconnect --context $CLUSTER1 --destination-context $CLUSTER2
cilium clustermesh disable --context $CLUSTER1
```

`cilium clustermesh status` 里的 `Global services` 一栏会显示当前网格中识别到的 Global Service 数量,是排查「Service 为什么不跨集群」的第一站。

### Global Service

把一个普通的 Service 变成跨集群的 Global Service,**只需要一个注解**,前提是各集群里存在同名同命名空间的 Service:

```shell
apiVersion: v1
kind: Service
metadata:
  name: nginx
  namespace: default
  annotations:
    service.cilium.io/global: "true"
spec:
  selector:
    app: nginx
  ports:
    - port: 80
```

相关注解:

```shell
service.cilium.io/global: "true"          声明为 Global Service
service.cilium.io/shared: "false"         不把自己的后端共享出去(只消费别人的)
service.cilium.io/affinity: local         优先用本地后端,本地全部不可用时才用远端
service.cilium.io/affinity: remote        优先用远端后端
service.cilium.io/affinity: none          默认,不做偏好,正常跨集群均衡
```

用 `cilium-dbg service list --clustermesh-affinity` 可以看到被标记为 `(preferred)` 的后端。

### 跨集群网络策略

Cilium 的网络策略可以按集群筛选对端:

```shell
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-from-cluster2
  namespace: default
spec:
  endpointSelector:
    matchLabels:
      app: nginx
  ingress:
    - fromEndpoints:
        - matchLabels:
            io.cilium.k8s.policy.cluster: cluster2
            app: client
```

`io.cilium.k8s.policy.cluster` 这个保留标签是区分对端集群的关键,写跨集群策略时必用。

### 注意

1. **Pod CIDR 不能重叠,Service CIDR 可以重叠**。这一点经常被记反:ClusterMesh 要求的是 PodCIDR 唯一,而 Service CIDR 重叠是允许的 —— 因为跨集群访问走的是 Global Service 的 VIP 与后端 IP,不做 Service VIP 之间的路由。
2. **Pod CIDR 重叠的「支持」是企业版特性,不是开个 flag 就行**。社区版 Cilium 文档明确写的是「所有集群、所有节点的 PodCIDR 必须不冲突且唯一」。重叠场景需要 Isovalent Enterprise 的 `enterprise.clustermesh.enableOverlappingPodCIDRSupport: true`,而且此时**只有 Global Service / Phantom Service 能通**,Pod 到 Pod 的直接访问不行,跨集群时源 IP 还会被改写成节点 IP。
3. **网上流传的 `--allow-mismatching-cidrs` 参数在官方 ClusterMesh 文档中并不存在**。查证时请以 `cilium clustermesh connect --help` 与官方文档为准,不要把博客里的参数直接抄进脚本。
4. **Cilium 版本差不能超过一个 minor**。跨版本混跑会表现为状态显示连接成功但流量不通,排查时先确认 `cilium version` 的差异。
5. **集群名有 32 字符上限**,且只允许小写字母数字与短横线、首尾必须为字母数字。用云厂商自动生成的长集群名很容易超限或被拒。
6. **改 cluster ID 会重建安全标识,必须重启工作负载**。这是升级/迁移中最容易忽略的一步,不重启会出现策略与身份不匹配的诡异现象。
7. **`maxConnectedClusters` 默认 255,最大 511,且只能在安装时设置一次**。规划大规模网格时必须在第一次 `cilium install` 就定好,后期无法修改。
8. **Global Service 要求各集群里存在同名 Service**。只在 A 集群建了 Service、B 集群没有,B 集群不会自动获得这个服务;这与 MCS-API 的 `ServiceExport` 模型不同。
9. **NodePort 与 host-network 流量的跨集群均衡有额外前提**。要么 `kubeProxyReplacement=true`,要么 `socketLB.enabled=true` 且 `socketLB.hostNamespaceOnly=true`,否则从集群外进来的流量不会均衡到远端后端。
10. **远端集群不可达时的行为由 `clustermesh.cacheTTL` 决定**,默认 `0s` 表示永不主动清理缓存。这会导致「远端集群已经挂了,本地还在往它的陈旧后端发流量」,生产环境需要按实际容忍度调这个值。
11. **agent 内的命令自 Cilium 1.16 起由 `cilium` 改名为 `cilium-dbg`**,老教程里的 `cilium service list` 要在节点上换成 `cilium-dbg service list`。
12. **注意与 Cilium 其它子系统的版本变更叠加**。BGP v2 的 CRD 已换成 `CiliumBGPClusterConfig` / `CiliumBGPPeerConfig` / `CiliumBGPAdvertisement`,`CiliumBGPPeeringPolicy` 在 1.19 已移除 —— 多集群 + BGP 的场景升级前务必核对。

### 相关命令

- `cilium` — Cilium CLI,ClusterMesh 的主要操作入口
- `kubectl` — Kubernetes集群管理工具
- `submariner` — 另一种跨集群 L3 方案,不依赖 CNI
- `networkpolicy` — 单集群网络策略,跨集群需用 CiliumNetworkPolicy
- `gateway-api` — 与 Global Service 不同的服务暴露路径
- `karmada` — 多集群编排,可与 ClusterMesh 叠加

### 参考链接

- [Cilium ClusterMesh 总览](https://docs.cilium.io/en/stable/network/clustermesh/)
- [设置 ClusterMesh(含前提条件与 CLI)](https://docs.cilium.io/en/stable/network/clustermesh/setup.html)
- [Global Services](https://docs.cilium.io/en/stable/network/clustermesh/global-services.html)
- [Service Affinity](https://docs.cilium.io/en/stable/network/clustermesh/affinity.html)
- [跨集群网络策略](https://docs.cilium.io/en/stable/network/clustermesh/policy.html)
- [Isovalent:重叠 Pod CIDR 与企业版支持](https://isovalent.com/blog/post/overlapping-pod-cidr-cilium-cluster-mesh/)
