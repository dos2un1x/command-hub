flannel
===

Kubernetes最简单常用的Overlay网络插件,专注Pod连通性

## 补充说明

**Flannel** 是最早、也最容易上手的 Kubernetes 网络插件之一,由 CoreOS 团队发起,现由 flannel-io 社区维护。它的目标非常克制:**只解决 Pod 跨节点互通**,不碰安全策略、不碰 Service 转发、不碰 BGP 对接。正因如此它的部署与排障都远比 Calico、Cilium 简单,至今仍是很多自建集群与发行版(k3s、RKE、部分云厂商的默认网络)的首选。

项目目前**仍在维护**,稳定线为 0.28.x,2026 年仍保持数月一次的补丁发布节奏,未归档也未停止维护。

Flannel 的工作模型是「**给每个节点分一块子网,再想办法把这台机器上的这块子网告诉别人**」:

```shell
1. flanneld 从 Kubernetes API(或 etcd)申请一个 Subnet,例如 10.244.1.0/24
2. 把结果写到 /run/flannel/subnet.env,并生成 /etc/cni/net.d/10-flannel.conflist
3. 由 CNI 插件(bridge + flannel)把地址配给 Pod
4. 节点之间靠 VXLAN 隧道(默认)或直接路由转发跨节点流量
```

**Flannel 默认不支持 NetworkPolicy**,创建策略对象不会报错,但也不会有任何效果 —— 这是使用 Flannel 最需要警惕的一点。

### 安装

清单方式(最常用):

```shell
kubectl apply -f https://github.com/flannel-io/flannel/releases/latest/download/kube-flannel.yml

# 确认 Pod 与网段
kubectl -n kube-flannel get pods -o wide
kubectl -n kube-flannel get configmap kube-flannel-cfg -o yaml
```

Helm 方式:

```shell
kubectl create ns kube-flannel
kubectl label --overwrite ns kube-flannel pod-security.kubernetes.io/enforce=privileged

helm repo add flannel https://flannel-io.github.io/flannel/
helm install flannel --set podCidr="10.244.0.0/16" --namespace kube-flannel flannel/flannel
```

清单里的 Pod 网段必须与 `kubeadm init --pod-network-cidr` 保持一致,否则节点之间会互相路由到不存在的网段。

前置条件:

```shell
# 内核模块
sudo modprobe br_netfilter
sudo modprobe overlay

# 内核参数
sudo sysctl -w net.bridge.bridge-nf-call-iptables=1
sudo sysctl -w net.ipv4.ip_forward=1

# 防火墙放行 VXLAN(默认 UDP 8472)
sudo firewall-cmd --permanent --zone=public --add-port=8472/udp
```

### 配置文件

配置放在 `kube-flannel` 命名空间的 ConfigMap `kube-flannel-cfg` 中,字段为 `net-conf.json`:

```shell
{
  "Network": "10.244.0.0/16",
  "EnableIPv4": true,
  "EnableIPv6": false,
  "Backend": {
    "Type": "vxlan"
  }
}
```

双栈配置:

```shell
{
  "EnableIPv4": true,
  "EnableIPv6": true,
  "Network": "10.244.0.0/16",
  "IPv6Network": "2001:cafe:42:0::/56",
  "Backend": {
    "Type": "vxlan",
    "DirectRouting": true
  }
}
```

可用的键:

```shell
Network / IPv6Network      整个集群的 Pod 网段,必须与 kubeadm 的 --pod-network-cidr 匹配
EnableIPv4 / EnableIPv6    协议栈开关,IPv4 默认开
SubnetLen                  每个节点分到的子网前缀长度,默认 24
SubnetMin / SubnetMax      子网分配范围,想留出固定段时使用
Backend.Type               后端类型,决定数据包怎么跨节点走
Backend.<其他键>           各后端自己的参数,见下节
EnableNFTables             实验性开关,把 MASQUERADE 从 iptables 换成 nftables
```

### 后端类型

```shell
vxlan       默认。内核 VXLAN 封装,Port 默认 8472,VNI 默认 1
            DirectRouting: true 时同子网内直连、跨子网才封装(要求底层 L2 可达)
            GBP、Learning、MTU 均为 Linux 侧可调项
host-gw     不做封装,直接写对端路由。性能最好,但要求所有节点在同一个二层网络里
wireguard   内核 WireGuard 加密,ListenPort 默认 51820,可选 PSK
            Mode 取值 separate(默认)、auto、ipv4、ipv6;内核低于 5.6 需额外装模块
udp         用户态封装,Port 默认 8285。仅用于调试或不支持 VXLAN 的老内核
ipip        IP-in-IP 封装,开销最小,但只支持 IPv4
ipsec       Strongswan 提供 IKEv2 加密,PSK 至少 96 字符,需放行 ESP 与 UDP 500/4500
alloc       只做地址分配,不转发数据包
tencent-vpc 腾讯云 VPC 路由表模式,路由表条目上限 50
```

选择建议:多数环境用默认的 `vxlan`;机房内所有节点同一网段、追求性能时用 `host-gw`;需要加密时用 `wireguard`;`udp` 只在排障时临时使用。

切换后端要修改 ConfigMap 中的 `Backend.Type`,然后**重启 DaemonSet** —— 运行时切换后端不受支持:

```shell
kubectl -n kube-flannel edit configmap kube-flannel-cfg
kubectl -n kube-flannel rollout restart daemonset kube-flannel-ds
```

### 常用操作

```shell
# 运行状态
kubectl -n kube-flannel get pods -o wide
kubectl -n kube-flannel logs -l app=flannel --tail=100

# 节点拿到的子网(flanneld 写入的运行时信息)
kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.podCIDR}{"\n"}{end}'
cat /run/flannel/subnet.env

# 节点上的 flannel 注解
kubectl get node <node-name> -o jsonpath='{.metadata.annotations}' | tr ',' '\n' | grep flannel

# 网络设备与路由
ip -d link show flannel.1
ip route | grep flannel
bridge fdb show dev flannel.1

# CNI 配置
cat /etc/cni/net.d/10-flannel.conflist

# 跨节点连通性测试
kubectl run test-a --image=nicolaka/netshoot --overrides='{"spec":{"nodeName":"node1"}}' -it --rm -- sh
ping <另一节点上的PodIP>
```

### 启用 NetworkPolicy

Flannel 自身不实现策略,但从 0.25.5 起可以用 Helm 附带部署 Kubernetes SIGs 的 `kube-network-policies` 控制器:

```shell
helm install flannel --set netpol.enabled=true --namespace kube-flannel flannel/flannel
```

开启后 flannel Pod 里会多出一个容器负责策略。也可以选择另一条更常见的路线:用 Flannel 做连通性,把策略交给别的组件,或直接换成 Calico、Cilium。

### 排障

```shell
# 1. Pod 起不来且卡在 ContainerCreating
kubectl -n kube-flannel get pods
journalctl -u kubelet -n 100 | grep -i flannel

# 2. 节点间不通:先确认隧道接口存在
ip -d link show flannel.1
ip route | grep 10.244

# 3. 确认 flanneld 是否成功申请到子网
kubectl -n kube-flannel logs <flannel-pod> | grep -i "subnet\|lease"

# 4. VXLAN 端口是否可达(跨节点不通的常见原因)
nc -zvu <对端节点IP> 8472
sudo tcpdump -i any -n udp port 8472

# 5. 多网卡机器上确认选了正确的出口网卡
kubectl -n kube-flannel get ds kube-flannel-ds -o yaml | grep -A3 "\-\-iface"
ip route get <对端节点IP>

# 6. MTU 不匹配(小包通、大包不通)
cat /run/flannel/subnet.env | grep MTU
ping -M do -s 1400 <对端PodIP>
```

多网卡节点必须显式指定网卡,否则 flanneld 可能选到管理网以外的接口:

```shell
kubectl -n kube-flannel patch ds kube-flannel-ds --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--iface=eth0"}]'
```

### 注意

1. **Flannel 默认不支持 NetworkPolicy**。策略对象能创建成功但完全不生效,属于最危险的「静默失效」;需要策略就必须启用 `netpol.enabled` 或换用 Calico、Cilium、Antrea。
2. **切换后端不能在运行时进行**。官方明确说明后端不应在运行时更改,修改 `Backend.Type` 后必须重启 DaemonSet,并且要在维护窗口内做,存量连接会中断。
3. **`host-gw` 要求所有节点在同一二层网络**。跨网段、跨可用区使用会直接不通,却不会有明显报错,只表现为部分节点之间 ping 不通。
4. **`--iface` 在多网卡环境下必须显式指定**。默认自动探测在多网卡、有 Docker 网桥或 VPN 接口的机器上极易选错,症状是「节点登录得上但 Pod 网络不通」。
5. **VXLAN 需要放行 UDP 8472**,云环境还要检查安全组;Windows 节点的 VXLAN 端口必须为 4789,与 Linux 默认值不同。
6. **Pod 网段必须与 kubeadm 的 `--pod-network-cidr` 一致**,两者不一致时 Pod 能拿到 IP,但跨节点路由会指向错误的网段,新节点加入后故障才会暴露。
7. **MTU 必须比底层网卡小 50 字节(VXLAN)**,不改 `MTU` 的典型症状是 ping 通、DNS 正常、TLS 握手卡住或大文件传不动。
8. **节点数量与子网大小要匹配**。默认 `SubnetLen: 24` 时,`10.244.0.0/16` 最多容纳 256 个节点;节点规模超出后新节点申请不到子网,`flanneld` 会持续报错。
9. **Flannel 不处理 Service**,ClusterIP 不通时应该查 kube-proxy,而不是折腾 flannel 的配置。
10. **删除 Flannel 换用其他 CNI 时要清理干净**:删掉 DaemonSet、ConfigMap、`/etc/cni/net.d/10-flannel.conflist`、`/run/flannel/` 与节点上的 `flannel.1`、`cni0` 设备,否则新 CNI 可能不生效。
11. **`wireguard` 后端在低版本内核上不可用**。内核低于 5.6 需要额外安装 WireGuard 模块,失败时 flanneld 会退出,节点随即 NotReady。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `cni` — Flannel所实现的容器网络接口规范
- `networkpolicy` — Flannel默认不支持,需额外组件
- `calico` — 需要策略能力时可替换Flannel的方案
- `cilium` — 需要策略与可观测性时可替换Flannel的方案
- `kube-proxy` — 与Flannel分工不同的Service实现者

### 参考链接

- [Flannel 项目仓库](https://github.com/flannel-io/flannel)
- [Flannel 配置说明](https://github.com/flannel-io/flannel/blob/master/Documentation/configuration.md)
- [Flannel 后端说明](https://github.com/flannel-io/flannel/blob/master/Documentation/backends.md)
- [Flannel 网络策略说明](https://github.com/flannel-io/flannel/blob/master/Documentation/netpol.md)
- [kube-network-policies 控制器](https://github.com/kubernetes-sigs/kube-network-policies)
