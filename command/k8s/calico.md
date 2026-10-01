calico
===

Kubernetes主流的CNI网络插件与网络策略引擎,支持BGP路由与多种封装模式

## 补充说明

**Calico** 是应用最广的 Kubernetes 网络方案之一,由 Tigera 主导开发,同时提供三件事:Pod 之间的连通(CNI)、NetworkPolicy 的执行(策略引擎)、以及与物理网络对接的路由分发(BGP)。相比只做连通性的插件,Calico 的定位是「集群网络 + 网络安全 + 网络可视化」的完整方案,项目长期活跃(v3.x 稳定迭代,目前仍在持续发布新版本,未归档也未停止维护)。

Calico 的核心设计是**三层路由**:每个节点通过 BGP 把自己负责的 Pod 网段宣告出去,节点之间直接路由到对端 Pod,不做隧道封装 —— 这是性能最好的模式,但要求底层网络能承载这些路由。做不到时退化为 IPIP 或 VXLAN 封装,用一点性能换取对网络环境的低要求。

组件角色:

```shell
calico-node        DaemonSet,每个节点一个。内含 Felix(编程路由与 iptables/eBPF)、
                   BIRD(BGP 客户端)、confd(配置同步)
calico-typha       控制平面与节点之间的代理,大规模集群(>50 节点)才需要
calico-kube-controllers  监听 Kubernetes 资源,负责 IPAM 回收、策略同步等
calico-apiserver   提供 projectcalico.org API 的聚合层,operator 安装时才有
calicoctl         命令行工具,通过 datastore 读写 Calico 资源
```

安装方式有两种,命名空间不同,排障时先确认落在哪个里:

```shell
Tigera Operator 安装   命名空间 calico-system,通过 Installation 自定义资源下发配置(推荐)
清单安装(calico.yaml)  命名空间 kube-system,通过环境变量与 ConfigMap 配置
```

### 安装

Tigera Operator 方式:

```shell
# 1. 安装 operator
kubectl create -f https://raw.githubusercontent.com/projectcalico/calico/v3.31.3/manifests/tigera-operator.yaml

# 2. 查看 operator 是否就绪
kubectl get pods -n tigera-operator

# 3. 下发安装配置(网络段按需修改)
curl -O https://raw.githubusercontent.com/projectcalico/calico/v3.31.3/manifests/custom-resources.yaml
kubectl create -f custom-resources.yaml

# 4. 等待节点就绪
kubectl get pods -n calico-system -o wide
kubectl get tigerastatus
```

清单方式(适合小集群与离线环境):

```shell
kubectl apply -f https://raw.githubusercontent.com/projectcalico/calico/v3.31.3/manifests/calico.yaml

# 默认 Pod 网段为 192.168.0.0/16,与 kubeadm 的 --pod-network-cidr 不一致时需修改 CALICO_IPV4POOL_CIDR
kubectl -n kube-system get daemonset calico-node -o yaml | grep -A3 CALICO_IPV4POOL_CIDR
```

安装命令行工具:

```shell
curl -L https://github.com/projectcalico/calico/releases/download/v3.31.3/calicoctl-linux-amd64 -o calicoctl
chmod +x calicoctl && sudo mv calicoctl /usr/local/bin/

# 默认走 Kubernetes API(KDD)作为 datastore
export DATASTORE_TYPE=kubernetes
export KUBECONFIG=~/.kube/config
calicoctl get ippool
```

### IP 池与封装模式

```shell
# 查看实际生效的 IP 池(不要凭记忆猜默认值,不同安装方式默认不同)
calicoctl get ippool -o yaml
calicoctl ipam show

# 查看某个池里已分配/剩余地址
calicoctl ipam show --show-blocks
calicoctl ipam show --show-borrowed
```

IPPool 的关键字段:

```shell
apiVersion: projectcalico.org/v3
kind: IPPool
metadata:
  name: default-ipv4-ippool
spec:
  cidr: 192.168.0.0/16
  blockSize: 26            # 每个节点分到的块大小,IPv4 默认 26
  ipipMode: Never          # Never | Always | CrossSubnet
  vxlanMode: Never         # Never | Always | CrossSubnet
  natOutgoing: true        # 出集群流量做 SNAT
  nodeSelector: all()
```

三种数据面行为:

```shell
None(ipip/vxlan 均为 Never)  纯路由,BGP 宣告 Pod 网段,性能最好,要求底层网络可路由
Always                      全程封装,最简单,跨网段跨云都能用,有封装开销
CrossSubnet                 同子网内直连路由,跨子网才封装,折中方案,最常用
```

用 operator 安装时,同样的参数写在 `Installation` 资源的 `spec.calicoNetwork.ipPools[].encapsulation` 里,取值为 `IPIP`、`IPIPCrossSubnet`、`VXLAN`、`VXLANCrossSubnet`、`None` 之一;清单安装则通过 `calico-node` 上的 `CALICO_IPV4POOL_VXLAN`、`CALICO_IPV4POOL_IPIP` 等环境变量指定。

切换模式需要删除并重建 IPPool,期间会影响存量连接,生产环境应安排窗口并先腾空节点。

### BGP 模式

Calico 默认启用**节点间全互联(node-to-node mesh)**,每个节点与所有其他节点建立 eBGP 会话,默认 AS 号 64512。集群超过约 100 个节点时必须改用路由反射器,否则 BGP 会话数呈平方增长。

```shell
# 关闭全互联(改走路由反射器)
calicoctl patch bgpconfiguration default -p '{"spec": {"nodeToNodeMeshEnabled": false}}'

# 修改全局 AS 号
calicoctl patch bgpconfiguration default -p '{"spec": {"asNumber": "64513"}}'

# 与物理路由器建立对等
calicoctl apply -f - <<'EOF'
apiVersion: projectcalico.org/v3
kind: BGPPeer
metadata:
  name: peer-to-tor
spec:
  peerIP: 10.0.0.1
  asNumber: 65001
  nodeSelector: rack == 'rack-1'
  # sourceAddress: 10.0.0.10      # 多网卡时指定源地址
  # keepOriginalNextHop: true     # 保留原始下一跳,做流量对称
EOF
```

把节点标记为路由反射器:

```shell
calicoctl patch node my-node -p '{"spec": {"bgp": {"routeReflectorClusterID": "244.0.0.1"}}}'
kubectl annotate node my-node projectcalico.org/RouteReflectorClusterID=244.0.0.1

# 其他节点主动与反射器建会话
calicoctl apply -f - <<'EOF'
apiVersion: projectcalico.org/v3
kind: BGPPeer
metadata:
  name: peer-with-route-reflectors
spec:
  nodeSelector: all()
  peerSelector: route-reflector == 'true'
EOF
```

给节点打上 `route-reflector: 'true'` 标签后,`peerSelector` 才能选中它。注意设置 `routeReflectorClusterID` 会**立即**把该节点移出全互联,正在通过它转发的会话会中断。

### 网络策略

```shell
# 与 Kubernetes 原生 NetworkPolicy 并存,Calico 自己的对象额外支持全局范围与更细的语义
apiVersion: projectcalico.org/v3
kind: GlobalNetworkPolicy
metadata:
  name: deny-all-ingress
spec:
  selector: all()
  types:
    - Ingress
```

```shell
apiVersion: projectcalico.org/v3
kind: NetworkPolicy
metadata:
  name: allow-from-frontend
  namespace: default
spec:
  selector: app == 'backend'
  types:
    - Ingress
  ingress:
    - action: Allow
      source:
        selector: app == 'frontend'
      destination:
        ports:
          - 8080
```

此外还有 `GlobalNetworkSet`(跨命名空间的 IP 集合)、`HostEndpoint`(把节点网卡纳入策略)、`BGPFilter`(控制路由宣告)。优先级由 `order` 字段决定,数值越小越先匹配。

### 常用操作

```shell
# 资源查看
calicoctl get ippool -o wide
calicoctl get nodes
calicoctl get bgpconfiguration -o yaml
calicoctl get bgppeer -o yaml
calicoctl get felixconfiguration -o yaml

# BGP 会话状态(必须在目标节点宿主机上执行,不能进容器)
sudo calicoctl node status

# IPAM 排查
calicoctl ipam show
calicoctl ipam check

# 收集诊断包
calicoctl node diags

# 日志
kubectl -n calico-system logs -l k8s-app=calico-node -c calico-node --tail=100
kubectl -n kube-system logs -l k8s-app=calico-node --tail=100
```

### 排障

```shell
# 1. calico-node 是否全部就绪
kubectl -n calico-system get pods -o wide
kubectl -n calico-system describe pod <calico-node-pod> | tail -30

# 2. 节点上没有路由 / Pod 跨节点不通
ip route show proto bird
ip route | grep 192.168
ip -d link show | grep -E "tunl0|vxlan.calico"

# 3. BGP 会话是否建立(宿主机执行)
sudo calicoctl node status
#    期望全部 Established;出现 Connect/Active 说明对端不可达,OpenSent 多为 AS 号不匹配

# 4. 用 BIRD 看细节(进 calico-node 容器)
kubectl -n calico-system exec <calico-node-pod> -- birdcl show protocols
kubectl -n calico-system exec <calico-node-pod> -- birdcl show route

# 5. 策略是否误伤
calicoctl get networkpolicy -A
calicoctl get globalnetworkpolicy
kubectl -n calico-system logs -l k8s-app=calico-node -c calico-node | grep -i "policy"

# 6. 端口连通性(BGP 会话不通时)
nc -zv <对端节点IP> 179
nc -zvu <对端节点IP> 8472    # VXLAN
```

### 注意

1. **默认封装的默认值随安装方式与版本变化**,不要凭记忆判断。部署后第一件事是 `calicoctl get ippool -o yaml` 看 `ipipMode` / `vxlanMode` 的真实取值,再决定要不要改。
2. **IPIP 只支持 IPv4**,且需要底层网络放行 IP 协议号 4;Google Cloud 这类纯 L3 网络**不支持跨子网(cross-subnet)模式**,只能选全程封装或纯 BGP。
3. **纯 BGP 模式(封装为 Never)要求上游路由器配合**。路由器不与你建立对等,Pod 网段就只在集群内可路由,跨网段 Pod 互访会直接失败 —— 这不是 Calico 的 bug。
4. **VXLAN 使用 UDP 8472**(可改),防火墙与云安全组必须放行,否则症状是「同节点 Pod 通、跨节点 Pod 不通」。
5. **全互联 BGP 在 100 节点以上不可用**,会话数 O(n²) 会拖垮 BIRD;提前规划路由反射器,并注意设置反射器会立刻断开该节点的既有会话。
6. **切换封装模式需要重建 IPPool**,`Always` 改 `CrossSubnet` 这类操作会造成存量连接中断,必须在维护窗口内做,并先 drain 节点。
7. **`calicoctl node status` 只能在宿主机执行**,因为它要访问本机 BIRD 与内核;在容器里跑会报连不上 datastore 或找不到 socket。
8. **MTU 必须显式设置**。IPIP 减 20 字节、VXLAN 减 50 字节,叠加 WireGuard 还要再减 60;不设置的症状是 ping 与 DNS 正常,但 TLS 握手、大文件传输卡死。
9. **Calico 与 MetalLB 的 BGP 可以共存但要注意 AS 号**,两者若都宣告同一网段会造成路由冲突;让 MetalLB 用独立 AS 或独立地址池更安全。
10. **删除 IPPool 不会自动回收已分配的地址**,残留记录会让新节点拿不到块;清理前先用 `calicoctl ipam show` 确认没有 Pod 仍在使用。
11. **不要手工 `iptables -F`**。Calico 的路由与策略规则都在 iptables/eBPF 里,清空后集群网络立即中断,恢复需要重启全部 calico-node。
12. **calico-node 被 OOMKilled 会表现为随机网络故障**,节点上 BIRD 进程随之消失,路由会在几分钟后过期,排查时应先看容器的重启次数与资源限制。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `cni` — Calico所实现的容器网络接口规范
- `networkpolicy` — 策略语义与各CNI的支持情况
- `bgp` — Kubernetes语境下的BGP宣告与排障
- `kube-proxy` — 负责Service转发,与Calico职责分离
- `kubeadm` — 集群安装工具,需指定与Calico一致的Pod网段

### 参考链接

- [Calico 官方文档](https://docs.tigera.io/calico/latest/about/)
- [Calico 网络选型指南](https://docs.tigera.io/calico/latest/networking/determine-best-networking)
- [配置 VXLAN 与 IPIP 封装](https://docs.tigera.io/calico/latest/networking/configuring/vxlan-ipip)
- [配置 BGP 对等](https://docs.tigera.io/calico/latest/networking/configuring/bgp)
- [calicoctl 命令参考](https://docs.tigera.io/calico/latest/reference/calicoctl/overview)
