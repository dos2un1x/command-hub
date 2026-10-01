kaniko
===

Google 已归档的集群内镜像构建工具,可在无守护进程的容器里解释执行 Dockerfile

## 补充说明

**项目已归档,不再维护。** Google 于 **2025 年 6 月 3 日** 将 `GoogleContainerTools/kaniko` 仓库归档为只读,README 顶部的原文是「This project is archived and no longer developed or maintained.」。`gcr.io/kaniko-project` 下的镜像从此冻结,不再更新,也不会再修复任何安全漏洞。

**现状时间线:**

```shell
2025-06-03   GoogleContainerTools/kaniko 归档,进入只读
2025-06      Chainguard 启动 EmeritOSS 计划,Kaniko 是首批项目之一
2025-10      osscontainertools/kaniko 社区分支仍在招募维护者,长期只有单一维护人
```

**当前可选的替代路线:**

```shell
chainguard-forks/kaniko        Chainguard 的维护型分支,只修 CVE、更依赖、修小 bug,不加新功能
osscontainertools/kaniko       社区分支,维护者数量有限,稳定性需自行评估
BuildKit(buildkitd)           官方推荐的现代方案,支持 rootless、多架构、缓存挂载
buildah                        无守护进程,构建隔离性好,详见 buildah 页
nerdctl build                  在节点上直接用 BuildKit 构建,详见 nerdctl 页
```

**如果是新建项目,请直接选 BuildKit**;如果只是想让存量流水线继续跑,至少把镜像从 `gcr.io/kaniko-project/executor` 换成仍在收 CVE 补丁的分支镜像,并固定 digest。

本页保留 kaniko 的用法说明,原因有两个:大量存量 CI 流水线仍在用它;它的设计思路(在容器内解释执行 Dockerfile)也是理解其他无守护进程构建方案的基础。

### 工作原理

kaniko 与传统构建工具的根本区别在于:**它不创建嵌套容器,也不调用任何运行时**。

```shell
docker build    起一个容器执行 RUN,由守护进程调度
buildah build   起一个容器执行 RUN,直连 runc
kaniko          在自身进程内逐条解释 Dockerfile,直接把结果写进镜像层
```

流程大致是:

```shell
1. 读取 --context 指定的构建上下文,取到 Dockerfile 与构建文件
2. 解包基础镜像的文件系统到容器内的根目录
3. 逐条执行 Dockerfile 指令:
     RUN   在解包出来的文件系统里直接执行(chroot 语义,没有嵌套容器)
     COPY  直接写文件
     其余指令改动镜像配置
4. 每条指令执行后对文件系统做一次快照,计算出这一层的差异
5. 把快照结果打包成层,推送或输出到 --destination
```

这带来两个直接结果。好处是**不需要守护进程,也不需要 `--privileged`**;代价是 **RUN 命令没有任何隔离** —— 构建环境就是正在构建的镜像本身,`/kaniko` 目录对 RUN 可见,恶意 Dockerfile 可以逃逸出来。**永远不要用它构建来源不可信的 Dockerfile。**

### 使用方式

kaniko 是一个镜像,不是一个可以随手安装的二进制:

```shell
gcr.io/kaniko-project/executor:latest       正式镜像
gcr.io/kaniko-project/executor:debug        带 shell 的调试镜像(排障用)
```

```shell
# 在本地直接跑(需要能访问 docker 或 podman)
docker run \
  -v "$PWD":/workspace \
  -v "$HOME/.docker":/kaniko/.docker \
  gcr.io/kaniko-project/executor:latest \
    --context=dir:///workspace \
    --dockerfile=Dockerfile \
    --destination=registry.example.com/app:v1
```

**不要在 kaniko 镜像之外重新打包它**。它依赖自身文件系统的固定布局,换个基础镜像重新构建后运行,往往会产出损坏的镜像。

### 在 Kubernetes 中构建

这是 kaniko 设计的主场:**在一个普通的 Pod 里完成构建,不需要挂载 docker.sock,也不需要特权**。

```shell
apiVersion: v1
kind: Pod
metadata:
  name: kaniko-build
spec:
  containers:
    - name: kaniko
      image: gcr.io/kaniko-project/executor:latest
      args:
        - "--context=git://github.com/example/app.git#refs/heads/main"
        - "--destination=registry.example.com/app:v1"
        - "--cache=true"
        - "--cache-repo=registry.example.com/cache/app"
      volumeMounts:
        - name: docker-config
          mountPath: /kaniko/.docker
  restartPolicy: Never
  volumes:
    - name: docker-config
      configMap:
        name: docker-config
```

私有仓库的凭据以 `config.json` 的形式挂到 `/kaniko/.docker/config.json`:

```shell
# 从现有凭据生成
kubectl create secret generic regcred \
  --from-file=config.json=$HOME/.docker/config.json

# 或者手工构造一个 Secret
kubectl create secret docker-registry regcred \
  --docker-server=registry.example.com \
  --docker-username=robot$ci \
  --docker-password='******'
```

注意 **`docker-registry` 类型的 Secret 生成的是 `.dockerconfigjson` 键**,而 kaniko 要的是 `/kaniko/.docker/config.json` 这个**路径**。直接挂 `docker-registry` Secret 需要额外指定 `items` 与 `path`,否则文件挂出来名字不对,kaniko 读不到凭据。

### 构建上下文

```shell
--context=dir:///workspace                 本地目录
--context=git://github.com/example/app.git 远端 Git 仓库
--context=git://.../app.git#refs/heads/main 指定分支
--context=git://.../app.git#refs/tags/v1.0  指定标签
--context=s3://bucket/path/context.tar.gz   S3 对象
--context=gs://bucket/context.tar.gz        GCS 对象
--context=tar:///workspace/context.tar.gz   本地 tar 包
--context=https://example.com/context.tar.gz HTTPS 直链
--context=/workspace                        默认值,等同于 dir:///workspace
```

用 `git://` 时要在同一个 Pod 里放一个 `git` 凭据 Secret,否则私有仓库拉不动。

### 缓存

集群内构建最怕每次都是冷启动,kaniko 的缓存有两条路:

```shell
--cache=true          开启缓存
--cache-repo=...      缓存层存放的仓库,不指定时默认用 --destination 所在仓库
--cache-dir=/cache    本地缓存目录,需自行挂载可写卷
--cache-ttl=336h      缓存有效期,默认两周
```

缓存仓库必须**可写**,CI 用的机器人账号要有 push 权限:

```shell
--cache=true
--cache-repo=registry.example.com/cache/app
--cache-ttl=168h
```

另外建议给构建 Pod 挂一个临时卷作为 `/cache`,可以显著减少对远端缓存的往返:

```shell
volumeMounts:
  - name: cache
    mountPath: /cache
volumes:
  - name: cache
    emptyDir: {}
```

### 常用参数

```shell
--dockerfile=Dockerfile             Dockerfile 路径,默认取上下文根下的 Dockerfile
--destination=registry/app:v1       推送目标,可重复写多次推多个仓库
--target=builder                    只构建到某个多阶段阶段
--build-arg=KEY=VALUE               构建参数
--label=key=value                   追加标签
--no-push                           只构建不推送
--tar-path=/out/image.tar           输出为 tar
--snapshot-mode=redo                快照模式:full / redo / time
--use-new-run                       启用更快的 RUN 实现(实验性)
--insecure                          允许推送时使用 HTTP
--skip-tls-verify                   跳过推送时的证书校验
--skip-tls-verify-pull              跳过拉取基础镜像时的证书校验
--verbosity=info                    日志级别:panic / fatal / error / warn / info / debug / trace
--force                             即使基础镜像未变化也重新构建
--ignore-path=/workspace/.git       快照时忽略的路径
--custom-platform=linux/arm64       指定目标平台
```

### 注意

1. **项目已归档,这是最大的风险**。基础镜像、Go 依赖里的 CVE **不会再有人修**,`gcr.io/kaniko-project/executor:latest` 会一直停在归档时的版本。继续使用请务必固定 digest,并规划迁移到 BuildKit / buildah。
2. **kaniko 不做多架构构建**。它没有 QEMU 模拟,`--custom-platform` **不是交叉编译**,构建节点必须本身就是目标架构。要产出多架构镜像必须开多个 Job 分别跑,然后手工合并 manifest。
3. **RUN 没有隔离**。构建环境就是被构建的镜像本身,且 `/kaniko` 对 RUN 可见。**不要用 kaniko 构建不可信的 Dockerfile**,这等同于让它在你的集群里跑任意代码。
4. **kaniko 通常仍需要以 root(uid 0)运行**。虽然它不需要 `--privileged`,但 `apt-get install`、`chown`、`useradd` 这类操作要求 uid 0。盲目设置 `runAsNonRoot: true` 会让构建在第一步就失败。
5. **私有仓库的凭据路径必须精确**。kaniko 只读 `/kaniko/.docker/config.json`。用 `kubectl create secret docker-registry` 创建的 Secret 键名是 `.dockerconfigjson`,直接挂载不会落在正确路径上,需要通过 `items` + `path` 映射。
6. **`--cache-repo` 指向的仓库必须存在且可写**。缓存层推送失败不会让构建中断,但会**静默地每次都全量重建**,表现为流水线越来越慢却查不出原因。
7. **不挂 `/cache` 时缓存只存在于远端仓库**,每次构建的网络往返都很大。给 Pod 加一个 `emptyDir` 是最省事的优化。
8. **构建上下文的体积会被完整读取**。用 `dir://` 且目录里有 `node_modules`、`.git` 时,上下文会先被打包再传输,既慢又占内存。请用 `.dockerignore` 或 `--ignore-path` 排除。
9. **每条指令后都要对文件系统做一次快照**,这是纯用户态的哈希计算,比内核层的 overlay 慢。大镜像构建明显比 BuildKit 慢是正常现象,不是配置问题。
10. **`--no-push` 与 `--tar-path` 常用于调试**。但注意 kaniko 产出的是 OCI 布局的 tar,**不能直接 `docker load`**,需要先 `skopeo copy oci-archive:... docker-archive:...` 转换。
11. **构建失败后 Pod 会留在集群里**。用 Job 而不是裸 Pod,并设置 `backoffLimit` 与 `ttlSecondsAfterFinished`,否则失败的构建 Pod 会不断堆积。
12. 迁移到 BuildKit 后,**`--context` 的语义并不一一对应**,`git://` 上下文需要改用 `buildctl` 的 git 源或者由 CI 先 clone;`--cache-repo` 则对应 `--import-cache` / `--export-cache type=registry`。迁移前请先验证缓存行为。
13. kaniko 的调试镜像 `:debug` 里带 shell(**正式版镜像里没有 shell**)。排查挂载与凭据问题时先用 `:debug` 进去手工执行一次,能省下大量时间。

### 相关命令

- `buildah` — 无守护进程的镜像构建工具,kaniko 的主要替代之一
- `nerdctl` — 借助 BuildKit 在节点上构建
- `skopeo` — 转换 kaniko 产出的 OCI 归档
- `harbor` — 构建产物的常见落点
- `pod` — kaniko 以 Pod / Job 形式运行

### 参考链接

- [kaniko 项目仓库(已归档)](https://github.com/GoogleContainerTools/kaniko)
- [Chainguard 维护分支 chainguard-forks/kaniko](https://github.com/chainguard-forks/kaniko)
- [社区分支 osscontainertools/kaniko](https://github.com/osscontainertools/kaniko)
- [Chainguard EmeritOSS 计划说明](https://www.chainguard.dev/unchained/fork-yeah-were-bringing-kaniko-back)
