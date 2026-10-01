buildah
===

无需守护进程即可构建 OCI / Docker 镜像的命令行工具

## 补充说明

**buildah** 是 containers 项目家族里的镜像构建工具,与 Podman、Skopeo、CRI-O 同源。它的定位很明确:**只做构建**,不做运行。

buildah 最核心的特点是 **daemonless(无守护进程)**:

```shell
docker build      需要 docker 守护进程,构建过程发生在 daemon 里
buildah build     直接调用 runc 起一个临时容器执行 RUN,构建完即销毁
```

这意味着两件事。一是**不需要 root 权限就能构建**(配置好 subuid/subgid 后,普通用户即可完成大部分构建);二是**可以安全地在容器里跑** —— CI 里不再需要挂载 `/var/run/docker.sock` 或使用 `--privileged` 的 Docker-in-Docker。

在 Kubernetes 场景里,buildah 的常见位置是 **CI 构建步骤**:用 buildah 构建镜像 → 推送到 Harbor 之类的私有仓库 → 集群按 `imagePullPolicy` 拉取。它本身不是运行时,不参与 kubelet 的任何环节。

与 Kaniko 的区别值得一提:两者都能在无守护进程的环境下构建,但 Kaniko 是**在容器内逐条解释 Dockerfile 命令**(不创建嵌套容器,但 RUN 也没有隔离),而 buildah 是**真的起一个容器**来跑 RUN。buildah 的隔离性更好,但需要更多的内核能力。

### 安装

```shell
# Debian/Ubuntu
sudo apt-get update
sudo apt-get install -y buildah

# RHEL / Fedora
sudo dnf install -y buildah

# 版本
buildah --version
buildah info
```

```shell
# 用容器方式运行(CI 中的常见形态)
podman run --rm --device /dev/fuse -v .:/build:z quay.io/buildah/stable:latest buildah --version
```

### 两种构建方式

buildah 提供两条完全不同的路径,理解它们的区别是用好 buildah 的关键:

```shell
buildah build / buildah bud    读 Dockerfile / Containerfile,是 docker build 的替代
buildah from + run + commit    脚本式构建,每一步都是一条独立命令
```

脚本式构建的威力在于**它不受 Dockerfile 语法的限制** —— 可以用 shell 的循环、条件、变量控制构建过程,适合生成大量结构相似的镜像。

### 用 Dockerfile 构建

```shell
# 标准用法(bud 是 build 的旧名字,两者等价)
buildah build -t registry.example.com/app:v1 .
buildah bud --file Dockerfile.prod -t registry.example.com/app:v1 .

# 常用参数与 docker build 基本一致
buildah build \
  --build-arg NODE_ENV=production \
  --target builder \
  --no-cache \
  --platform linux/amd64 \
  --label org.opencontainers.image.source=https://git.example.com/app \
  -t registry.example.com/app:v1 .
```

多阶段构建与缓存:

```shell
# 多阶段构建:直接支持 FROM ... AS 语法
buildah build --target runtime -t app:v1 .

# 从远端镜像取构建缓存
buildah build --cache-from registry.example.com/app:cache -t app:v1 .

# 清理构建缓存(缓存会占用本地存储)
buildah rmi --prune
```

### 脚本式构建

```shell
# 1. 从基础镜像创建一个「工作容器」
container=$(buildah from docker.io/library/node:20-alpine)

# 2. 往里面拷文件
buildah copy $container ./app /app

# 3. 执行命令
buildah run $container -- npm ci --omit=dev
buildah run $container -- npm run build

# 4. 写镜像元数据
buildah config --workingdir /app $container
buildah config --env NODE_ENV=production $container
buildah config --port 3000 $container
buildah config --entrypoint '["node","server.js"]' $container
buildah config --user 1000:1000 $container
buildah config --label maintainer=ops@example.com $container

# 5. 提交成镜像
buildah commit $container registry.example.com/app:v1

# 6. 清理工作容器
buildah rm $container
```

### 推送与导出

```shell
# 推送到仓库
buildah push registry.example.com/app:v1

# 推送到仓库并同时打一个 latest 标签
buildah tag registry.example.com/app:v1 registry.example.com/app:latest
buildah push registry.example.com/app:latest

# 推送凭据
buildah login registry.example.com
buildah push --creds user:password registry.example.com/app:v1
buildah push --tls-verify=false registry.example.com/app:v1

# 导出为归档
buildah push registry.example.com/app:v1 docker-archive:/tmp/app.tar

# 直接写入本地容器存储(Podman / CRI-O 可直接使用)
buildah push registry.example.com/app:v1 containers-storage:registry.example.com/app:v1
```

### 镜像格式

buildah **默认输出 OCI 格式**,这一点与 `docker build` 不同,也是最常引发兼容问题的地方:

```shell
# 默认:OCI 格式
buildah build -t app:v1 .

# 输出 Docker v2s2 格式(需要兼容老工具或使用某些 Dockerfile 指令时)
buildah build --format docker -t app:v1 .

# 查看构建产物的格式
buildah inspect --type image registry.example.com/app:v1 | grep -i -A3 manifest
```

### rootless 构建

```shell
# 确认 subuid / subgid 映射
grep $USER /etc/subuid
grep $USER /etc/subgid

# 在用户命名空间中执行命令(挂载、chown 等需要真实 root 的操作)
buildah unshare
buildah unshare -- sh -c 'buildah build -t app:v1 .'

# 存储驱动:内核 overlay 受限时退化为 vfs(慢但一定能跑)
buildah --storage-driver=vfs build -t app:v1 .

# 在无法使用命名空间的环境里(某些受限的 CI 容器)
buildah build --isolation=chroot -t app:v1 .
```

### 在 CI 中的最小可用形态

```shell
# GitLab CI / Jenkins 里的典型步骤
buildah login -u "$CI_REGISTRY_USER" -p "$CI_REGISTRY_PASSWORD" "$CI_REGISTRY"

buildah build \
  --build-arg CI_COMMIT_SHA="$CI_COMMIT_SHA" \
  --format docker \
  -t "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA" \
  -t "$CI_REGISTRY_IMAGE:latest" .

buildah push "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA"
buildah push "$CI_REGISTRY_IMAGE:latest"

# 推完清理本地镜像,避免 Runner 磁盘被撑满
buildah rmi -a -f
buildah rmi --prune
```

### 与 Kubernetes 的关系

```shell
镜像构建     buildah 负责,产出推送到 registry
镜像分发     registry / harbor 负责
镜像拉取     kubelet 通过 CRI 调用 containerd / CRI-O 完成
容器运行     containerd / CRI-O 负责,buildah 不参与
```

一个容易被忽略的细节:**buildah 与 CRI-O 共用 `containers/storage`**。在同时装了 buildah 与 CRI-O 的节点上,root 身份构建出的镜像可以被 CRI-O 直接使用(前提是 Pod 的 `imagePullPolicy` 允许命中本地镜像),这在离线节点上很有价值。但 **rootless buildah 的存储与 CRI-O 的不通用**,别指望普通用户构建的镜像能被节点运行时看到。

### 注意

1. **buildah 默认输出 OCI 格式,某些 Dockerfile 指令会因此失败**。最典型的是 `SHELL`:在 OCI 格式下会直接报 `SHELL is not supported for OCI image format`,因为 `SHELL` 是 Docker 的扩展指令。解决办法是加 `--format docker`,或者干脆去掉 `SHELL`(改用 `RUN ["/bin/bash","-c","..."]`)。
2. **`COPY --link` 不支持**。它是 BuildKit 专有语法,`buildah build` 会直接解析失败。同理,`RUN --mount=type=cache` 等 BuildKit 扩展虽然在较新的 buildah 上有实现,但行为并不完全一致,**跨引擎的 Dockerfile 应尽量只用标准指令**。
3. **`COPY --chmod` 只接受八进制值**。`--chmod=a+rX,go-w`、`--chmod=+x` 这类符号写法会在**解析阶段**就报错,连 ARG 都来不及生效。需要保持可移植性时,改用 `COPY` + `RUN chmod -R a+rX,go-w`。
4. `buildah bud` 与 `buildah build` 是同一个命令的两个名字,**新脚本请统一用 `build`**。
5. **rootless 构建需要 subuid/subgid 映射**,且容器内看到的 UID 与宿主机不同。涉及 `chown`、`useradd` 的 Dockerfile 在 rootless 下行为可能与 rootful 不一致。
6. **构建缓存不共享**。`--cache-from` 用的是远端镜像,本地层缓存则存在 `containers/storage` 里。CI Runner 每次换机器就完全冷启动,该上远端缓存的场景不要省。
7. **`buildah rmi -a -f` 会删掉本地所有镜像**,在长期运行的 Runner 上是常规清理手段,但在开发机上会连自己常用的基础镜像一起删掉。
8. `buildah push` 到 `containers-storage:` 与推送到远端仓库是两回事,后者才需要凭据。**推完本地存储不等于集群能拉到**,Pod 里写的镜像地址必须与真实推送的仓库地址一致。
9. **`--tls-verify=false` 只跳过校验,不能让纯 HTTP 仓库工作**。自建仓库要么配好证书,要么在 `/etc/containers/registries.conf` 里把该仓库标记为 `insecure`。
10. 不指定 `-t` 时,buildah 不会自动生成镜像名,**未命名的镜像只能靠 ID 引用**,后续推送会很麻烦。
11. buildah 的构建产物**不会自动进入 containerd 的 `k8s.io` 命名空间**。节点需要预置镜像时,正确路径是推送到仓库后由 kubelet 拉取,或者用 `ctr images import` 导入,而不是指望 `buildah push containers-storage:`。
12. 在主流的 Kubernetes 节点上,**不要尝试用 buildah 代替运行时**。buildah 不是 CRI 实现,`kubelet --container-runtime-endpoint` 无法指向它。

### 相关命令

- `podman` — 与 buildah 同源的容器引擎
- `skopeo` — 与 buildah 同源的镜像搬运工具
- `kaniko` — 另一种集群内构建方案(已归档)
- `harbor` — 构建产物的常见落点
- `docker` — 容器管理工具

### 参考链接

- [Buildah 官方文档](https://buildah.io/)
- [Buildah 项目仓库](https://github.com/containers/buildah)
- [Containerfile / Dockerfile 语法说明](https://github.com/containers/common/blob/main/docs/Containerfile.5.md)
- [containers-storage 说明](https://github.com/containers/storage)
