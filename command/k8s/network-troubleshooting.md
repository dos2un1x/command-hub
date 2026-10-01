network-troubleshooting
===

Kubernetes网络不通的逐层排查方法论:DNS→Service→Endpoint→Pod→CNI

## 补充说明

Kubernetes 的网络问题之所以难查,是因为一次「连不上」要依次穿过 **域名解析 → Service 虚拟 IP → kube-proxy 规则 → EndpointSlice 后端 → Pod 网络命名空间 → CNI 数据面** 六七个环节,每一环都可能出问题,而报错信息往往只有一句 `connection timed out`。

本页给的是一条**自顶向下、逐层收敛**的排查路径。核心思路是:**不要猜,用一次「跨层对比」把范围砍掉一半**。

### 一次对比就能定位到层

同一时刻,从同一个客户端发四种请求:

```shell
域名      curl -v --connect-timeout 3 http://backend-svc:8080
ClusterIP curl -v --connect-timeout 3 http://10.96.12.34:8080
PodIP     curl -v --connect-timeout 3 http://10.244.1.7:8080
NodePort  curl -v --connect-timeout 3 http://<节点IP>:30080
```

对照结果:

```shell
只有域名不通            → DNS 层(第 1 层)
域名与 ClusterIP 不通、PodIP 通  → Service / kube-proxy 层(第 2 层)
ClusterIP 通但返回拒绝    → Endpoint 为空或后端端口错(第 3 层)
PodIP 也不通(同节点通、跨节点不通) → CNI 数据面 / MTU / 策略(第 5 层)
PodIP 完全不通(包括自己连自己) → 应用没监听或监听地址错(第 4 层)
全部都不通              → 客户端自身的问题,先换一个 Pod 复现
```

先做这一步,后面所有命令都有了方向。

### 第 1 层:DNS

判定依据:**域名解析不出 IP,或解析出的 IP 不对**。

```shell
# 从客户端 Pod 里看自己的 DNS 配置
kubectl exec -it <client-pod> -- cat /etc/resolv.conf

# 换一个干净的调试 Pod 对比(排除客户端自身问题)
kubectl run dnsutils --rm -it --image=nicolaka/netshoot -- bash
nslookup backend-svc
nslookup backend-svc.default.svc.cluster.local
dig @<kube-dns ClusterIP> backend-svc.default.svc.cluster.local

# 解析出来的是不是当前 Service 的 ClusterIP
kubectl get svc backend-svc -o jsonpath='{.spec.clusterIP}'
```

```shell
现象                         指向
no such host                 域名拼写、命名空间不对、Service 不存在
i/o timeout                  到 53 端口的流量被 NetworkPolicy 掐了
解析到旧 IP                  客户端缓存,或 CoreDNS 的 cache
间歇性超时(约 5s / 10s)    UDP DNS 的 conntrack 竞态
```

细节见 `dns-troubleshooting` 页。

### 第 2 层:Service 与 kube-proxy

判定依据:**域名解析正常,但 ClusterIP 连不上**。

```shell
# Service 是否存在、类型与端口对不对
kubectl get svc backend-svc -o wide
kubectl describe svc backend-svc
kubectl get svc backend-svc -o yaml
```

重点核对三组端口,这是最常见的写错之处:

```shell
port        Service 对外暴露的端口(客户端连这个)
targetPort  转发到 Pod 的哪个端口(默认等于 port)
nodePort     仅 NodePort 类型,节点上暴露的端口
```

```shell
# kube-proxy 是否在跑、用的什么模式
kubectl -n kube-system get pods -l k8s-app=kube-proxy -o wide
kubectl -n kube-system logs -l k8s-app=kube-proxy --tail=200

# 在节点上直接看转发规则是否生成(模式不同,命令不同)
iptables-save | grep <ClusterIP>            # iptables 模式
nft list ruleset | grep <ClusterIP>         # nftables 模式
ipvsadm -Ln | grep <ClusterIP>              # ipvs 模式(已废弃)
```

```shell
现象                                指向
ClusterIP ping 不通但 TCP 能通       正常现象,ClusterIP 是虚拟 IP,不响应 ICMP
连 ClusterIP 超时,PodIP 正常         kube-proxy 规则未生成 / 规则被覆盖
只有本节点能连,跨节点不通            kube-proxy 或 CNI 的跨节点转发
NodePort 不通但 ClusterIP 通         nodePortAddresses、云安全组、externalTrafficPolicy
```

`kube-proxy` 的 IPVS 模式已废弃(KEP-5495),新集群请用 nftables 或 iptables 模式。

### 第 3 层:EndpointSlice

判定依据:**Service 存在且 ClusterIP 正确,但没有后端**。

```shell
# 新版本用 EndpointSlice
kubectl get endpointslice -l kubernetes.io/service-name=backend-svc -o wide
kubectl get endpointslice -l kubernetes.io/service-name=backend-svc -o yaml

# 老版本/兼容命令
kubectl get endpoints backend-svc
kubectl describe endpoints backend-svc
```

看三个东西:

```shell
有没有 address        没有 → 选择器没匹配到任何 Pod
address 是不是空的    <none> → 同上
ports 对不对          端口不匹配 → targetPort 写错
ready 是不是 true     不是 → 探针没过,或 Pod 在 Terminating
```

```shell
# 拿 Service 的选择器去反查 Pod
kubectl get svc backend-svc -o jsonpath='{.spec.selector}'
kubectl get pods -l app=backend --show-labels -o wide

# 命名空间必须一致 —— 选择器只在同一命名空间内匹配
kubectl get pods -n <svc的命名空间> -l app=backend
```

```shell
现象                                指向
Endpoints 为空                       podSelector 与 Pod 标签不匹配
Endpoints 有但 notReady              readinessProbe 失败
Endpoints 里是旧 Pod IP              控制器还没更新,或 Pod 卡在 Terminating
Service 是 ExternalName 类型         没有 ClusterIP,是 CNAME,不能用 IP 方式测
```

### 第 4 层:Pod 自身

判定依据:**后端 Pod 存在且 Ready,但连它自己的 PodIP 也不通**。

```shell
# Pod 在不在、Ready 不 Ready、在哪个节点
kubectl get pod <pod> -o wide
kubectl describe pod <pod>

# 容器里到底有没有监听、监听在哪个地址
kubectl exec -it <pod> -- ss -lntp
kubectl exec -it <pod> -- netstat -lntp

# 从容器内部自己连自己(排除网络,纯看应用)
kubectl exec -it <pod> -- curl -v --connect-timeout 3 http://127.0.0.1:8080/healthz
```

```shell
现象                          指向
ss 里没有对应端口             应用根本没起来,或换了端口
只监听 127.0.0.1              监听地址写成了回环,集群内其他 Pod 连不上
只监听 IPv6                   IPv4 客户端连不上
监听正常但自己连自己也不通     应用 hang 住(线程池满、死锁、启动未完成)
探针失败                       readinessProbe 的 path/port/scheme 写错
```

### 第 5 层:CNI 与数据面

判定依据:**同节点内 Pod 互通,跨节点不通**。

```shell
# 当前用的什么 CNI
kubectl -n kube-system get pods -o wide | grep -Ei "calico|cilium|flannel|weave|antrea"
ls /etc/cni/net.d/

# CNI 组件日志
kubectl -n kube-system logs -l k8s-app=calico-node --tail=200
kubectl -n kube-system logs -l k8s-app=cilium --tail=200
kubectl -n kube-system logs -l app=flannel --tail=200

# 从两端确认路由与封装接口
kubectl exec -it <pod-on-node-a> -- ip route
ip link show | grep -E "vxlan|flannel|tunl0|cilium"
ip route show
```

按症状收敛:

```shell
跨节点不通,小包通、大包不通     → MTU 问题,见 mtu 页
跨节点 ping 通但 TCP 建连超时   → conntrack 表满,见 conntrack 页
部分 Pod 不通、部分通           → NetworkPolicy 选择性拦截
偶发丢包、重试后恢复            → 节点间链路或 CNI 组件抖动
新建连接失败、老连接正常        → 同上,conntrack 的典型特征
```

```shell
# 策略是否在拦
kubectl get netpol -A
kubectl get ciliumnetworkpolicy -A 2>/dev/null
kubectl get globalnetworkpolicy -A 2>/dev/null

# Cilium 用户直接看丢包原因
kubectl -n kube-system exec ds/cilium -- cilium-dbg monitor --type drop
```

### 工具箱

```shell
# netshoot:自带 curl / nc / dig / tcpdump / mtr / ss
kubectl run netshoot --rm -it --image=nicolaka/netshoot -- bash

# 临时容器:不重启业务 Pod 就能进去做网络诊断(1.25+ 默认可用)
kubectl debug -it <pod> --image=nicolaka/netshoot --target=<container>

# 事件按时间排序,常能直接看到根因
kubectl get events -A --sort-by=.lastTimestamp | tail -50

# 测试端口连通性
nc -zv backend-svc 8080
nc -zvu <kube-dns-ip> 53

# 路径探测
mtr -rwzc 20 backend-svc
traceroute -T -p 8080 backend-svc

# 抓包(容器里可能没有 tcpdump,用节点上的 nsenter 或 ksniff)
kubectl exec -it <pod> -- tcpdump -i eth0 -nn port 8080
```

### 注意

1. **先做「四路对比」再敲任何复杂命令**。域名 / ClusterIP / PodIP / NodePort 四个地址各测一次,能立刻把范围缩到某一层,比逐个组件看日志快一个数量级。
2. **ClusterIP 不响应 ping 是正常的**。它是 iptables/nftables 规则虚拟出来的地址,只有 TCP/UDP 才会被转发。用 `curl` 或 `nc -z` 测,不要用 `ping` 判断死活。
3. **`kubectl exec` 进去测和从另一个 Pod 测,结论可能相反**。`kubectl exec` 走的是 apiserver → kubelet 的流式通道,不经过 Service;要验证 Service 链路,必须从另一个 Pod 发起请求。
4. **NetworkPolicy 生效后是白名单,「默认全通」会变成「默认全拒」**。排查时先 `kubectl get netpol -A` 看有没有策略选中了目标 Pod。DNS 被掐掉的症状是「所有域名解析超时,IP 直连一切正常」。
5. **命名空间是硬边界**。`Endpoints` 只会在同一个命名空间内匹配 Pod;跨命名空间访问必须用完整域名 `svc.ns.svc.cluster.local`,并且策略要放通。
6. **`targetPort` 用的是容器端口名时,名字必须在 Pod 里存在**。写 `targetPort: http` 而容器端口没命名,Endpoints 会是空的,但 Service 本身看不出任何异常。
7. **`externalTrafficPolicy: Local` 会让没有本地后端的节点直接拒绝 NodePort 请求**。这是「NodePort 有时通有时不通」的最常见原因,尤其配合 DaemonSet 类服务时容易被误判成网络故障。
8. **跨节点不通优先怀疑 MTU 和 conntrack,而不是 CNI 坏了**。这两个问题的共同特征是「小包正常、大包或新建连接失败」,而 CNI 组件本身日志干净。
9. **节点间的 ICMP 被云安全组挡掉会掩盖真实问题**。ping 不通不代表 TCP 不通,反之亦然;判断跨节点连通性要用目标端口做 TCP 探测,别只依赖 ping。
10. **`kube-proxy` 的 IPVS 模式已废弃**,1.35 起警告、1.40 起门控默认关闭、1.43 移除代码。老集群排查时看到 IPVS 规则不要照抄新集群的文档。
11. **不要忽略「客户端」本身**。大量「服务连不上」的工单最后落在客户端:连接池打满、DNS 缓存过期、Sidecar 拦截了出站流量。换一个干净的调试 Pod 复现是性价比最高的一步。
12. **CNI 组件的日志级别默认往往只报错**。真正定位跨节点转发问题时,临时提高日志级别(如 Cilium 的 `cilium-dbg monitor`)比翻日志有效得多。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `dns-troubleshooting` — 第1层DNS问题的专项排查
- `conntrack` — 连接跟踪表相关问题
- `mtu` — 封装导致的MTU与大包不通问题
- `networkpolicy` — 策略导致的定向不通
- `ksniff` — 在Pod上抓包定位
- `cni` — 网络插件与数据面
- `hubble` — Cilium环境下的流量观测
- `ipvs` — kube-proxy的IPVS模式(已废弃)

### 参考链接

- [调试 Service](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/)
- [集群网络排查](https://kubernetes.io/docs/tasks/debug/debug-cluster/)
- [Service 与 Pod 的 DNS](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)
- [网络插件](https://kubernetes.io/docs/concepts/extend-kubernetes/compute-storage-net/network-plugins/)
- [虚拟 IP 与 Service 实现](https://kubernetes.io/docs/reference/networking/virtual-ips/)
