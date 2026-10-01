flux
===

Kubernetes GitOps持续交付工具

## 补充说明

**flux命令** 是 Flux v2 的 CLI。Flux 是一组运行在集群内的控制器,持续把 Git 仓库(以及 OCI、Helm 仓库、对象存储)中的期望状态拉取到集群 —— 典型的**拉取式(pull-based)GitOps**。

控制器分工:

- **source-controller** —— 拉取并缓存源(Git 仓库、OCI 制品、Helm 仓库、S3 桶)。
- **kustomize-controller** —— 用 kustomize 渲染并 apply 清单,负责漂移纠正与垃圾回收。
- **helm-controller** —— 管理 HelmRelease。
- **notification-controller** —— 收发事件与告警。
- **image-reflector-controller / image-automation-controller** —— 扫描镜像新版本并回写 Git(可选组件)。

与 Argo CD 的核心差异:Flux **没有 Web UI**,配置全部通过 CRD 声明;`flux bootstrap` 会把 Flux 自身的清单也提交到 Git,让 Flux **管理它自己**。

### 安装

推荐用 bootstrap 流程 —— 它同时完成「安装控制器」与「把控制器交给 Git 管理」两件事:

```shell
# 1. 安装 CLI(macOS)
brew install fluxcd/tap/flux

# 2. 安装 CLI(通用脚本)
curl -s https://fluxcd.io/install.sh | sudo bash

# 3. 安装前自检:检查集群版本、权限、网络等前置条件
flux check --pre

# 4. 引导安装(GitHub 为例)
export GITHUB_TOKEN=<拥有 repo 权限的 PAT>
flux bootstrap github \
  --token-auth \
  --owner=my-github-username \
  --repository=my-repository-name \
  --branch=main \
  --path=clusters/my-cluster \
  --personal

# 组织仓库去掉 --personal,并确保账号有组织管理员权限
flux bootstrap github \
  --owner=my-org --repository=fleet-infra --branch=main \
  --path=clusters/production --team=team-1

# 5. 安装后自检
flux check
```

bootstrap 会在 Git 仓库中建立如下结构,并把这些文件提交上去:

```shell
clusters/my-cluster/
└── flux-system/
    ├── gotk-components.yaml    # Flux 控制器与 CRD 的清单
    ├── gotk-sync.yaml          # GitRepository + Kustomization,即同步入口
    └── kustomization.yaml      # 把上面两个文件组合起来
```

控制器与 CRD 会被安装到 **`flux-system` 命名空间**,同时集群里会创建一个名为 `flux-system` 的 Secret 保存仓库凭据。

如果只是想快速试用、不需要 Git 托管:

```shell
# 直接安装控制器,不建立 Git 同步关系(官方称之为 dev install)
flux install

# 导出清单供审查
flux install --export > flux-system.yaml
```

### 语法与常用命令

```shell
flux [command]
```

```shell
# 源
flux create source git my-app \
  --url=https://github.com/example/my-app \
  --branch=main \
  --interval=1m \
  --export > source.yaml

flux create source git my-app \
  --url=ssh://git@github.com/example/my-app \
  --branch=main \
  --secret-ref=my-app-auth          # 引用已存在的凭据 Secret

# 同步
flux create kustomization my-app \
  --source=GitRepository/my-app \
  --path="./deploy/production" \
  --prune=true \
  --interval=10m \
  --target-namespace=my-app \
  --export > kustomization.yaml

flux get kustomizations --all-namespaces
flux get kustomizations --show-source -w     # 带来源信息并持续观察

# 手动触发同步(等价于「立即拉取」)
flux reconcile source git my-app
flux reconcile kustomization my-app --with-source

# 暂停/恢复:排障时避免被自动回滚
flux suspend kustomization my-app
flux resume kustomization my-app

# 日志与链路追踪
flux logs --kind=Kustomization --name=my-app --namespace=flux-system --follow
flux logs --all-namespaces --level=error --since=10m
flux trace deployment my-app -n my-app

# 卸载(会连 CRD 一起删除)
flux uninstall --namespace=flux-system
flux uninstall --namespace=infra --keep-namespace=true
```

### 核心 CRD

Flux 的 API 版本已经稳定到 **v1**(旧教程里的 `v1beta2` 已过时,`flux create --export` 输出的就是新版):

```shell
source.toolkit.fluxcd.io/v1        GitRepository / OCIRepository / HelmRepository / HelmChart / Bucket
kustomize.toolkit.fluxcd.io/v1     Kustomization
helm.toolkit.fluxcd.io/v2          HelmRelease
image.toolkit.fluxcd.io/v1         ImageRepository / ImagePolicy / ImageUpdateAutomation
```

一个典型的 Kustomization:

```shell
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: my-app
  namespace: flux-system
spec:
  interval: 10m                 # 必需字段,最小 60s
  retryInterval: 1m
  path: ./deploy/production
  prune: true                   # 必需字段:开启垃圾回收
  wait: true                    # 等待资源就绪;为 true 时 healthChecks 会被忽略
  timeout: 5m
  sourceRef:
    kind: GitRepository
    name: my-app
  targetNamespace: my-app       # 目标命名空间必须已存在
  dependsOn:
  - name: my-app-crds
  healthChecks:
  - apiVersion: apps/v1
    kind: Deployment
    name: my-app
    namespace: my-app
```

### HelmRelease

用 flux 管理 Helm 发布,不再需要在本机执行 `helm upgrade`:

```shell
apiVersion: source.toolkit.fluxcd.io/v1
kind: HelmRepository
metadata:
  name: bitnami
  namespace: flux-system
spec:
  interval: 1h
  url: https://charts.bitnami.com/bitnami
---
apiVersion: helm.toolkit.fluxcd.io/v2
kind: HelmRelease
metadata:
  name: my-redis
  namespace: my-app
spec:
  interval: 1h
  chart:
    spec:
      chart: redis
      version: "20.x"
      sourceRef:
        kind: HelmRepository
        name: bitnami
        namespace: flux-system
  install:
    createNamespace: true
  upgrade:
    remediation:
      retries: 3
  values:
    architecture: standalone
```

### 多环境目录布局

bootstrap 之后,集群状态完全由 Git 决定,典型布局:

```shell
fleet-infra/
├── clusters/
│   ├── staging/
│   │   └── flux-system/          # bootstrap 生成,不要手改
│   └── production/
│       └── flux-system/
├── infrastructure/
│   ├── sources/                  # GitRepository / HelmRepository
│       └── kustomization.yaml
└── apps/
    ├── base/
    └── production/
```

```shell
# 追加一个应用:把清单放进 apps/production,Flux 会在下一轮自动同步
flux get kustomizations -A
flux reconcile kustomization apps --with-source
```

### 注意

1. **`gotk-components.yaml` 是 Flux 自身的事实来源**。集群里的 Flux 部署由 Git 中的这个文件决定,手工 `kubectl edit` 控制器会被漂移纠正回 Git 版本。升级 Flux 的正确做法是重新执行 `flux bootstrap`(它是幂等的,可反复运行),由它更新 Git 中的清单。
2. **`kubectl` 手改被 Flux 管理的资源会被回滚**。kustomize-controller 会做服务端 apply 的 dry-run 来检测漂移并纠正;排障要临时改东西时,先 `flux suspend kustomization <name>`,改完记得 `flux resume`。
3. **`prune: true` 的垃圾回收是真删**。源里删掉的对象、以及 **Kustomization 对象本身被删除时**所管理的对象,都会被回收。`flux-system` 目录同理 —— 它管着 Flux 组件自己,所以不要随意删除或清空该目录。
4. **bootstrap 的凭据权限很大**。GitHub PAT 需要仓库的管理权限,并且会以 Secret `flux-system` 的形式长期留在集群里;更安全的做法是用 deploy key(`--token-auth=false`)或 GitHub App,把权限收敛到单个仓库。
5. **`--path` 目录必须与 bootstrap 生成的 `flux-system/` 子目录匹配**。换个路径重新 bootstrap 会在 Git 里生成第二套清单,导致两个 Flux 实例互相打架;迁移路径时应当把原目录一并移动。
6. **`interval` 有下限**。Kustomization 的 `interval` 最小 60 秒,别指望「提交即生效」的实时同步;需要立刻生效就用 `flux reconcile ... --with-source`。
7. **`targetNamespace` 不会创建命名空间**。它只是把资源投递到该命名空间,命名空间本身必须已经存在(或用 `CreateNamespace` 之类的手段另行管理),否则 apply 会失败。
8. **`wait: true` 会让 `healthChecks` 失效**。官方明确说明 `spec.wait` 为真时忽略 `spec.healthChecks`;要精确控制健康检查对象,就把 `wait` 关掉并显式声明 `healthChecks`。
9. **CRD 的 API 版本是 `v1`,不是 `v1beta2`**。大量旧文章仍在用 `v1beta2`,复制到新集群上虽然可能被转换,但字段语义与校验强度不同;一律用 `flux create --export` 生成当前版本。
10. **`flux uninstall` 会连 CRD 一起删除**,集群上所有的 GitRepository / Kustomization / HelmRelease 对象随之消失;`--keep-namespace` 只能保留命名空间,并不能保留 CRD。生产环境执行前务必确认。
11. **`flux logs` 与 `flux trace` 在官方文档中标注为 preview**,行为可能随版本变化;排障时也可以直接看控制器的 Pod 日志,`flux trace` 的名字是位置参数(没有 `--name` 标志)。
12. **`spec.force` 会删除重建资源**。当 patch 遇到不可变字段(如 Deployment 的 selector)时可以打开它绕过,但会造成中断,生产环境慎用。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `argocd` — Kubernetes声明式GitOps持续交付工具
- `helm` — Kubernetes包管理器
- `kustomize` — Kubernetes声明式配置定制工具
- `skaffold` — Kubernetes构建与部署流水线工具

### 参考链接

- [Flux 官方文档](https://fluxcd.io/flux/)
- [安装与引导](https://fluxcd.io/flux/installation/)
- [bootstrap 定制](https://fluxcd.io/flux/installation/configuration/bootstrap-customization/)
- [Kustomization 控制器](https://fluxcd.io/flux/components/kustomize/kustomizations/)
- [flux CLI 参考](https://fluxcd.io/flux/cmd/)
