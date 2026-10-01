kube-proxy
===

Kubernetes集群网络代理,Service的实现者

## 补充说明

**kube-proxy命令** 是运行在每个节点上的网络代理,负责把 Service 的虚拟 IP(ClusterIP)翻译成后端 Pod 的真实地址。它是 Service 这一抽象能够落地的实现者 —— 你创建的每一条 Service,最终都变成节点上的一组 iptables 规则或 IPVS 转发条目。

kube-proxy 只处理**Service 转发**,不负责给 Pod 分配 IP,也不负责跨节点 Pod 之间的直连,那些是 CNI 插件的职责。删掉 kube-proxy,Pod 之间依然能互通,但所有 Service 会立刻失效 —— 这条边界是排查网络问题时首先要分清的方向。

在 kubeadm 集群中,kube-proxy 以 DaemonSet 形式运行在 `kube-system` 命名空间,配置存放在同名的 ConfigMap 里。

### 安装

kube-proxy 由 kubeadm 自动部署为 DaemonSet,通常无需手工安装:

```shell
# 确认每个节点都有实例
kubectl get daemonset -n kube-system kube-proxy
kubectl get pods -n kube-system -l k8s-app=kube-proxy -o wide

# 查看版本
kube-proxy --version
```

二进制安装(非 kubeadm)时它由 systemd 托管,配置默认放在 `/var/lib/kube-proxy/`。

### 语法

```shell
kube-proxy [flags]
```

常用标志:

```shell
--config=/var/lib/kube-proxy/config.conf   配置文件路径
--kubeconfig=/var/lib/kube-proxy/kubeconfig.conf   访问 apiserver 的凭据
--hostname-override=<node-name>            覆盖节点名
--cluster-cidr=10.244.0.0/16               集群 Pod 网段,用于判断是否需要 MASQUERADE
--proxy-mode=iptables|ipvs|nftables        转发模式
--masquerade-all                           对所有出集群流量做 SNAT
--healthz-bind-address=0.0.0.0             健康检查监听地址
--metrics-bind-address=127.0.0.1:10249     指标监听地址
--v=2                                      日志级别
```

### 三种转发模式

```shell
iptables   默认模式。用 iptables 的 nat 表实现,兼容性最好,规则数随 Service 线性增长
ipvs       基于内核 IPVS,用哈希表查找,大规模集群性能明显更好,需要内核模块支持
nftables   1.29 引入、1.31 进入 Beta 的新模式,规则集更简洁,面向超大规模集群
userspace  已废弃并在 1.14 中移除,不要使用
```

```shell
# 查看当前模式
kubectl -n kube-system get configmap kube-proxy -o yaml | grep mode

# 切换模式:编辑 ConfigMap,把 mode: "" 改成 mode: "ipvs"
kubectl -n kube-system edit configmap kube-proxy

# 修改后必须重启 DaemonSet 才生效
kubectl -n kube-system rollout restart daemonset kube-proxy
kubectl -n kube-system rollout status daemonset kube-proxy
```

IPVS 模式需要先加载内核模块:

```shell
sudo modprobe ip_vs
sudo modprobe ip_vs_rr
sudo modprobe ip_vs_wrr
sudo modprobe ip_vs_sh
sudo modprobe nf_conntrack

# 持久化,避免重启后丢失
printf 'ip_vs\nip_vs_rr\nip_vs_wrr\nip_vs_sh\nnf_conntrack\n' | \
  sudo tee /etc/modules-load.d/ipvs.conf
```

### 配置文件

ConfigMap `kube-system/kube-proxy` 中的 `config.conf` 就是 KubeProxyConfiguration:

```shell
apiVersion: kubeproxy.config.k8s.io/v1alpha1
kind: KubeProxyConfiguration
bindAddress: 0.0.0.0
clientConnection:
  kubeconfig: /var/lib/kube-proxy/kubeconfig.conf
clusterCIDR: 10.244.0.0/16
mode: ipvs
metricsBindAddress: 127.0.0.1:10249
ipvs:
  scheduler: rr
  strictARP: true
conntrack:
  maxPerCore: 32768
  tcpEstablishedTimeout: 24h0m0s
```

### 常用操作

```shell
# 查看日志
kubectl logs -n kube-system -l k8s-app=kube-proxy --tail=100
kubectl logs -n kube-system <kube-proxy-pod> -f

# 健康检查与指标
curl http://127.0.0.1:10256/healthz
curl -s http://127.0.0.1:10249/metrics | grep kubeproxy

# 查看某条 Service 的后端地址,为空说明选择器没匹配到 Pod
kubectl get endpointslices -l kubernetes.io/service-name=<svc-name> -o wide
kubectl get endpoints <svc-name> -o yaml

# 在集群内验证 Service 连通性
kubectl run curl-test --rm -it --image=curlimages/curl --restart=Never -- \
  curl -s -o /dev/null -w '%{http_code}\n' http://<cluster-ip>:<port>
```

### iptables 模式排障

```shell
# Service 的总入口链
sudo iptables -t nat -L KUBE-SERVICES -n --line-numbers

# 找到某个 ClusterIP 对应的规则
sudo iptables -t nat -L KUBE-SERVICES -n | grep <cluster-ip>

# 该 Service 的转发链(KUBE-SVC-xxx)与后端链(KUBE-SEP-xxx)
sudo iptables -t nat -L KUBE-SVC-XXXXXXXXXXXXXXXX -n
sudo iptables -t nat -L KUBE-SEP-XXXXXXXXXXXXXXXX -n

# NodePort 链
sudo iptables -t nat -L KUBE-NODEPORTS -n

# 规则数量,过大说明该换 IPVS 或 nftables 了
sudo iptables -t nat -L -n | wc -l

# 带计数器查看,确认流量确实命中了规则
sudo iptables -t nat -L KUBE-SVC-XXXXXXXXXXXXXXXX -n -v
```

### IPVS 模式排障

```shell
# 虚拟服务与真实后端
sudo ipvsadm -Ln

# 转发统计与速率
sudo ipvsadm -Ln --stats
sudo ipvsadm -Ln --rate

# 当前连接数
sudo ipvsadm -Lnc | wc -l

# 确认内核模块已加载
lsmod | grep ip_vs
```

### conntrack 相关

```shell
# 查看连接跟踪表用量(iptables 模式的 sessionAffinity 依赖它)
sudo conntrack -C
cat /proc/sys/net/netfilter/nf_conntrack_max

# 临时调大上限
sudo sysctl -w net.netfilter.nf_conntrack_max=1048576

# 排查丢包
sudo dmesg | grep -i conntrack
```

### 注意

1. **kube-proxy 与 Pod 间通信无关**。Pod 跨节点互通靠 CNI,Service 转发才靠 kube-proxy。排查「Pod 之间不通」先怀疑 CNI,排查「访问 Service 不通」才轮到 kube-proxy。
2. **ClusterIP 是虚拟地址,ping 不通完全正常**。它由 iptables/IPVS 规则实现,只在特定端口上响应,不处理 ICMP。请用 `curl <cluster-ip>:<port>` 验证,不要用 ping。
3. 修改 `kube-system/kube-proxy` 这个 ConfigMap **不会自动生效**,必须 `kubectl -n kube-system rollout restart daemonset kube-proxy`。忘了这一步是「改了配置没反应」的头号原因。
4. 不要手工执行 `iptables -F` 或 `iptables -t nat -F`。这会同时清掉 kube-proxy 和 CNI 的规则,导致整个集群网络中断,恢复需要重启所有节点的相关组件。
5. iptables 模式下规则数量随 Service 与 Endpoint 数量线性增长,几千个 Service 的集群会出现规则同步缓慢、CPU 占用高、新建 Service 长时间不生效。这类集群应改用 IPVS 或 nftables 模式。
6. IPVS 模式下若配合 MetalLB 等依赖 ARP 的组件,必须设置 `ipvs.strictARP: true`,否则 VIP 无法被外部访问。
7. `externalTrafficPolicy: Local` 只把流量转发到本节点的 Endpoint:能保留客户端源 IP,但节点上没有 Endpoint 时会直接拒绝连接,配合 NodePort 使用时需要额外的健康检查。
8. `sessionAffinity: ClientIP` 在 iptables 模式下依赖 conntrack,长连接多时容易打满 `nf_conntrack_max`,日志里出现 `nf_conntrack: table full, dropping packet`。
9. NodePort 的默认范围是 30000-32767,由 apiserver 的 `--service-node-port-range` 决定,kube-proxy 只是执行者,改它没用。
10. DaemonSet 重启期间旧规则不会被立即清除,存量连接可以继续工作,但新建连接可能短暂失败 —— 这属于正常的收敛过程,不要当成故障。
11. kube-proxy 全部 Pod 处于 Running **不等于**网络正常,还要确认 CNI 就绪、Endpoint 列表非空、Pod 的 readinessProbe 通过。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kubelet` — 节点代理,负责启动 Pod
- `kubeadm` — Kubernetes集群安装工具
- `crictl` — 容器运行时调试工具

### 参考链接

- [kube-proxy 命令行参考](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-proxy/)
- [虚拟 IP 与 Service 代理](https://kubernetes.io/docs/reference/networking/virtual-ips/)
- [Service](https://kubernetes.io/docs/concepts/services-networking/service/)
- [IPVS 集群内负载均衡深入解析](https://kubernetes.io/blog/2018/07/09/ipvs-based-in-cluster-load-balancing-deep-dive/)
