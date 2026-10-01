tilt
===

把Kubernetes微服务的本地开发环境写成代码的开发内循环工具

## 补充说明

**tilt命令** 是 Docker(原 Tilt Labs)开源的开发环境编排工具,一句话概括它的定位:**Kubernetes for Prod, Tilt for Dev** —— 把「改一行代码 → 看到效果」这条链路自动化。

它解决的问题很具体:一个微服务应用跑在 Kubernetes 上,你改了 `main.go`,正常流程要重新构建镜像、推仓库、改 tag、`kubectl apply`、等滚动更新。Tilt 把这套流程压成 **保存文件 → 自动重建 → 自动部署 → 日志聚合**,并把所有资源的状态集中在一个本地 Web UI 里。

两个核心概念:

```shell
Tiltfile        用 Starlark(Python 方言)写的一段脚本,描述「这个项目的开发环境长什么样」
                包含:构建哪些镜像、部署哪些 YAML、镜像和资源怎么对应、哪些文件走热更新
Live Update     不重建镜像,把改动的文件直接同步进正在运行的容器(见下)
```

Tilt 的架构很轻:**引擎跑在你本机**,通过你的 kubeconfig 直接和集群对话,集群里不安装任何常驻组件(只有 Live Update 时才在 Pod 里临时执行命令)。这一点和 Skaffold 一致,和 Telepresence、DevSpace 不同。

在这批开发工具里的分工:

```shell
skaffold     构建 + 部署流水线,`skaffold dev` 也能监听重建,但无 UI、无热更新编辑体验
tilt         Tiltfile 描述环境 + Web UI + Live Update —— 本页
devspace     devspace.yaml 描述环境 + 双向文件同步 + 终端/端口转发
telepresence 把本地进程接入远程集群,改的是流量走向,不重建镜像
krew         kubectl 插件管理器,与内循环无关
```

**Tilt Cloud 已于 2022 年关闭。** 2022-05-19 起只读(无法注册、无法建团队、无法保存云端 Snapshot),2022-06-17 服务器关停并删除所有已保存的 Snapshot;代码库归档在 `docker/tilt-dev-cloud-archived`,`cloud.tilt.dev` 现在只剩一个静态说明页。自 v0.30.0 起 Snapshot 改为**纯离线**功能。所有团队协作类特性(共享 Snapshot、团队面板)都已不存在,不要再按旧教程去找「Tilt Cloud」入口。项目本体仍在积极维护,最近版本 v0.37.7(2026-08-15)。

### 安装

```shell
# 官方脚本(macOS / Linux)
curl -fsSL https://raw.githubusercontent.com/tilt-dev/tilt/master/scripts/install.sh | bash

# Homebrew
brew install tilt

# 其他包管理器:Scoop、Conda、asdf 见官方安装文档
# Windows 用 install.ps1

# 验证
tilt version
```

### 语法

```shell
tilt [command]
```

```shell
tilt up              启动 Tilt,按 Tiltfile 构建并部署(最常用)
tilt ci              以 CI 模式运行:所有任务完成且服务健康即退出,失败则非零退出
tilt down            删除本次启动部署的资源
tilt trigger         手动触发某个资源的更新
tilt args            查看/修改传给 Tiltfile 的参数
tilt logs            在终端输出某个资源的日志
tilt get / describe  读取 Tilt 内部对象(类似 kubectl)
tilt enable/disable  临时启用或禁用某个资源
tilt wait            等待指定资源达到某状态
tilt snapshot        生成/查看环境快照(离线)
tilt doctor          输出环境诊断信息
tilt verify-install  自检:集群能否正常连接与应用
tilt dump            导出引擎内部数据(排障用);tilt alpha 为实验性命令
```

### Tiltfile 常用函数

Tiltfile 是 Tilt 的全部配置入口。常用的几个:

```shell
docker_build(ref, context)                  用 docker build 构建镜像
custom_build(ref, command, deps)            用你自己的命令构建镜像(如 buildkit、bazel)
k8s_yaml(paths)                             部署这些 YAML(文件路径或 Blob)
k8s_resource(workload, port_forwards=[...]) 给资源配端口转发、依赖、名字等
k8s_kind(kind, image_json_path=[...])       告诉 Tilt 某个 CRD 的镜像字段在哪
k8s_custom_deploy(name, apply_cmd, delete_cmd) 用自定义命令部署(如 helm install)
helm(path_to_chart, values=[...])           用 helm template 渲染并返回 Blob
kustomize(path_to_dir)                      用 kustomize 渲染并返回 Blob
docker_compose(config_paths) / dc_resource(name)  把 compose 当资源来源并配置
local_resource(name, cmd, deps=[...])       在本机跑命令(如跑测试、生成代码)
allow_k8s_contexts(contexts)                允许 Tilt 操作这些集群上下文(安全闸,见下)
default_registry(host)                      把本地镜像名改写到某个仓库
config.set_enabled_resources([...])         默认启用哪些资源
update_settings(max_parallel_updates=3, ...) 调并行度与超时
trigger_mode(TRIGGER_MODE_MANUAL)           全局默认改为手动触发
load(path, *args) / include(path)           拆分 Tiltfile(include 已不推荐,改用 load)
read_file(path) / watch_file(path)          读文件 / 监听文件变化触发 Tiltfile 重载
encode_json(obj)                            把对象序列化成 JSON Blob
workload_to_resource_function(fn)           自定义「K8s 对象 → 资源名」的映射规则
```

一个最小可用的 Tiltfile:

```shell
docker_build('registry.example.com/my-app', '.')        # context 为当前目录
k8s_yaml(['k8s/deployment.yaml', 'k8s/service.yaml'])   # 部署清单

k8s_resource(                                           # 配端口转发与依赖
  'my-app',
  port_forwards=['8080:8080'],
  resource_deps=['postgres'],
)

local_resource('test', 'go test ./...', deps=['.', 'go.mod'])   # 纯本地任务
```

### Live Update:不重建镜像的热更新

这是 Tilt 最有价值的能力。`live_update` 是 `docker_build()` / `custom_build()` / `k8s_custom_deploy()` 的一个参数,由一串**步骤函数**组成:

```shell
initial_sync()            可选,必须放第一位:首次看到容器运行(以及每次重启)时做一次全量同步
fall_back_on(files)       可选,靠前放置:命中这些文件的改动强制走「完整重建 + 重新部署」
sync(local_path, remote_path)  核心步骤:文件变动时把本地路径同步进容器(本地删除会同步删除远端)
run(cmd, trigger=[...])   在运行的容器里执行命令(如重启进程)
```

三条硬性规则:

```shell
1. 步骤顺序固定:initial_sync → fall_back_on → sync → run
2. run 步骤必须全部排在 sync 步骤之后
3. 至少要有 sync 步骤 —— 官方原话是 "Tilt will only run a Live Update if it
   detects a change to one or more files matching a sync step"
```

示例:

```shell
docker_build(
  'registry.example.com/my-app',
  '.',
  live_update=[
    # 依赖清单变了就整体重建,别试图热更
    fall_back_on(['go.mod', 'go.sum']),
    # 把本地源码同步进容器
    sync('./cmd', '/app/cmd'),
    sync('./internal', '/app/internal'),
    # 只在这些文件变化时重启进程
    run('pkill -f /app/server || true', trigger=['./cmd', './internal']),
  ],
)
```

改动文件落在不同位置时 Tilt 的行为:

```shell
命中 sync                     → 走 Live Update(最快)
在构建上下文内但没命中 sync     → 走完整 docker build + 重新部署(慢)
既不在 sync 也不在上下文内      → 什么都不会发生(静默,最容易困惑)
命中 fall_back_on             → 强制完整重建 + 重新部署(优先级最高)
```

`initial_sync()` 只上传、**不删除容器里的文件**,排除规则沿用镜像自身的文件监听设置(`.dockerignore`、`ignore=`、`only=`)。

### 为什么需要 docker_build_with_restart

`run()` 里重启进程需要容器里有 shell。官方提供了 `restart_process` 扩展:把 `docker_build()` 换成 `docker_build_with_restart()`,再指定 `entrypoint`,它会在容器里注入一个包装脚本来管理进程生命周期。

```shell
# 需要在 Tiltfile 顶部加载扩展
load('ext://restart_process', 'docker_build_with_restart')

docker_build_with_restart(
  'registry.example.com/my-app',
  '.',
  entrypoint=['/app/server'],
  live_update=[
    sync('./internal', '/app/internal'),
  ],
)
```

`docker_build_with_restart` 的适用边界很明确,**以下情况都不可用**:

```shell
Docker Compose 资源         → 用 restart_container()(仅 Compose 支持)
custom_build 构建的镜像     → 不支持
没有 shell 的镜像           → scratch、distroless 等
CRD                        → 不支持
```

没有 shell 又想重启进程时,官方给的备选是 rerun-process-wrapper 脚本(同样需要 shell)或用 `entr` 监听一个约定文件(如 `/restart.txt`,也需要 shell 且文件得存在)。

### 安全闸:allow_k8s_contexts

Tilt 默认**拒绝**向未经允许的集群上下文部署,目的是防止手滑打到生产。开箱即用的白名单是本机开发集群:Minikube、Docker for Desktop、Microk8s、Red Hat CodeReady Containers、Kind、K3D、Krucible。要往别的集群部署,必须在 Tiltfile 里显式放行:

```shell
# 允许一个或多个上下文
allow_k8s_contexts('staging-cluster')

# 注意:k8s_context() 等价于「放行任意上下文」,等于关掉这道闸
# 官方文档把它和手工校验脚本一起给出,意思是「你自己负责校验」
allow_k8s_contexts(k8s_context())
```

### 常用工作流

```shell
# 启动:构建 + 部署 + UI
tilt up

# 只启动部分资源(Tiltfile 未用 config.parse 时,参数即资源名)
tilt up my-app postgres

# 指定 Tiltfile 与命名空间
tilt up -f ./dev/Tiltfile --namespace dev

# 不自动转发端口
tilt up --port-forwards=false

# 改变更新策略:image(重建镜像)/ container / exec / auto
tilt up --update-mode=container

# 改端口(默认 10350)
tilt up --port 10360

# 退出时导出快照,便于事后分析
tilt up --output-snapshot-on-exit=/tmp/tilt-snapshot.json

# CI 模式:所有任务完成且服务健康则退出 0,构建失败或服务崩溃则非零
tilt ci

# 手动触发某个资源
tilt trigger my-app

# 看日志
tilt logs my-app

# 清理本次部署的资源
tilt down
```

UI 默认地址是 `http://localhost:10350`。

### 注意

1. **Ctrl+C 退出 `tilt up` 不会清理集群资源**。官方文档写得很清楚:Kubernetes 与 Docker Compose 资源在退出后**继续运行**,需要用 `tilt down` 显式删除;只有用 `serve_cmd` 启动的长期本地进程会被停止。别以为退出就等于收拾干净了。
2. **Live Update 需要「容器已经能跑起来」**。它作用在**正在运行的容器**上,所以基础构建必须能在没有 sync 文件、没有 `run` 命令的前提下把容器启动起来。如果应用启动就依赖那些被同步的文件,第一次会起不来,陷入死循环。
3. **`run` 步骤的工作目录是 `/`**,命令里的路径必须写绝对路径,写相对路径会找不到文件。
4. **`trigger` 不会自动带来监听或同步**。`run(cmd, trigger=['./src'])` 里的 trigger 文件**必须同时也出现在某个 `sync` 步骤里**,否则改动它既不会触发同步也不会触发运行。这是很容易踩的一个坑。
5. **改动不在任何 sync 路径下时会静默无反应**。这种情况 Tilt 不会报错,你会盯着屏幕以为「怎么没热更新」。排障时先看文件是不是被 `sync` 覆盖到了 —— 官方原话是 "if Tilt is watching it, you can `sync` it",`sync` 的本地路径必须在 `docker_build` 的 context 或 `custom_build` 的 deps 之内。
6. **每个步骤函数都必须被真正用上**。定义一个 `LiveUpdateStep` 却没用进任何 `live_update` 调用里,Tiltfile 校验会直接报错。
7. **`sync` 会同步删除**。本地删了文件,容器里对应的文件也会被删掉。这不是单向覆盖,别在容器里手改文件后指望它留着 —— 下一轮同步可能就没了。
8. **`live_update` 不是万能的同步机制**。它只处理文件。改了 `Dockerfile`、加了依赖、动了环境变量,都得走完整重建;用 `fall_back_on` 把这些路径显式列出来,比等着 Tilt 猜要可靠。
9. **`allow_k8s_contexts(k8s_context())` 等于关掉生产保护**。写这一行之前想清楚:它放行的是**任意** kubeconfig 上下文。团队里更稳的做法是显式列出允许的上下文名,并在 CI 之外禁止改这一行。
10. **`default_registry` 在 CI 与本地行为不同**。本地开发通常让镜像留在本机 Docker 里(`--update-mode=image` 也不推送),一旦切到远程集群就必须让它推到某个可达的仓库,否则节点拉不到镜像,报 `ImagePullBackOff` 却看不出原因。
11. **不再有云端协作能力**。Tilt Cloud 2022 年就关了,团队共享 Snapshot、Web 端团队面板这些功能不存在。Snapshot 现在只能 `tilt snapshot create` 生成文件、`tilt snapshot view` 本地查看,或用 `tilt ci --output-snapshot-on-exit` 在 CI 结束时自动存档。旧教程里让你登录 cloud.tilt.dev 的步骤全部作废。
12. **`Tiltfile` 是代码,`load()` 出来的东西也是代码**。它用 Starlark 编写,可以读文件、跑本地命令。评审 `Tiltfile` 的关注度和评审构建脚本一致 —— `local_resource` 里的命令会在你的机器上以你的身份执行。

### 相关命令

- `skaffold` — 构建与部署流水线,与 Tilt 定位最接近的替代品
- `devspace` — 客户端内循环开发工具,提供双向文件同步
- `telepresence` — 把本地进程接入远程集群,不重建镜像
- `kubectl` — Kubernetes集群管理工具
- `helm` — Kubernetes包管理器
- `kustomize` — Kubernetes声明式配置定制工具

### 参考链接

- [Tilt 官方文档](https://docs.tilt.dev/)
- [Tiltfile API 参考](https://docs.tilt.dev/api.html)
- [Live Update 参考](https://docs.tilt.dev/live_update_reference.html)
- [Tilt CLI 参考](https://docs.tilt.dev/cli/tilt.html)
- [Tilt GitHub 仓库](https://github.com/tilt-dev/tilt)
- [Offline Snapshots & Tilt Cloud Deprecation(2022-05-12)](https://blog.tilt.dev/2022/05/12/offline-snapshots)
