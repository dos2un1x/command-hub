kubebuilder
===

Kubernetes官方推荐的Operator与控制器脚手架工具

## 补充说明

**kubebuilder** 是 `kubernetes-sigs` 维护的 Operator 脚手架,也是 Kubernetes 官方文档在「如何编写 Operator」时推荐的工具。它的作用是:**把一个符合最佳实践的控制器项目骨架一次性生成出来**。

生成之后,你要写的只有业务逻辑 —— 类型定义里加字段、Reconcile 里写调谐代码,其余的缓存、watch、领导者选举、指标、健康检查、CRD 清单、RBAC 清单、多架构镜像构建、envtest 集成测试、kind 上的 e2e 测试、Helm Chart 打包,全部由脚手架与 Makefile 提供。

```shell
kubebuilder  →  生成骨架(本项目)
controller-runtime  →  骨架里实际运行的核心库
```

它**不生成业务逻辑**,也不会替你决定 Operator 该做什么。`// TODO(user): your logic here` 那几行注释,才是这个项目真正的价值所在。

关于版本,有几件事必须说清楚,否则照抄老教程会得到一个与当前脚手架不一致的项目:

```shell
v4.0.0(2024 年 5 月)是一次大版本升级
    移除 go/v2、go/v3、kustomize/v1 插件,移除 Declarative 插件与 ComponentConfig
    仍在用 go/v2、go/v3 的项目必须迁移到 go/v4
    Go module 路径变为 sigs.k8s.io/kubebuilder/v4

当前主线为 v4.x(2026 年下半年已发布到 v4.16 系列)
    脚手架使用 kustomize v5(不再是 v3/v4 时代的字段)
    基础镜像为 gcr.io/distroless/static:nonroot
    脚手架默认启用的 kube-rbac-proxy 已被移除,指标鉴权改为使用
    controller-runtime 自带的 WithAuthenticationAndAuthorization
```

```shell
kubebuilder version          # 查看已安装版本
# 官方发布页:https://github.com/kubernetes-sigs/kubebuilder/releases
# 版本迁移指南:https://book.kubebuilder.io/migrations
```

因此,老教程里的 `go/v3`、`bases` 字段、`config/rbac/auth_proxy_*` 这类写法都已经过时,**遇到时以脚手架实际生成的产物为准**。

### 安装

```shell
# macOS(Homebrew)
brew install kubebuilder

# 官方脚本:下载最新稳定版
curl -L -o kubebuilder "https://go.kubebuilder.io/dl/latest/$(go env GOOS)/$(go env GOARCH)"
chmod +x kubebuilder && sudo mv kubebuilder /usr/local/bin/

# 指定版本(把版本号写进 URL)
curl -L -o kubebuilder "https://go.kubebuilder.io/dl/<版本>/$(go env GOOS)/$(go env GOARCH)"
chmod +x kubebuilder && sudo mv kubebuilder /usr/local/bin/

kubebuilder version
```

前置条件:**Go 工具链**(版本要求随 kubebuilder 版本提高,以官方 README 为准),以及一个可用的集群(kind 即可)。`make deploy` 路线还需要 `docker`/`podman`、`kubectl`、`kustomize`;启用 webhook 时需要 `cert-manager`。

### 语法

```shell
kubebuilder [command]
```

```shell
kubebuilder init        初始化项目(生成骨架、Makefile、PROJECT)
kubebuilder create      创建 API、控制器、Webhook
kubebuilder edit        修改项目配置(如开启 multigroup、追加插件)
kubebuilder alpha       试验性命令(项目再生成、版本升级辅助)
kubebuilder version     查看版本
```

### 初始化项目

```shell
mkdir myproject && cd myproject

# --domain 决定 API 组后缀,--repo 决定 Go module 路径(必填)
kubebuilder init --domain example.com --repo github.com/example/myproject

# 显式指定插件(当前主线为 go/v4)
kubebuilder init --domain example.com --repo github.com/example/myproject \
  --plugins=go/v4

# 同时生成部署用的 kustomize 骨架
kubebuilder init --domain example.com --repo github.com/example/myproject \
  --plugins=go/v4 --project-name=myproject
```

### 创建 API 与控制器

```shell
# 同时生成类型定义(api/)与控制器(internal/controller/)
kubebuilder create api --group webapp --version v1 --kind Guestbook

# 只生成类型(不生成控制器)
kubebuilder create api --group webapp --version v1 --kind Guestbook \
  --resource=true --controller=false

# 只生成控制器(类型已存在)
kubebuilder create api --group webapp --version v1 --kind Guestbook \
  --resource=false --controller=true
```

生成后的目录长这样:

```shell
myproject/
├── PROJECT                          # 项目元数据:插件版本、已生成的资源
├── Makefile                         # 全部构建/部署动作的入口
├── cmd/main.go                      # Manager 启动入口
├── api/v1/guestbook_types.go        # CRD 的 Go 类型与 kubebuilder 注解
├── internal/controller/guestbook_controller.go   # 你要写逻辑的地方
├── config/
│   ├── crd/                         # 生成的 CRD 清单
│   ├── rbac/                        # 生成的 RBAC 清单
│   ├── manager/                     # 控制器 Deployment
│   ├── samples/                     # 示例 CR
│   ├── webhook/                     # Webhook 配置
│   └── default/                     # kustomize 入口
├── hack/boilerplate.go.txt
└── test/e2e/                        # kind 上的端到端测试
```

### 创建 Webhook

```shell
# 默认值(Defaulter)与校验(Validator)
kubebuilder create webhook --group webapp --version v1 --kind Guestbook \
  --defaulting --programmatic-validation

# 版本转换 Webhook(为 CRD 多版本演进准备)
kubebuilder create webhook --group webapp --version v1 --kind Guestbook \
  --conversion
```

### 类型定义与标记(markers)

`api/v1/guestbook_types.go` 里的注释不是普通注释,而是会**被 `make manifests` 解析成清单字段**的标记:

```shell
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced,shortName=gb,categories=all
// +kubebuilder:printcolumn:name="Replicas",type=integer,JSONPath=`.spec.replicas`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

type GuestbookSpec struct {
    // +kubebuilder:validation:Minimum=1
    // +kubebuilder:validation:Maximum=10
    // +kubebuilder:default=3
    Replicas int32 `json:"replicas,omitempty"`

    // +kubebuilder:validation:Enum=Small;Medium;Large
    Size string `json:"size,omitempty"`
}

// +kubebuilder:object:root=true
type GuestbookStatus struct {
    ReadyReplicas int32 `json:"readyReplicas,omitempty"`
    Conditions []metav1.Condition `json:"conditions,omitempty"`
}
```

控制器所需的 RBAC 同样由标记生成:

```shell
// +kubebuilder:rbac:groups=webapp.example.com,resources=guestbooks,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=webapp.example.com,resources=guestbooks/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=webapp.example.com,resources=guestbooks/finalizers,verbs=update
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
```

### Makefile 常用目标

```shell
make manifests        # 依据标记重新生成 CRD / RBAC / Webhook 清单(改完标记必跑)
make generate         # 重新生成 DeepCopy 等方法(改完类型必跑)
make fmt vet          # 格式化与静态检查
make test             # 单元测试 + envtest(需要 KUBEBUILDER_ASSETS)
make lint             # golangci-lint
make build            # 编译 manager 二进制到 bin/

make run              # 本地直接运行控制器(用当前 kubeconfig)
make install          # 把 CRD 安装进当前集群
make uninstall        # 卸载 CRD
make deploy IMG=<镜像>  # 把控制器部署进集群
make undeploy         # 卸载控制器

make docker-build IMG=registry.example.com/guestbook:v0.1.0
make docker-push  IMG=registry.example.com/guestbook:v0.1.0
make build-installer IMG=...   # 生成 dist/install.yaml(单文件安装清单)
```

典型的本地开发循环:

```shell
# 终端 1:装好 CRD 后本地跑控制器,改代码即重启
make install
make run ENABLE_WEBHOOKS=false

# 终端 2:应用一个示例 CR,观察调谐
kubectl apply -k config/samples/
kubectl get guestbooks -w
kubectl describe guestbook guestbook-sample
```

### 插件体系

kubebuilder 的能力几乎全部由插件提供,`init` / `create` 时的 `--plugins` 决定项目形态:

```shell
go/v4              默认插件,生成 Go 项目与 v4 目录布局
deploy-image/v1-alpha   生成带 Deployment 管理的示例代码
helm/v1-alpha      额外生成 Helm Chart
grafana/v1-alpha   生成 Grafana 仪表板配置
autoupdate/v1-alpha     辅助项目脚手架版本升级
```

`alpha` 后缀表示试验特性,**接口与产物不保证向后兼容**,不建议在关键项目上依赖。

给已有项目追加插件:

```shell
kubebuilder edit --plugins=helm/v1-alpha
kubebuilder edit --multigroup=true    # 开启多 API 组布局(中途开启需手工搬迁目录)
```

### 注意

1. **脚手架只生成骨架,不等于 Operator 已完成。** 生成的 Reconcile 里只有 `// TODO(user): your logic here`,不做任何事。把它当成项目模板,不要当成可运行的产品。
2. **只 `make install` 不跑控制器,CR 会「毫无反应」。** `make install` 只是把 CRD 装进集群,不会启动控制器;必须再 `make run` 或 `make deploy`。现象是 `kubectl apply` 成功、`kubectl get` 也能看到对象,但 status 永远为空 —— 这与 CRD 页提到的「只建 CRD 不建控制器」是同一个坑。
3. **改了 Go 类型之后必须重新生成清单。** 只改 `_types.go` 而不跑 `make manifests`,集群里的 CRD 仍是旧 schema,新字段会被 API Server **静默丢弃**(`preserveUnknownFields: false` 会剪掉未知字段),表现为「字段填了却读不到」。
4. **CRD 的多数字段不可修改,`make install` 会因此报错。** 一旦要给已存在的版本改 schema(特别是改 `group`、`kind`),`kubectl apply` 会被拒绝,只能删除 CRD 重建 —— 而删除会带走所有 CR。**正式项目应在早期就把版本策略想清楚,用新增版本 + 转换 Webhook 而不是原地改**。
5. **`--repo` 写错代价很大。** 它决定所有生成代码的 Go module 路径,写错后需要全局替换 import 与 Makefile,**初始化时务必填真实的仓库地址**。
6. **`PROJECT` 文件是脚手架的账本,不要删也不要手改。** 它记录插件版本与已生成的资源,丢失后 `kubebuilder create` 无法继续追加代码,只能手工重建项目。
7. **`make deploy` 不指定 `IMG` 会拉取失败。** 默认镜像是无仓库前缀的 `controller:latest`,集群节点上并不存在,结果是 `ImagePullBackOff`。正确做法是 `make deploy IMG=<可达的仓库地址>/<名字>:<tag>`。
8. **Webhook 需要证书,本地与集群两条路线不同。** 集群路线依赖 `cert-manager`(需要先安装),由它签发并注入;本地 `make run` 没有 webhook 证书,必须 `ENABLE_WEBHOOKS=false`,否则启动即报证书错误。而 CRD 的多版本转换 Webhook 一旦不可用,**整个资源类型都无法读写**。
9. **RBAC 由标记生成,忘记重新生成会导致 `Forbidden`。** 控制器新增了对某种资源的操作后,必须补 `+kubebuilder:rbac` 标记并 `make manifests`、重新部署,否则运行时报权限不足。反过来,脚手架默认生成的权限往往偏大,交付前应收敛。
10. **基础镜像是 distroless,容器里没有 shell。** `kubectl exec` 进去排查会失败(`exec: "sh": executable file not found`)。需要现场调试时应临时换用带 shell 的基础镜像或使用 `kubectl debug`。
11. **`test/e2e` 依赖 kind。** 它会在本地创建临时集群并安装 CRD,对资源有限的开发机不友好;CI 中应单独安排阶段,或改用 envtest 覆盖大部分逻辑。
12. **单 group 与多 group 布局不能随意切换。** 中途执行 `kubebuilder edit --multigroup=true` 后,需要按新布局手工搬迁 `api/` 下的目录结构,否则生成器找不到已有类型。
13. **升级 kubebuilder 不会自动升级项目。** 项目布局与插件版本固化在 `PROJECT` 文件里(其中包括记录脚手架版本的 `cliVersion` 字段),新版本脚手架的改进(新的 Makefile、新的安全默认值)不会自动进入老项目。需要时用 `kubebuilder alpha generate`(用当前插件重新生成)与 `kubebuilder alpha update`(按新版本重新脚手架并合并),并**在版本控制下逐项比对 diff**,不要盲目覆盖。
14. **老项目里的 `kube-rbac-proxy` 镜像正在退役。** 脚手架早已不再生成它,改由 controller-runtime 自身完成指标端点的认证与授权;仍在用 `gcr.io/kubebuilder/kube-rbac-proxy` 的项目会遇到镜像不可用,需要按新写法迁移指标配置。
14. **别把 kubebuilder 与 operator-sdk 的脚手架混在同一个项目里。** 两者的 `PROJECT` 元数据与插件体系不同(见 `operator-sdk` 页),混用会让后续生成行为不可预期。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `operator` — Operator 模式与控制器
- `controller-runtime` — 控制器核心库
- `crd` — 自定义资源定义
- `operator-sdk` — Operator 开发与打包工具

### 参考链接

- [kubebuilder 官方手册](https://book.kubebuilder.io/)
- [kubebuilder 仓库](https://github.com/kubernetes-sigs/kubebuilder)
- [kubebuilder 快速开始](https://book.kubebuilder.io/quick-start)
- [Operator 模式官方文档](https://kubernetes.io/docs/concepts/extend-kubernetes/operator/)
