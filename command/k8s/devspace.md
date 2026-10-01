devspace
===

用单个YAML定义构建、部署与热更新工作流的Kubernetes客户端开发工具

## 补充说明

**devspace命令** 是 Loft Labs 开源的客户端开发工具(CNCF Sandbox 项目,Apache-2.0),定位是**把「构建镜像 → 部署 → 开发调试」整条工作流写进一个 `devspace.yaml`**,让团队里不熟悉 Kubernetes 的人也能一条命令把项目跑起来。

它和 `kubectl` 一样是**纯客户端**:单个二进制,通过你的 kubeconfig 直连集群,**不在集群里常驻任何组件**。但它会在开发时**临时修改你的工作负载**(见「dev 模式做了什么」),这一点比 Tilt、Skaffold 都要激进。

核心卖点是**双向文件同步**:本地改代码,文件立刻同步进正在运行的容器,不重建镜像、不重启容器。官方强调这是「high performance, bi-directional file synchronization」。

在这批开发工具里的分工:

```shell
skaffold     构建 + 部署流水线,配置最薄,无 UI 无同步编辑体验
tilt         Tiltfile + Web UI,Live Update 偏「单向推送 + 重启进程」
devspace     devspace.yaml + 双向同步 + 终端/端口转发/SSH —— 本页
telepresence 把本地进程接入远程集群,改的是流量走向
krew         kubectl 插件管理器,与内循环无关
```

当前稳定版为 v6.x(配置版本 **`v2beta1`**),最近发布 v6.3.19(2026-04-23),另有 v6.4.0-rc.1(2026-04-30)。v6 相对 v5 有若干破坏性变更(见「注意」)。

### 安装

```shell
# Homebrew
brew install devspace

# Linux / macOS 二进制
curl -L -o devspace "https://github.com/devspace-sh/devspace/releases/latest/download/devspace-linux-amd64"
sudo install -c -m 0755 devspace /usr/local/bin

# Apple Silicon 用 devspace-darwin-arm64,Windows 用 Scoop:
scoop install devspace

# 验证
devspace version
```

### 语法

```shell
devspace [command]
```

```shell
devspace init        交互式生成 devspace.yaml
devspace dev         开发模式:构建 + 部署 + 同步 + 端口转发 + 终端
devspace deploy      构建镜像并部署一次(CI / 共享环境)
devspace build       只构建与推送镜像,不部署
devspace purge       删除本项目部署的资源
devspace run         执行 devspace.yaml 里定义的命令
devspace enter       在容器里开一个终端(进程内)
devspace logs        流式输出容器日志
devspace sync        独立运行文件同步(不构建不部署)
devspace render      只渲染清单并打印,不部署
devspace open        打开配置里定义的链接
devspace ui          启动本地 Web UI
devspace analyze     分析命名空间里 Pod 的问题并给出建议
devspace print       打印解析后的完整配置(含旧版本配置的自动升级结果)
devspace use         use namespace / context / profile / space
devspace list        list commands / profiles / vars / deployments
devspace add         add image / deployment / port / sync 等配置片段
devspace update      update dependencies
devspace cleanup     cleanup images(清理构建出的镜像)
```

`devspace dev` 的常用参数:

```shell
-b, --force-build      强制重建所有镜像
-d, --force-deploy     强制重新部署
--skip-build           跳过构建(只部署 + 同步)
--skip-deploy          跳过部署
--skip-push            不推送镜像
--build-sequential     串行构建,不并行
-i, --interactive      直接进交互式终端
-p, --profile          启用指定 profile
--var                  覆盖配置变量
-n, --namespace        指定命名空间
--kube-context         指定 kube-context
--render               只渲染不部署
```

### devspace.yaml 结构

配置的顶层键是 **`version`**(不是 `apiVersion`),当前值为 `v2beta1`。DevSpace 会把旧版本的配置在内存里自动转换到最新版,`devspace print` 可以看到转换结果。

```shell
version: v2beta1

# 1. 镜像:构建什么、推到哪
images:
  app:
    image: registry.example.com/my-app
    dockerfile: ./Dockerfile
    context: ./
    tags:
    - dev-${DEVSPACE_RANDOM}

# 2. 部署:用什么工具、什么参数
deployments:
  app:
    helm:
      chart:
        name: ./chart
      values:
        image: registry.example.com/my-app

# 3. 开发:针对哪个负载、怎么同步
dev:
  app:
    imageSelector: registry.example.com/my-app
    ports:
    - port: "8080"          # 把远端 Pod 的 8080 转发到本地
    reversePorts:
    - port: "3000"          # 把本地的 3000 暴露进容器
    sync:
    - path: ./src:/app/src
      excludePaths:
      - node_modules/
    logs:
      enabled: true
    terminal:
      enabled: true
    ssh:
      enabled: false

# 4. profile:按环境切换
profiles:
- name: prod
  patches:
  - op: replace
    path: images.app.image
    value: registry.example.com/my-app-prod

# 5. 变量与命令
vars:
- name: APP_VERSION
  value: dev
commands:
- name: test
  command: go test ./...
```

### dev 模式做了什么

`devspace dev` 不是「只开个同步」,它按顺序做这些事:

```shell
1. 读取 Dockerfile,必要时覆盖 entrypoint
2. 构建镜像并推送到仓库(除非 --skip-build / --skip-push)
3. 部署应用(等价于 devspace deploy)
4. 启动端口转发
5. 启动文件同步,先做一次 initial sync
6. 可选:开终端、流日志、建 SSH 隧道
```

**关键点:DevSpace 会替换你的 Pod。** 为了注入同步辅助进程与 SSH 隧道,它会改写 Pod 定义后重新创建。`terminal.disableReplace` 与 `attach.disableReplace` 可以让它在开终端 / attach 时不去替换 Pod,但同步功能本身仍然依赖这套机制。

### 文件同步策略:initialSync

同步分两段:**initial sync**(启动时先对齐两侧文件系统)和**之后的实时增量同步**。真正会删文件的是 initial sync,所以要重点看这个策略。

```shell
mirrorLocal    默认。以本地为准:删除容器里本地没有的文件,上传本地独有的文件,
               两侧都有但不同时以本地为准
preferLocal    与上相同,但「不删除」容器里多出来的文件
mirrorRemote   以容器为准:删除本地在容器里没有的文件,下载容器独有的文件,
               冲突以容器为准
preferRemote   与上相同,但「不删除」本地多出来的文件
preferNewest   双向合并,冲突时比较最后修改时间,取新的
keepAll        双向合并,但不解决冲突
disabled       完全不做 initial sync
```

只有两个 `mirror*` 策略会删除文件。`mirrorLocal` 删的是**容器里**的文件,`mirrorRemote` 删的是**你本机**的文件 —— 后者尤其危险,它可能把你工作区里还没进容器的文件删掉。

```shell
dev:
  app:
    imageSelector: registry.example.com/my-app
    sync:
    # 源码目录:以本地为准,但要排除依赖目录
    - path: ./src:/app/src
      excludePaths:
      - node_modules/
    # 依赖目录反过来:以容器为准,别把本地的空目录推上去
    - path: ./node_modules:/app/node_modules
      initialSync: preferRemote
      disableUpload: true
```

其他 sync 字段:

```shell
path / file                 路径映射,`本地:远端` 形式;file: true 表示同步单个文件
excludePaths / excludeFile  排除规则,gitignore 语法;排除目录会递归排除其下全部内容
uploadExcludePaths          只在「上传」方向排除
downloadExcludePaths        只在「下载」方向排除
initialSyncCompareBy        mtime 或 size,增量比较的依据
waitInitialSync             是否等 initial sync 完成再继续
disableUpload / disableDownload  关闭某个方向
onUpload.restartContainer   上传后重启容器(需要镜像内有 restart helper)
onUpload.exec               上传后执行命令;注意别让命令又触发一轮同步
bandwidthLimits             限速,单位 KB/s
polling                     用轮询代替 inotify
noWatch                     同步一次就停
```

### 与 CI / 共享环境配合

```shell
# 只构建推送镜像
devspace build

# 部署一次就退出,适合 CI
devspace deploy --skip-build

# 用指定 profile 部署
devspace deploy -p prod

# 看看最终会部署什么(不真的部署)
devspace render

# 清理
devspace purge
```

### 注意

1. **`devspace dev` 默认的 `mirrorLocal` 会删除容器里的文件**。这是最反直觉的一条:第一次连上去,容器里凡是本地没有的文件都会被删掉。如果容器里有构建产物、生成的配置、或镜像里预置的数据,请改用 `initialSync: preferLocal` 或显式排除那些路径。
2. **`mirrorRemote` 会删除你本机工作区的文件**。它以容器为准,本地独有的文件会被清掉。用在工作区上等于把没提交的代码置于风险中 —— 除非确实想「以远端为准」,否则别用它。
3. **`devspace dev` 会替换(重建)你的 Pod**。为了注入同步辅助进程和终端,它会改写 Pod 定义后重新创建。这不是无副作用的操作:如果该工作负载同时被其他人使用,他们的连接会断;有状态的工作负载更要小心。`--skip-deploy` 能避免重新部署,但替换行为仍可能在开发会话建立时发生。
4. **同一时间只应有一个 `devspace dev` 在跑**。官方文档明确不建议并行运行多个 `devspace dev`。需要额外的终端或日志会话时,用 `devspace enter` 和 `devspace logs`,不要另开一个 dev 会话。
5. **容器里要有 `tar`**。辅助进程的注入与文件同步依赖 `kubectl cp` 一类的 tar 流;`distroless`、`scratch` 这类没有 tar 的镜像会导致同步失败。
6. **`polling: true` 会显著吃 CPU**。默认用 inotify;某些挂载类型报警「inotify 数量不足」时才退化为轮询,官方文档的原话是轮询「might increase CPU consumption of the container drastically」,别默认打开。
7. **`onUpload` 里的命令不能再次触发同步**。官方专门警告:「Make sure that post-sync commands will not trigger a new sync process」—— 否则会陷入无限循环。比如命令去改被同步的文件就会这样。
8. **`onUpload.restartContainer` 有前置条件**。它要求镜像里能注入 restart helper(`injectRestartHelper`),或者镜像自带 `devspace-restart-helper` 脚本;同时必须另外指定 `command: [...]`。不满足这些条件时重启不会生效。
9. **v6 有破坏性变更**。`devspace sync` 的 `--container-path` 与 `--local-path` 已移除,统一为 `--path`;`dev.sync[*].onDownload` 被移除。照 v5 或更早的教程写配置会直接报错或静默不生效,升级前先读 v6 的迁移说明。
10. **配置的自动版本升级是「内存里」的**。DevSpace 会把旧版配置转成 `v2beta1` 再执行,但**不会改写你的文件**。想看清它到底把你的配置理解成了什么,用 `devspace print`。
11. **`imageSelector` 是「选中工作负载」的钩子,选错了会静默失效**。它按镜像名匹配 Pod,匹配不上时 `devspace dev` 不会报错说「找不到」,而是同步与端口转发整块不生效。用 `devspace list deployments` 和 `devspace analyze` 核对实际匹配到的东西。
12. **生产集群上跑 `devspace dev` 后果自负**。它按当前 kube-context 操作,并且会替换 Pod、注入辅助进程。团队里更稳的做法是把 dev 相关的 profile 与 CI 用的 profile 明确分开,并在流水线里只使用 `devspace build` / `devspace deploy`,不要用 `dev`。
13. **项目活跃度尚可但节奏偏慢**。最近一次稳定发布是 2026-04,选型时建议对比 Tilt、Skaffold 的发布节奏,并确认社区与你所用 Kubernetes 版本的兼容性。

### 相关命令

- `tilt` — 同类内循环开发工具,提供 Web UI 与 Live Update
- `skaffold` — 构建与部署流水线工具
- `telepresence` — 把本地进程接入远程集群
- `kubectl` — Kubernetes集群管理工具
- `helm` — Kubernetes包管理器
- `kustomize` — Kubernetes声明式配置定制工具

### 参考链接

- [DevSpace 官方文档](https://www.devspace.sh/docs/introduction)
- [配置文件参考(v2beta1)](https://www.devspace.sh/docs/configuration/reference)
- [文件同步配置](https://www.devspace.sh/docs/configuration/dev/connections/file-sync)
- [devspace dev 命令参考](https://www.devspace.sh/docs/cli/devspace_dev)
- [DevSpace GitHub 仓库](https://github.com/devspace-sh/devspace)
- [DevSpace v6 变更说明](https://github.com/devspace-sh/devspace/discussions/2108)
