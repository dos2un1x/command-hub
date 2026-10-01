nydus
===

基于RAFS格式的按需加载镜像服务,把容器冷启动从分钟级压到秒级

## 补充说明

**Nydus** 是 Dragonfly 的姊妹项目,在 **RAFS**(Registry Acceleration File System)格式之上实现了一套内容寻址文件系统。它把 OCI 镜像改造成「元数据 + 分块数据」的形态,容器启动时只按需拉取真正读到的块,而不是先下载完整镜像层。

它解决的是这个具体问题:**镜像越来越大(几 GB 的 AI/Java 镜像很常见),而容器启动往往只用到其中很小一部分,却必须等整个镜像下载并解压完**。

三个关键收益:

```shell
冷启动   按需加载,只拉容器真正读到的数据块
空间     块级去重,跨层、跨镜像复用相同数据块
带宽     与 Dragonfly P2P 结合,块在节点间流转而不回源 registry
```

### 工具链

```shell
nydusd         用户态守护进程,处理内核的 FUSE/fscache 请求并解析 Nydus 镜像
               正常不需要手工启动,由 nydus-snapshotter 在准备 rootfs 时拉起
nydus-image    把单层 OCI 镜像转成 Nydus 格式,分别产出 meta(bootstrap)与 data(blob)
nydusify       镜像转换与校验的 CLI:拉取 OCI 镜像 → 调用 nydus-image → 推回 registry
nydusctl       查询 nydusd 的工作状态与指标
nydus-overlayfs  containerd 的 mount helper,给 overlayfs 补一点挂载参数
```

加上 containerd 侧的 remote snapshotter:

```shell
containerd-nydus-grpc   即 nydus-snapshotter,containerd 的非核心子项目
                        仓库:github.com/containerd/nydus-snapshotter
```

**它遇到非 Nydus 镜像时的行为与 containerd 内置的 overlayfs snapshotter 完全一致** —— 也就是说把默认 snapshotter 换成它,不会导致普通镜像跑不起来。

### 版本与状态

```shell
Nydus 本体            活跃维护中。v2.x 是稳定线,v3.0.0-alpha.x 是预发布
                      (v3.0.0-alpha.1 发布于 2026-08-04)
nydus-snapshotter     活跃维护中,托管在 containerd 组织下
                      (v0.15.15 发布于 2026-04-17)

生产环境请用 v2.x 稳定线,v3 尚在 alpha。
```

### 第一步:转换镜像格式

**这是 Nydus 与「镜像加速」类工具最大的区别 —— 它不改运行时行为,而是要求镜像本身换一种格式。** 现有的 OCI 镜像不会自动被加速。

```shell
# 从 registry 转换
nydusify convert \
  --source myregistry/repo:tag \
  --target myregistry/repo:tag-nydus

# 本地调试用
nydusify convert --source ubuntu --target localhost:5000/ubuntu-nydus

# 从本地 OCI 归档转换(离线场景)
nydusify convert \
  --source myregistry/repo:tag \
  --source-archive /path/to/source-oci-image.tar \
  --target myregistry/repo:tag-nydus

# 校验转换结果(比对 rootfs 文件元数据与数据一致性)
nydusify check --source myregistry/repo:tag --target myregistry/repo:tag-nydus
```

其他转换途径:

```shell
nerdctl image convert        # containerd 用户,nerdctl 直接支持
Acceld (goharbor/acceleration-service)   # Harbor 的通用加速转换服务
Buildkit                     # 直接从 Dockerfile 构建 Nydus 镜像
```

### 第二步:containerd 侧配置

```shell
# 注册 nydus snapshotter 为 proxy plugin
[proxy_plugins]
  [proxy_plugins.nydus]
    type = "snapshot"
    address = "/run/containerd-nydus/containerd-nydus-grpc.sock"
```

```shell
# containerd 1.x(版本 2 配置格式)
[plugins."io.containerd.grpc.v1.cri".containerd]
   snapshotter = "nydus"
   disable_snapshot_annotations = false
   discard_unpacked_layers = false
```

```shell
# containerd 2.x(版本 3 配置格式)
# 注意这三个键在 io.containerd.cri.v1.images 下,不在 .v1.runtime 下
[plugins]
  [plugins.'io.containerd.cri.v1.images']
    snapshotter = 'nydus'
    disable_snapshot_annotations = false
    discard_unpacked_layers = false
```

改完重启 containerd:

```shell
systemctl restart containerd
```

### 第三步:启动 snapshotter

```shell
# nydusd 的配置,默认落在 /etc/nydus/nydusd-config.fusedev.json
{
  "device": {
    "backend": {
      "type": "registry",
      "config": {
        "scheme": "",
        "skip_verify": false,
        "timeout": 5,
        "connect_timeout": 5,
        "retry_limit": 4,
        "auth": ""
      }
    },
    "cache": {
      "type": "blobcache",
      "config": { "work_dir": "cache" }
    }
  },
  "mode": "direct",
  "digest_validate": false,
  "enable_xattr": true,
  "fs_prefetch": { "enable": true, "threads_count": 4 }
}
```

```shell
containerd-nydus-grpc \
  --nydusd-config /etc/nydus/nydusd-config.fusedev.json \
  --log-to-stdout
```

Kubernetes 环境下推荐用 Helm 部署:

```shell
git clone https://github.com/dragonflyoss/helm-charts.git

helm install --wait --timeout 10m --dependency-update \
  --create-namespace --namespace nydus-system \
  -f config-nydus.yaml \
  nydus-snapshotter helm-charts/charts/nydus-snapshotter
```

### 运行与验证

```shell
# 用 nerdctl 直接试
nerdctl --snapshotter nydus run --rm -it localhost:5000/ubuntu-nydus:latest bash

# Kubernetes 里 Pod 直接用 Nydus 镜像
kubectl run nydus-pod --image=ghcr.io/dragonflyoss/image-service/nginx:nydus-latest

# 看 snapshotter 状态
systemctl status nydus-snapshotter
journalctl -u nydus-snapshotter -f

# 看 nydusd 是否被拉起、有没有在按需拉块
ps aux | grep nydusd
ls /var/lib/containerd/io.containerd.snapshotter.v1.nydus/

# 看启动耗时对比
kubectl get events --field-selector involvedObject.name=<pod>
```

### 与 Dragonfly 结合

```shell
# Helm 同时部署 Dragonfly 与 Nydus
helm install --create-namespace --namespace dragonfly-system \
  dragonfly helm-charts/charts/dragonfly
```

Nydus 的 blob 会通过 dfdaemon 的 storage 服务(4005 TCP / 4006 QUIC)在节点之间流转,官方给出的生产数据是网络延迟下降 80% 以上。

### 其他形态

```shell
EROFS     内核态 EROFS 自 Linux 5.16 起完全兼容 RAFS v6,未压缩镜像可直接挂块设备
          自 Linux 5.19 起支持 fscache,压缩镜像也能挂载 —— 无需 FUSE,性能更好
stargz    nydus-snapshotter 加 --enable-stargz 后也能直接跑 eStargz 镜像
nydus-zran 从现有 OCI 镜像快速生成一个很小的 zran artifact,
          无需完整转换就能加速启动
```

### 注意

1. **Nydus 不加速现有 OCI 镜像,必须先转换格式**。这是最容易误解的一点:装了 snapshotter、配好了 containerd,但如果 Pod 用的还是原来的 OCI 镜像,那就完全走不到 Nydus 路径,启动速度不会有任何变化。转换后的镜像是另一套 manifest 与 blob。
2. **转换后的镜像不再是普通镜像**。没有安装 Nydus snapshotter 的环境(比如同事的本机 Docker、其他集群)拉下来跑不起来。要同时保留两套:原镜像给通用场景,`-nydus` 后缀的给 Nydus 集群。
3. **`discard_unpacked_layers = false` 必须显式设置**。containerd 默认是 `true`,会在解包后把层从 content store 删掉;而 Nydus 需要保留这些层用于按需拉取与共享。已配错的集群会报 `content digest sha256:xxx: not found`。修复要先把开关改成 false,再用 `ctr -n k8s.io content fetch <镜像>` 把镜像重新拉回来 —— 只改配置不重新拉取是没用的,blob 已经删了。
4. **`disable_snapshot_annotations = false` 同样必须显式设置**。containerd 默认不透传镜像相关注解给 snapshotter,而 Nydus 正是靠这些注解来识别并拉取镜像。漏掉这一条的表现同样是「Succeeded to pull image 但没走 Nydus」。
5. **containerd 2.x 里这两个键在 `io.containerd.cri.v1.images` 下,不是 `.v1.runtime`**。写在 runtime 表里不会报错,只是不生效。1.x 用户则是 `io.containerd.grpc.v1.cri`。
6. **FUSE 模式需要节点上有 `/dev/fuse`**。容器化的节点、受限的安全策略、部分托管的节点池都可能没有这个设备,表现为 nydusd 起不来。kind 集群要显式把 `/dev/fuse` 挂进去。
7. **`nydusd` 不要手工启动**。它由 nydus-snapshotter 在准备容器 rootfs 时按需拉起,每个挂载点一个实例。手工起的那些会在重启后造成状态不一致。
8. **FUSE 有实打实的开销**。按需加载省下的是启动时间,代价是运行期的每次缺页都要走用户态。读密集且反复读大文件的负载要评估,或者改用内核态 EROFS(需要 Linux 5.16+,fscache 需要 5.19+)。
9. **`fs_prefetch.enable: true` 是默认值,但并非总是好事**。它会在后台预取数据,启动更快,代价是磁盘与网络压力。节点磁盘紧张或带宽有限时应当关掉。
10. **`skip_verify: true` 会跳过 registry 证书校验并允许自动降级到 HTTP**,只适合本地测试。生产环境请配好 CA。
11. **换了默认 snapshotter 后,切换回来是有代价的**。已经用 nydus snapshotter 解包的镜像与 overlayfs 的 snapshot 目录不通用;反过来切换 `snapshotter` 配置时,记得先清理 `/var/lib/containerd/io.containerd.snapshotter.v1.nydus`。
12. **v3.0.0-alpha.x 是预发布版本**。写本文时 Nydus 的最新 tag 是 2026-08-04 的 v3.0.0-alpha.1,生产环境请沿用 v2.x 稳定线。
13. **runtime-level snapshotter(只给某些 Pod 用 Nydus)需要给 containerd 打补丁**,不是官方原生能力,升级 containerd 时会丢。对多数团队来说,把 Nydus 设成全局 snapshotter 更省事 —— 反正它遇到普通镜像会退化成 overlayfs 行为。

### 相关命令

- `dragonfly` — 与Nydus配套的P2P分发系统
- `containerd` — 需要配置snapshotter与注解透传
- `crictl` — 验证镜像是否真的走了Nydus
- `nerdctl` — 支持--snapshotter nydus直接运行
- `registry-mirror` — Nydus与镜像加速是两件事,常被混淆
- `spegel` — 另一条镜像分发加速路径

### 参考链接

- [Nydus 官方文档](https://nydus.dev/)
- [Nydus 仓库](https://github.com/dragonflyoss/nydus)
- [Nydusify 转换工具](https://github.com/dragonflyoss/nydus/blob/master/docs/nydusify.md)
- [containerd 环境下的 Nydus 安装](https://github.com/dragonflyoss/nydus/blob/master/docs/containerd-env-setup.md)
- [nydus-snapshotter 在 Kubernetes 中运行](https://github.com/containerd/nydus-snapshotter/blob/main/docs/run_nydus_in_kubernetes.md)
