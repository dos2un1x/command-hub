metallb
===

裸金属Kubernetes集群的LoadBalancer类型Service实现,支持L2与BGP两种宣告模式

## 补充说明

**MetalLB** 解决的是一个非常具体的问题:在没有云厂商负载均衡器的裸金属或自建机房里,`type: LoadBalancer` 的 Service 会永远停在 `EXTERNAL-IP: <pending>`。MetalLB 补上了这块能力 —— 它从你划定的地址池里分配 IP,再通过网络层(L2 的 ARP/NDP,或 BGP 路由)把这个 IP 宣告出去,让集群外的客户端能访问到。

项目**仍在积极维护**,当前稳定版本为 v0.16.1(2026 年 5 月发布),同时只维护最新一个次版本 —— v0.15 及更早版本已停止支持(EOL),升级前应先看清兼容性说明。

两个组件分工明确:

```shell
controller   Deployment,负责从 IPAddressPool 里给 Service 分配/回收 IP
speaker      DaemonSet,负责把分配到的 IP 宣告到网络上(L2 应答 ARP,或 BGP 发路由)
```

MetalLB 有**三种 BGP 后端**,默认与推荐的都是 FRR-K8s:

```shell
FRR-K8s      默认后端,支持 BFD、IPv6、多协议 BGP,功能最完整(Helm 默认)
native       纯 Go 实现的 BGP,只能在同主机上直接建会话,不支持 BFD,功能最少
FRR          传统 FRR 后端,官方已标注 deprecated,应尽快迁移到 FRR-K8s
```

```shell
# 安装界面上的选择方式
FRR-K8s      Helm 默认,无需额外参数
native       --set speaker.frr.enabled=false --set frrk8s.enabled=false
FRR(已废弃)  --set speaker.frr.enabled=true --set frrk8s.enabled=false
```

注意从 FRR 切到 FRR-K8s 会改变 Pod 拓扑与指标前缀(`metallb_` 变为 `frrk8s_`),监控告警需要同步调整。

### 安装

Helm 方式:

```shell
helm repo add metallb https://metallb.github.io/metallb
helm repo update

kubectl create namespace metallb-system
kubectl label --overwrite namespace metallb-system \
  pod-security.kubernetes.io/enforce=privileged \
  pod-security.kubernetes.io/audit=privileged \
  pod-security.kubernetes.io/warn=privileged

helm install metallb metallb/metallb --namespace metallb-system
kubectl -n metallb-system get pods -o wide
```

清单方式:

```shell
kubectl apply -f https://raw.githubusercontent.com/metallb/metallb/v0.16.1/config/manifests/metallb-native.yaml
```

speaker 需要主机网络与特权能力,namespace 上必须允许 privileged,否则 Pod 会因 Pod Security Admission 被拒绝创建。

### 地址池

IPAddressPool 决定「可以发哪些 IP」:

```shell
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: production
  namespace: metallb-system
spec:
  addresses:
    - 192.168.10.10-192.168.10.100
    - 203.0.113.0/28
  autoAssign: true          # 为 false 时必须由 Service 注解显式指定本池
  avoidBuggyIPs: true       # 跳过 .0/.255 这类历史上有问题的地址
```

BGP 模式下还可以按需声明聚合与团体属性:

Service 侧通过注解精确控制分配:

```shell
apiVersion: v1
kind: Service
metadata:
  name: web
  annotations:
    metallb.io/address-pool: production
    metallb.io/loadBalancerIPs: 192.168.10.20
spec:
  type: LoadBalancer
  externalTrafficPolicy: Local
  ports:
    - port: 80
      targetPort: 8080
```

```shell
旧的 metallb.universe.tf/address-pool 等注解为遗留写法,新部署请统一用 metallb.io/ 前缀
spec.loadBalancerIP 字段自 Kubernetes 1.24 起已废弃,双栈场景只能靠 metallb.io/loadBalancerIPs 注解
```

### L2 模式

L2 模式不需要网络设备配合,由选举出的一个节点负责应答该 VIP 的 ARP/NDP 请求:

```shell
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: l2-adv
  namespace: metallb-system
spec:
  ipAddressPools:
    - production
  interfaces:
    - eth0                  # 可选:限定用哪块网卡应答
```

要点:

```shell
1. VIP 必须与节点网卡在同一网段,否则 ARP 根本到不了
2. 只有一台节点应答,带宽上限就是那台机器的网卡
3. 节点故障时需要重新选举并重新广播 ARP,期间有秒级中断
4. 必须有 L2Advertisement 对象存在,只建 IPAddressPool 不会宣告
```

### BGP 模式

BGP 模式把 VIP 作为路由宣告给上游路由器(通常是对等建立到 ToR 交换机),由路由器做 ECMP 负载分摊:

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
  # bfdProfile: fast                 # 需要快速故障检测时引用 BFDProfile
  # ebgpMultihop: 5                  # 非直连对等时必须设置
  # sourceAddress: 10.0.0.10         # 多网卡时指定建会话的源地址
```

```shell
apiVersion: metallb.io/v1beta1
kind: BGPAdvertisement
metadata:
  name: bgp-adv
  namespace: metallb-system
spec:
  ipAddressPools:
    - production
  aggregationLength: 32
  communities:
    - 64512:100
```

两种模式的取舍:

```shell
L2   优点:零网络设备配合、配置简单
     缺点:单节点承载流量、故障切换有秒级中断、不能做真正的多路径负载
     适合:开发测试环境、小规模集群、没有 BGP 能力的机房

BGP  优点:天然 ECMP 多路径、切换快(配 BFD 可到亚秒级)、可跨网段
     缺点:必须上游路由器配合建立对等并放行 179,配置复杂度高
     适合:生产环境、需要横向扩展与快速故障切换的场景
```

`BFDProfile` 用于加速故障检测:

```shell
apiVersion: metallb.io/v1beta1
kind: BFDProfile
metadata:
  name: fast
  namespace: metallb-system
spec:
  receiveInterval: 300
  transmitInterval: 300
  detectMultiplier: 3
```

### 常用操作

```shell
# 分配的 IP 与服务是否匹配
kubectl get svc -A | grep LoadBalancer
kubectl describe svc web | grep -A5 Events

# 池的使用情况
kubectl get ipaddresspools -n metallb-system -o yaml
kubectl -n metallb-system get ipaddresspools.metallb.io

# 查看 controller / speaker 日志
kubectl -n metallb-system logs -l component=controller --tail=100
kubectl -n metallb-system logs -l component=speaker --tail=100

# 指标(默认 7472 端口)
kubectl -n metallb-system port-forward ds/speaker 7472:7472
curl -s http://127.0.0.1:7472/metrics | grep -E "bgp_session_up|addresses_in_use"

# 从宿主机验证 L2 宣告
arping -I eth0 192.168.10.20
sudo tcpdump -n -i eth0 arp src host 192.168.10.20

# BGP 会话状态(FRR-K8s 后端看 FRRNodeState;native 后端看日志)
kubectl -n metallb-system get frrnodestates
kubectl -n metallb-system logs -l component=speaker | grep -i "session"
```

### 排障

```shell
# 1. Service 一直是 EXTERNAL-IP <pending> —— 问题在 controller
kubectl -n metallb-system logs -l component=controller | tail -50
#    常见原因:没有匹配的 IPAddressPool(含选择器)、池内地址耗尽、
#    指定的 IP 不在任何池里;autoAssign: false 的池必须用注解显式指定

# 2. 分配到了 IP 但外部访问不通 —— 问题在 speaker
kubectl describe svc web | grep -A10 Events
#    speaker 只有在「该节点有可用端点」时才会宣告
kubectl get endpointslices -l kubernetes.io/service-name=web

# 3. L2 模式:确认只有一台节点应答 ARP
kubectl -n metallb-system logs -l component=speaker | grep -i arp
arping -I eth0 192.168.10.20

# 4. BGP 模式:确认有 BGPAdvertisement 存在,且会话是 Established
kubectl -n metallb-system get bgpadvertisements,bgppeers -o wide
kubectl -n metallb-system logs -l component=speaker | grep -i -E "BGP session|failed to send"

# 5. 配置是否被判定为无效(无效配置会保留上一份可用配置继续工作,只在日志里报错)
kubectl -n metallb-system logs -l component=speaker | grep -i "failed to parse"
curl -s http://127.0.0.1:7472/metrics | grep metallb_k8s_client_config_stale_bool

# 6. 控制平面节点不宣告:检查是否带了这个标签
kubectl get nodes --show-labels | grep exclude-from-external-load-balancers
```

### 注意

1. **L2 模式下必须存在 L2Advertisement 对象**。只创建 IPAddressPool 时 IP 会被分配,但没有任何节点去应答 ARP,表现就是「有 EXTERNAL-IP 但完全 ping 不通」,这一点与老版本 MetalLB 的配置模型不同。
2. **L2 模式不是真正的负载均衡**。同一个 VIP 始终由一台节点应答,带宽受限于该节点网卡,且节点故障时依赖 ARP 重新收敛,会有秒级中断;需要多路径与快速切换必须用 BGP。
3. **L2 的 VIP 必须与节点网卡同网段**。跨网段使用 L2 模式是行不通的,路由器不会替你转发一个未宣告的地址。
4. **BGP 模式必须上游路由器配合**。对端不配置 peer、不放行 TCP 179、或 AS 号写错,都会让 `EXTERNAL-IP` 分配成功但外部完全不可达 —— 这类问题要同时看集群侧与网络设备侧。
5. **kube-proxy 为 IPVS 模式时必须开 `ipvs.strictARP: true`**。否则节点上的 `kube-ipvs0` 会替 VIP 应答 ARP,导致 L2 模式行为异常;使用 kube-router 时默认已开启。
6. **`externalTrafficPolicy: Local` 会限制宣告范围**。只有本地有端点的节点才会宣告该服务,节点上没有 Pod 时该节点不宣告,配合 L2 模式可能造成「访问时通时不通」。
7. **控制平面节点默认不宣告**。带 `node.kubernetes.io/exclude-from-external-load-balancers` 标签的节点会被 MetalLB 跳过,单节点集群或希望控制平面参与宣告时,需要去掉该标签或给 speaker 加 `--ignore-exclude-lb`。
8. **无效配置不会让服务停止工作,只会静默回退**。MetalLB 校验失败时保留上一份可用配置并继续运行,唯一的线索在 controller/speaker 日志里,改完配置务必看日志确认已加载。
9. **地址池耗尽是最常见的线上事故**。池子用完时新建的 LoadBalancer Service 会一直 pending,而存量服务毫无异常;应对池使用量设置告警(`metallb_allocator_addresses_in_use_total`)。
10. **不要把 DHCP 池或已有设备的地址划进地址池**。MetalLB 不会探测地址是否被占用,分配到冲突地址的症状是随机丢包与连接重置,排查代价极高。
11. **speaker 是特权容器**,distroless 镜像里没有 shell,调试需要用 `kubectl debug --target=speaker` 注入临时容器,不要指望 `kubectl exec` 进去敲命令。
12. **v0.15 及更早版本已 EOL**,只支持最新次版本;升级前先读 release notes 中的破坏性变更(例如 BGP 后端默认值与指标前缀的改变)。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `service` — MetalLB所实现的LoadBalancer类型Service
- `bgp` — BGP宣告、对等配置与排障
- `kube-proxy` — IPVS模式下需配合strictARP
- `cni` — 承载Pod网络的底层插件
- `kubeadm` — 自建集群的安装工具

### 参考链接

- [MetalLB 官方文档](https://metallb.universe.tf/)
- [MetalLB 安装说明](https://metallb.universe.tf/installation/)
- [MetalLB 配置说明](https://metallb.universe.tf/configuration/)
- [MetalLB 使用说明](https://metallb.universe.tf/usage/)
- [MetalLB 排障指南](https://metallb.universe.tf/troubleshooting/)
