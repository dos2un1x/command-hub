operator
===

Kubernetes Operator模式,把运维知识编码成控制器与自定义资源

## 补充说明

官方给 Operator 的定义是:**Operators 是利用自定义资源(custom resources)来管理应用及其组件的 Kubernetes 软件扩展,并且遵循 Kubernetes 的原则 —— 尤其是控制循环(control loop)**。另一句同样重要的表述是:Operator 模式让你**在不修改 Kubernetes 自身代码的前提下扩展集群行为**,做法是把控制器与一个或多个自定义资源关联起来;Operator 就是「为某个自定义资源服务的控制器」。

用一句话概括其构成:

```shell
CRD(声明期望状态)  +  Controller(观测并驱动)  =  Operator
```

它不是一个新的 API 对象,也不是某个具体的软件,而是一种**模式**:把人类运维 DBA、中间件工程师的日常判断 —— 何时做备份、主库挂了怎么切、版本升级要按什么顺序滚动 —— 翻译成一段永不疲倦的控制循环代码。

Kubernetes 内置的控制器(Deployment、StatefulSet、Job)解决的是**通用**编排问题。而「PostgreSQL 主从切换」「Etcd 集群成员增删」「证书到期前 30 天续签」这类知识,只有领域专家清楚,于是官方给出的答案就是:让用户自己定义一种资源类型,自己写控制器去实现它。这就是 Operator。

### 三个层次

初学者最容易把这三个词混着用,先把它们的边界划清:

| 概念 | 是什么 | 例子 |
| --- | --- | --- |
| CustomResourceDefinition | 在 API 中注册一种新类型 | `postgresqls.acid.zalan.do` |
| CustomResource | 这种类型的一个具体实例,即期望状态 | `kind: postgresql`,`replicas: 3` |
| Controller | 一段持续运行的进程,读实例、调资源 | 监听后创建 StatefulSet、Service、Secret |
| Operator | **分发单位**:CRD + Controller + RBAC + 部署清单 + 镜像 | 上述全部打包成一个可安装的整体 |

**有了 CRD 而没有控制器,那份 API 就只是躺在 etcd 里的数据**,不会有任何事情发生。这是自建 Operator 最常见的「看起来装好了但没反应」的原因 —— 只 `kubectl apply -f` 了 CRD,忘了部署控制器。

### 控制循环(Reconcile Loop)

Operator 的心脏是一个无限循环:读取实际状态,与期望状态比对,然后执行动作让二者靠近。

```shell
for {
    期望状态 := 读取 CR 的 spec           # 用户写的,如 replicas: 3
    实际状态 := 读取集群里的真实对象        # 如现存的 Pod 数量
    if 实际状态 != 期望状态 {
        执行动作                          # 创建 / 删除 / 更新
    }
    等待下一次触发                        # watch 到变化,或定时重新同步
}
```

在 `controller-runtime` 里,这个循环被抽象成一个接口,每次被调用时只处理**一个对象**:

```shell
func (r *Reconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
    var pg myv1.Postgres
    if err := r.Get(ctx, req.NamespacedName, &pg); err != nil {
        return ctrl.Result{}, client.IgnoreNotFound(err)   // 对象已删除,不是错误
    }
    // ……比对并驱动……
    return ctrl.Result{}, nil
}
```

**循环本身不保存任何状态**。真正的状态永远在 API Server(etcd)里 —— 这也是 Operator 可以在任意时刻被重启、被迁移、被杀掉重建的原因:重启后它会重新把世界的现状读一遍,然后继续收敛。

### 期望状态与观测状态

Kubernetes 里所有对象都遵循同一个约定:用户只写 `spec`,控制器只写 `status`。

```shell
apiVersion: acid.zalan.do/v1
kind: postgresql
spec:
  replicas: 3          # 期望状态:由用户声明
  version: "16"
status:
  observedGeneration: 4    # 控制器最近处理的是第几代 spec
  readyReplicas: 2         # 观测状态:由控制器回写
  conditions:
  - type: Ready
    status: "False"
    reason: PodsNotReady
```

两个实践要点:

1. **`observedGeneration` 是判断「Operator 到底处理没有」的关键字段**。它小于 `metadata.generation` 时,说明控制器还没有看到最新的 spec,此时状态是陈旧的 —— 排查问题时先看这个字段,能立刻区分「Operator 挂了」和「Operator 在处理但没成功」。
2. **用户不应该去写 `status`**。它由控制器独占,手工改动会在下一次 reconcile 时被覆盖。

### 水平触发,而非边缘触发

这是理解 Operator 行为最重要的一个论断。它出自 Kubernetes 官方的 **API 约定文档**(`kubernetes/community` 仓库的 api-conventions,不是 kubernetes.io 的概念页,概念页只讲「控制循环让现状趋近期望状态」):**系统的行为是「基于水平(level-based)」而不是「基于边缘(edge-based)」的,这样才能在中间状态变化丢失的情况下依然保持健壮。** 同一份文档在讲 conditions 时也重申:系统是水平触发而非边缘触发的,应当假设自己面对的是一个开放世界。

- **边缘触发(edge-triggered)**:因为「收到了 A 事件」所以执行动作 A。事件丢了,动作就丢了。
- **水平触发(level-triggered)**:因为「现在的状态是 B」所以执行纠正动作。事件只是让你**去看一眼**的信号,看的内容是世界的现状。

因此,同一次用户改动导致 reconcile 被调用 **1 次还是 5 次都不重要** —— 每次调用看到的都是同一个现状,收敛出的结果也相同。这直接推导出下一条要求。

### 幂等性是硬性要求

**Reconcile 必须可以执行任意多次而结果相同。** 触发它的情况包括:

```shell
用户改了一次 spec                     → 触发
控制器自己写了 status,又触发了一次 watch  → 触发
缓存重新同步(resync,默认约 10 小时)     → 触发
上一位 Operator 副本被驱逐,新副本接管     → 触发
网络抖动导致事件重复投递                  → 触发
```

所以下面这些写法都是错的:

```shell
# 错误:把「追加」当成一次性操作,重跑就会写两条记录
appendRecord(externalSystem, object.Name)

# 错误:用自增的方式计数,重跑就会多加一次
current := getCounter(); setCounter(current + 1)

# 错误:假设上一次 reconcile 一定已经成功执行过
if object.Status.LastApplied != desired { applyOnce() }
```

正确的思路是**每次都重新比对**:先 `Get` 当前值,与期望值不同才写。写回时用 `CreateOrUpdate`、`Patch` 或服务端应用(Server-Side Apply)这类天然幂等的接口。

错误处理同样要分清种类:

```shell
返回 error           → 指数退避后重新入队,适用于临时性故障
返回 RequeueAfter    → 明确要求「过一会儿再来看」,适用于等待外部系统就绪
返回空 Result 且无错 → 认为已收敛,不再重试
```

**把永久性错误(比如用户填的密码格式非法)返回成 error,会让 Operator 无限重试刷爆日志**,正确做法是把它写进 `status.conditions` 让用户看到。

### finalizer:清理集群外的资源

Pod 被删除时,kubelet 会负责杀掉容器;但 Operator 创建的东西常常在集群之外 —— 云厂商的负载均衡器、DNS 记录、对象存储桶、外部数据库账号。这些必须由 Operator 自己清理,靠的是 **finalizer**。

```shell
删除请求到达
    ↓
API Server 发现 metadata.finalizers 非空
    ↓
只设置 metadata.deletionTimestamp,对象不消失
    ↓
Operator 观察到 deletionTimestamp 非空 → 先做外部清理 → 再移除 finalizer
    ↓
最后一个 finalizer 被移除 → 对象真正从 etcd 消失
```

```shell
# 控制器中处理删除的典型骨架
if !object.DeletionTimestamp.IsZero() {
    if controllerutil.ContainsFinalizer(&object, "example.com/cleanup") {
        cleanupExternalResources(&object)          // 必须幂等
        controllerutil.RemoveFinalizer(&object, "example.com/cleanup")
        r.Update(ctx, &object)
    }
    return ctrl.Result{}, nil                       // 直接返回,不要继续往下建资源
}
```

**自定义 finalizer 的名字必须是「限定名」**(形如 `example.com/finalizer-name`)。这是 API Server **强制**的规则:对自定义 finalizer 使用不带域名的名字,写入会被直接拒绝。

**最常见的生产事故:finalizer 写了却忘了移除,资源永远卡在 `Terminating`。** 应急手段是手工摘掉 finalizer:

```shell
kubectl patch postgresql my-db --type=json \
  --patch='[{"op":"remove","path":"/metadata/finalizers"}]'
```

但请务必明白代价:对象会**立刻消失**,而外部资源(云负载均衡器、DNS 记录)会被留成孤儿,后续只能手工清理或写脚本兜底。官方文档的建议同样是「**避免**手工移除 finalizer」—— 除非你确实理解它的用途,并且已经用别的方式完成了那件事。这应该是应急而非流程。

### OwnerReference 与级联删除

Operator 创建子对象(StatefulSet、Service、ConfigMap)时,应把 CR 设为它们的 owner:

```shell
metadata:
  ownerReferences:
  - apiVersion: acid.zalan.do/v1
    kind: postgresql
    name: my-db
    uid: 6f1a...            # 必须是 uid,不能只写名字
    controller: true
    blockOwnerDeletion: true
```

好处是**用户删掉 CR,所有子对象由垃圾回收器自动清走**,Operator 不必自己遍历删除(这也让上文 finalizer 的逻辑更简单)。两条硬性限制:

1. **跨命名空间的 owner 是不允许的(设计如此)。** 命名空间级的 dependent 可以指向集群级或同命名空间的 owner;如果 owner 不在同一个命名空间,这个 owner 引用会被**当作不存在**,并伴随一个 `OwnerRefInvalidNamespace` 事件 —— 表现为「子对象没有被回收」而不是明确报错。
2. **集群级对象只能以集群级对象为 owner。** 反过来(命名空间级对象指向集群级 owner)是允许的。

排查悬空引用:

```shell
kubectl get events -A --field-selector=reason=OwnerRefInvalidNamespace
```

### 什么时候该写 Operator

这是最值得先想清楚的一步。需要说明的是:**官方并没有一张「Operator 何时该写」的清单**,它把问题抬高了一层 —— 回答「这个 API 到底该不该是声明式的」。

官方的第一条判据是**先用最简单的**:

- 只是要存配置?用 **ConfigMap**(敏感数据用 Secret)。判据是:已经有现成的配置文件格式、整份配置可以放在一个键里、以文件或环境变量形式被 Pod 消费、希望改动后滚动更新。

第二条判据是**当下面这些条件大部分成立时,才轮到自定义资源(CRD 或聚合 API)**:

- 你希望用 Kubernetes 的客户端库与 CLI 操作它,例如 `kubectl get my-object`;
- 你希望围绕它写新的自动化:watch 它的变化,再去 CRUD 其他对象,或者反过来;
- 你希望沿用 `.spec`、`.status`、`.metadata` 这套 API 约定;
- 它是对一组受控资源的抽象,或是对其他资源的汇总。

官方还给出了「声明式 API」的验收条件:对象小而少、内容是配置、更新不频繁、由人来读写、操作是 CRUD 式的、**不需要跨对象事务**(API 表达的是期望状态,不是精确状态)。反过来,「单个对象大于几 kB 或对象数上千」「需要每秒几十次的持续带宽」「非 CRUD 的操作」被明确列为不该做成声明式 API 的信号。

在此基础上,下面是从实践出发的取舍建议(属于经验判断,不是文档原文):

**适合写:**

- 有**状态**的中间件/数据库,运维动作需要顺序与判断(初始化、选主、扩缩容、备份恢复)。
- 需要把**集群外的系统**纳入期望状态(云资源、外部服务、DNS)。
- 同一套运维知识会被反复使用,值得固化成代码并测试(如公司内部统一的 MySQL 交付标准)。
- 需要自动修复:副本挂了自动补、证书快过期自动换。

**不适合写:**

- 只是要把一组 Deployment、Service、ConfigMap 交付到集群 —— 用 Helm 或 Kustomize 就够了。
- 一次性的迁移任务 —— 用 Job。
- 纯粹的定时动作 —— 用 CronJob。
- 只有一两个环境用、运维步骤几乎不变 —— 写 Operator 的维护成本(CRD 版本演进、e2e 测试、升级)会超过收益。

判断标准可以概括为一句话:**如果「怎么做」比「做什么」复杂,才值得写 Operator。** 一个只是把若干 Deployment、Service、ConfigMap 交付到集群的应用,用 Helm 或 Kustomize 打包就够了,不需要为它发明一种 API。

### 与 Controller 的关系

- **Controller 是机制,Operator 是领域封装。** 所有 Operator 都由一个或多个 Controller 组成,但 Controller 这个词也用于描述 Kubernetes 内置的组件(`kube-controller-manager` 里的 Deployment Controller、Node Controller)。
- 一个 Operator 可以包含**多个 Controller**,分别负责同一 CRD 的不同方面(例如一个管数据库、一个管备份、一个管监控),这是推荐做法:单一 Controller 只做一件事,彼此通过同一个 CR 通信。
- **控制器可以监听不只自己 CRD 的资源**。例如把「某个 ConfigMap 变了」也映射成一次 reconcile(map 函数),这是 Operator 表达「配置驱动」的常用手段。

### 编写与分发方式

| 名称 | 定位 | 说明 |
| --- | --- | --- |
| controller-runtime | 控制器核心库 | Manager、Cache、Client、Builder 一应俱全 |
| kubebuilder | 官方脚手架 | 生成项目骨架、Makefile、测试与清单 |
| operator-sdk | 打包与分发 | 内嵌 kubebuilder 作脚手架,额外提供 bundle 与 OLM 能力 |
| OLM | 集群内生命周期管理 | 负责安装、升级、权限治理,详见对应页面 |

语言方面 Go 是绝对主流(生态与文档最完整),此外还有 Java(`java-operator-sdk`)、Python(`kopf`)、Rust 等实现,但用它们写出的 Operator 通常无法复用 kubebuilder 生态。

### 注意

1. **Reconcile 会被调用任意多次,幂等是底线。** 不要在里面做「追加」「自增」「只做一次」的假设,也不要依赖事件顺序。判断是否要动手的唯一依据是当前读到的实际状态。
2. **删除 finalizer 不等于清理完成。** 手工 `kubectl patch` 摘掉 finalizer 会让对象瞬间消失,外部资源变成孤儿。排查 `Terminating` 时,先看 Operator 日志确认它卡在哪一步。
3. **在 reconcile 里做长时间阻塞操作会拖垮整个控制器。** 默认每个 Controller 只有一个 worker,一次慢调用会挡住所有对象。要么把耗时逻辑拆出去,要么调大 `MaxConcurrentReconciles`,要么返回 `RequeueAfter` 稍后再来。
4. **更新 `status` 必须走 status 子资源**(前提是 CRD 声明了 `subresources.status`)。若用普通 `Update` 写回整个对象,status 的改动会被 API Server 丢弃,而 spec 的改动可能与用户并发写冲突,报 `the object has been modified` —— 遇到这类冲突要用 `retry.RetryOnConflict` 重读后再写,而不是忽略它。
5. **Operator 的能力上限等于它的 RBAC。** 社区里大量 Operator 直接申请 `cluster-admin`,这等于把整个集群交出去。应尽快把权限收敛到最小集合,并注意 `secrets` 读权限等同于拿到 ServiceAccount 身份。
6. **一个 Operator 通常只能有一个活跃副本。** 多副本必须开启 leader election,否则两个副本同时 reconcile 会互相打架。
7. **升级 Operator 时 CRD 的版本演进最麻烦。** 同一个 CRD 存多个版本需要 `conversion` webhook,而 webhook 不可用会导致该类型所有请求失败 —— 详见 `crd` 页。
8. **卸载前要先删 CR。** 先删 Operator 部署,再删 CR,最后删 CRD;顺序错了会留下无人管理的资源和卡住的 finalizer。反过来,删 CRD 会**连同所有 CR 一起删掉**。
9. **别把 CRD 当成配置中心。** 用 CRD 存一堆没有控制器处理的「配置」,只会得到一份没人校验、没人执行的 YAML,徒增 API 面。
10. **观测状态不等于真实状态。** `status` 是控制器写进去的自我报告,控制器挂了它就停止更新。看到 `Ready: True` 时,留意它的时间戳和 `observedGeneration`。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `crd` — 自定义资源定义
- `controller-runtime` — 控制器核心库
- `kubebuilder` — Operator 脚手架
- `operator-sdk` — Operator 开发与打包工具
- `olm` — Operator 生命周期管理
- `helm` — Kubernetes包管理器

### 参考链接

- [Operator 模式官方文档](https://kubernetes.io/docs/concepts/extend-kubernetes/operator/)
- [自定义资源官方文档](https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/custom-resources/)
- [Finalizers 官方文档](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/)
- [垃圾回收与 OwnerReference](https://kubernetes.io/docs/concepts/architecture/garbage-collection/)
- [CNCF Operator 白皮书](https://tag-app-delivery.cncf.io/whitepapers/operator/)
- [Kubernetes API 约定(水平触发)](https://github.com/kubernetes/community/blob/main/contributors/devel/sig-architecture/api-conventions.md)
