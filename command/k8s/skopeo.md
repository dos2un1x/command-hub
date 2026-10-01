skopeo
===

在不落地的情况下直接操作远端镜像仓库,用于镜像检查、复制与离线同步

## 补充说明

**skopeo** 是 containers 项目家族里的镜像搬运工具。它和 `docker pull` / `ctr images pull` 最大的区别在于:**skopeo 不把镜像下载到本地**。

它把镜像理解成一组「传输位置(transport)」之间的搬运,源和目的地可以分别是远端仓库、本地目录、本地归档文件,或者容器存储 —— 中间那一步完全不需要落到本地镜像仓库里:

```shell
docker/skopeo inspect   查看远端镜像的元数据,一个字节的层都不下载
skopeo copy             从远端仓库直接复制到另一个远端仓库
```

这个特性在 Kubernetes 场景里非常关键:内网集群无法直连 Docker Hub,传统做法是「在能上网的机器上 `docker pull` → `docker save` → 拷贝 → `docker load`」,而用 skopeo 只需要一步跨仓库复制,既不占本地磁盘,也不会因为本地存储驱动不同而出现兼容问题。

本页讲的是 skopeo 本身。镜像在节点上的导入导出请看 `ctr` 页,运行时的调试请看 `crictl` 页。

### 安装

```shell
# Debian/Ubuntu
sudo apt-get update
sudo apt-get install -y skopeo

# RHEL / Fedora
sudo dnf install -y skopeo

# 版本
skopeo --version
```

```shell
# 用容器方式运行(不想装到宿主机时)
podman run --rm quay.io/skopeo/stable:latest --version
```

### 传输格式

skopeo 的每个位置都写成 `传输类型:引用` 的形式,这是它最核心的概念:

```shell
docker://registry.example.com/app:v1      远端仓库(Docker Registry HTTP API V2)
dir:/path/to/dir                          本地目录,层以独立文件存放,非标准格式
containers-storage:app:v1                 本地容器存储(Podman / Buildah / CRI-O 共用)
docker-archive:/path/app.tar               docker save 格式的归档
oci:/path/to/oci-dir                       OCI 镜像布局目录
oci-archive:/path/app-oci.tar              OCI 归档
docker-daemon:app:v1                       本机 docker 守护进程(需要 root)
```

最常用的是 `docker://`、`dir:`、`containers-storage:` 三种。

### 语法

```shell
skopeo [全局参数] 子命令 [子命令参数]
```

常用子命令:

```shell
copy        在两种传输位置之间复制镜像
inspect     查看远端镜像的元数据(不下载)
delete      删除远端仓库中的镜像
list-tags   列出仓库中某个镜像的全部标签
sync        在仓库与本地目录之间批量同步
login       登录仓库,保存凭据
logout      删除保存的凭据
```

### 查看镜像

不需要拉取,直接读远端元数据:

```shell
# 查看镜像的架构、层数、标签、环境变量
skopeo inspect docker://docker.io/library/nginx:1.27

# 只看某一项
skopeo inspect docker://docker.io/library/nginx:1.27 | grep -i architecture

# 查看原始 manifest(排查多架构、digest 不一致时用)
skopeo inspect --raw docker://docker.io/library/nginx:1.27

# 列出某个镜像的全部标签
skopeo list-tags docker://registry.example.com/app
```

### 复制镜像

```shell
# 远端仓库 → 远端仓库(不落地,最常用)
skopeo copy docker://docker.io/library/nginx:1.27 \
  docker://registry.example.com/library/nginx:1.27

# 远端仓库 → 本地目录
skopeo copy docker://docker.io/library/nginx:1.27 dir:/tmp/nginx

# 本地目录 → 远端仓库
skopeo copy dir:/tmp/nginx docker://registry.example.com/library/nginx:1.27

# 远端仓库 → 本地容器存储(会被 Podman / Buildah 直接看到,需要 root)
sudo skopeo copy docker://docker.io/library/nginx:1.27 \
  containers-storage:docker.io/library/nginx:1.27

# 导出为 docker save 格式的 tar(交给不支持 OCI 的老工具时)
skopeo copy docker://docker.io/library/nginx:1.27 docker-archive:/tmp/nginx.tar
```

多架构相关:

```shell
# 复制整个多架构 index(默认行为,保留所有平台)
skopeo copy --all docker://docker.io/library/nginx:1.27 docker://registry.example.com/library/nginx:1.27

# 只复制指定平台(常用于瘦身内网仓库)
skopeo copy --override-arch amd64 --override-os linux \
  docker://docker.io/library/nginx:1.27 docker://registry.example.com/library/nginx:1.27

# 多架构策略
--multi-arch=system     只复制当前系统架构
--multi-arch=all        复制全部平台
--multi-arch=index-only 只复制 index 本身(需要目标仓库能自行回源)
```

其他常用参数:

```shell
--retry-times 3                失败重试次数,跨公网复制建议加大
--src-tls-verify=false         跳过源仓库证书校验(仅测试环境)
--dest-tls-verify=false        跳过目标仓库证书校验
--dest-creds user:password     目标仓库凭据
--src-creds user:password      源仓库凭据
--format v2s2 / oci            输出格式
```

### 批量同步

`sync` 用于把一个仓库里的整批镜像搬到本地目录,是离线交付的常用入口:

```shell
# 把仓库里某个镜像的全部标签同步到本地目录
skopeo sync --src docker --dest dir registry.example.com/library/busybox /media/usb

# 同步一个 YAML 清单里列出的多个镜像
skopeo sync --src yaml --dest dir images.yaml /media/usb

# 从本地目录反向同步到内网仓库
skopeo sync --src dir --dest docker /media/usb registry.internal.example.com

# 先演练一遍,不真正写入
skopeo sync --dry-run --src docker --dest dir registry.example.com/library/busybox /media/usb
```

`images.yaml` 的写法:

```shell
registry.example.com:
  images:
    library/nginx:
      - "1.27"
      - "1.26"
    library/redis:
      - "7.2"
```

### 鉴权

```shell
# 登录(凭据默认保存在 $XDG_RUNTIME_DIR/containers/auth.json)
skopeo login registry.example.com

# 也可以直接复用 docker 的凭据文件
skopeo login --authfile ~/.docker/config.json registry.example.com

# 临时指定凭据文件
skopeo inspect --authfile /etc/containers/auth.json docker://registry.example.com/app:v1

# 源与目标使用不同凭据
skopeo copy --src-creds srcuser:srcpass --dest-creds dstuser:dstpass \
  docker://public.example.com/app:v1 docker://internal.example.com/app:v1

# 登出
skopeo logout registry.example.com
```

凭据文件查找顺序:`--authfile` 指定路径 → `$REGISTRY_AUTH_FILE` → `${XDG_RUNTIME_DIR}/containers/auth.json` → `$HOME/.docker/config.json`。也就是说,**`docker login` 过的仓库,skopeo 通常可以直接用**。

### 安全校验

```shell
# skopeo 会依据 /etc/containers/policy.json 做签名校验
cat /etc/containers/policy.json

# 只想跳过策略检查时(测试环境)
skopeo copy --remove-signatures docker://src/app:v1 docker://dst/app:v1
```

### 删除镜像

```shell
# 删除远端仓库中的一个标签
skopeo delete docker://registry.example.com/app:v1

# 按 digest 删除
skopeo delete docker://registry.example.com/app@sha256:xxxxx
```

**这要求目标仓库开启了删除功能**。以 distribution 为例,配置里必须有 `delete: enabled: true`(或环境变量 `REGISTRY_STORAGE_DELETE_ENABLED=true`);Harbor 则在配置里控制。而且删除标签只是「标记」,**真正释放磁盘还要在仓库侧跑垃圾回收**。

### 配合 Kubernetes 的典型流程

```shell
# 1. 联网机器:跨仓库复制到内网仓库(不落地)
skopeo copy --all docker://docker.io/library/nginx:1.27 \
  docker://harbor.internal.example.com/library/nginx:1.27

# 2. 完全离线:先落到目录,再拷介质,再进内网
skopeo copy --all docker://docker.io/library/nginx:1.27 dir:/tmp/nginx-1.27
tar czf nginx-1.27.tar.gz -C /tmp nginx-1.27
# ... 拷贝到内网机器 ...

# 3. 内网机器:目录 → 内网仓库
skopeo copy --all dir:/tmp/nginx-1.27 \
  docker://harbor.internal.example.com/library/nginx:1.27

# 4. 集群侧照常由 kubelet 拉取,Pod 里写内网仓库地址即可
```

节点需要预置镜像(而不是走仓库)时,再交给 `ctr images import` 或 `nerdctl load`,而不是 skopeo —— skopeo 写的是 `containers/storage`,与 containerd 的 `k8s.io` 命名空间不互通。

### 注意

1. **`skopeo copy` 不等于 `docker pull`**。它不会在本地留下任何镜像,也不会启动容器。想「拉下来留着用」请用 `docker pull`、`podman pull` 或 `ctr -n k8s.io images pull`。反过来,也正是因为它不落地,复制大镜像时几乎不占本地磁盘。
2. **`skopeo copy` 到 `containers-storage:` 通常需要 root**,因为目标存储(`/var/lib/containers/storage`)属于 root。普通用户只能写自己的那份存储,与 Podman rootless 的那套又不通用。
3. **`skopeo` 写入的 `containers/storage` 与 containerd 的 `k8s.io` 命名空间完全不相通**。用 skopeo 把镜像推进本地存储,kubelet 依然看不到,节点上还是得重新从仓库拉。它替代的是 `docker pull`,不是 `ctr images import`。
4. **多架构镜像必须显式决定 `--all` 还是 `--multi-arch`**。默认行为会复制整个 index;若目标仓库不支持或只需要单平台,不加限制会把仓库撑大好几倍。反之,用 `--override-arch` 单平台复制后,在其他架构节点上会报 `no matching manifest`。
5. `--src-tls-verify=false` / `--dest-tls-verify=false` **只是跳过校验,并不会让 HTTP 仓库变得可用**。访问纯 HTTP 的仓库要显式把地址写成 `docker://` 前缀加上允许非安全仓库的配置(`/etc/containers/registries.conf` 中的 `insecure = true`),否则报的仍是 TLS 错误。
6. `skopeo delete` **需要仓库开启删除**,且只删除 manifest/tag。**磁盘空间不会立即释放**,必须在仓库侧运行垃圾回收。没开 `delete.enabled` 时,删除请求会被拒绝或静默失败。
7. **不要对同一个仓库一边复制一边跑 GC**。垃圾回收期间被引用计数判定为「无引用」的 blob 可能正好是正在复制的层,结果是复制成功但镜像损坏。
8. `dir:` 格式是 skopeo 自己的非标准布局,**不能直接当 `docker load` 的输入**,也不能直接挂给容器运行时。需要可移植归档请用 `oci-archive:` 或 `docker-archive:`。
9. skopeo **默认会做签名策略校验**(`/etc/containers/policy.json`)。默认策略对 `docker` 传输通常是 `insecureAcceptAnything`,但如果公司镜像里改成了 `signedBy`,会出现「同样的命令在本地能跑、在 CI 里报 not trusted」。
10. `skopeo login` 保存的凭据在 `$XDG_RUNTIME_DIR` 下,**该目录在会话结束后可能被清空**。CI 里请显式用 `--authfile` 指向一个持久路径,而不是依赖 `skopeo login`。
11. 复制私有仓库镜像时,**源与目标的凭据是分开的**。只用 `--authfile` 时两个仓库共用一份凭据,源仓库没有凭据就会报 `unauthorized: authentication required`,需要改用 `--src-creds` / `--dest-creds`。
12. skopeo 走的是 registry 的 HTTP API,**不经过 kubelet、不经过 CRI**,推送完成后集群侧要等 kubelet 按 `imagePullPolicy` 自行拉取,不存在「推完节点上就有了」这回事。

### 相关命令

- `podman` — 与 skopeo 同源的容器引擎
- `buildah` — 与 skopeo 同源的镜像构建工具
- `ctr` — containerd 原生 CLI,负责节点上的镜像导入导出
- `harbor` — 常作为 skopeo 复制目标的私有仓库
- `registry` — 支持删除与垃圾回收的轻量仓库实现

### 参考链接

- [skopeo 项目仓库](https://github.com/containers/skopeo)
- [skopeo copy 手册](https://github.com/containers/skopeo/blob/main/docs/skopeo-copy.1.md)
- [skopeo sync 手册](https://github.com/containers/skopeo/blob/main/docs/skopeo-sync.1.md)
- [containers-transports 传输格式说明](https://github.com/containers/image/blob/main/docs/containers-transports.5.md)
