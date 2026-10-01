mtu
===

CNI封装导致的MTU问题:怎么算开销、怎么验证路径、怎么改与MSS钳制

## 补充说明

**MTU(最大传输单元)** 是一条链路单次能承载的最大 IP 包字节数,以太网默认 1500。问题出在**封装**:VXLAN、IP-in-IP、WireGuard 都要在原始包外面再套一层包头,套完之后的包会超过底层链路能承载的大小,于是被丢弃或分片。

Pod 网络里的 MTU 问题有一个极为鲜明的特征:

```shell
小包正常      ping、健康检查、TCP 建连都通
大包不通      上传大文件卡死、TLS 握手偶发失败、镜像层拉不下来
```

之所以是这个表现,是因为 MTU 只在包「大到一定程度」时才起作用。懂得这一点,排查方向立刻从「网络不通」收敛到「MTU 不对」。

### 怎么算:物理 MTU 减去封装开销

各封装的额外字节数(IPv4 外层):

```shell
IP-in-IP (IPIP)  20 字节     仅多一个外层 IPv4 头
VXLAN (IPv4)     50 字节     外层 IPv4 20 + UDP 8 + VXLAN 8 + 内层以太网 14
VXLAN (IPv6)     70 字节     外层 IPv6 40 + UDP 8 + VXLAN 8 + 内层以太网 14
WireGuard (IPv4) 60 字节     IPv4 20 + UDP 8 + WireGuard 32
WireGuard (IPv6) 80 字节     IPv6 40 + UDP 8 + WireGuard 32
Geneve           约 58 字节  基础头(bucket 内选项会变化,Cilium 按 58 计算)
IPsec            约 77 字节  按 128 位密钥估算,实际随算法与密钥长度变化
host-gw / 原生路由  0 字节    无封装,直接用底层 MTU
```

物理 MTU 为 1500 时,常见的 Pod MTU 结果:

```shell
无封装 / host-gw          1500
IP-in-IP                  1480    1500 - 20
VXLAN                     1450    1500 - 50
VXLAN(IPv6 外层)        1430    1500 - 70
Geneve                    1442    1500 - 58
VXLAN + WireGuard        1390 / 1370   按 60 或 80 计,取决于采用哪家的开销
VXLAN + IPsec             1373    1500 - 50 - 77
```

不同厂商对同一个封装的取值并不完全一致,**WireGuard 是最典型的一个**:

```shell
Calico 文档    IPv4 外层 60 字节,IPv6 外层 80 字节
Cilium 源码    常量 WireguardOverhead = 80(按 32 + 40 + 8 计算,
              外层头按 40 字节保守估计,不区分 v4/v6)
```

也就是说,**照抄不同项目文档里的数字会差 20 字节**。选型之后请以你实际使用的那个项目的文档为准,并以实测验证(见下一节)。

Cilium 的常量还给出了另外几个值:`TunnelOverheadIPv4 = 50`、`TunnelOverheadIPv6 = 70`、`DsrTunnelOverhead = 12`(GENEVE DSR 选项)、`IPIPv4Overhead = 20`、`IPIPv6Overhead = 48`、`EncryptionIPsecOverhead = 77`。

### 怎么验证

**第一步:看接口的 MTU。**

```shell
# 节点上的封装接口
ip link show | grep -E "flannel|cilium_vxlan|tunl0|vxlan|geneve"
ip -d link show flannel.1
ip -d link show cilium_vxlan
ip link show tunl0

# Pod 内的网卡
kubectl exec -it <pod> -- ip link show eth0
kubectl exec -it <pod> -- cat /sys/class/net/eth0/mtu

# 节点上的 veth 对
ip link show | grep -E "^[0-9]+: (veth|lxc)"
```

**第二步:看路由的 MTU。** 隧穿与加密模式下,Cilium 会把开销扣在**路由**上而不是设备上:

```shell
kubectl exec -it <pod> -- ip route show default
# default via 10.244.0.1 dev eth0 mtu 1380      ← 这个 mtu 才是实际生效值

kubectl exec -it <pod> -- ip route get 8.8.8.8

# 节点上
ip route show
```

**遇到「Pod 的 eth0 MTU 是 1460,但路由显示 1380」不要困惑** —— 这是正常的,Cilium 在 WireGuard 场景下就是这样设计的:设备 MTU 保持底层链路的 MTU,开销扣在路由 MTU 上。判断实际可用大小时要看**路由上的 mtu**。

**第三步:用 ping 实测路径能承载多少字节。**这是最可靠的验证方式:

```shell
# -M do 禁止分片,-s 指定 ICMP 载荷大小(不含 28 字节的 IP+ICMP 头)
kubectl exec -it <pod> -- ping -M do -s 1472 -c 3 <对端IP>   # 1500 - 28
kubectl exec -it <pod> -- ping -M do -s 1422 -c 3 <对端IP>   # 1450 - 28,VXLAN
kubectl exec -it <pod> -- ping -M do -s 1452 -c 3 <对端IP>   # 1480 - 28,IPIP
kubectl exec -it <pod> -- ping -M do -s 1352 -c 3 <对端IP>   # 1380 - 28
```

```shell
# 二分法找临界值
for s in 1472 1442 1400 1350 1300; do
  echo -n "$s: "
  ping -M do -s $s -c 1 -W 2 <对端IP> >/dev/null 2>&1 && echo OK || echo FAIL
done
```

**不要在 Pod 内部自己 ping 自己** —— 那走的是 loopback,MTU 是 65536,永远成功。必须**跨节点** ping。

**第四步:看 TCP 的 MSS。**

```shell
# 建一条连接后看实际协商的 MSS
ss -ti | grep -A1 ESTAB

# 抓包看 SYN 里的 MSS 选项
tcpdump -i eth0 -nn -v 'tcp[tcpflags] & tcp-syn != 0'
```

**第五步:确认 ICMP 有没有被挡。**

```shell
# 排查 PMTUD 黑洞:路径上是否有 ICMP type 3 code 4(fragmentation needed)
tcpdump -i any -nn 'icmp and icmp[0] = 3 and icmp[1] = 4'

# 路径 MTU 探测
tracepath <对端IP>
tracepath -n <对端IP>
```

### 为什么大包不通:PMTUD 黑洞

```shell
1. TCP 建连时双方协商 MSS,依据是本地接口 MTU
2. 中间路径的 MTU 更小,包发出去超限
3. 转发设备应该回一个 ICMP "fragmentation needed"(type 3 code 4)
4. 如果这个 ICMP 被防火墙/安全组挡掉,发送方永远收不到通知
5. 包不断重传、不断被丢 —— 连接挂住,直到超时
```

这就是**PMTUD(路径 MTU 发现)黑洞**。表现是「连得上,但一传数据就卡死」。云环境中安全组默认往往不放通 ICMP,所以黑洞很常见。

### TCP MSS 钳制

比改 MTU 更直接的解法是**在 SYN 包里改 MSS**,让双方从一开始就用小一点的段:

```shell
# 节点上手工加规则(回程方向也要加)
iptables -t mangle -A FORWARD -p tcp --tcp-flags SYN,RST SYN \
  -j TCPMSS --clamp-mss-to-pmtu

iptables -t mangle -A FORWARD -p tcp --tcp-flags SYN,RST SYN \
  -j TCPMSS --set-mss 1360
```

```shell
# 检查现有规则
iptables -t mangle -L FORWARD -n -v | grep TCPMSS
nft list ruleset | grep -i mss
```

**大多数 CNI 已经自动做了这件事**(Calico、Cilium、Flannel 都会在自己的规则链里钳制 MSS),所以通常不需要手工加。但要注意两点:MSS 钳制**只对 TCP 生效**,UDP 与 ICMP 不受保护;而且它只对**经过该节点转发**的流量生效。

### 怎么改 MTU

**Calico:**

```shell
# Operator 安装
kubectl patch installation.operator.tigera.io default --type merge \
  -p '{"spec":{"calicoNetwork":{"mtu":1440}}}'

# Manifest 安装
kubectl patch configmap/calico-config -n kube-system --type merge \
  -p '{"data":{"veth_mtu": "1440"}}'
kubectl rollout restart daemonset calico-node -n kube-system
```

Calico 默认会自动探测:依据节点网卡 MTU 与启用的封装模式(vxlanEnabled / ipipEnabled / wireguardEnabled / wireguardEnabledV6)算出合适的值。

**Cilium:**

```shell
helm upgrade cilium oci://quay.io/cilium/charts/cilium 1.20.2 \
  --namespace kube-system --reuse-values --set MTU=1450

# 或改 ConfigMap
kubectl -n kube-system edit configmap cilium-config   # mtu: "1450"
kubectl -n kube-system rollout restart daemonset cilium
```

Cilium 的 `MTU` 值**不会改动宿主网卡(eth0/ens0)的 MTU**,改的是 `cilium_net@cilium_host`、`cilium_host@cilium_net`、`cilium_vxlan` 与 `lxc_health` 这些接口。设为 0 表示自动探测。

**Flannel:**

```shell
# net-conf.json 或 helm values 里指定 Backend.MTU
{
  "Network": "10.244.0.0/16",
  "Backend": { "Type": "vxlan", "MTU": 1400 }
}
kubectl -n kube-system edit configmap kube-flannel-cfg
kubectl -n kube-system rollout restart daemonset kube-flannel-ds
```

Flannel 会把结果写进 `/run/flannel/subnet.env` 的 `FLANNEL_MTU`,CNI 插件读它来设置 Pod 网卡;CNI 配置里显式的 `delegate.mtu` 会覆盖它。

```shell
# 确认 Flannel 实际下发值
cat /run/flannel/subnet.env
ip link show flannel.1
```

### 云环境的实际 MTU

不要假设底层就是 1500:

```shell
GCE           1460    google 的 MTU 不是 1500
AKS           1400    网卡报 1500,但实际承载只有 1400
AWS Jumbo     9001    开启巨型帧后
OpenStack     1450    底层已是 VXLAN 时
```

AKS 尤其要注意:因为 WireGuard 会给包打上 DF 位,AKS 上必须按 1400 再减 60(IPv6 减 80)。

### 注意

1. **「小包通、大包不通」就是 MTU 问题**,不要再往 DNS、策略、conntrack 上找。典型表现:`ping` 通、TCP 建连通,但一传数据就卡住;或者换小文件正常、大文件必挂。
2. **必须在 Pod 里 ping,而且必须跨节点**。Pod 内 ping 自己走 loopback(MTU 65536)永远成功;同节点内 veth 直连也测不出封装开销。只有跨节点的路径才真正经过隧道。
3. **`ping -s` 的值要减去 28**。`-s` 是 ICMP 载荷长度,加上 20 字节 IP 头与 8 字节 ICMP 头才是实际 IP 包大小。验证 1500 的链路要 `-s 1472`,验证 1450 的 Pod MTU 要 `-s 1422`。少减 28 会得出错误结论。
4. **Cilium 的开销可能扣在「路由 MTU」上而不是设备 MTU 上**。Pod 里 `ip link show eth0` 显示 1460 而 `ip route show default` 显示 `mtu 1380` 是正常的。判断实际可用值要看路由,不能只看网卡。
5. **WireGuard 的开销,Metric 取值各家不同**。Calico 文档写 IPv4 外层 60 字节,Cilium 源码的 `WireguardOverhead` 常量是 80。照抄错的数字会差 20 字节,导致「按文档配完了还是不通」。以实测为准。
6. **PMTUD 黑洞的根源是 ICMP 被挡**。丢包不是因为包太大本身,而是因为「包太大」的通知(ICMP type 3 code 4)没能回到发送方。云安全组、防火墙默认常常不放通 ICMP —— 排查时务必确认这条路径是通的。
7. **MSS 钳制只保护 TCP**。UDP 没有 MSS 协商机制,隧道对 UDP 是硬性的:超过 MTU 的 UDP 包只能靠 IP 分片或被丢弃。跑 QUIC、VXLAN over UDP、自研 UDP 协议的服务要特别留意,必须让应用层自己控制包大小。
8. **改 MTU 只对新创建的 Pod 生效**。Calico 的官方说明是「更新后的 MTU 只作用于新工作负载」;已有的 Pod veth MTU 不会变,必须重建 Pod(不是重启容器)。验证时要新建 Pod。
9. **改了 Flannel 的 MTU 还要检查已有的 `flannel.1` 设备**。某些版本会复用已存在的设备而不更新它的 MTU,导致 `FLANNEL_MTU` 与实际设备不一致,需要手工 `ip link set dev flannel.1 mtu <值>` 或干脆删掉设备让它重建。
10. **封装的层数可以叠加,开销也要叠加**。VXLAN 之上再跑 WireGuard 就是 50 + 60,如果这些还跑在一条 MTU 不是 1500 的链路上(比如 OpenStack 的 1450),结果是 1450 - 110 = 1340。逐层相减,不要只算一层。
11. **不要把 MTU 调得「比需要的更小」当作保险**。MTU 过小会显著降低吞吐(同样的数据需要更多包、更多中断),并且会让 PMTUD 失去意义。目标是「路径能承载的最大值」。
12. **`tracepath` 与 `traceroute` 的结果要交叉验证**。`tracepath` 会做路径 MTU 探测,但依赖 ICMP 回包;如果 ICMP 被部分过滤,结果会误导。配合 `ping -M do` 的二分法更可靠。
13. **检查中间设备**。即使两端 Pod 的 MTU 都配对了,中间的负载均衡、VPN 网关、隧道设备也可能有更小的 MTU。`ping -M do` 二分法测的是端到端真实路径,这也是它比看配置更可靠的原因。

### 相关命令

- `network-troubleshooting` — MTU在整体排查中的位置
- `cni` — 封装模式的来源
- `calico` — vxlan/ipip/wireguard 的 MTU 配置
- `cilium` — Geneve/VXLAN/WireGuard 的 MTU 模型
- `flannel` — vxlan 后端的 MTU 下发
- `conntrack` — 另一类「老连接正常、新连接异常」的问题
- `ksniff` — 抓包确认大包是否被丢弃

### 参考链接

- [Calico 配置 MTU](https://docs.tigera.io/calico/latest/networking/configuring/mtu)
- [Cilium MTU 计算源码(pkg/mtu)](https://github.com/cilium/cilium/blob/main/pkg/mtu/mtu.go)
- [Cilium Helm values(MTU)](https://docs.cilium.io/en/stable/helm-values/)
- [Flannel 配置说明](https://github.com/flannel-io/flannel/blob/master/Documentation/configuration.md)
- [RFC 1191 路径 MTU 发现](https://www.rfc-editor.org/rfc/rfc1191)
