ipvs
===

Linux内核的IP虚拟服务器负载均衡,曾被kube-proxy用作Service转发模式

## 补充说明

**IPVS**(IP Virtual Server)是 Linux 内核自带的四层负载均衡实现,是 LVS(Linux Virtual Server)的核心。它用哈希表组织转发规则,查找复杂度接近 O(1),因此在大规模集群里比 iptables 的线性规则链快得多 —— 这正是 kube-proxy 在 1.8 引入 `ipvs` 模式的原因。

**重要前提:必须知道这个模式已经进入废弃流程。** Kubernetes 的 IPVS 模式由 KEP-5495 正式废弃,时间线如下:

```shell
v1.35        文档标注废弃,kube-proxy 以 ipvs 模式启动时打印弃用警告
v1.37        引入特性门控 KubeProxyIPVS(默认 true),可通过它了解后续计划
v1.40        门控默认翻转为 false,不显式开启时 kube-proxy 直接报错退出,列出可用模式(iptables、nftables)
v1.43        彻底移除 pkg/proxy/ipvs 代码
v1.46        移除 KubeProxyIPVS 门控本身
```

废弃的原因是内核 IPVS API 无法完整表达 Kubernetes Service 的语义,scheduler 之类的特性在 Kubernetes 里也基本没有实际作用。**新集群应直接使用 nftables(推荐)或 iptables 模式**;既有 IPVS 集群应尽早规划迁移。迁移方式就是把 kube-proxy ConfigMap 里的 `mode` 改掉并重启 DaemonSet。

kube-proxy 使用 IPVS 时的转发模型:

```shell
1. ClusterIP 会被绑定到节点上的 kube-ipvs0 这个 dummy 网卡
2. 每条 Service 在 IPVS 中表现为一个虚拟服务(Virtual Service)
3. 每个 Endpoint 表现为一个真实服务器(Real Server),转发模式为 NAT(masq)
4. 未命中 IPVS 的流量(如 NodePort 的某些路径)仍由 iptables 规则兜底
```

### 配置

kube-proxy 的配置在 `kube-system/kube-proxy` ConfigMap 的 `config.conf` 中:

```shell
apiVersion: kubeproxy.config.k8s.io/v1alpha1
kind: KubeProxyConfiguration
mode: ipvs
syncPeriod: 30s              # 顶层字段,重同步周期
minSyncPeriod: 0s            # 顶层字段,0 表示每次变更立即同步
ipvs:
  scheduler: rr              # 调度算法,默认 rr
  strictARP: true            # 配合 MetalLB 等依赖 ARP 的组件时必须开启
  excludeCIDRs: []           # 不接管的网段,避免与服务网段冲突
  tcpTimeout: 0s             # 0 表示沿用系统默认
  tcpFinTimeout: 0s
  udpTimeout: 0s
```

注意 `syncPeriod` 与 `minSyncPeriod` 属于顶层 `KubeProxyConfiguration`,不写在 `ipvs` 段里。

修改后必须重启 DaemonSet 才生效:

```shell
kubectl -n kube-system edit configmap kube-proxy
kubectl -n kube-system rollout restart daemonset kube-proxy
kubectl -n kube-system rollout status daemonset kube-proxy
```

### 内核模块

```shell
sudo modprobe ip_vs
sudo modprobe ip_vs_rr
sudo modprobe ip_vs_wrr
sudo modprobe ip_vs_sh
sudo modprobe nf_conntrack

# 持久化,避免重启后丢失
printf 'ip_vs\nip_vs_rr\nip_vs_wrr\nip_vs_sh\nnf_conntrack\n' | \
  sudo tee /etc/modules-load.d/ipvs.conf

# 确认已加载
lsmod | grep ip_vs
```

缺少模块时 kube-proxy 会启动失败或反复重启,日志里能看到 `Can't find ip_vs`、`Failed to load ip_vs` 之类的报错。

### 调度算法

```shell
rr     轮询,kube-proxy 的默认值
wrr    加权轮询,权重需要手工设置,而 Kubernetes 没有暴露权重的入口,实际等同 rr
lc     最少连接
wlc    加权最少连接,LVS 的默认算法
sh     源地址哈希,同一客户端固定到同一后端,用于会话保持
dh     目的地址哈希
mh     Maglev 一致性哈希,后端变化时影响面最小
sed    最短期望延迟
nq     永不排队
lblc / lblcr / fo / ovf   基于 locality 与溢出策略的变体,生产中用得很少
```

设置了 `sessionAffinity: ClientIP` 的 Service,kube-proxy 会把它的调度算法换成 `sh`,而不是使用 `scheduler` 里配置的值。

### 迁移到其他模式

```shell
# 1. 确认当前模式
kubectl -n kube-system get configmap kube-proxy \
  -o jsonpath='{.data.config\.conf}' | grep 'mode:'

# 2. 把 mode 改为 nftables(或 iptables)
kubectl -n kube-system edit configmap kube-proxy

# 3. 重启 DaemonSet 使配置生效
kubectl -n kube-system rollout restart daemonset kube-proxy
kubectl -n kube-system rollout status daemonset kube-proxy

# 4. 节点上清理 IPVS 残留
sudo ipvsadm -L -n | head
sudo ip link del kube-ipvs0
```

迁移期间存量连接会中断,建议按节点灰度:先腾空一个节点、观察 Service 转发正常后再继续。v1.40 之后若确实需要临时留在 ipvs 模式,必须显式开启特性门控(如 `--feature-gates=KubeProxyIPVS=true`),否则 kube-proxy 会直接报错退出。

### 常用操作

```shell
# 当前所有虚拟服务与后端
sudo ipvsadm -Ln

# 只过滤某个 Service
sudo ipvsadm -Ln | grep -A5 <cluster-ip>

# 转发统计与速率
sudo ipvsadm -Ln --stats
sudo ipvsadm -Ln --rate

# 当前连接
sudo ipvsadm -Lnc
sudo ipvsadm -Lnc | wc -l

# 超时设置
sudo ipvsadm -L --timeout

# 查看被绑定到 kube-ipvs0 上的 ClusterIP
ip addr show kube-ipvs0

# 手工验证某个 VIP 的连通性
curl -s -o /dev/null -w '%{http_code}\n' http://<cluster-ip>:<port>
```

### 排障

```shell
# 1. 内核模块是否加载
lsmod | grep -E "ip_vs|nf_conntrack"

# 2. kube-proxy 是否真的工作在 ipvs 模式
kubectl -n kube-system get configmap kube-proxy -o yaml | grep mode
kubectl -n kube-system logs -l k8s-app=kube-proxy | grep -i ipvs | head

# 3. VIP 是否被绑定(为空说明 kube-proxy 没接管)
ip addr show kube-ipvs0

# 4. 后端列表是否为空(为空说明 Endpoint 没匹配到 Pod)
sudo ipvsadm -Ln | grep -A3 <cluster-ip>
kubectl get endpointslices -l kubernetes.io/service-name=<svc>

# 5. 连接异常与 conntrack 表打满
sudo conntrack -C
cat /proc/sys/net/netfilter/nf_conntrack_max
dmesg | grep -i conntrack

# 6. 清理与重建(危险,仅在确认无业务流量时执行)
sudo ipvsadm -C
kubectl -n kube-system rollout restart daemonset kube-proxy
```

### 注意

1. **IPVS 模式已被官方废弃**,1.40 起默认不可用、1.43 起代码移除。新集群不要再选它,既有集群应尽早迁到 nftables 或 iptables —— 迁移只需改 `mode` 并重启 DaemonSet,但期间已有连接会中断。
2. **IPVS 模式仍依赖 iptables**。内核 IPVS API 无法表达全部 Service 语义(如 NodePort 的部分路径、SNAT 细节),kube-proxy 依然会写一批 iptables 规则,所以「换成 IPVS 就不需要 iptables 了」是误解。
3. **IPVS 模式下配合 MetalLB 的 L2 服务必须开 `ipvs.strictARP: true`**。否则 kube-ipvs0 会替 VIP 应答 ARP,导致 L2 宣告行为错乱,外部访问时通时不通。
4. **`sessionAffinity: ClientIP` 会把调度算法改成 `sh`**,`scheduler` 里的配置对该服务不再生效,排查「会话保持没生效」时先确认这一点。
5. **不要手工用 `ipvsadm` 增删条目**。kube-proxy 会在下次同步时覆盖,手工改动还可能让同步逻辑残留脏数据;调试完请用 `ipvsadm -C` 清空后重启 kube-proxy 重建。
6. **`ipvsadm -C` 会清空所有虚拟服务**,在运行业务的节点上执行等于瞬间切断所有 Service 访问,务必谨慎。
7. **conntrack 表大小是硬瓶颈**。IPVS 的 NAT 转发依赖连接跟踪,`nf_conntrack_max` 打满后表现为随机丢包与新建连接失败,日志中会出现 `nf_conntrack: table full, dropping packet`。
8. **IPVS 模式对内核版本与发行版补丁敏感**。部分发行版的内核缺少某些 `ip_vs_*` 模块,或 IPVS 的 conntrack 行为有差异,升级内核后应重新验证 Service 转发。
9. **`excludeCIDRs` 用错会引发环路**。把 Service 网段或 Pod 网段错误地排除,可能让流量绕过 IPVS 又回到转发路径上,表现为连接超时;没必要时不要动这个字段。
10. **IPVS 的转发统计不能当作业务监控**。`ipvsadm --stats` 只反映本节点的虚拟服务,且不区分连接的实际去向,需要按 Service 维度的指标请用 kube-proxy 暴露的 metrics。
11. **ClusterIP 依然 ping 不通**。这是虚拟 IP 的固有性质,与用哪种模式无关,请用 `curl <cluster-ip>:<port>` 验证。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kube-proxy` — Service转发的实现者,IPVS模式的宿主
- `service` — IPVS转发的对象
- `metallb` — L2模式下需配合strictARP
- `conntrack` — 连接跟踪表,IPVS NAT的前置依赖
- `kube-router` — 同样使用IPVS做Service代理的方案

### 参考链接

- [虚拟 IP 与 Service 代理](https://kubernetes.io/docs/reference/networking/virtual-ips/)
- [kube-proxy 命令行参考](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-proxy/)
- [KEP-5495:废弃 kube-proxy 的 ipvs 模式](https://github.com/kubernetes/enhancements/blob/master/keps/sig-network/5495-deprecate-ipvs-mode-in-kube-proxy/README.md)
- [IPVS 集群内负载均衡深入解析](https://kubernetes.io/blog/2018/07/09/ipvs-based-in-cluster-load-balancing-deep-dive/)
- [ipvsadm 手册](https://manpages.debian.org/unstable/ipvsadm/ipvsadm.8.en.html)
