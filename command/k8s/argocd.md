argocd
===

Kubernetes声明式GitOps持续交付工具

## 补充说明

**argocd命令** 是 Argo CD 的 CLI。Argo CD 是运行在集群内的 GitOps 持续交付控制器:它以 Git 仓库中的清单作为**唯一事实来源**,持续对比「期望状态」与集群「实际状态」,并把差异可视化或自动同步。

几个必须分清的概念:

- **Application**:一个 CRD,描述「哪个 Git 仓库的哪个路径」要部署到「哪个集群的哪个命名空间」。
- **AppProject**:对 Application 做分组与权限边界,限制可用的源仓库与目标集群。
- **ApplicationSet**:用生成器批量生成 Application,适合「一个应用 × 多个集群」的场景。
- **同步状态(Sync Status)**:`Synced` / `OutOfSync`;**健康状态(Health Status)**:`Healthy` / `Progressing` / `Degraded`。两者相互独立,`Synced` 不代表 Pod 跑起来了。

Argo CD 的定位是**部署**而非构建:它不做镜像构建、不做单元测试,只负责把已经存在的清单同步到集群。

### 安装

```shell
# 1. 创建命名空间
kubectl create namespace argocd

# 2. 部署非高可用版本(官方推荐加 --server-side --force-conflicts)
kubectl apply -n argocd --server-side --force-conflicts \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml

# 3.(与上一步二选一)生产环境应锁定版本,而不是用 stable
kubectl apply -n argocd --server-side --force-conflicts \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/v3.2.0/manifests/install.yaml

# 4. 安装 CLI(macOS)
brew install argocd

# 5. 安装 CLI(Linux)
curl -sSL -o argocd-linux-amd64 \
  https://github.com/argoproj/argo-cd/releases/latest/download/argocd-linux-amd64
sudo install -m 555 argocd-linux-amd64 /usr/local/bin/argocd
rm argocd-linux-amd64
```

安装后集群里会多出 `argocd-server`(API/UI)、`argocd-application-controller`(同步控制器)、`argocd-repo-server`(清单渲染)、`argocd-redis`、`argocd-dex-server`(SSO)等组件。

### 访问与登录

```shell
# 查看组件状态
kubectl -n argocd get pods

# 端口转发(API Server 默认 443)
kubectl port-forward svc/argocd-server -n argocd 8080:443

# 获取初始 admin 密码(新版 CLI 直接读取)
argocd admin initial-password -n argocd

# 等价的手工取法:secret 名为 argocd-initial-admin-secret,键为 password
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath="{.data.password}" | base64 -d && echo

# 登录(自签证书需要 --insecure)
argocd login localhost:8080 --username admin --password '<初始密码>' --insecure

# 修改密码后建议删除初始密码 Secret
argocd account update-password
kubectl -n argocd delete secret argocd-initial-admin-secret
```

### Application:声明式创建

最典型的 Application 清单如下,注意 `metadata.namespace` 必须是 `argocd`,而 `destination.namespace` 才是业务所在的命名空间:

```shell
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: guestbook
  namespace: argocd
  # 删除 Application 时级联删除它部署出来的资源
  finalizers:
  - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: https://github.com/argoproj/argocd-example-apps.git
    targetRevision: HEAD
    path: guestbook
  destination:
    server: https://kubernetes.default.svc
    namespace: guestbook
  syncPolicy:
    automated:
      prune: true       # Git 中删掉的资源,集群里也删掉
      selfHeal: true    # 集群被手工改动时自动同步回 Git 状态
    syncOptions:
    - CreateNamespace=true
    retry:
      limit: 5
      backoff:
        duration: 5s
        factor: 2
        maxDuration: 3m
```

### Application:命令行创建

```shell
# 从 Git 仓库创建
argocd app create guestbook \
  --repo https://github.com/argoproj/argocd-example-apps.git \
  --path guestbook \
  --dest-server https://kubernetes.default.svc \
  --dest-namespace guestbook \
  --sync-policy automated \
  --auto-prune \
  --self-heal \
  --sync-option CreateNamespace=true

# Helm Chart 作为源
argocd app create my-app \
  --repo https://charts.bitnami.com/bitnami \
  --helm-chart nginx \
  --revision 15.0.0 \
  --helm-set replicaCount=3 \
  --dest-server https://kubernetes.default.svc \
  --dest-namespace web

# 使用 values 文件覆盖
argocd app create my-app --repo https://... --path charts/my-app \
  --values values-prod.yaml --dest-server https://kubernetes.default.svc \
  --dest-namespace web
```

### 常用操作

```shell
argocd app list -o wide               # 列出全部 Application 及同步状态
argocd app get guestbook              # 查看详情与资源树
argocd app diff guestbook             # 查看 Git 与集群的差异
argocd app sync guestbook             # 手动同步
argocd app sync guestbook --dry-run   # 只预览不执行
argocd app sync guestbook --prune     # 同步时一并删除多余资源
argocd app sync guestbook --resource apps:Deployment:my-app  # 只同步单个资源
argocd app wait guestbook --health    # 等待健康
argocd app wait guestbook --sync --timeout 300   # 等待同步完成

argocd app history guestbook          # 同步历史
argocd app rollback guestbook 3       # 回滚到某个历史版本
argocd app set guestbook --sync-policy automated --self-heal
argocd app set guestbook --sync-option ServerSideApply=true
argocd app terminate-op guestbook     # 终止正在进行的同步
argocd app delete guestbook           # 删除 Application
argocd app delete guestbook --cascade # 连同其资源一起删除
```

### 仓库与凭据

```shell
# HTTPS 方式,用户名 + 访问令牌
argocd repo add https://github.com/example/apps.git \
  --username git --password '<token>'

# SSH 方式
argocd repo add git@github.com:example/apps.git \
  --ssh-private-key-path ~/.ssh/id_rsa

# 自签/内网 GitLab
argocd repo add https://gitlab.internal/apps.git \
  --username root --password '<token>' --insecure-skip-server-verification

argocd repo list
argocd repo rm https://github.com/example/apps.git
```

仓库凭据最终以 Secret 形式保存在 **argocd 命名空间**,并带有 `argocd.argoproj.io/secret-type: repository` 标签。删除仓库时若用 `--name` 之外的写法,注意清理残留 Secret,否则同名仓库再次添加会报冲突。

### AppProject:多租户边界

```shell
apiVersion: argoproj.io/v1alpha1
kind: AppProject
metadata:
  name: team-a
  namespace: argocd
spec:
  # 只允许从这两个仓库拉取清单
  sourceRepos:
  - https://github.com/example/team-a-*.git
  # 只允许部署到指定集群的指定命名空间
  destinations:
  - namespace: team-a-*
    server: https://kubernetes.default.svc
  # 允许部署的资源类型(空表示全部)
  clusterResourceWhitelist:
  - group: ''
    kind: Namespace
  roles:
  - name: developer
    policies:
    - p, proj:team-a:developer, applications, sync, team-a/*, allow
    groups:
    - team-a-devs
```

### RBAC

Argo CD 的权限由 `argocd-rbac-cm` ConfigMap 控制,与 Kubernetes 的 RBAC 是**两套独立体系**:

```shell
kubectl -n argocd edit configmap argocd-rbac-cm
```

```shell
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-rbac-cm
  namespace: argocd
data:
  policy.default: role:readonly
  policy.csv: |
    p, role:developer, applications, get, */*, allow
    p, role:developer, applications, sync, */*, allow
    p, role:developer, logs, get, */*, allow
    g, team-a-devs, role:developer
  scopes: '[groups]'
```

```shell
# 校验权限与生成令牌
argocd account can-i sync applications '*'
argocd account generate-token --account ci-bot
```

### 忽略差异与同步选项

HPA、Service 的 `clusterIP`、`metadata.annotations` 等字段会被集群侧改写,导致长期 `OutOfSync`:

```shell
spec:
  ignoreDifferences:
  - group: apps
    kind: Deployment
    jsonPointers:
    - /spec/replicas
  syncPolicy:
    syncOptions:
    - RespectIgnoreDifferences=true
    - ApplyOutOfSyncOnly=true
    - PrunePropagationPolicy=foreground
    - PruneLast=true
```

### 注意

1. **`automated.selfHeal: true` 会覆盖手工改动**。任何 `kubectl edit` / `kubectl patch` / `kubectl scale` 的改动都会在下一轮 reconcile 中被回滚。排障时若只是临时改一下副本数,先执行 `argocd app set <app> --sync-policy none` 暂停自动同步,或给 Application 临时打上 `argocd.argoproj.io/sync-options: Replace=false` 一类的同步选项注解,事后记得改回来。
2. **`prune: true` 会真删资源**。把文件从 Git 中移除后,集群里对应的 Deployment/Service 会被删除;带上 `resources-finalizer.argocd.argoproj.io` 后,连删除 Application 本身都会级联删除业务资源。生产环境务必先 `--dry-run` 看一遍。
3. **HPA 与 GitOps 天然冲突**。HPA 会改写 Deployment 的 `spec.replicas`,而 Git 里写的是固定值,于是永远 `OutOfSync`。要么用 `ignoreDifferences` 忽略 `/spec/replicas`,要么不要把副本数交给 Git 管理。
4. **Application 对象必须建在 argocd 命名空间**,`destination.namespace` 才是目标命名空间。把 Application 建到业务命名空间里,控制器默认看不见它(除非配置 `ARGOCD_APPLICATION_NAMESPACES` 开启多租户)。
5. **CRD 太大,必须用 server-side apply**。Argo CD 的 CRD 超过 client-side apply 的 262KB 注解上限,直接 `kubectl apply -f install.yaml` 会报 `metadata.annotations: Too long`,所以官方命令里带了 `--server-side --force-conflicts`。
6. **首次登录后立即改密码并删除 `argocd-initial-admin-secret`**。该 Secret 长期留存等于把 admin 密码明文放在集群里。
7. **UI/CLI 默认走 gRPC(443)**,用 Ingress 暴露时 nginx 需要 `nginx.ingress.kubernetes.io/backend-protocol: "HTTPS"`,否则 CLI 会报 `transport: Error while dialing`;纯 HTTP Ingress 只能访问 Web UI 的部分功能。
8. **`argocd app sync` 不是幂等的“随便点点”**。同步过程中若涉及 `Replace=true` 或不可变字段(如 Deployment 的 selector),会删除重建资源,造成短暂不可用。
9. **repo-server 需要能访问 Git 与 Helm 仓库**。私有化环境里 repo-server 无法出网时,Application 会卡在 `ComparisonError`,而不是报网络错误。
10. **同步不是实时的**。`timeout.reconciliation`(默认 3 分钟)决定控制器多久对比一次,集群侧漂移最长要等一轮才被发现;只开 `automated` 不开 `selfHeal` 时,漂移只会显示 `OutOfSync` 而不会自动纠正。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `helm` — Kubernetes包管理器
- `kustomize` — Kubernetes声明式配置定制工具
- `flux` — GitOps持续交付工具

### 参考链接

- [Argo CD 官方文档](https://argo-cd.readthedocs.io/en/stable/)
- [Argo CD 快速开始](https://argo-cd.readthedocs.io/en/stable/getting_started/)
- [Application 规格参考](https://argo-cd.readthedocs.io/en/stable/user-guide/application-specification/)
- [同步策略与同步选项](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-options/)
- [Argo CD RBAC 配置](https://argo-cd.readthedocs.io/en/stable/operator-manual/rbac/)
