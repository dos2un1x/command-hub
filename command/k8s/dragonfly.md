dragonfly
===

基于P2P技术的镜像与文件分发加速系统,CNCF毕业项目

## 补充说明

**Dragonfly** 是 CNCF **毕业**项目(2018-11-13 加入 CNCF,2020-04-09 进入孵化,2025-10-28 毕业),用 P2P 技术在集群内分发容器镜像、文件、OCI 制品与 AI 模型。它解决的核心问题是:**上千个节点同时拉同一个镜像时,不要产生上千份回源流量**。

它由两部分组成:Dragonfly 本体负责「数据块怎么在节点间流转」,姊妹项目 **Nydus** 负责「镜像怎么按需加载」。两者常一起部署,但可以独立使用。

历史名称需注意:项目仓库曾叫 `dragonflyoss/Dragonfly2`,现在统一为 `dragonflyoss/dragonfly`;当前稳定线是 v2.5.x,容器镜像仓库前缀是 `dragonflyoss/`(`client`、`scheduler`、`manager`)。

### 组件与角色

```shell
manager      控制面。存储 seed-peer / scheduler 集群的动态配置,维护二者关系,
             通过 keepalive 感知实例健康,为 dfdaemon 挑选最优 scheduler 集群。
             提供 Web 控制台、Open API、预热任务、多集群管理。
             依赖 MySQL 与 Redis(Helm 里可用内置的,也可外接;也支持 PostgreSQL)。
             端口:REST 8080,GRPC 65003。

scheduler    调度面。为每个下载任务构建 P2P 调度树,用多特征智能调度挑选最优父节点,
             剔除异常 peer;调度失败时告诉 peer 回源下载。
             端口 8002,Service 是 headless 的,客户端通过 DNS 发现全部实例。

seed-peer    回源节点。本质是「跑在 Seed Peer 模式下的 dfdaemon」,是 P2P 树的根节点,
             负责从源站(registry / 对象存储)把数据拉进来,再分给普通 peer。
             没有它就没人回源,整个 P2P 网络拿不到新数据。

dfdaemon     节点级 agent,以 DaemonSet 部署,是真正干活的进程。
             提供 gRPC 给 dfget 调用,伪装成 registry 的 mirror 或 HTTP 代理,
             同时向 scheduler 上报、向 manager 拉取动态配置。
```

dfdaemon 的默认端口:

```shell
4000    upload 服务的 gRPC 端口
4001    proxy 服务端口,containerd/CRI-O 的 mirror 指向这里
4002    metrics
4003    health
4004    download 服务的 gRPC 端口
4005    storage 服务的 TCP 端口(向其他 peer 供块)
4006    storage 服务的 QUIC 端口(向其他 peer 供块)
```

### 一次镜像拉取的完整链路

```shell
1. kubelet 让 containerd 拉 image
2. containerd 按 hosts.toml 把请求打到本节点 dfdaemon 的 proxy(4001)
3. dfdaemon 向 scheduler 发起调度请求
4. scheduler 返回若干「已有该块的父节点」,或告诉它回源
5. dfdaemon 从父节点并发拉块;父节点不够时,seed-peer 回源补数据
6. dfdaemon 把块拼好返回给 containerd,同时自己也成为后续请求的父节点
```

### 语法

```shell
helm repo add dragonfly https://dragonflyoss.github.io/helm-charts/
helm install --create-namespace --namespace dragonfly-system \
  dragonfly dragonfly/dragonfly

kubectl -n dragonfly-system get pods
kubectl -n dragonfly-system get svc

# 也可用 OCI 方式安装
helm install --create-namespace --namespace dragonfly-system \
  dragonfly oci://ghcr.io/dragonflyoss/helm-charts/dragonfly
```

### 与 containerd 的对接

dfdaemon 会自动改写节点的 containerd 配置,把每个 registry 的 mirror 指向自己。Helm 里的关键配置:

```shell
manager: …              # 控制面,restPort 8080 / grpcPort 65003
scheduler:
  config:
    server:
      port: 8002        # 客户端连接端口
      advertisePort: 8002
seedClient:             # 即 seed-peer,独立的一份 dfdaemon 配置
  enable: true
  replicas: 3
  image:
    repository: dragonflyoss/client
client:                 # 即每节点的 dfdaemon
  config:
    proxy:
      addr: http://127.0.0.1:4001
    containerRuntime:
      containerd:
        configPath: /etc/containerd/config.toml
        proxyAllRegistries: true     # 生成 _default/hosts.toml,兜住所有 registry
        registries:
          - hostNamespace: docker.io
```

它同时兼容 containerd 两代 CRI 插件 ID:配置版本 2 用 `io.containerd.grpc.v1.cri`,版本 3 用 `io.containerd.cri.v1.images`;也可以手工指定 `criPluginId`。

生成的 `hosts.toml` 形态与手工配置的镜像加速完全一致:

```shell
server = "https://registry-1.docker.io"

[host."http://127.0.0.1:4001"]
  capabilities = ["pull", "resolve"]
```

### 常用操作

```shell
# 查看组件状态
kubectl -n dragonfly-system get pods -o wide
kubectl -n dragonfly-system logs -l app=dfdaemon --tail=200

# 查看 scheduler 日志(调度失败会打在这里)
kubectl -n dragonfly-system logs -l app=scheduler --tail=200

# 查看 seed-peer 是否在回源
kubectl -n dragonfly-system logs -l app=seed-client --tail=200

# 查看端口与 Service
kubectl -n dragonfly-system get svc
kubectl -n dragonfly-system get endpointslice

# 确认节点上的 containerd 是否被改写
cat /etc/containerd/certs.d/docker.io/hosts.toml
cat /etc/containerd/certs.d/_default/hosts.toml

# dfget 命令行下载(Dragonfly 自带的客户端)
dfget -O /tmp/file https://example.com/big.iso
dfget --url https://example.com/big.iso --output /tmp/file
```

### 与 Nydus 配合

```shell
# 同时部署 Dragonfly 与 Nydus
git clone https://github.com/dragonflyoss/helm-charts.git
helm install --wait --timeout 10m --dependency-update \
  --create-namespace --namespace dragonfly-system \
  dragonfly helm-charts/charts/dragonfly
```

Nydus 的 blob 通过 dfdaemon 的 storage 服务(4005 TCP / 4006 QUIC)在节点间流转,官方给出的生产数据是网络延迟下降 80% 以上。

### 排障

```shell
# 1. 拉取慢但没报错 —— 先确认到底有没有走 P2P
kubectl -n dragonfly-system logs -l app=dfdaemon --tail=500 | grep -i "peer\|parent\|back.source"

# 2. 看 scheduler 是否收到了这个任务
kubectl -n dragonfly-system logs -l app=scheduler --tail=500 | grep -i "<镜像名>"

# 3. 调度失败会回落成回源,表现为「能用但没提速」
#    检查 seed-peer 是否 Ready
kubectl -n dragonfly-system get pods -l app=seed-client

# 4. 检查 hosts.toml 是否真被写进去了
cat /etc/containerd/certs.d/_default/hosts.toml

# 5. 检查 dfdaemon 与 scheduler 的连通性
kubectl -n dragonfly-system exec -it <dfdaemon-pod> -- \
  curl -sv http://dragonfly-scheduler.dragonfly-system.svc:8002

# 6. 检查 manager 依赖的 MySQL / Redis
kubectl -n dragonfly-system get pods | grep -E "mysql|redis"
kubectl -n dragonfly-system logs -l app=manager --tail=200
```

### 注意

1. **dfdaemon 与 scheduler 是完全不同的角色,不要混着看日志**。dfdaemon 在节点上(容器镜像 `dragonflyoss/client`),scheduler 是集群级的无状态服务(端口 8002)。「下载慢」的问题八成在 dfdaemon 侧(没配上 mirror),「调度不到父节点」的问题才在 scheduler 侧。
2. **seed-peer 不是可选项**。它是 P2P 树的根与回源出口,`seedClient.enable=false` 或副本数为 0 时,集群里没有任何节点能回源,所有拉取都会退化。它本身就是一份 dfdaemon 配置(`seedPeer.type: super`),别把它当成「另一个 scheduler」。
3. **manager 依赖 MySQL 与 Redis,是整套里最容易先挂的组件**。manager 挂掉后已有 P2P 流量不受影响,但 dfdaemon 的动态配置无法刷新、新节点拿不到 scheduler 列表,表现为「跑着跑着新 Pod 起不来了」。生产环境建议外接数据库而不是用 Helm 内置的。
4. **dfdaemon 是直接改写节点上 `config.toml` 与 `certs.d` 的,会和已有的镜像加速配置打架**。已经手工配过 `registry-mirror` 的集群,要先决定由谁负责写 `hosts.toml`,否则两边互相覆盖;`prependExisting` 类的选项决定谁在前。
5. **`proxyAllRegistries: true` 会生成 `_default/hosts.toml`,影响集群里所有 registry**。这是最省事的配置,但也意味着任意 registry 的拉取都会先经过 dfdaemon;私有仓库、免认证仓库、特殊 path 的仓库出问题时,先把它关掉缩小范围。
6. **containerd 的配置版本决定插件 ID**。v2 配置写 `[plugins."io.containerd.grpc.v1.cri".registry]`,v3 配置写 `[plugins."io.containerd.cri.v1.images".registry]`。写错不会报错,只是不生效 —— 表现就是「配了 Dragonfly 但流量没走它」。
7. **P2P 加速的前提是块已经在别的节点上**。集群里第一次拉某个镜像,所有人都是冷启动,速度与直连 registry 相当甚至略慢(多了一跳调度);要覆盖冷启动,靠的是预热(preheat)任务或 seed-peer 提前回源。
8. **Dragonfly 加速的是「块」,不是「层」**。如果业务镜像每一层都不同,块级复用率就低;共用基础镜像的集群收益最明显。
9. **快速判断有没有生效**:在节点上 `curl -sv http://127.0.0.1:4001/v2/` 看 dfdaemon 的 proxy 是否响应;或直接 `kubectl -n dragonfly-system logs -l app=dfdaemon | grep -c peer`,有 peer 关键字说明确实走了 P2P。
10. **不要用「镜像能不能拉下来」判断 Dragonfly 是否工作**。dfdaemon 调度失败会静默回源,拉取照常成功,只是完全没有加速 —— 这是最常见的「配了但没用」。
11. **v1 与 v2 架构不同**。老教程里的「supernode」在 v2 里已经不存在,被 scheduler + seed-peer 取代;看到 `supernode` 字样的文档基本是 v1 时代的。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `nydus` — 与Dragonfly配套的按需加载镜像格式
- `containerd` — 被dfdaemon改写registry配置的运行时
- `registry-mirror` — 手工配置镜像加速的等价方案
- `harbor` — 常用于作为Dragonfly的上游registry
- `helm` — 安装Dragonfly的推荐方式

### 参考链接

- [Dragonfly 官方文档](https://d7y.io/docs/)
- [Dragonfly 架构说明](https://d7y.io/docs/concepts/terminology/architecture/)
- [Dragonfly Helm Charts](https://github.com/dragonflyoss/helm-charts)
- [containerd registry 配置(hosts.toml)](https://github.com/containerd/containerd/blob/main/docs/hosts.md)
- [CNCF Dragonfly 项目页](https://www.cncf.io/projects/dragonfly/)
