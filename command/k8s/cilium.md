cilium
===

Kubernetes基于eBPF的高性能CNI网络、安全策略与可观测性方案

## 补充说明

**Cilium** 是基于 eBPF 的 Kubernetes 网络方案,由 Isovalent(现属 Cisco)主导、已从 CNCF 毕业。它把网络转发、负载均衡、安全策略全部下沉到内核 eBPF 程序,绕过了 iptables 规则链,因此在规模、延迟与可观测性上都有明显优势。项目长期活跃,当前稳定线为 1.20.x(1.18、1.19 仍在维护期),未归档也未停止维护。

Cilium 与「只管连通性」的 CNI 最大的区别在于:它的安全模型基于**身份(identity)**而不是 IP 地址。同一组 Pod 共享一个安全身份,策略写在身份之间,Pod IP 变化不影响策略判定;这让它在大规模动态集群里比基于 IP 的规则稳定得多。

```shell
Cilium Agent        DaemonSet(名称 cilium),每个节点一个,负责编译与下发 eBPF 程序
Cilium Operator     处理集群级任务:IPAM 分配、CRD 清理、身份回收
Hubble             可观测性组件,基于 eBPF 采集流量与丢包原因,可对接 Prometheus
cilium CLI         宿主机/管理机上的命令行工具,安装、排障、连通性测试都靠它
cilium-dbg         Agent 内部的调试命令(1.16 起由 cilium 改名),需 exec 进 Pod 执行
```

### 安装

Helm 方式:

```shell
helm repo add cilium https://helm.cilium.io/
helm repo update

helm install cilium cilium/cilium --namespace kube-system \
  --set ipam.mode=kubernetes \
  --set kubeProxyReplacement=true \
  --set k8sServiceHost=10.0.0.10 \
  --set k8sServicePort=6443 \
  --set hubble.enabled=true \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true
```

cilium CLI 方式(内部即调用 Helm):

```shell
curl -L --fail https://github.com/cilium/cilium-cli/releases/latest/download/cilium-linux-amd64.tar.gz \
  | sudo tar xzvf - -C /usr/local/bin

cilium install --version 1.20.2
cilium status --wait
```

`k8sServiceHost` 与 `k8sServicePort` 在启用 kube-proxy replacement 时**必须显式指定**,否则 agent 无法找到 apiserver —— 因为 ClusterIP 的转发本来就是被替换掉的那部分功能。

### kube-proxy 替换

```shell
helm upgrade cilium cilium/cilium --namespace kube-system \
  --set kubeProxyReplacement=true \
  --set k8sServiceHost=10.0.0.10 \
  --set k8sServicePort=6443

# 确认替换已生效
cilium-dbg status | grep -i "KubeProxyReplacement"
#   True (socket)  表示 socket 层替换已开启
```

新建集群时从源头就不装 kube-proxy:

```shell
sudo kubeadm init --skip-phases=addon/kube-proxy --pod-network-cidr=10.244.0.0/16
```

存量集群删除 kube-proxy:

```shell
kubectl -n kube-system delete ds kube-proxy
kubectl -n kube-system delete cm kube-proxy     # 一并删除,避免升级时被 kubeadm 重新创建
# 每个节点上清理残留规则
sudo iptables-save | grep -v KUBE | sudo iptables-restore
```

### 常用操作

```shell
# 集群整体状态
cilium status
cilium status --verbose

# 节点上的 agent 视角
kubectl -n kube-system exec ds/cilium -- cilium-dbg status
kubectl -n kube-system exec ds/cilium -- cilium-dbg status --verbose

# 端点(每个 Pod 对应一个 eBPF 端点)
cilium endpoint list
kubectl -n kube-system exec ds/cilium -- cilium-dbg endpoint list

# Service 与后端
cilium service list
cilium-dbg service list

# 连通性测试(会起一批测试 Pod,建议在测试集群先跑)
cilium connectivity test

# 版本与配置
cilium version
cilium config view
```

### 策略

Cilium 支持 Kubernetes 原生 NetworkPolicy,同时提供表达能力更强的 `CiliumNetworkPolicy`,后者支持 L7(HTTP 方法、路径)与基于 DNS 名/FQDN 的出站控制:

```shell
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-api-get
  namespace: default
spec:
  endpointSelector:
    matchLabels:
      app: backend
  ingress:
    - fromEndpoints:
        - matchLabels:
            app: frontend
      toPorts:
        - ports:
            - port: "8080"
              protocol: TCP
          rules:
            http:
              - method: GET
                path: "/api/v1/.*"
```

```shell
apiVersion: cilium.io/v2
kind: CiliumNetworkPolicy
metadata:
  name: allow-egress-fqdn
  namespace: default
spec:
  endpointSelector:
    matchLabels:
      app: backend
  egress:
    - toFQDNs:
        - matchPattern: "*.example.com"
      toPorts:
        - ports:
            - port: "443"
              protocol: TCP
```

集群级策略用 `CiliumClusterwideNetworkPolicy`(无 `namespace` 字段),节点与主机网络用 `CiliumNodeConfig`、`HostFirewall` 相关字段控制,这些都属于谨慎开启的功能。

### BGP 宣告

Cilium 从 1.16 起提供 BGP Control Plane v2,配置分散在三个 CRD 里:

```shell
apiVersion: cilium.io/v2
kind: CiliumBGPClusterConfig
metadata:
  name: cilium-bgp
spec:
  nodeSelector:
    matchLabels:
      bgp: "true"
  bgpInstances:
    - name: instance-65000
      localASN: 65000
      peers:
        - name: tor
          peerASN: 65001
          peerAddress: 10.0.0.1
          peerConfigRef:
            name: cilium-peer
```

`CiliumBGPPeerConfig` 承载会话级参数(定时器、密码、多跳、`families` 与 `advertisements.matchLabels`),`CiliumBGPAdvertisement` 承载宣告内容:

```shell
apiVersion: cilium.io/v2
kind: CiliumBGPAdvertisement
metadata:
  name: bgp-advertisements
  labels:
    advertise: bgp
spec:
  advertisements:
    - advertisementType: Service
      service:
        addresses:
          - LoadBalancerIP
```

启用 BGP 需要在安装时打开开关,并重启 agent 与 operator:

```shell
helm upgrade cilium cilium/cilium --namespace kube-system \
  --set bgpControlPlane.enabled=true \
  --set operator.rollOutPods=true
```

旧的 `CiliumBGPPeeringPolicy`(BGP v1)在 1.19 中已被移除,老清单必须迁移到上面三个 CRD。**默认不宣告任何前缀**,peer 只有在 `families[].advertisements.matchLabels` 匹配到某个 `CiliumBGPAdvertisement` 时才会宣告。

### 可观测性

```shell
# 实时流量事件(最常用的排障入口)
hubble observe --last 50
hubble observe --namespace default --follow

# 只看被策略丢弃的流量
hubble observe --verdict DROPPED --last 50
kubectl -n kube-system exec ds/cilium -- hubble observe --verdict DROPPED --last 20

# 按 Pod 过滤
hubble observe --pod default/backend-xxx --last 30

# 转发端口(本地 4245 -> hubble relay)
cilium hubble port-forward &
export HUBBLE_SERVER=127.0.0.1:4245
```

### 排障

```shell
# 1. Agent 是否健康
cilium status --verbose
kubectl -n kube-system get pods -l k8s-app=cilium -o wide

# 2. 节点 NetworkUnavailable / Pod 拿不到 IP
kubectl -n kube-system logs -l k8s-app=cilium --tail=100 | grep -i -E "error|ipam"

# 3. 某个 Pod 的端点状态(策略是否生效、身份是什么)
kubectl -n kube-system exec ds/cilium -- cilium-dbg endpoint list
kubectl -n kube-system exec ds/cilium -- cilium-dbg endpoint get <endpoint-id>

# 4. 丢包在哪里被丢
kubectl -n kube-system exec ds/cilium -- cilium-dbg monitor --type drop
kubectl -n kube-system exec ds/cilium -- cilium-dbg monitor --type policy-verdict

# 5. Service 不通时看后端列表是否为空
kubectl -n kube-system exec ds/cilium -- cilium-dbg service list | grep <cluster-ip>

# 6. 路由与邻居
kubectl -n kube-system exec ds/cilium -- cilium-dbg bpf ipcache list
kubectl -n kube-system exec ds/cilium -- cilium-dbg bgp peers
```

### 注意

1. **Cilium 对内核版本有硬要求**。官方最低内核为 4.19(推荐 5.10 及以上),低于 5.10 会关闭 BPF masquerade、BPF host routing 等一批特性,表现为性能不如预期或某些功能不可用;部署前务必核对目标节点的内核版本与官方系统要求表。
2. **kube-proxy replacement 一旦启用就难以回退**,而且替换过程中已有连接会中断。启用时不要只改 `kubeProxyReplacement`,必须同时给出 `k8sServiceHost` 与 `k8sServicePort`,否则 agent 找不到 apiserver。
3. **删除 kube-proxy 与启用替换必须按顺序做**。先装好 Cilium 并确认替换生效,再删 kube-proxy;反过来会让整个集群的 Service 立刻失效。
4. **不要与 Calico、Flannel 等 CNI 同时安装**。多余的 CNI 配置会让 `/etc/cni/net.d` 里出现多个 conflist,节点可能加载错的那一个,故障现象是「有些节点正常有些节点不正常」。
5. **`cilium` 与 `cilium-dbg` 是两个不同的命令**。宿主机上的是 `cilium`(安装与管理),Pod 内的是 `cilium-dbg`(调试),1.16 之前 Pod 内也叫 `cilium`,照抄老文档会提示命令不存在。
6. **策略默认不是拒绝**。没有策略时全通;一旦某个端点被策略选中,该方向才变为默认拒绝 —— 与 NetworkPolicy 的语义一致,改动策略前先想清楚禁掉了什么。
7. **L7 策略与 FQDN 策略依赖 DNS 代理**。用了 `toFQDNs` 就必须保证 DNS 流量经过 Cilium 的 DNS proxy,自定义 `dnsPolicy` 或绕过集群 DNS 的 Pod 上这类策略会失效。
8. **Hubble 不是零成本**。开启后 eBPF ring buffer 与 relay 都会占用内存与 CPU,大流量集群需要调大 `hubble.eventBufferCapacity` 或只按需开启采样。
9. **BGP Control Plane 默认不宣告任何前缀**,只配了 peer 而没有匹配的 `CiliumBGPAdvertisement` 时,`cilium-dbg bgp peers` 显示 Established 但路由器上什么路由都学不到。
10. **IPAM 模式要提前定好**。`cluster-pool` 由 Cilium 自己分配、`kubernetes` 复用节点 PodCIDR、`eni`/`azure-ipam` 走云厂商网卡;模式选错会导致 Pod IP 与云网络不通,迁移时必须重建 Pod。
11. **升级前先跑 `cilium connectivity test`**,升级后也跑一遍。Cilium 的 eBPF 程序与内核强相关,内核未升级却升级 Cilium、或反过来,都可能出现难以定位的转发异常。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `cni` — Cilium所实现的容器网络接口规范
- `networkpolicy` — 策略语义与各CNI的支持情况
- `bgp` — BGP宣告与对等配置排障
- `hubble` — Cilium的可观测性组件
- `kube-proxy` — 被Cilium replacement取代的Service实现

### 参考链接

- [Cilium 官方文档](https://docs.cilium.io/en/stable/)
- [kube-proxy 替换](https://docs.cilium.io/en/stable/network/kubernetes/kubeproxy-free/)
- [BGP 控制平面](https://docs.cilium.io/en/stable/network/bgp-control-plane/)
- [网络策略](https://docs.cilium.io/en/stable/security/policy/)
- [系统要求](https://docs.cilium.io/en/stable/operations/system-requirements/)
