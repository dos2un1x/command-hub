skaffold
===

面向Kubernetes的构建与部署流水线工具

## 补充说明

**skaffold命令** 把「构建镜像 → 推送镜像 → 部署清单」这条链路自动化:一个 `skaffold.yaml` 描述如何构建镜像(本地 Docker、Buildpacks、Kaniko 等)、清单从哪里来(原生 YAML、Helm、kustomize)以及用什么部署(kubectl、Helm、kustomize)。

定位必须说清楚:

- Skaffold 是**客户端工具**,集群里**不安装任何组件**,也没有 CRD 和控制器。
- 主要用途是**本地开发**(`skaffold dev` 监听文件变化、自动重建、自动部署)与 **CI 流水线**(`skaffold build` / `skaffold run`)。
- 它**不是**生产环境的部署控制器 —— 生产环境的 GitOps 同步仍应由 Argo CD、Flux 这类控制器负责;Skaffold 可以通过 `skaffold render` 输出渲染好的清单交给它们。

当前配置版本是 `skaffold/v4beta14`,用 `skaffold fix` 可以把旧版本的配置自动升级。

### 安装

```shell
# macOS (Homebrew)
brew install skaffold

# macOS (MacPorts)
sudo port install skaffold

# Linux(直接下载二进制)
curl -Lo skaffold https://storage.googleapis.com/skaffold/releases/latest/skaffold-linux-amd64
sudo install skaffold /usr/local/bin/

# Linux ARM64
curl -Lo skaffold https://storage.googleapis.com/skaffold/releases/latest/skaffold-linux-arm64
sudo install skaffold /usr/local/bin/

# macOS Apple Silicon
curl -Lo skaffold https://storage.googleapis.com/skaffold/releases/latest/skaffold-darwin-arm64
sudo install skaffold /usr/local/bin/

# Windows(Scoop / Chocolatey)
scoop install skaffold
choco install -y skaffold

# 也可以用 Google Cloud SDK 安装
gcloud components install skaffold

# 查看版本
skaffold version
```

### 语法

```shell
skaffold [command]
```

```shell
skaffold init        交互式生成 skaffold.yaml
skaffold dev         监听源码变化,持续构建与部署(本地开发)
skaffold run         构建并部署一次,然后退出(CI)
skaffold debug       以调试模式运行,自动挂载调试器
skaffold build       只构建镜像
skaffold deploy      只部署(可复用已构建的镜像)
skaffold render      只渲染最终清单,不部署
skaffold apply       把渲染结果直接提交给集群
skaffold delete      删除已部署的资源
skaffold verify      在部署后运行验证容器
skaffold test        对构建出的镜像运行测试
skaffold exec        执行自定义动作
skaffold schema      列出用于校验 skaffold.yaml 的 JSON Schema
skaffold diagnose    输出环境诊断信息
skaffold fix         把 skaffold.yaml 升级到当前 schema 版本
```

### skaffold.yaml 结构

```shell
apiVersion: skaffold/v4beta14
kind: Config
metadata:
  name: my-app

# 1. 构建:产物是什么、怎么构建、tag 怎么打
build:
  artifacts:
  - image: registry.example.com/my-app
    context: .
    docker:
      dockerfile: Dockerfile
  local:
    push: false                  # 本地开发用本地镜像,不推送
    useDockerCLI: true
  tagPolicy:
    # 可选 gitCommit / sha256 / inputDigest / dateTime / envTemplate
    inputDigest: {}

# 2. 清单:部署什么
manifests:
  kustomize:
    paths:
    - overlays/dev
  # 原生 YAML 写法
  # rawYaml:
  # - k8s/deployment.yaml
  # - k8s/service.yaml
  # Helm 写法
  # helm:
  #   releases:
  #   - name: my-app
  #     chartPath: charts/my-app
  #     valuesFiles: [charts/my-app/values-dev.yaml]
  #     setValues:
  #       image.tag: latest

# 3. 部署:用什么提交
# 可用的部署器只有 kubectl / helm / kpt / docker
# 注意 kustomize 属于上面的「渲染器」,不是部署器
deploy:
  kubectl: {}

# 4. 文件同步:改代码不重建镜像直接同步进容器
# 需要配合 manifests 中的 Deployment 使用
```

### 文件同步(sync)

`skaffold dev` 最省时间的能力是把改动的文件直接拷进正在运行的容器,而不是重新构建镜像:

```shell
build:
  artifacts:
  - image: registry.example.com/my-app
    context: .
    docker:
      dockerfile: Dockerfile
    # 自动推断可同步的文件(按容器内常见路径匹配)
    sync:
      infer:
      - '**/*.js'
      - '**/*.html'
    # 或手工指定
    # sync:
    #   manual:
    #   - src: "src/**/*.js"
    #     dest: /app/src
    #     strip: src/
```

同步只覆盖文件,**不会重启容器**。依赖热加载的框架(Node、Python 开发服务器)才适合 sync,Java 这类需要重启的场景应关掉 sync,让 Skaffold 走重新构建。

### profiles:区分环境

```shell
profiles:
- name: dev
  activation:
  - kubeContext: minikube
  patches:
  - op: replace
    path: /build/local/push
    value: false

- name: prod
  # 只有显式 -p prod 时才启用
  manifests:
    kustomize:
      paths:
      - overlays/prod
  build:
    local:
      push: true
    tagPolicy:
      gitCommit:
        variant: AbbrevCommitSha
```

```shell
# 使用指定 profile
skaffold dev -p dev
skaffold run -p prod
skaffold dev -p dev,debug
```

### 常用工作流

```shell
# 交互式生成 skaffold.yaml:自动识别 Dockerfile 与 k8s 清单
skaffold init

# 本地开发:持续构建 + 部署 + 日志聚合
skaffold dev
skaffold dev --port-forward              # 自动端口转发
skaffold dev --tail=false                # 不聚合日志
skaffold dev --cleanup=false             # 退出时不删除已部署资源
skaffold dev --no-prune                  # 退出时不清理它构建的镜像与容器

# CI:构建并部署一次
skaffold run
skaffold run --tail                      # 部署后持续输出日志

# build once, deploy many:构建产物写入文件,后续部署复用
skaffold build --file-output=tags.json
skaffold deploy --build-artifacts=tags.json
skaffold render --build-artifacts=tags.json --output=rendered.yaml

# 调试
skaffold debug                           # 自动注入调试参数
skaffold diagnose                        # 环境诊断
skaffold fix                             # 升级 skaffold.yaml 的 schema 版本

# 清理
skaffold delete
```

### 与 GitOps 配合

Skaffold 不负责「持续同步」,但可以只做渲染,把结果交给 Argo CD 或 Flux:

```shell
# 渲染出最终清单(镜像 tag 已确定),不部署
skaffold render --output=rendered.yaml

# 在 CI 中构建并推送镜像,产出 tag 清单
skaffold build --file-output=tags.json --push=true

# 用渲染结果做差异对比
skaffold render > /tmp/rendered.yaml
kubectl diff -f /tmp/rendered.yaml
```

### 注意

1. **Skaffold 不是生产部署工具**。集群里没有 Skaffold 的任何组件,它只在你执行命令时起作用;`skaffold dev` 退出后不会有人继续守护你的应用。生产环境请用 Argo CD / Flux 之类的控制器。
2. **在错误的 kube-context 上执行 `skaffold dev` 是灾难**。它会直接操作当前 context 所指集群并监听文件变化持续部署;务必用 `--kube-context` 或 profile 的 `activation.kubeContext` 显式限定,避免手滑打到生产。
3. **`skaffold dev` 退出时会清理它部署的资源**。默认会删除本次部署的对象,本地调试想保留现场要加 `--cleanup=false`;`--no-prune` 指的是退出时不清理它构建的镜像与本地容器,别把两者混为一谈。
4. **固定镜像 tag 会导致「改了代码没生效」**。Kubernetes 在 tag 不变且 `imagePullPolicy: IfNotPresent` 时不会重新拉镜像,而 Skaffold 靠 tag 变化触发滚动更新。应使用 `inputDigest`、`gitCommit` 之类的动态 tag 策略,或把拉取策略设为 `Always`。
5. **本地构建需要可用的 Docker 守护进程**。`build.local` 依赖本机 Docker;在 CI 或没有 Docker 的环境里应改用 `build.cluster`(Kaniko)或 `build.googleCloudBuild` 等远端构建方式。
6. **文件同步不等于重启,还有若干硬限制**。`sync` 只把文件拷进容器,对需要重启才生效的应用没有意义;此外容器内**必须有 `tar` 命令**、目标文件必须能被容器运行用户改写、只能同步本地源文件(构建产物不行),而且 `manual`、`infer`、`auto` 三种模式**不能混用**。同步只对 `dev` 与 `debug` 生效。
7. **`skaffold run` 不会自动清理**。它与 `dev` 不同,部署完即退出,资源留在集群里,需要显式 `skaffold delete`。
8. **`apiVersion` 与 CLI 版本强相关**。老配置在新 CLI 上可能报 schema 不兼容,升级 CLI 后先跑 `skaffold fix` 再提交。
9. **渲染与部署要使用同一份构建产物**。CI 里先用 `skaffold build --file-output=tags.json`,再用 `--build-artifacts=tags.json` 部署,否则渲染阶段可能因为重新构建而产生不同 tag,导致部署的镜像与验证过的镜像不是同一个。
10. **`manifests` 里不要混用多套渲染方式**。同时配置 `kustomize`、`helm`、`rawYaml` 会同时渲染全部清单,重复定义同一对象时后应用的会覆盖前者,排查起来非常痛苦。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `helm` — Kubernetes包管理器
- `kustomize` — Kubernetes声明式配置定制工具
- `argocd` — Kubernetes声明式GitOps持续交付工具
- `flux` — GitOps持续交付工具

### 参考链接

- [Skaffold 官方文档](https://skaffold.dev/docs/)
- [安装 Skaffold](https://skaffold.dev/docs/install/)
- [skaffold.yaml 配置参考](https://skaffold.dev/docs/references/yaml/)
- [文件同步](https://skaffold.dev/docs/filesync/)
- [GitHub 仓库](https://github.com/GoogleContainerTools/skaffold)
