dns-troubleshooting
===

CoreDNS与集群DNS的专项排查:ndots、解析超时、resolv.conf与NodeLocal DNSCache

## 补充说明

集群 DNS 的特殊之处在于:**它的故障会伪装成业务故障**。大量服务同时报「连接超时」,而用 IP 直连一切正常 —— 这几乎总是 DNS。

本页只讲 DNS 这一层。排查的基本工具与顺序见 `network-troubleshooting`,`CoreDNS` 本身的配置见 `coredns` 页。

### 先理解 resolv.conf 与 ndots

Pod 里的 `/etc/resolv.conf` 长这样:

```shell
search default.svc.cluster.local svc.cluster.local cluster.local
nameserver 10.96.0.10
options ndots:5
```

解析器(libc)的规则是:

```shell
名字里的「点」数量 >= ndots(默认 5)  → 先当作 FQDN 直接查询
名字里的「点」数量 <  ndots           → 先挨个拼 search 域,全部失败后才当作 FQDN 查询
```

`ndots:5` 意味着 `www.baidu.com`(2 个点)会被依次尝试:

```shell
www.baidu.com.default.svc.cluster.local
www.baidu.com.svc.cluster.local
www.baidu.com.cluster.local
www.baidu.com.                        # 最后才查这个
```

一次业务调用变成 4 次 DNS 查询,前 3 次必然 NXDOMAIN。这就是**「ndots:5 导致大量无效查询」**的由来:它是外部域名解析延迟与 CoreDNS 负载的主要来源。

规避方式有两种:

```shell
# 1. 业务代码里写带结尾点的绝对域名,直接跳过 search 域
curl http://www.baidu.com./

# 2. 给 Pod 单独调小 ndots(注意副作用)
```

```shell
spec:
  dnsConfig:
    options:
      - name: ndots
        value: "2"
```

**调小 ndots 有代价**:集群内 `backend-svc` 这类短名本来靠 search 域补全,ndots 调小后它们会先被当作外部域名查询一遍,内部调用反而变慢。正确的做法是内外部域名在代码里都写全(内部写 `svc.ns.svc.cluster.local.`)。

### 排查步骤

```shell
# 1. 起一个调试 Pod(自带 dig / nslookup / tcpdump)
kubectl run dnsutils --rm -it --image=nicolaka/netshoot -- bash

# 2. 看自己的 resolv.conf
cat /etc/resolv.conf

# 3. 内部域名
nslookup kubernetes.default
dig kubernetes.default.svc.cluster.local

# 4. 指定服务器,绕过 search 域干扰(注意结尾的点)
dig @10.96.0.10 kubernetes.default.svc.cluster.local.

# 5. 外部域名(验证 forward 插件)
dig www.baidu.com.

# 6. 看解析耗时,判断是否命中超时重传
dig kubernetes.default.svc.cluster.local. | grep "Query time"
```

```shell
# CoreDNS 侧
kubectl -n kube-system get pods -l k8s-app=kube-dns -o wide
kubectl -n kube-system logs -l k8s-app=kube-dns --tail=200
kubectl -n kube-system get svc kube-dns
kubectl -n kube-system get endpointslice -l kubernetes.io/service-name=kube-dns
kubectl -n kube-system get configmap coredns -o yaml

# 是否 OOMKilled(大集群的常见问题)
kubectl -n kube-system get pod -l k8s-app=kube-dns \
  -o jsonpath='{.items[*].status.containerStatuses[*].lastState}'

# CoreDNS 的权限是否完整(缺 endpointslices 会导致 SERVFAIL)
kubectl describe clusterrole system:coredns

# 指标:请求量、响应码、转发错误
kubectl -n kube-system port-forward svc/kube-dns 9153:9153
curl -s localhost:9153/metrics | grep -E "coredns_dns_(requests|responses)_total"
curl -s localhost:9153/metrics | grep coredns_forward
```

在 Corefile 里临时加 `log` 插件可以看到每条查询 —— 这是判断「查询到底有没有到 CoreDNS」最直接的方式:

```shell
kubectl -n kube-system edit configmap coredns
```

```shell
data:
  Corefile: |
    .:53 {
        log
        errors
        health
        ready
        kubernetes cluster.local in-addr.arpa ip6.arpa {
          pods insecure
          fallthrough in-addr.arpa ip6.arpa
        }
        prometheus :9153
        forward . /etc/resolv.conf
        cache 30
        loop
        reload
        loadbalance
    }
```

改动传播到 CoreDNS Pod 需要一到两分钟。

### 解析超时:5 秒与 10 秒的来源

「DNS 偶发卡 5 秒 / 10 秒」是一个有明确内核原因的现象:**UDP DNS 与 conntrack 的竞态**。

```shell
1. 解析器同时发出 A 与 AAAA 两个 UDP 查询(两个不同的源端口)
2. 内核为它们创建 conntrack 表项,这个过程有竞争窗口
3. 竞争失败时,回包匹配不到 conntrack 表项,被直接丢弃
4. 解析器只能等超时重传 —— glibc 默认 5 秒超时、重试 2 次
5. 表现为「大部分请求很快,偶尔有一个卡 5 秒」
```

Kubernetes 官方在 NodeLocal DNSCache 文档里把最坏情况描述为「最多 30 秒 = 3 次重试 + 10 秒超时」,并把「避免 conntrack 竞态、避免 UDP 表项塞满 conntrack」列为引入本地缓存的动机之一。

三种缓解手段:

```shell
# 1. 部署 NodeLocal DNSCache(最彻底,推荐)
#    它让 Pod 查本节点的缓存,绕开 kube-proxy 的 DNAT 与 conntrack;
#    其内置 Corefile 对集群域使用 force_tcp,TCP 表项随连接关闭即回收

# 2. 给 Pod 加 resolv.conf 选项(仅 glibc 有效)
spec:
  dnsConfig:
    options:
      - name: single-request-reopen     # A 与 AAAA 复用同一个源端口,串行发出
      - name: use-vc                    # 强制走 TCP 查询
```

```shell
# 3. 提高 conntrack 容量,降低表满导致的丢包概率
sysctl -w net.netfilter.nf_conntrack_max=1048576
```

```shell
# 检查是否有 conntrack 丢包
conntrack -S | grep -E "insert_failed|drop"
dmesg -T | grep "nf_conntrack: table full"
```

### NodeLocal DNSCache

思路:每个节点跑一个 DNS 缓存,Pod 查本机而不是查 ClusterIP,从而**完全绕开 kube-proxy 的 DNAT 与 conntrack**。

```shell
# 官方清单
# https://github.com/kubernetes/kubernetes/blob/master/cluster/addons/dns/nodelocaldns/nodelocaldns.yaml

coredns=$(kubectl get svc kube-dns -n kube-system -o jsonpath={.spec.clusterIP})
domain=cluster.local
localdns=169.254.20.10

# iptables 模式
sed -i "s/__PILLAR__LOCAL__DNS__/$localdns/g; \
        s/__PILLAR__DNS__DOMAIN__/$domain/g; \
        s/__PILLAR__DNS__SERVER__/$coredns/g" nodelocaldns.yaml

kubectl create -f nodelocaldns.yaml
```

部署后 kube-system 里会多出这些对象:

```shell
ServiceAccount  node-local-dns
ConfigMap       node-local-dns          # 本地缓存的 Corefile
Service         kube-dns-upstream       # 指回真正的 CoreDNS
Service         node-local-dns          # headless,暴露 :9253 指标
DaemonSet       node-local-dns          # hostNetwork + dnsPolicy: Default
```

本地 Corefile 的关键几行(节选):

```shell
cluster.local:53 {
    errors
    cache {
            success 9984 30
            denial 9984 5
    }
    reload
    loop
    bind 169.254.20.10 <kube-dns ClusterIP>
    forward . <kube-dns ClusterIP> {
            force_tcp            # 对上游用 TCP,规避 UDP conntrack 竞态
    }
    prometheus :9253
    health 169.254.20.10:8080
}
```

```shell
# 验证
kubectl -n kube-system get pods -l k8s-app=node-local-dns -o wide
kubectl exec -it <pod> -- cat /etc/resolv.conf     # nameserver 应变成 169.254.20.10
kubectl exec -it <pod> -- dig kubernetes.default.svc.cluster.local.
```

### 注意

1. **`options ndots:5` 是集群 DNS 负载的最大来源**。任何含点少于 5 个的名字都会先拼 3 次 search 域,外部域名解析因此多出 3 次必然失败的查询。业务里访问外部服务请写**带结尾点的 FQDN**(`www.baidu.com.`),或给该工作负载单独设 `dnsConfig.options` 调小 ndots。
2. **调小 ndots 会让集群内部短名解析变慢**。`backend-svc` 这类名字依赖 search 域补全;ndots 降到 2 以后它们要先把每个 search 域之外的可能性都试一遍。这是典型的「按下葫芦浮起瓢」,正确解法是在代码里写完整域名而不是全局改 ndots。
3. **「DNS 偶发卡 5 秒」不是 CoreDNS 慢,而是 conntrack 竞态**。UDP DNS 的回包可能因 conntrack 表项竞争失败被内核丢弃,只能等解析器超时重传。加大 CoreDNS 副本数、调大缓存都不会改善,要治本得用 NodeLocal DNSCache。
4. **`single-request-reopen` 与 `use-vc` 只对 glibc 有效**。musl(Alpine 等)不认这两个选项,配了也不生效。musl 系的镜像要靠 NodeLocal DNSCache 或换基础镜像解决。
5. **Alpine 3.17 及更早版本的 DNS 有设计缺陷**。其 musl 在 1.24 之前没有 DNS 的 TCP 回退,任何超过 512 字节的响应都会失败。官方建议直接**升级到 Alpine 3.18 或以上**,不要试图用 resolv.conf 选项绕。
6. **glibc 只支持最多 3 个 nameserver**。Kubernetes 自己要用掉 1 个;如果节点上原本已经有 3 个,有些会被静默丢弃。节点上跑 systemd-resolved 或 dnsmasq 时要特别小心这一条,可以用 kubelet 的 `--resolv-conf` 指定别的文件。
7. **systemd-resolved 的 stub resolv.conf 会造成转发环路**。Ubuntu 系默认用 systemd-resolved,`/etc/resolv.conf` 是指向 stub 的软链,CoreDNS 的 `forward . /etc/resolv.conf` 可能形成环。修法是用 kubelet 的 `--resolv-conf` 指向 `/run/systemd/resolve/resolv.conf`(kubeadm 会自动处理)。
8. **`hostNetwork: true` 的 Pod 用不了集群 DNS**。它的 resolv.conf 继承自节点,访问 Service 域名会直接失败。要么改 `dnsPolicy: ClusterFirstWithHostNet`,要么在有状态服务里用无头 Service 的完整域名。
9. **`dnsPolicy` 有四种,值不同结果完全不同**。`ClusterFirst`(默认)走 CoreDNS;`Default` 继承节点 DNS;`None` 完全自定义;`ClusterFirstWithHostNet` 供 hostNetwork 使用。排查时第一步就该确认这个字段。
10. **限制出站的 NetworkPolicy 必须显式放通 DNS**。要同时放通 UDP 与 TCP 的 53 —— 响应超过 512 字节或发生截断时会自动改用 TCP,只放 UDP 会在某些域名上失败。症状是「所有域名解析超时,IP 直连正常」。
11. **`kube-dns` 这个 Service 名字被 kubelet 硬编码**。即使换成 CoreDNS 以外的实现,也要保留这个名字,否则 `nameserver` 注入会指向一个不存在的地址。
12. **CoreDNS 的 `reload` 插件有约 30 秒的轮询延迟**。改完 ConfigMap 不会立即生效,急着验证就 `rollout restart deployment coredns`,但那会短暂中断解析 —— 生产环境至少保持 2 副本。
13. **CoreDNS 内存随 Service 与 Pod 数量增长**。上万 Pod 的集群里默认的 170Mi 上限会导致周期性 OOMKilled,表现为随机性的解析失败。看 `lastState` 里的 `OOMKilled` 就能确认,同时检查 `coredns-autoscaler` 是否正常工作。
14. **NodeLocal DNSCache 在 IPVS 模式下必须改 kubelet 的 `--cluster-dns`**。IPVS 模式下 node-local-dns 无法绑定 CoreDNS 的 ClusterIP(该地址已被 IPVS 负载均衡占用),只能监听本地地址。iptables 模式下则不需要改,因为 Pod 会同时监听两个地址。
15. **判断「查询到底有没有到 CoreDNS」要看日志而不是看症状**。临时加 `log` 插件最直接:如果日志里没有这条查询,问题在客户端到 CoreDNS 的路径上(策略、kube-proxy、conntrack);如果有查询但返回 SERVFAIL,问题在 CoreDNS 内部(上游、权限、插件)。另外注意 CoreDNS 需要 `endpointslices.discovery.k8s.io` 的 list/watch 权限,缺了会大面积 SERVFAIL。

### 相关命令

- `coredns` — 集群DNS服务本身
- `network-troubleshooting` — DNS在整体排查流程中的位置
- `networkpolicy` — 出站限制时须放通53端口
- `conntrack` — UDP DNS超时的根因所在
- `service` — kube-dns Service与EndpointSlice
- `pod` — dnsPolicy与dnsConfig的载体
- `kubelet` — resolv-conf与cluster-dns参数

### 参考链接

- [调试 DNS 解析](https://kubernetes.io/docs/tasks/administer-cluster/dns-debugging-resolution/)
- [自定义 DNS 服务](https://kubernetes.io/docs/tasks/administer-cluster/dns-custom-nameservers/)
- [使用 NodeLocal DNSCache](https://kubernetes.io/docs/tasks/administer-cluster/nodelocaldns/)
- [Service 与 Pod 的 DNS](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)
- [CoreDNS 官方文档](https://coredns.io/manual/toc/)
