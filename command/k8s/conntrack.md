conntrack
===

连接跟踪表:为何表满之后新连接被丢、老连接却正常,以及怎么查与怎么调

## 补充说明

**conntrack(连接跟踪)** 是 Linux 内核 netfilter 的一部分,记录「这条连接的包从哪里来、到哪里去、要不要做 NAT」。它用一张哈希表存这些状态,表项由 `nf_conntrack` 内核模块维护。

Kubernetes 的 Service 实现**重度依赖它**:kube-proxy 用 DNAT 规则把 ClusterIP 换成 Pod IP,而这条 NAT 关系必须被记住,回包才能改回来。每一个经 Service 的 TCP/UDP 连接、每一次 NodePort 访问,都会在表里占一个表项。

**表项不是免费的**:每个表项约占 300 字节内核内存,并且有各自的老化时间。当表被占满,**内核会丢弃无法建立表项的新包**,大量新连接直接超时 —— 而已经建立连接的流量完全正常。这个「老连接好、新连接坏」的特征,是 conntrack 表满最典型的辨识点。

### 关键文件

```shell
/proc/sys/net/netfilter/nf_conntrack_count        # 当前表项数
/proc/sys/net/netfilter/nf_conntrack_max          # 表容量上限
/proc/sys/net/netfilter/nf_conntrack_buckets      # 哈希桶数
/proc/sys/net/netfilter/nf_conntrack_tcp_timeout_established
/proc/sys/net/netfilter/nf_conntrack_tcp_timeout_close_wait
/proc/sys/net/netfilter/nf_conntrack_udp_timeout
/proc/sys/net/netfilter/nf_conntrack_udp_timeout_stream
```

用 sysctl 读写(注意 `net.netfilter.` 前缀):

```shell
sysctl net.netfilter.nf_conntrack_count
sysctl net.netfilter.nf_conntrack_max
sysctl -w net.netfilter.nf_conntrack_max=1048576
```

### 查看与诊断

```shell
# 当前用量与上限(第一眼就该看这两个数)
cat /proc/sys/net/netfilter/nf_conntrack_count
cat /proc/sys/net/netfilter/nf_conntrack_max

# 按协议与状态的统计,含错误计数
conntrack -S

# 只看表项数
conntrack -C

# 列出表项(大表上极慢,先看 count 再决定)
conntrack -L
conntrack -L -p tcp --state ESTABLISHED
conntrack -L -d 10.96.0.0/12          # 只看指向 ClusterIP 网段的

# 实时事件流(观察新建/销毁)
conntrack -E

# 是否有丢包:这是最关键的一步
conntrack -S | grep -E "insert_failed|drop|early_drop"
dmesg -T | grep -i "nf_conntrack"
```

`insert_failed` 增长说明「包到达时无法插入表项」,`drop` 增长说明「表项已满被丢弃」—— 表满的确切证据在内核日志里:

```shell
nf_conntrack: table full, dropping packet
```

**这条信息只会出现在 `dmesg` / 内核日志里,不会出现在任何业务日志中**,这是它最容易被漏掉的原因。

### kube-proxy 的相关参数

kube-proxy 会在启动时按下面的参数去设置内核的 conntrack 上限:

```shell
--conntrack-max-per-core              默认 32768
    每个 CPU 核心最多跟踪多少 NAT 连接
    设为 0 表示「保持现状」,并忽略 --conntrack-min

--conntrack-min                       默认 131072
    无论每核上限多少,至少分配这么多表项
    (maxPerCore=0 时本项无效)

--conntrack-tcp-timeout-established   默认 24h0m0s
    已建立 TCP 连接的空闲超时
--conntrack-tcp-timeout-close-wait    默认 1h0m0s
    CLOSE_WAIT 状态表项的空闲超时
--conntrack-udp-timeout               默认未设置(0 = 保持现状)
    UNREPLIED 状态的 UDP 表项空闲超时
--conntrack-udp-timeout-stream        默认未设置(0 = 保持现状)
    ASSURED 状态的 UDP 表项空闲超时
--conntrack-tcp-be-liberal            默认未设置
    开启后乱序序号不再被标记为 INVALID
```

这些参数的配置文件写法(新版 kube-proxy 把 conntrack 放在了 `linux` 段下):

```shell
apiVersion: kubeproxy.config.k8s.io/v1alpha1
kind: KubeProxyConfiguration
linux:
  conntrack:
    maxPerCore: 32768
    min: 131072
    tcpEstablishedTimeout: 24h0m0s
    tcpCloseWaitTimeout: 1h0m0s
    udpTimeout: 30s
    udpStreamTimeout: 120s
    tcpBeLiberal: false
```

**实际上限怎么算:** 大致是 `maxPerCore × CPU 核数`,但不会低于 `min`。例如 8 核机器上 `32768 × 8 = 262144`,高于 `min` 的 131072,所以最终是 262144。核数少的机器(如 2 核)算出来只有 65536,会被 `min` 抬到 131072。

### 一个典型的表满现场

```shell
# 现象
应用大量报 "connection timed out",但已有的长连接完全正常
节点上 ping 通、curl 到已建立的连接也通,新建连接全部超时

# 定位
dmesg -T | tail -50
#   nf_conntrack: table full, dropping packet

sysctl net.netfilter.nf_conntrack_count net.netfilter.nf_conntrack_max
#   net.netfilter.nf_conntrack_count = 131072
#   net.netfilter.nf_conntrack_max = 131072      ← 顶格了

conntrack -S | grep -E "insert_failed|drop"

# 看谁在占用表项
conntrack -L -p tcp --state ESTABLISHED | awk '{print $5}' | sort | uniq -c | sort -rn | head
```

### 调优

```shell
# 提高容量(节点上临时生效,重启会丢)
sysctl -w net.netfilter.nf_conntrack_max=1048576

# 同时调大哈希桶,避免链表过长导致查找变慢
# 经验值:buckets ≈ max / 4
sysctl -w net.netfilter.nf_conntrack_buckets=262144

# 缩短 TCP 空闲超时,让表项更早回收
# 注意:kube-proxy 会在启动时把它改回去,见「注意」第 2 条
sysctl -w net.netfilter.nf_conntrack_tcp_timeout_established=86400

# 持久化(不同发行版路径不同)
# /etc/sysctl.d/99-conntrack.conf
net.netfilter.nf_conntrack_max = 1048576
net.netfilter.nf_conntrack_buckets = 262144
```

kube-proxy 侧:

```shell
--conntrack-max-per-core=65536
--conntrack-min=262144
--conntrack-tcp-timeout-established=1h
--conntrack-tcp-timeout-close-wait=30m
```

```shell
# 生效方式:改 kube-proxy 的 ConfigMap 后重启
kubectl -n kube-system edit configmap kube-proxy
kubectl -n kube-system rollout restart daemonset kube-proxy
```

### 监控

```shell
# node-exporter 暴露的指标
node_nf_conntrack_entries
node_nf_conntrack_entries_limit

# 用率告警(超过 80% 就该处理)
node_nf_conntrack_entries / node_nf_conntrack_entries_limit > 0.8
```

```shell
# 没有 node-exporter 时用文本采集器
cat /proc/sys/net/netfilter/nf_conntrack_count
cat /proc/sys/net/netfilter/nf_conntrack_max
```

### 注意

1. **表满的表现是「新连接被丢、老连接正常」**,这是它与其他网络故障最本质的区别。节点没挂、CNI 没挂、带宽没满,只是建不了新连接。看到这个组合就该立刻去 `dmesg` 里找 `table full`。
2. **kube-proxy 只在启动时设置 `nf_conntrack_max`**。这意味着运行时手工 `sysctl -w` 改大的值,在 kube-proxy 重启后会按 `--conntrack-max-per-core` 重算并覆盖回去。要持久生效必须同时调 kube-proxy 的参数,或让它彻底不管(`--conntrack-max-per-core=0`)再交给 sysctl.d 管理。
3. **`--conntrack-max-per-core` 是「每核」,不是总数**。实际上限约等于它乘以 CPU 核数。按总数去填这个参数会得到一个大出好几倍的值,浪费内存;反之在小规格节点上会算出一个比预期小得多的上限。
4. **`--conntrack-min` 是下限兜底,不是上限**。它的作用是保证小规格节点也有足够表项。注意 `--conntrack-max-per-core=0` 时它会被忽略 —— 这时内核的上限完全不受 kube-proxy 控制。
5. **`--conntrack-tcp-timeout-established` 的默认值是 24 小时**。这是 kube-proxy 的历史默认值,意味着一条空闲的已建立连接会占着表项整整一天。高并发短连接场景下,把它降到 1 小时能显著缓解表满。
6. **这些 conntrack 参数并未废弃**。kube-proxy 的命令行参考里它们仍是正常选项(默认值 32768 / 131072 / 24h / 1h);新版配置文件把它们挪到了 `linux.conntrack` 下。老集群的 `--conntrack-max-per-core` 写法依然可用,但写 ConfigMap 时注意缩进层级。
7. **`conntrack -L` 在大表上会把机器拖慢**。它会遍历整张表并输出几十万行。先 `conntrack -C` 看规模,再用 `-p` / `-d` / `--state` 收窄,或直接看 `conntrack -S` 的统计数字。
8. **`conntrack -D` 清理表项会中断对应的连接**。它不是「优雅清理」,而是把表项删掉,后续回包匹配不上就会失败。生产环境不要用它来「腾地方」。
9. **UDP DNS 的偶发 5 秒超时,根因也在 conntrack**。并发发出的 A/AAAA 查询在插入表项时有竞争窗口,失败时回包被丢,解析器只能等超时重传。`conntrack -S` 里的 `insert_failed` 增长就是线索;缓解办法见 `dns-troubleshooting`(NodeLocal DNSCache 或 `single-request-reopen`)。
10. **IPVS 模式的 conntrack 行为与 iptables 不同**。IPVS 有自己的连接表,同时对内核 conntrack 的依赖方式不一样,调优参数也不能照搬。注意 IPVS 模式本身在 kube-proxy 中已废弃(1.40 起门控默认关闭),新集群请用 nftables 或 iptables 模式。
11. **表项的默认老化时间因协议而异**。TCP 已建立连接很长(见第 5 条),UDP 短得多(内核默认通常是 30 秒 / 120 秒两档,具体用 `sysctl net.netfilter.nf_conntrack_udp_timeout*` 确认)。短连接多、UDP 多的负载更容易把表撑满。
12. **调大 `nf_conntrack_max` 不是没有代价的**。每个表项约占 300 字节内核内存,`buckets` 也要占用内存;把上限调到几百万在内存小的节点上反而会引发别的问题。经验上是「先看基线用量,再给 2~3 倍余量」。
13. **不要只在出问题的那台节点上查**。DNAT 是在**发起方**所在节点做的,所以表满通常发生在「客户端密集」的节点上,而不是服务端节点。排查时先确认哪一侧的节点指标异常。
14. **表满不会自动恢复**。表项要等老化时间到了才会释放,期间新连接会持续被丢。已经满了的节点,提升上限或重启 kube-proxy 是唯一能立刻缓解的动作。

### 相关命令

- `dns-troubleshooting` — UDP DNS超时的conntrack根因
- `network-troubleshooting` — conntrack在整体排查中的位置
- `kube-proxy` — 设置conntrack上限的组件
- `ipvs` — 另一套连接表实现(已废弃)
- `mtu` — 另一类「小包通大包不通」的问题
- `node-exporter` — 采集conntrack用量的指标

### 参考链接

- [kube-proxy 命令行参考](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-proxy/)
- [kube-proxy 配置 API](https://kubernetes.io/docs/reference/config-api/kube-proxy-config.v1alpha1/)
- [虚拟 IP 与 Service 实现](https://kubernetes.io/docs/reference/networking/virtual-ips/)
- [netfilter conntrack 文档](https://docs.kernel.org/networking/nf_conntrack-sysctl.html)
- [使用 NodeLocal DNSCache 缓解 conntrack 竞态](https://kubernetes.io/docs/tasks/administer-cluster/nodelocaldns/)
