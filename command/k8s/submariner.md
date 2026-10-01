submariner
===

跨集群 L3 网络互联,让不同集群的 Pod 与 Service 直接互通

## 补充说明

**Submariner** 是 CNCF Sandbox 项目(2021-04-28 进入沙箱,截至 2026 年 9 月仍未晋升 Incubating/Graduated),由 Red Hat 主导,采用 Apache-2.0 许可。它解决的是多集群场景中最底层的一个问题:**让集群 A 的 Pod 能用 IP 直接访问集群 B 的 Pod 与 Service**。

它工作在**网络层(L3)**,与 CNI 无关(Calico、Cilium、Flannel、OVN-Kubernetes 都能配合),这是它与 Skupper 这类应用层方案最本质的区别。当前最新版本为 **v0.24.1(2026-08-30)**,是一个安全修复版本(修掉了 WireGuard 默认 PSK 回退问题);项目仍是 0.x,但已在生产中使用,维护着 7 条发布分支的回移植。

### 与其它多集群网络方案的定位

```shell
方案                     层次    跨集群 Pod IP   跨集群 Service        依赖
Submariner               L3      IP 直接可达      clusterset.local DNS  CNI 无关
Cilium ClusterMesh       L3/L4   IP 直接可达      Global Service        必须用 Cilium
Skupper                  L7      不可达           代理转发(AMQP)       无
Karmada 的 ServiceImport  API    不负责           提供发现 API          不提供数据面
```

一句话:**Submariner 把多个集群的网络「压平」成一个平面**,集群 A 里的 Pod 直接用集群 B 的 Pod IP 就能通信。代价是它要求两边地址空间能协调,以及网关节点必须能互通。

### 架构与组件

```shell
submariner-gateway        DaemonSet,只调度到打了网关标签的节点,负责建立 IPsec/WireGuard 隧道
submariner-routeagent     DaemonSet,跑在所有节点,把跨集群流量从节点转发到活动网关
submariner-globalnet      可选组件,处理 CIDR 重叠场景下的地址转换
submariner-lighthouse-*   服务发现(CoreDNS 插件 + lighthouse-agent)
submariner-operator       控制器,负责安装与协调上述组件
submariner-k8s-broker     只在 broker 集群部署,供各集群交换元数据
submariner-metrics-proxy  指标代理(监控用)
```

默认命名空间:`submariner-operator`(成员组件)与 `submariner-k8s-broker`(broker)。

Broker 的形态比较特殊 —— 它**不是一个服务,而是一组 CRD + RBAC**,所有集群的 Gateway Engine 都能读写这个集群的 API Server,通过里面的 `Endpoint`、`Cluster` 等对象互相发现对方。因此 Broker 集群的 API Server 必须对所有成员集群可达。

### 安装:subctl

`subctl` 是官方推荐的部署入口,一个集群做 broker,其余集群 join:

```shell
# 安装 subctl
curl -Ls https://get.submariner.io | bash

# 1. 选一个集群作为 broker
subctl deploy-broker --kubeconfig cluster-a.config
# 会生成 broker-info.subm,后续 join 都靠它

# 2. 其余集群加入
subctl join broker-info.subm --kubeconfig cluster-b.config
subctl join broker-info.subm --kubeconfig cluster-c.config

# 3. 校验连通性(需要两个集群的 kubeconfig)
subctl verify --context cluster-a --tocontext cluster-b

# 4. 查看状态
subctl show all
subctl show networks
subctl show connections
subctl show gateways
subctl show endpoints

# 5. 排障与信息收集
subctl diagnose all
subctl gather

# 6. 导出服务供其它集群访问
subctl export service -n default nginx

# 7. 卸载 / broker 信息恢复
subctl uninstall
subctl recover-broker-info
```

`subctl join` 会顺带装上 Submariner Operator,并自动挑选一个 Worker 节点作为网关(`--label-gateway` 默认开启,即自动打标签并提示)。

### 安装:Helm

不用 `subctl` 时,两个官方 chart 分别是 broker 端与成员端:

```shell
helm repo add submariner-latest https://submariner-io.github.io/submariner-charts/charts

# broker 集群
helm install submariner-k8s-broker submariner-latest/submariner-k8s-broker \
  --create-namespace --namespace submariner-k8s-broker

# 成员集群
helm install submariner-operator submariner-latest/submariner-operator \
  --create-namespace --namespace submariner-operator \
  --set ipsec.psk="${SUBMARINER_PSK}" \
  --set broker.server="${SUBMARINER_BROKER_URL}" \
  --set broker.token="${SUBMARINER_BROKER_TOKEN}" \
  --set broker.namespace=submariner-k8s-broker \
  --set broker.ca="${SUBMARINER_BROKER_CA}" \
  --set submariner.serviceDiscovery=true \
  --set submariner.cableDriver=libreswan \
  --set submariner.clusterId="${CLUSTER_ID}" \
  --set submariner.clusterCidr="${CLUSTER_CIDR}" \
  --set submariner.serviceCidr="${SERVICE_CIDR}" \
  --set submariner.natEnabled="true"
```

关键 values:

```shell
ipsec.psk                   集群间的预共享密钥,必须所有集群一致
submariner.cableDriver      libreswan(默认) / wireguard / vxlan
broker.globalnet            CIDR 重叠时置 true
submariner.natEnabled       网关之间是否存在 NAT
submariner.clusterId        集群数字 ID,broker 内唯一
submariner.clusterCidr      Pod CIDR
submariner.serviceCidr      Service CIDR
submariner.globalCidr       Globalnet 使用的全局网段
```

注意 PSK 的键名是 `ipsec.psk`,不是 `submariner.ceIPSecPSK` —— 后者是 Mesh 方案里常见的误写。

### 网关节点

网关节点通过**节点标签**手工指定,这是与其他组件最容易混淆的一点:

```shell
kubectl label node worker-1 submariner.io/gateway=true

# 查看哪些节点是网关
kubectl get nodes -l submariner.io/gateway=true

# MTU 问题时的应急注解(封装后大包被丢)
kubectl annotate node worker-1 submariner.io/tcp-clamp-mss=1400
```

一个集群**可以标记多个网关节点做冗余,但同一时刻只有一个 Gateway Engine 处于活动状态**,由 leader election 选出。活动网关失联后,另一个节点会赢得选举、重建 `Endpoint`,其它集群通过 broker 感知到新 `Endpoint` 并重新建隧道。

### 节点间端口要求

```shell
4500/UDP     IPsec NAT-T,隧道封装端口(可用 --nattport 改成非标准端口)
4490/UDP     NAT 发现端口(不可改),网关之间必须双向放行
4800/UDP     VXLAN,集群内部节点与网关之间的隧道流量
ESP 协议     网关之间没有 NAT、直接可达时需要放行
8080/TCP     指标端口(按需)
```

如果网关之间是公网直连(无 NAT),放行 ESP 即可;一旦中间有 NAT,就退化为 4500/UDP 的 NAT-T。企业防火墙常常只放行 TCP,这是部署 Submariner 时最常见的阻塞点。

### 服务发现

跨集群的 Service 发现基于 Multi-Cluster Services API(`multicluster.x-k8s.io`),**必须显式导出**:

```shell
apiVersion: multicluster.x-k8s.io/v1alpha1
kind: ServiceExport
metadata:
  name: nginx
  namespace: default
```

导出后,其它集群可以用固定 DNS 名称访问:

```shell
nginx.default.svc.clusterset.local                    普通 Service
pod-0.cluster-b.nginx.default.svc.clusterset.local    headless Service 下的单个 Pod
```

`ServiceImport` 由 Lighthouse 内部创建,不需要人工干预;没有 `ServiceExport` 就没有 `clusterset.local` 记录。

### Globalnet:处理 CIDR 重叠

如果两个集群的 Pod/Service CIDR 重叠,普通模式无法工作,需要启用 Globalnet 把重叠地址做一层转换:

```shell
subctl deploy-broker --globalnet
subctl join broker-info.subm --globalnet --globalnet-cidr-range 242.0.0.0/8

# 集群级出网 IP
kubectl get clusterglobalegressips -A

# 入向暴露单个 Service
kubectl get globalingressips -A
```

Globalnet 是**补丁而不是等价替代**:它引入额外的地址转换与 `GlobalIngressIP` 对象管理,排障复杂度明显上升,能重新规划 CIDR 就应该重新规划。

### 注意

1. **集群之间的 Pod CIDR 与 Service CIDR 默认必须不重叠**,这是硬前提。`subctl diagnose deployment` 会检查这一点。重叠时只能用 Globalnet,而 Globalnet 会带来额外 NAT 与对象管理成本。
2. **Broker 是逻辑中心但不会让数据面立刻中断**。官方明确说明:broker 不可达时数据面继续按最后一次已知信息转发,但控制面停摆 —— 新的 `Endpoint` 无法发布,集群加入/变更也不可见。因此 broker 集群要当生产组件对待,并定期执行 `subctl recover-broker-info` 备份 broker 信息。
3. **网关节点必须能被其它集群的网关直接访问**。私有 IP + NAT 的环境中必须正确设置 `submariner.natEnabled`,否则表现为隧道一直建不起来、`subctl show connections` 里连接状态异常。
4. **端口不是一个,而是一组**。只放行 4500/UDP 是不够的:4490/UDP 用于 NAT 发现,4800/UDP 用于集群内节点到网关的流量。忽略 4800 会导致「网关之间通、但 Pod 之间不通」这种反直觉现象。
5. **网关切换不是无损的**。活动网关挂掉后要重新选举、重建隧道并让其它集群感知新 `Endpoint`,期间跨集群流量会中断,不要期望秒级无感切换。
6. **MTU 是高频问题**。IPsec/VXLAN 封装会增加头部开销,表现为小包正常、大包卡死(典型是 TLS 握手成功但传输挂起)。除了给节点打 `submariner.io/tcp-clamp-mss` 注解,还可以在应用侧调小 MSS。
7. **`ServiceExport` 必须逐个命名空间显式创建**,没有「自动导出整个集群」的开关。导出前 `clusterset.local` 一定解析失败,不要误判成 DNS 故障。
8. **Submariner 仍是 0.x 版本**,升级要遵循官方支持的相邻版本路径,不要跨多个小版本跳跃。同时注意 v0.24.1 修的是 WireGuard 默认 PSK 回退这一安全问题,使用 WireGuard cable driver 的集群应尽快升级。
9. **不同的 cable driver 安全性不同**。`vxlan` **不加密**,只适合可信网络;跨公网应使用 `libreswan`(IPsec)或 `wireguard`。选择 vxlan 又会引入 4800/UDP 的额外放行要求。
10. **它与 Karmada、Cilium ClusterMesh 不是替代关系**。Submariner 只解决网络连通,不做应用分发;Karmada 负责分发但明确不提供数据面。真要跑多集群应用,常见组合是 Karmada + Submariner,或 Cilium ClusterMesh 单独搞定两者。
11. **某些 CNI 会改变端口需求**。例如 OVN-Kubernetes 环境下不需要 4800/UDP;而 OpenShift SDN 下则要求所有节点双向放行。按官方文档逐条确认,不要照抄别人的清单。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `cilium` — 自带 ClusterMesh 多集群网络能力
- `calico` — 常与 Submariner 配合的 CNI
- `istio` — 跨集群服务网格,可叠加使用
- `karmada` — 多集群应用分发,与 Submariner 互补
- `helm` — 用官方 chart 部署 broker 与 operator

### 参考链接

- [Submariner 官方文档](https://submariner.io/)
- [Submariner 架构总览](https://submariner.io/getting-started/architecture/)
- [Submariner Broker 架构](https://submariner.io/getting-started/architecture/broker/)
- [Submariner Gateway Engine](https://submariner.io/getting-started/architecture/gateway-engine/)
- [subctl 参考](https://submariner.io/operations/deployment/subctl/)
- [Submariner Helm 部署](https://submariner.io/operations/deployment/helm/)
- [Submariner GitHub 仓库](https://github.com/submariner-io/submariner)
