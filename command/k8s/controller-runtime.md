controller-runtime
===

构建Kubernetes控制器的Go语言核心库,Manager与Reconcile的实现基础

## 补充说明

**controller-runtime** 是 `kubernetes-sigs` 下的控制器开发库,也是 kubebuilder 与 operator-sdk 生成的 Operator 项目**实际运行的底层代码**。脚手架只是帮你把目录和 Makefile 搭好,真正干活的 `Manager`、`Cache`、`Client`、`Builder` 全部来自这里。

它要解决的问题是:直接用 `client-go` 写一个控制器,你需要自己处理 informer 的启动顺序、workqueue 的去重与限速、事件到对象的映射、缓存与直连的取舍、领导者选举、健康检查、指标暴露 —— 几百行样板代码,而且每一处都可能写错。controller-runtime 把这一整套收敛成了声明式 API:

```shell
ctrl.NewManager(...)          →  负责缓存、选举、指标、webhook 服务、优雅退出
ctrl.NewControllerManagedBy  →  负责 watch 什么、谁来处理、并发多少
reconcile.Reconciler         →  你只需要实现这一个方法
```

它**不是一个独立安装的软件**,没有二进制、没有 CLI,只以 Go module 的形式被引用(pkg.go.dev 上的官方文档即为其 API 手册)。

### 安装

```shell
go get sigs.k8s.io/controller-runtime@latest

# 当前最新稳定版为 v0.25.x(2026 年 9 月),对应 k8s.io/* v0.37
go list -m sigs.k8s.io/controller-runtime

# 生成的项目里通常还会带上这些配套库
go list -m k8s.io/api k8s.io/apimachinery k8s.io/client-go
```

版本兼容关系很重要:**controller-runtime 的每个次版本都对应一个 Kubernetes 次版本**,必须与 `k8s.io/*` 依赖保持一致,交叉升级会出现编译错误或难以定位的运行时行为差异。仓库 README 中的兼容矩阵(此处摘录,以官方为准):

| controller-runtime | k8s.io/*、client-go | 最低 Go |
| --- | --- | --- |
| v0.25 | v0.37 | 1.26 |
| v0.24 | v0.36 | 1.26 |
| v0.23 | v0.35 | 1.25 |
| v0.22 | v0.34 | 1.24 |
| v0.21 | v0.33 | 1.24 |
| v0.20 | v0.32 | 1.23 |
| v0.19 | v0.31 | 1.22 |

需要留意它的版本策略:项目停留在 `v0` 大版本,**每个 Kubernetes 次版本对应一个 controller-runtime 次版本**,破坏性变更允许出现在次版本之间、绝不出现在补丁版本里。因此升级时必须成对升级,而不是只升 `k8s.io/client-go`。

### 核心概念

| 类型 | 作用 |
| --- | --- |
| `Manager` | 进程级单例,聚合 Cache、Client、Scheme、指标、选举与生命周期 |
| `Scheme` | 类型注册表,决定哪些 Go 类型能被序列化/反序列化 |
| `Cache` | 基于 informer 的本地缓存,所有 watch 与读请求的数据源 |
| `Client` | 读写入口,**读默认走缓存,写直连 API Server** |
| `Reconciler` | 你实现的接口,`Reconcile(ctx, req)` 处理单个对象 |
| `Builder` | 声明式地组装 Controller:For / Owns / Watches |
| `Predicate` | 事件过滤器,决定哪些变更值得触发 reconcile |
| `Source` | 事件来源(默认是 watch,也可以是 channel 或定时) |

### Manager

Manager 是整个进程的入口,通常作为 `main()` 里唯一被创建的重量级对象。**一个进程只应创建一个 Manager** —— 它是缓存、连接、指标的持有者,创建多个会得到多份互相独立的缓存,内存与连接数成倍增长,而且底层共享的 informer 会互相干扰。

```shell
mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
    Scheme:                 scheme,
    Metrics:                metricsserver.Options{BindAddress: ":8080"},
    HealthProbeBindAddress: ":8081",
    LeaderElection:         true,
    LeaderElectionID:       "example.com.my-operator",
    Cache: cache.Options{
        SyncPeriod: ptr.To(10 * time.Hour),      // 默认值,含 10% 抖动
    },
})
if err != nil {
    os.Exit(1)
}

if err := ctrl.NewControllerManagedBy(mgr).For(&myv1.Postgres{}).Complete(r); err != nil {
    os.Exit(1)
}

if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
    os.Exit(1)
}

if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
    os.Exit(1)
}
```

几点约定:

- `ctrl.GetConfigOrDie()` 的顺序是 `--kubeconfig` 参数 → `KUBECONFIG` 环境变量 → 集群内 ServiceAccount。**集群内运行时不需要任何配置文件**,靠挂载的 token 与 CA。
- `ctrl.SetupSignalHandler()` 返回的 context 在收到 SIGTERM/SIGINT 时取消,Manager 借此优雅停止:先停止接收集群事件,再等待正在执行的 reconcile 收尾。
- Manager 启动时会**等待所有缓存完成首次同步**才会开始分发事件。缓存没同步完,`kubectl logs` 里会看到控制器「没动静」,这是正常的。
- 用 `LeaderElection: true` 时 `LeaderElectionID` 必填,并且需要 `coordination.k8s.io` 的 `leases` 权限;未当选的副本只是待命,不执行 reconcile。

### Cache 与 Client

这是最容易踩坑的一对概念。**Manager 的 Client 是一个「双面」客户端**:

```shell
读操作(Get/List)  →  走 Cache(informer 本地缓存),不访问 API Server
写操作(Create/Update/Patch/Delete)  →  直连 API Server
```

好处是对 API Server 的压力极小 —— watch 一次,之后所有 List 都在本地完成。代价是**缓存与 API Server 之间必然存在延迟**:

```shell
# 典型陷阱:写完立刻读,读到的可能是旧值
r.Update(ctx, &obj)                  # 写入成功
r.Get(ctx, key, &fresh)              # 从缓存读,可能还是旧版本
```

对一致性要求高的读取有两条出路:

```shell
# 1. 直接读 API Server,绕过缓存
apiReader := mgr.GetAPIReader()
apiReader.Get(ctx, key, &obj)

# 2. 让某个类型不走缓存(在 Manager 的 Cache 选项里声明)
cache.Options{
    ReaderFailOnMissingInformer: true,
    ByObject: map[client.Object]cache.ByObject{
        &corev1.Secret{}: {Namespaces: map[string]cache.Config{"default": {}}},
    },
}
```

### 缓存命名空间限制

**这是 Namespace 级 Operator 最容易撞上的一堵墙。** 为了省内存,很多人会把缓存限制到自己关心的命名空间:

```shell
mgr, _ := ctrl.NewManager(cfg, ctrl.Options{
    Cache: cache.Options{
        DefaultNamespaces: map[string]cache.Config{
            "my-app": {},
        },
    },
})
```

一旦这样做,行为会发生这些变化:

- **只能缓存该命名空间内的对象**,其他命名空间的对象读不到;
- **集群级资源(Node、PersistentVolume、CRD 等)无法通过这个缓存访问**,对它们调用 `Get`/`List` 会报 `failed to get informer from cache`,需要改用 `mgr.GetAPIReader()` 或为它们单独配置一个不做限制的 client;
- **`Watches`/`Owns` 注册了被排除的命名空间的对象时,控制器启动会失败或永远收不到事件**;
- 若要覆盖多个命名空间,用 `DefaultNamespaces` 列出,或用 `cache.Options{DefaultNamespaces: ...}` 配合 `ByObject` 做更细的控制。

限制缓存范围是有效的内存优化手段,但它不是「透明」的 —— 加之前先确认控制器不需要看集群级对象和其他命名空间。

### Reconciler 与事件源

```shell
func (r *PostgresReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    log := logf.FromContext(ctx)

    var pg myv1.Postgres
    if err := r.Get(ctx, req.NamespacedName, &pg); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)
    }
    log.Info("reconciling", "generation", pg.Generation)
    // ……
    return ctrl.Result{}, nil
}
```

组装控制器时,`For` 是主对象,`Owns` 是「由主对象创建的子资源」,`Watches` 是任意第三方资源:

```shell
ctrl.NewControllerManagedBy(mgr).
    For(&myv1.Postgres{}).                       // 主对象:CR 变化时触发
    Owns(&appsv1.StatefulSet{}).                 // 子资源变化时,找到它的 owner 再触发
    Owns(&corev1.Service{}).
    Watches(&corev1.ConfigMap{},                 // 非 owner 关系,需要自己写映射函数
        handler.EnqueueRequestsFromMapFunc(func(ctx context.Context, o client.Object) []reconcile.Request {
            return []reconcile.Request{
                {NamespacedName: types.NamespacedName{Name: "my-db", Namespace: o.GetNamespace()}},
            }
        })).
    WithOptions(controller.Options{MaxConcurrentReconciles: 4}).
    Complete(r)
```

**`Owns` 依赖 `ownerReferences` 才能工作。** 子对象上没有正确的 owner 引用时,它的变化不会被关联回主对象 —— 表现是「改了子资源,CR 不会重新调谐」。用 `controllerutil.SetControllerReference(&pg, deploy, r.Scheme)` 设置,它同时会帮你校验命名空间与类型合法性。

### 并发、重试与限速

- 同一个对象**不会**被并发处理:workqueue 保证同一 key 同时只有一个 worker,但**不同对象之间是并发的**。
- 默认每个 Controller 只有一个 worker。`MaxConcurrentReconciles` 调大能提升吞吐,但你的 Reconciler 必须**并发安全**:别在结构体里累积可变状态,别写全局 map 而不加锁。
- 返回 `error` 会按指数退避重试(默认限速器约从毫秒级起步,上限十几分钟),同时打印错误日志;返回 `RequeueAfter` 是精确的定时重排,适合「等 30 秒后检查外部系统」。
- 每次缓存重新同步(`SyncPeriod`,默认约 10 小时,**带随机抖动**)都会为所有对象触发一轮 reconcile。这意味着 **reconcile 的频率和时机不可预期,幂等性不是可选项**。

### Predicate:减少无意义的调谐

```shell
import "sigs.k8s.io/controller-runtime/pkg/predicate"

ctrl.NewControllerManagedBy(mgr).
    For(&myv1.Postgres{}).
    WithEventFilter(predicate.Or(
        predicate.GenerationChangedPredicate{},        // spec 变化才触发,忽略纯 status 更新
        predicate.LabelChangedPredicate{},
        predicate.AnnotationChangedPredicate{},
    )).
    Complete(r)
```

`GenerationChangedPredicate` 只对「会递增 `metadata.generation` 的资源」有意义(即带 status 子资源的资源),对 ConfigMap 这类资源无效 —— 它们的 generation 永远是 1。

### 本地运行与测试

```shell
# 用当前 kubeconfig 在本地跑控制器(不打包镜像)
make run
go run ./cmd/main.go --leader-elect=false

# 只跑单元测试
go test ./...

# envtest:启动真实的 etcd + kube-apiserver 二进制做集成测试
make test
KUBEBUILDER_ASSETS=/usr/local/kubebuilder/bin go test ./... -v
```

envtest 需要 CRD 与 webhook 清单已安装到测试环境,通常在测试代码里声明:

```shell
testEnv := &envtest.Environment{
    CRDDirectoryPaths:     []string{filepath.Join("..", "config", "crd", "bases")},
    ErrorIfCRDPathMissing: true,
}
```

### 注意

1. **读走缓存、写直连,读后写会读到旧值。** 这是 controller-runtime 最经典的坑。写入后需要立即基于最新版本做判断时,用 `mgr.GetAPIReader()` 或直接使用 `Update` 返回的对象,不要用缓存里的旧对象再次 `Update`。
2. **一个进程只创建一个 Manager。** 多 Manager 意味着多份缓存、多份指标注册(会因重复注册而 panic)、多套选举,资源占用翻倍且行为难以预测。
3. **缓存限制了命名空间,就看不到集群级资源。** 报错信息通常是 `failed to get informer from cache` 或 `no matches for kind`。Namespace 级 Operator 必须显式处理 PV、Node、StorageClass 这类集群级对象。
4. **`Credentials` / `Secret` 等内容不要放进宽范围的缓存。** 缓存会把对象完整保留在内存中,把 Secret 全量缓存到进程里等于把集群密钥复制一份到 Operator 内存,同时显著抬高内存占用。用 `ByObject` 限制命名空间,或对敏感类型改用直连读取。
5. **`Owns` 不生效时先查 ownerReference。** 子对象缺少 owner 引用(或引用的 uid 不对)时,事件无法回溯到主对象,控制器看起来「漏事件」。
6. **返回 error 与返回 `RequeueAfter` 语义不同。** 前者是失败并退避重试(会打错误日志),后者是「稍后再来」的正常调度。把正常等待当成 error 返回,会污染错误指标并让日志充满噪音。
7. **Reconciler 必须是并发安全的。** `MaxConcurrentReconciles > 1` 时多个对象同时进入 Reconcile,任何结构体字段、缓存 map、共享 client 上的可变状态都要加锁或改为每次新建。
8. **别在 Reconcile 里做长时间阻塞调用。** 单个 worker 被阻塞时,该 Controller 的所有对象都停止调谐。外部 API 调用要带超时,长流程拆成多次 reconcile。
9. **`GenerationChangedPredicate` 对没有 status 子资源的对象无效。** ConfigMap、Secret 等对象的 generation 恒为 1,加了它等于屏蔽全部更新事件。
10. **指标端口与安全服务的默认值随版本变化过。** 较新版本的 `metricsserver` 默认启用安全服务(HTTPS + 自签证书),本地 `go run` 时若沿用旧写法可能连不上采集端点。以所用版本脚手架的 `main.go` 为准,不要照抄老教程。
11. **`k8s.io/*` 依赖版本必须与 controller-runtime 匹配。** 手动升级 client-go 而不升 controller-runtime(或反之)会出现接口不兼容的编译错误,或更隐蔽的 informer 行为差异。
12. **envtest 不是完整集群。** 它没有 kubelet、没有调度器、没有控制器管理器,Pod 不会被真正运行。依赖调度结果的逻辑无法在 envtest 中验证,必须补真实集群的 e2e。
13. **webhook 与控制器可以共用一个 Manager,但要注意启动顺序。** 转换 webhook(CRD conversion)不可用会导致整个 CRD 类型不可读写,证书未就绪就启动是常见的自锁原因。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `operator` — Operator 模式与控制器
- `kubebuilder` — Operator 脚手架
- `operator-sdk` — Operator 开发与打包工具
- `crd` — 自定义资源定义

### 参考链接

- [controller-runtime 仓库](https://github.com/kubernetes-sigs/controller-runtime)
- [controller-runtime API 文档](https://pkg.go.dev/sigs.k8s.io/controller-runtime)
- [kubebuilder 手册](https://book.kubebuilder.io/)
- [Operator 模式官方文档](https://kubernetes.io/docs/concepts/extend-kubernetes/operator/)
