spegel
===

无状态的集群内P2P OCI镜像缓存,让节点互相拉取已缓存的镜像层

## 补充说明

**Spegel**(瑞典语「镜子」)是一个**无状态、去中心化的集群内 OCI registry mirror**。每个节点跑一个实例,它把本节点 containerd 已经拉取过的镜像暴露出来,供其他节点拉取 —— 于是同一个镜像在集群里只需要从上游 registry 拉一次。

它没有中心节点:实例之间通过 **libp2p**(Kademlia DHT)互相发现并交换「我有哪些镜像」的信息,不依赖数据库、不依赖控制面。任意节点挂掉都不影响其他节点。

**但请先看清项目的自我定位**:Spegel 官方 README 写明「这是一个 API 仍在演进、不保证支持的项目,由开发者以 best-effort 方式提供帮助,我们聚焦于 home lab 与个人贡献者场景」。它可以很好地工作,但不要默认它等同于商业支持级别的组件,上生产前请自行评估。

### 工作原理

```shell
1. 每个节点以 DaemonSet 跑一个 Spegel,监听 hostPort(默认 30020 / router 5001)
2. Spegel 读取本节点 containerd 的 content store,得到「本节点已有哪些镜像」
3. 通过 libp2p 与其他节点的 Spegel 交换索引,无需中心节点
4. 节点的 containerd 被配置成「mirror 指向本机 Spegel」
5. 拉镜像时,本机 Spegel 先问 peer 有没有;有就从 peer 拉,没有才回源上游 registry
6. 拉到的内容直接写进本机 containerd 的 content store,顺带成为下一个 peer 的源
```

关键点:**它不是一个独立运行的 registry**,而是借用本机 containerd 的 content store 作为存储,因此不需要额外的磁盘。

### 硬性前提

```shell
仅支持 containerd          # 官方明确说明「目前只支持 Containerd」,CRI-O 不支持
必须设置 registry 配置路径  # containerd 的 registry.config_path 必须显式配置,不是默认值
必须保留解包后的层          # discard_unpacked_layers 必须为 false
```

containerd 侧的最小配置(两代版本写法不同):

```shell
# containerd 2.x(配置版本 3)
version = 3

[plugins."io.containerd.cri.v1.images".registry]
  config_path = "/etc/containerd/certs.d"

[plugins."io.containerd.cri.v1.images"]
  discard_unpacked_layers = false
```

```shell
# containerd 1.x(配置版本 2)
version = 2

[plugins."io.containerd.grpc.v1.cri".registry]
  config_path = "/etc/containerd/certs.d"

[plugins."io.containerd.grpc.v1.cri".containerd]
  discard_unpacked_layers = false
```

Spegel **不会**替你写这份配置 —— 它自己也这么说:配置改动需要重启 containerd 才生效,它做不到。

### 安装

```shell
# Helm chart 走 OCI registry
helm install --create-namespace --namespace spegel \
  spegel oci://ghcr.io/spegel-org/helm-charts/spegel

# Flux 用户用 HelmRepository
```

```shell
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: spegel
  namespace: flux-system
spec:
  type: oci
  url: oci://ghcr.io/spegel-org/helm-charts
---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: spegel
  namespace: spegel
spec:
  chart:
    spec:
      chart: spegel
      sourceRef:
        kind: HelmRepository
        name: spegel
```

### 节点上的 mirror 配置

Spegel 默认用一个 init container 往节点写 `hosts.toml`。手工写的话是这样(以 `_default` 兜住所有 registry):

```shell
# /etc/containerd/certs.d/_default/hosts.toml
[host.'http://${NODE_IP}:30020']
  capabilities = ['pull', 'resolve']
  dial_timeout = '200ms'
```

注意两点:host 必须是**节点自己的 IP**,不能写 `localhost` 或 `127.0.0.1`;`dial_timeout` 要给短一点,否则 Spegel 不可用时回退到上游 registry 会被拖慢。

### 主要参数

```shell
mirroredRegistries: []            # 要镜像哪些 registry,空表示全部
additionalMirrorTargets: []       # 除 Spegel 外还要指向的额外 mirror
mirrorResolveRetries: 3           # 最多尝试几个 mirror
mirrorResolveTimeout: "20ms"      # 找 mirror 的最长耗时
containerdSock: /run/containerd/containerd.sock
containerdNamespace: k8s.io
containerdRegistryConfigPath: /etc/containerd/certs.d
containerdContentPath: /var/lib/containerd/io.containerd.content.v1.content
containerdMirrorAdd: true         # 是否让 Spegel 自己写 mirror 配置
resolveTags: true                 # 把 tag 解析成 digest
registryFilters: []               # 正则过滤要解析的 tag/registry,如 ".*:latest$"
prependExisting: false            # 已有 mirror 配置是保留还是被 Spegel 插到前面
debugWebEnabled: true             # 调试页面

service.registry.port: 5000       # 集群内 Service 端口
service.registry.nodePort: 30020  # 节点上暴露的 hostPort
service.router.port: 5001         # libp2p P2P 通信端口
service.metrics.port: 9090
priorityClassName: system-node-critical
```

### 验证是否真的生效

```shell
# 1. 在节点上确认 mirror 配置写进去了
cat /etc/containerd/certs.d/_default/hosts.toml

# 2. 在两个不同节点上各起一个用同一镜像的 Pod
kubectl run a --image=nginx:1.27 --overrides='{"spec":{"nodeName":"node-a"}}'
kubectl run b --image=nginx:1.27 --overrides='{"spec":{"nodeName":"node-b"}}'

# 3. 转发第二个 Pod 所在节点的 Spegel,看调试页面
kubectl -n spegel port-forward <spegel-pod-on-node-b> 9090:9090
# 浏览器打开 http://localhost:9090/debug/web

# 4. 看指标
curl -s http://localhost:9090/metrics | grep spegel
```

调试页面里的 **Last Mirror Success** 显示的是一个时长,说明确实通过 Spegel 服务过;显示 **Pending** 说明这次拉取根本没走 Spegel。

### 排障

```shell
# Spegel 是否起来
kubectl -n spegel get pods -o wide
kubectl -n spegel logs -l app.kubernetes.io/name=spegel --tail=200

# 节点之间能不能通(router 端口)
kubectl -n spegel exec -it <spegel-pod-a> -- nc -zv <node-b-ip> 5001

# 节点上的 Spegel registry 是否响应
curl -sv http://<node-ip>:30020/v2/

# containerd 是否真的把 mirror 读进去了
crictl info | grep -A5 registry
cat /etc/containerd/config.toml | grep -A3 config_path

# 磁盘上有没有镜像内容(Spegel 依赖 content store)
ls /var/lib/containerd/io.containerd.content.v1.content/blobs/sha256 | head
```

### 注意

1. **失败是静默的 —— 这是 Spegel 最大的坑**。任何环节没配上,镜像照样能拉下来,只是从上游 registry 直连,没有任何加速。官方文档特意点出这一点:「pull 会回退到上游 registry」,从而掩盖配置错误。判断依据只有调试页面的 `Last Mirror Success`,不能靠「镜像能拉」。
2. **必须节点间可达**。去中心化不等于不需要网络:镜像内容是从 peer 的 `hostPort` 直接拉的,如果节点之间被 NetworkPolicy、安全组或防火墙隔断,P2P 就完全不工作。Helm 里的 `networkPolicy.enabled` 是**收窄** libp2p 流量的,不是打开它。
3. **只支持 containerd**。CRI-O 用户请直接用 `registry-mirror` 那套方案,或等官方支持。
4. **`discard_unpacked_layers` 必须为 false,否则 Spegel 拿不到层**。这个默认值在多数发行版里是 true(解包后把层从 content store 删掉以省空间),正好把 Spegel 依赖的数据删没了。EKS/AL2023 默认开启,GKE 则是**无法**在 containerd 启动前改掉,所以官方把 GKE 标为不支持。
5. **必须先有 `registry.config_path`,Spegel 不会替你写**。这个路径在 containerd 里不是默认值,不改配置就没有 mirror 机制可挂。改完还要重启 containerd。
6. **mirror 地址必须写节点 IP**。写 `127.0.0.1` 或 `localhost` 会让 kubelet/containerd 打到错误的地方(而且 Spegel 的监听在 hostPort 上,不是 loopback)。
7. **K3s / RKE2 已经内置了 Spegel**,再装一份会冲突。这两个发行版的用户先查官方文档确认内置版本怎么配。
8. **Talos 需要额外放开 Pod Security**。默认的 PSA 档位太严,Spegel 的命名空间要打上 privileged 的 enforce 标签才能起来。
9. **Bottlerocket 上 containerd 配置在镜像里就固定了**,改不了,只能靠 bootstrap container,且要求 Bottlerocket v1.56 以上,同时把 `containerdMirrorAdd` 设为 false 免得两边打架。
10. **kind 需要额外差异配置**:除了配置版本要用老写法,还要把 content sharing policy 设为 `isolated`。
11. **节点自身首次拉取仍然要回源**。Spegel 缓存的是「已经拉过的镜像」,集群里第一次出现某个镜像时所有节点都是冷的,这时候没有任何加速 —— 与 Dragonfly 是同一个物理限制。
12. **`resolveTags: true` 会带来额外请求**。把 tag 解析成 digest 需要访问上游 registry,如果上游限流(Docker Hub 的匿名拉取限额),这一步本身就可能被限流。可以用 `registryFilters` 把 `.*:latest$` 之类容易变的 tag 排除掉。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `containerd` — Spegel唯一支持的容器运行时
- `registry-mirror` — 不依赖P2P的传统镜像加速配置
- `dragonfly` — 另一套P2P分发方案,有中心调度组件
- `cilium` — 用NetworkPolicy收窄libp2p流量时须放通
- `helm` — 安装Spegel的推荐方式

### 参考链接

- [Spegel 官方文档](https://spegel.dev/)
- [Spegel 快速开始](https://spegel.dev/docs/getting-started/)
- [Spegel 节点配置](https://spegel.dev/docs/usage/node-configuration/)
- [Spegel Helm Chart](https://github.com/spegel-org/spegel/tree/main/charts/spegel)
- [containerd hosts.toml 规范](https://github.com/containerd/containerd/blob/main/docs/hosts.md)
