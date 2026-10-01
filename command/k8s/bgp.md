bgp
===

Kubernetes集群通过BGP向物理网络宣告Service与Pod网段的路由协议应用

## 补充说明

**BGP**(Border Gateway Protocol)是互联网上用来交换路由信息的事实标准协议。在 Kubernetes 语境下,它解决的是一个非常具体的问题:**集群里的 IP(LoadBalancer VIP、Service IP、Pod 网段)怎么让集群外的网络设备知道,并把流量送进来。**

云上集群通常不需要关心 BGP —— 云厂商的负载均衡器与 VPC 路由表代劳了。但在裸金属、自建机房、专有云里,要让外部访问一个 `type: LoadBalancer` 的 Service,或者让 Pod IP 在集群外可路由,基本只有两条路:让网络设备依赖 ARP/二层(只能在一个广播域内有效),或者用 BGP 把路由宣告给路由器。**BGP 是唯一能跨网段、可 ECMP、可快速收敛的方案。**

Kubernetes 里说 BGP 的通常是这四类组件:

```shell
MetalLB        把 LoadBalancer 类型 Service 的 VIP 宣告给上游路由器
Calico         宣告节点 Pod 网段,实现无封装的三层路由;也支持与物理网络对等
Cilium         BGP Control Plane v2,可宣告 PodCIDR 与 Service 地址
kube-router    内嵌 GoBGP,宣告 Pod 网段与可选的 ClusterIP/ExternalIP/LoadBalancerIP
```

本页只讲**在 Kubernetes 里配 BGP、查 BGP、踩 BGP 的坑**,不展开协议理论。需要协议细节时以 RFC 4271 为准。

### 它到底宣告什么

```shell
Pod 网段       10.244.1.0/24 这样每个节点一块,宣告后集群外可直接访问 Pod IP
LoadBalancer   Service 分到的 VIP,通常 /32,由多台节点同时宣告以获得 ECMP
ClusterIP      一般不需要对外宣告,除非外部客户端要直连 Service IP
ExternalIP     手工指定的对外地址,同样可以宣告
```

多个节点同时宣告同一个 VIP 时,路由器做 **ECMP** 把流量分摊到多台节点,这是 BGP 模式相比 L2 模式最大的价值:没有单点、带宽可以叠加。

### 最小必要的协议概念

```shell
ASN          自治系统号,私有范围 64512-65534(eBGP 场景常用)
eBGP / iBGP  不同 AS 之间/同一 AS 内部的会话;iBGP 要求下一跳可达,通常需 next-hop-self
TCP 179      BGP 会话端口,必须放行;非直连对等还需允许 TTL>1(ebgp-multihop)
Hold / Keepalive  默认 hold 90s、keepalive 30s,两端必须匹配,不匹配会反复超时
Next-hop     宣告出去的路由的下一跳,写错会出现「路由学到了但流量黑洞」
ECMP         等价多路径,要求 AS 路径等属性一致才会被路由器采纳为等价
BFD          双向转发检测,把故障检测从秒级压到亚秒级,MetalLB 与 Cilium 都支持
Community    路由标记,用于在对端做策略(打标、过滤、调整优先级)
```

对等拓扑有两种常见形态:**全互联**(每个节点与所有其他节点建会话,Calico 默认如此)与**路由反射器**(选少数节点做反射器,其他节点只与反射器建会话,解决 O(n²) 问题)。

### MetalLB 的 BGP 配置

MetalLB 的 BGP 由 `BGPPeer` 与 `BGPAdvertisement` 两个 CRD 组成:前者描述"和谁建会话",后者描述"宣告什么"。

```shell
apiVersion: metallb.io/v1beta2
kind: BGPPeer
metadata:
  name: tor-01
  namespace: metallb-system
spec:
  myASN: 64512
  peerASN: 65001
  peerAddress: 10.0.0.1
  # ebgpMultihop: 5              # 非直连对等时设置
  # sourceAddress: 10.0.0.10     # 多网卡时指定建会话的源地址
  # bfdProfile: fast             # 引用 BFDProfile 加速故障检测
```

```shell
apiVersion: metallb.io/v1beta1
kind: BGPAdvertisement
metadata:
  name: default
  namespace: metallb-system
spec:
  ipAddressPools:
    - production
  aggregationLength: 32
  communities:
    - 64512:100
```

BFD 通过在 `metallb-system` 下定义 `BFDProfile`(`receiveInterval`、`transmitInterval`、`detectMultiplier`)并由 `BGPPeer` 的 `bfdProfile` 字段引用即可启用,通常从 300ms × 3 起步。

`BGPPeer` 的 v1beta1 版本已废弃,新配置请直接用 v1beta2。MetalLB 默认使用 FRR-K8s 作为 BGP 后端,传统 FRR 后端已标注 deprecated。

### Calico 的 BGP 配置

```shell
# 查看当前 BGP 全局配置(AS 号、是否全互联)
calicoctl get bgpconfiguration -o yaml

# 关闭节点全互联,改用路由反射器
calicoctl patch bgpconfiguration default -p '{"spec": {"nodeToNodeMeshEnabled": false}}'

# 设置全局 AS 号
calicoctl patch bgpconfiguration default -p '{"spec": {"asNumber": "64513"}}'
```

```shell
apiVersion: projectcalico.org/v3
kind: BGPPeer
metadata:
  name: peer-to-tor
spec:
  peerIP: 10.0.0.1
  asNumber: 65001
  nodeSelector: rack == 'rack-1'
  # sourceAddress: 10.0.0.10
  # keepOriginalNextHop: true
```

```shell
# 会话状态(必须在节点宿主机执行)
sudo calicoctl node status

# 路由细节(进 calico-node 容器)
kubectl -n calico-system exec <calico-node-pod> -- birdcl show protocols
kubectl -n calico-system exec <calico-node-pod> -- birdcl show route
```

Calico 的 BGP 客户端是 BIRD,因此排障工具是 `birdcl` 而不是 `vtysh`。宣告出去的网段取决于 IPPool 的 `ipipMode` / `vxlanMode` 是否为 `Never` —— 只要用了封装,Pod 网段就通过隧道而非 BGP 转发。

### Cilium 的 BGP 配置

Cilium 从 1.16 起使用 BGP Control Plane v2,配置由三个 CRD 分担:

```shell
CiliumBGPClusterConfig    哪些节点、用哪个 ASN、与谁建会话
CiliumBGPPeerConfig       会话级参数(定时器、密码、多跳、地址族与广告选择器)
CiliumBGPAdvertisement    宣告哪些前缀(PodCIDR、Service 的 ClusterIP/ExternalIP/LoadBalancerIP)
CiliumBGPNodeConfigOverride  单节点级别的覆盖
```

```shell
kubectl -n kube-system exec ds/cilium -- cilium-dbg bgp peers
kubectl -n kube-system exec ds/cilium -- cilium-dbg bgp routes advertised ipv4 unicast
kubectl -n kube-system exec ds/cilium -- cilium-dbg bgp routes available ipv4 unicast
```

**Cilium 默认不宣告任何前缀**,peer 的 `families[].advertisements.matchLabels` 必须匹配到某个 `CiliumBGPAdvertisement` 才会宣告。旧的 `CiliumBGPPeeringPolicy` 已在 1.19 中移除。

### kube-router 的 BGP 配置

kube-router 默认使用 iBGP 全互联、集群 AS 号 64512,无需配置即可工作:

```shell
--cluster-asn=64512
--nodes-full-mesh=false
--peer-router-ips="192.168.1.99,192.168.1.100"
--peer-router-asns="65000,65000"
--advertise-pod-cidr=true
--advertise-loadbalancer-ip
--override-nexthop
```

```shell
# 单节点级别的对等配置(注解)
kubectl annotate node node1 kube-router.io/peers="- remoteip: 192.168.1.99
  remoteasn: 65000"

# 查看 RIB(进容器执行)
kubectl -n kube-system exec <kube-router-pod> -- gobgp neighbor
```

### 上游路由器侧要做什么

**这是最容易漏掉的一半工作。** 集群侧配得再对,路由器不做对应配置,什么都不会发生:

```shell
1. 为每台集群节点(或路由反射器)配置邻居,AS 号必须与集群侧一致
2. 放行 TCP 179;非直连对等还要允许 TTL 大于 1,或配置 ebgp-multihop
3. 接受集群宣告的前缀:VIP 段、需要对外暴露的 Pod 网段
4. 配置 ECMP:多条等价路径要能同时进转发表,并设置合适的哈希算法
5. 可选但强烈建议:配置 BFD,把故障收敛从秒级降到亚秒级
6. 注意反向路径:路由器要能把流量送回集群,别只配了单向
```

以 FRR 为例(路由器侧,示意):

```shell
router bgp 65001
  neighbor 10.0.0.10 remote-as 64512
  neighbor 10.0.0.11 remote-as 64512
  address-family ipv4 unicast
    maximum-paths 8
    neighbor 10.0.0.10 activate
    neighbor 10.0.0.11 activate
  exit-address-family
```

### 排障

按「会话 → 前缀 → 可达性」三层往下查,不要跳步。

```shell
# 第一层:会话是否建立
#   MetalLB(native 后端)看日志;FRR-K8s 后端看 FRRNodeState 与指标
kubectl -n metallb-system logs -l component=speaker | grep -i "session"
curl -s http://127.0.0.1:7472/metrics | grep -E "bgp_session_up|frrk8s_bgp_session_up"

#   Calico
sudo calicoctl node status
kubectl -n calico-system exec <calico-node-pod> -- birdcl show protocols all <protocol>

#   Cilium
kubectl -n kube-system exec ds/cilium -- cilium-dbg bgp peers

#   kube-router
kubectl -n kube-system exec <kube-router-pod> -- gobgp neighbor

# 第二层:前缀是否宣告出去
kubectl -n kube-system exec ds/cilium -- cilium-dbg bgp routes advertised ipv4 unicast
kubectl -n metallb-system logs -l component=speaker | grep -i "announcing"

# 第三层:路由器是否学到、流量是否可达
#   路由器上执行(FRR 语法)
show bgp summary
show bgp ipv4 unicast

# 会话建不起来时的抓包(在节点上)
sudo tcpdump -i any -n port 179

# 端口与路由可达性
nc -zv <对端路由器IP> 179
```

会话状态与常见原因:

```shell
Idle / Connect   对端不可达:路由不通、防火墙拦了 179、对端没配邻居
Active           TCP 连不上,同上;检查源地址是否选错网卡
OpenSent         TCP 通了但协商失败,几乎都是 AS 号写错
OpenConfirm     协商进行中,持续停留通常是 MTU 或中间设备干扰
Established     会话正常,问题在宣告或路由器策略上
```

前缀宣告有问题时,再检查这几处:

```shell
MetalLB   有没有 BGPAdvertisement 对象?IPAddressPool 是否匹配?speaker 所在节点是否有可用端点?
Calico    IPPool 的 ipipMode/vxlanMode 是否为 Never?BGPPeer 的 nodeSelector 是否选中了节点?
Cilium    peer 的 families[].advertisements.matchLabels 是否匹配到 CiliumBGPAdvertisement?
kube-router  --advertise-pod-cidr / --advertise-loadbalancer-ip 是否开启?
```

### 注意

1. **BGP 是双边协议,上游路由器必须配合**。集群侧配置正确只是成功的一半,对端不做邻居配置、不放行 179、不接受宣告的前缀,结果都是「会话可能建立但外部完全不通」。
2. **AS 号写错的表现是会话停在 OpenSent**。这类错误排查成本很高,配置改动后第一件事就是确认两端 ASN 一致。
3. **非直连对等必须处理多跳**。MetalLB 用 `ebgpMultihop`,Calico/Cilium 用各自的多跳字段;不设置时 TCP 179 的 TTL 只有 1,包到不了对端。
4. **多网卡节点必须指定源地址**。默认从路由表选源地址,常常选中管理网卡,导致会话建在错误的网络上;MetalLB 的 `sourceAddress`、Calico 的 `sourceAddress` 都是为此存在。
5. **宣告了 VIP 不代表能访问**。VIP 到达节点后还要经过 kube-proxy/Cilium 转发到 Pod,而 `externalTrafficPolicy: Local` 时只有本地有 Pod 的节点才应宣告,否则出现黑洞。
6. **ECMP 要求属性一致**。同一 VIP 从多台节点宣告时,若 AS 路径长度、community、local-pref 不一致,路由器只会选一条路径,带宽无法叠加。
7. **iBGP 需要下一跳可达**。集群内部 iBGP(如 Calico 全互联、kube-router 默认模式)如果没开 next-hop-self 或路由不可达,会出现「路由在 RIB 里但流量不通」。
8. **全互联在 100 节点以上不可用**。BGP 会话数随节点数平方增长,必须提前改造成路由反射器;Calico、kube-router 都提供了对应配置。
9. **忘记清理旧宣告会留下路由残留**。删除 Service 或迁移地址池后,路由器上的前缀会在会话超时后才消失,期间可能出现「访问到已经不存在的后端」。
10. **BFD 能显著改善故障切换,但两端都要配**。只在一端开 BFD 不会生效,而且过短的检测间隔可能引发抖动,生产建议从 300ms × 3 起步,按链路质量调整。
11. **MTU 与 BGP 报文也可能相互影响**。会话能建立但传输大更新报文时中断,通常是路径 MTU 问题,BGP 的 TCP 默认不做 PMTU 发现,必要时显式设置 MSS。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `metallb` — 用BGP宣告LoadBalancer IP的实现
- `calico` — 用BGP宣告Pod网段,基于BIRD
- `cilium` — 提供BGP Control Plane v2
- `kube-router` — 内嵌GoBGP的一体化方案
- `ipvs` — VIP到达节点后的转发实现

### 参考链接

- [RFC 4271:BGP-4 规范](https://datatracker.ietf.org/doc/html/rfc4271)
- [MetalLB BGP 概念](https://metallb.universe.tf/concepts/bgp/)
- [Calico 配置 BGP 对等](https://docs.tigera.io/calico/latest/networking/configuring/bgp)
- [Cilium BGP 控制平面](https://docs.cilium.io/en/stable/network/bgp-control-plane/)
- [kube-router BGP 说明](https://github.com/cloudnativelabs/kube-router/blob/master/docs/bgp.md)
- [FRR 官方文档](https://docs.frrouting.org/)
