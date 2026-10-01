kube-router
===

一体化Kubernetes网络方案,集CNI、网络策略、IPVS服务代理与BGP路由于一身

## 补充说明

**kube-router** 的设计思路与主流方案不同:它不满足于只做 CNI,而是把几个通常由不同组件承担的角色塞进**同一个 DaemonSet、同一个二进制**里 —— Pod 网络(CNI)、网络策略(NetworkPolicy)、Service 代理(IPVS/LVS)、以及基于 BGP 的路由宣告。对希望减少组件数量、降低运维复杂度的团队,这是很有吸引力的取舍。

```shell
--run-router          用 BGP 宣告与学习 Pod 路由(默认 true)
--run-firewall        执行 NetworkPolicy,基于 ipset + iptables(默认 true)
--run-service-proxy   用内核 IPVS 实现 Service 转发(默认 true)
--run-loadbalancer    为 LoadBalancer 类型 Service 分配 IP(需配合宣告才有意义)
```

BGP 部分使用 GoBGP 实现,不依赖 etcd,状态直接从 Kubernetes API 读取。默认模式是**所有节点之间的 iBGP 全互联**,集群共用私有 AS 号 64512,用户无需做任何配置即可获得跨节点 Pod 路由。

项目**仍在维护**,当前稳定线为 2.x,2026 年仍持续发布补丁与安全修复。需要留意一个已修复的高危漏洞:2026 年的 GHSA-phqm-jgc3-qf8g(CVE-2026-32254)指出代理模块会盲目信任 ExternalIPs / LoadBalancer IP,可能被用于劫持集群流量与 DNS 拒绝服务,v2.8.0 起引入 `--strict-external-ip-validation`(默认 true)修复,多租户集群应尽快升级。

### 安装

```shell
# 与 kube-proxy 并存的最小安装(只用 BGP 宣告 Pod 路由)
kubectl apply -f https://raw.githubusercontent.com/cloudnativelabs/kube-router/master/daemonset/kubeadm-kuberouter.yaml

# 全功能(含 NetworkPolicy、Service 代理、负载均衡 IP)
kubectl apply -f https://raw.githubusercontent.com/cloudnativelabs/kube-router/master/daemonset/kubeadm-kuberouter-all-features.yaml

kubectl -n kube-system get pods -l k8s-app=kube-router -o wide
```

若要让 kube-router 接管 Service 代理,必须先停掉 kube-proxy,否则两套规则会互相干扰:

```shell
kubectl -n kube-system delete ds kube-proxy
kubectl -n kube-system delete cm kube-proxy

# 每个节点清理残留规则
sudo iptables-save | grep -v KUBE | sudo iptables-restore
```

启用 IPVS 需要内核模块与命令行工具:

```shell
sudo modprobe ip_vs ip_vs_rr ip_vs_wrr ip_vs_sh nf_conntrack
sudo apt-get install -y ipvsadm        # 排障用

# kube-router 默认启用 strict ARP,无需像 kube-proxy 那样手工设置
```

CNI 相关约定:

```shell
KUBE_ROUTER_CNI_CONF_FILE         默认 /etc/cni/net.d/10-kuberouter.conf
KUBE_ROUTER_CNI_CONF_TEMPLATE_FILE 自定义模板文件路径
所需插件                             bridge 二进制必须在 /opt/cni/bin 中,cni 插件版本需匹配
```

### 服务发现与运行组件

```shell
kube-router          单个二进制,按开关承担四种角色
kube-router-dsr      DSR(Direct Server Return)变体,返回路径绕过代理节点
GoBGP                内嵌的 BGP 实现,提供 gobgp 调试入口
```

### BGP 配置

默认的 iBGP 全互联不需要配置,但一旦集群变大或需要与物理网络对接,就得显式设置:

```shell
# 修改集群 AS 号
--cluster-asn=64513

# 关闭全互联,改用路由反射器或多组 AS
--nodes-full-mesh=false

# 与外部路由器建立对等
--peer-router-ips="192.168.1.99,192.168.1.100" \
--peer-router-asns="65000,65000"

# 带 MD5 口令的对等
--peer-router-passwords="U2VjdXJlUGFzc3dvcmQK,"
--peer-router-passwords-file=/etc/kube-router/bgp-passwords.conf

# 宣告内容(默认只宣告本节点 Pod 网段)
--advertise-pod-cidr=true
--advertise-cluster-ip
--advertise-external-ip
--advertise-loadbalancer-ip

# 跨子网时用 IP-in-IP 隧道
--enable-overlay=true

# 路由宣告时改写下一跳为自身
--override-nexthop
```

按节点精细控制可以用注解:

```shell
# 合并写法(推荐)
kubectl annotate node node1 kube-router.io/peers="$(cat <<'EOF'
- remoteip: 192.168.1.99
  remoteasn: 65000
  password: U2VjdXJlUGFzc3dvcmQK
- remoteip: 192.168.1.100
  remoteasn: 65000
EOF
)"

# 指定节点 AS 号
kubectl annotate node node1 kube-router.io/node.asn=64514

# 路由反射器与客户端
kubectl annotate node rr1 kube-router.io/rr.server=244.0.0.1
kubectl annotate node node1 kube-router.io/rr.client=244.0.0.1

# 本节点用于 BGP 监听的地址
kubectl annotate node node1 kube-router.io/bgp-local-addresses=192.168.1.10

# 路由优先级调整
kubectl annotate node node1 kube-router.io/path-prepend.as=65000
kubectl annotate node node1 kube-router.io/path-prepend.repeat-n=5
```

容器内可以直接用 GoBGP 的调试命令查看 RIB:

```shell
kubectl -n kube-system exec <kube-router-pod> -- gobgp global rib
kubectl -n kube-system exec <kube-router-pod> -- gobgp neighbor
```

### 负载均衡 IP

```shell
# 分配一段 LoadBalancer 地址池,并允许通过 BGP 宣告出去
--run-loadbalancer=true
--loadbalancer-ip-range=192.168.50.0/24
--advertise-loadbalancer-ip
```

单个 Service 可以通过注解控制是否宣告:

```shell
kubectl annotate svc my-svc kube-router.io/service.advertise.loadbalancer=true
```

### 常用操作

```shell
# 运行状态与日志
kubectl -n kube-system get pods -l k8s-app=kube-router -o wide
kubectl -n kube-system logs <kube-router-pod> --tail=100

# 健康检查与指标(需显式开启指标端口)
kubectl -n kube-system get ds kube-router -o yaml | grep -E "metrics-port|health-port"
curl http://<node-ip>:20244/healthz

# 查看策略规则
sudo ipset list | head -30
sudo iptables -L KUBE-ROUTER-INPUT -n | head

# 查看路由是否被学习到
ip route show | grep 10.244
kubectl -n kube-system exec <kube-router-pod> -- gobgp global rib

# 查看 IPVS 转发
sudo ipvsadm -Ln
sudo ipvsadm -Ln --stats
```

### 排障

```shell
# 1. Pod 跨节点不通
kubectl -n kube-system logs <kube-router-pod> | grep -i -E "error|bgp" | tail -50
ip route show | grep 10.244

# 2. BGP 邻居状态
kubectl -n kube-system exec <kube-router-pod> -- gobgp neighbor
#    关注 State 是否为 ESTABLISHED,以及是否收到对端前缀

# 3. 策略不生效
kubectl -n kube-system logs <kube-router-pod> | grep -i "network policy"
sudo ipset list -n | head

# 4. Service 不通
sudo ipvsadm -Ln | grep -A3 <cluster-ip>
kubectl get endpointslices -l kubernetes.io/service-name=<svc>

# 5. 与 kube-proxy 冲突(SERVICE 转发错乱)
kubectl -n kube-system get ds | grep -E "kube-proxy|kube-router"
```

### 注意

1. **kube-router 的 Service 代理与 kube-proxy 不能同时运行**。两者会各自编写 iptables/IPVS 规则,症状是 Service 转发随机异常,启用 `--run-service-proxy` 前必须先删掉 kube-proxy。
2. **它使用的 IPVS 与 kube-proxy 的 IPVS 模式是两回事**。kube-proxy 的 IPVS 模式已被 KEP-5495 废弃并在后续版本中移除,而 kube-router 自带 IPVS 实现,不受该废弃影响 —— 不要把两者混为一谈。
3. **全互联 iBGP 有规模上限**。默认 AS 64512 的全互联在几十个节点内表现良好,节点数继续增长应改用 `--nodes-full-mesh=false` 配合路由反射器注解。
4. **`--enable-overlay` 默认开启**,跨子网时用 IP-in-IP 封装;底层网络禁止 IP-in-IP 协议号 4 时,Pod 跨子网会不通,需要改走纯 BGP 路由或调整底层网络放行策略。
5. **`--strict-external-ip-validation` 不要随手关掉**。它是修复流量劫持漏洞(GHSA-phqm-jgc3-qf8g / CVE-2026-32254)的关键开关,只在升级前确有兼容问题时临时设 false,并尽快补齐 CIDR 配置。
6. **BGP 节点注解里可能带口令**,升级到含修复的版本后,日志不再以 `--v=2` 打印这些注解;排查时也不要把带密码的注解贴进工单或聊天群。
7. **BGP 宣告需要上游路由器配合**。只在集群侧配置 `--peer-router-ips` 而路由器没有做对等配置、或没有放行 TCP 179,Pod 网段就不会被任何外部设备学到。
8. **`--advertise-cluster-ip` 会把所有 ClusterIP 宣告出去**,数量大时会显著增加路由表压力,生产环境慎用,或配合具体 Service 的注解做白名单。
9. **NetworkPolicy 依赖 ipset 与 iptables**。节点上 ipset 版本过低或规则被外部工具清空,策略会静默失效,变更后应验证一次策略效果。
10. **DSR 变体需要额外条件**。DSR 模式要求后端 Pod 直接把响应发回客户端,涉及回程路由与 rp_filter,启用前先在测试环境验证,否则会出现「请求到达但响应丢失」。
11. **CNI 配置文件名固定为 `10-kuberouter.conf`**。与 Flannel、Calico 混装时该文件与它们的配置会同时存在,必须以 kube-router 为唯一 CNI,否则节点可能加载到错误的配置。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `cni` — kube-router所实现的容器网络接口规范
- `ipvs` — kube-router用于Service代理的内核负载均衡
- `networkpolicy` — kube-router的防火墙组件所执行的策略
- `bgp` — BGP宣告、对等与排障
- `kube-proxy` — 与之互斥的Service实现

### 参考链接

- [kube-router 项目仓库](https://github.com/cloudnativelabs/kube-router)
- [kube-router 用户指南](https://github.com/cloudnativelabs/kube-router/blob/master/docs/user-guide.md)
- [kube-router BGP 说明](https://github.com/cloudnativelabs/kube-router/blob/master/docs/bgp.md)
- [kube-router 架构与工作原理](https://github.com/cloudnativelabs/kube-router/blob/master/docs/how-it-works.md)
- [GHSA-phqm-jgc3-qf8g 安全公告](https://github.com/cloudnativelabs/kube-router/security/advisories)
