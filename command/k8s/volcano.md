volcano
===

面向批处理与AI训练的Kubernetes批调度器(gang scheduling/队列管理)

## 补充说明

**Volcano** 是 CNCF **Incubating** 级别的批调度系统(2020-04-09 被 CNCF 接纳,2022-03-21 进入 Incubating),由华为发起,补上了原生 kube-scheduler 在**批处理与 AI 训练**场景缺失的两块能力:

```shell
Gang scheduling   一组 Pod 要么全部调度成功,要么全部不调度
                  (原生调度器是逐个 Pod 调度的,分布式训练会互相等待而死锁)

队列与公平分享    以 Queue 为单位做资源配额、权重、抢占与回收
                  (原生只有 PriorityClass + 抢占,没有队列概念)
```

当前最新版本为 **v1.15.2(2026-08-29)**,这是一个**安全修复版本**,修的是 DRA 容量核算里「过度迭代可阻塞调度」的问题(CVSS 6.5),**影响 v1.15.0 与 v1.15.1**,在用这两个版本应尽快升级。更早的 v1.14.2 / v1.13.3 / v1.12.4 则修了 Webhook 因请求体过大导致 OOM 的问题。

三个核心对象:

```shell
Queue      集群级对象,资源池。配额、权重、优先级、抢占都在这里配置
PodGroup   一组必须同生共死的 Pod 的集合,gang scheduling 的载体
Job(vcjob) Volcano 自己的批作业对象,内部会自动创建并管理 PodGroup
```

### 安装

```shell
helm repo add volcano-sh https://volcano-sh.github.io/helm-charts
helm repo update
helm install volcano volcano-sh/volcano -n volcano-system --create-namespace

kubectl get pods -n volcano-system
# vc-scheduler / vc-controller-manager / vc-webhook-manager / vc-agent ...
```

装完之后集群里多了一个 `schedulerName` 为 `volcano` 的调度器,**它只处理 `schedulerName: volcano` 的 Pod**,其余 Pod 照旧由 kube-scheduler 调度 —— 两者可以长期共存,不需要额外协调。

### PodGroup 与 gang scheduling

`PodGroup` 是 gang scheduling 的载体(`scheduling.volcano.sh/v1beta1`),**`minMember` 是其中最关键的一个字段**:

```shell
apiVersion: scheduling.volcano.sh/v1beta1
kind: PodGroup
metadata:
  name: training-group
  namespace: default
spec:
  minMember: 8            # 少于 8 个可调度任务时,一个都不启动
  queue: research
  priorityClassName: high-priority
  minResources:
    cpu: "32"
    memory: 128Gi
    nvidia.com/gpu: "8"
```

`minMember` 的官方定义就是:**资源不足以启动全部任务时,调度器不会启动任何一个**。这正是分布式训练需要的语义 —— 宁可等着,也不要起一半。

普通的 Deployment/StatefulSet 想用 gang scheduling,就给 Pod 打上注解,让它加入某个 PodGroup:

```shell
apiVersion: apps/v1
kind: Deployment
metadata:
  name: gang-demo
spec:
  replicas: 4
  template:
    metadata:
      annotations:
        scheduling.k8s.io/group-name: training-group
    spec:
      schedulerName: volcano
      containers:
        - name: app
          image: busybox:1.36
          command: ["sleep", "infinity"]
```

注解名是 **`scheduling.k8s.io/group-name`**,这是控制器实际读写的键;Volcano 的 API 里另外定义了一个 `scheduling.volcano.sh/group-name` 常量,写文档或写工具时不要把它当成主键。

PodGroup 有两个自动创建的路径:

```shell
vcjob            作业控制器自动创建名为 <job名>-<job UID> 的 PodGroup
普通工作负载     podgroup 控制器为「有 owner 但没有注解」的 Pod 创建
                 名为 podgroup-<owner UID> 的 PodGroup(StatefulSet 除外,它自己管)
```

`spec` 里还有 `minTaskMember`(按任务角色分别指定最小数量)与 `subGroupPolicy`(子组级 gang 与网络拓扑)。官方源码注释已明确**推荐用 `subGroupPolicy`**,它覆盖了 `minTaskMember` 的全部能力。

### Queue:资源池与配额

`Queue` 是**集群级对象**(不是命名空间的):

```shell
apiVersion: scheduling.volcano.sh/v1beta1
kind: Queue
metadata:
  name: research
spec:
  weight: 1              # 权重,默认 1,范围 1-65535
  capability:            # 资源上限
    cpu: "100"
    memory: 400Gi
    nvidia.com/gpu: "16"
  deserved:              # 应得份额,超出部分可被其他队列回收
    cpu: "40"
    memory: 160Gi
  reclaimable: true      # 是否允许被回收
  priority: 10           # 队列优先级,抢占时参考
  dequeueStrategy: traverse    # traverse(默认)/ fifo
```

几个字段的差别值得记清楚:

```shell
capability   硬上限。队列内所有 Pod 的用量之和不能超过它
deserved     应得份额。低于它时受保护;高于它的部分可以被别人 reclaim
guarantee    预留资源,不可被共享
reclaimable  是否允许别的队列从本队列回收资源
```

`dequeueStrategy` 的默认值是 `traverse`,即跳过暂时调度不上的队首继续往后看;改成 `fifo` 会严格遵守先进先出。

**队列层级**在 v1.11.0 引入:调度器启动时会自动创建一个 `root` 队列作为树根,子队列用 `spec.parent` 挂上去。

```shell
spec:
  parent: research
  deserved:
    cpu: "16"
```

层级语义:子队列的 `capability` 不能超过父队列;未指定的维度从父队列继承;只有**叶子队列**能接收作业;回收时先看兄弟队列(仅当兄弟超出其 `deserved`),不够再向上层回溯。要启用层级队列,必须在调度器配置里打开 **`capacity` 插件的 `enableHierarchy: true`**,并启用 `reclaim` action。

### 调度器配置:actions 与 plugins

Volcano 调度器的行为由一个 ConfigMap 决定,默认配置(Helm chart 的 `volcano-scheduler.conf`)是:

```shell
actions: "enqueue, allocate, backfill"
tiers:
  - plugins:
      - name: priority
      - name: gang
        enablePreemptable: false
      - name: conformance
  - plugins:
      - name: overcommit
      - name: drf
        enablePreemptable: false
      - name: predicates
      - name: proportion
      - name: nodeorder
      - name: binpack
```

可用的 action 有:

```shell
enqueue   把 Pending 的 PodGroup 放进待调度队列,分配队列配额
allocate  真正做节点绑定,gang 语义在这里生效
backfill  在没有更好的选择时,用低优先级任务填空闲资源
preempt   高优先级抢占低优先级
reclaim   跨队列回收超出 deserved 的资源
shuffle   主动打散已运行的 Pod 以缓解热点
gangpreempt / gangreclaim   成组抢占与回收(alpha)
```

**默认的 `actions` 里没有 `preempt`、`reclaim`、`shuffle`** —— 想要抢占与跨队列回收,必须显式加进去,例如 `actions: "enqueue, allocate, preempt, reclaim, backfill"`。Volcano 不会校验 action 的先后顺序是否合理。

常用 plugin:`gang`、`priority`、`drf`(主导资源公平)、`proportion`(队列间按权重分配)、`capacity`(层级队列与配额)、`predicates`、`nodeorder`、`binpack`、`task-topology`(按任务拓扑就近调度)、`numa-aware`、`deviceshare`(GPU 共享)、`network-topology-aware`、`sla`、`overcommit`。

v1.15.0 起新增的 `gangpreempt` / `gangreclaim` 官方明确提示:**不要与旧的 `preempt` / `reclaim` 同时配置**。

### 队列的 admission 与配额

PodGroup 的 `queue` 字段**默认是 `"default"`**,所以集群里必须有一个名为 `default` 的 Queue,否则作业会一直无法入队。用 `vcctl` 观察队列:

```shell
vcctl queue list
vcctl queue get research
vcctl job list -A
vcctl job get -n default my-vcjob
```

注意 **v1.11.0 起,队列里各种状态 PodGroup 的计数已从 `Queue.status` 迁移到 metrics**(为了降低 API Server 压力),`vcctl` 与指标是查这些数字的正确入口,别再依赖 status 里的计数字段。

### 相关命令

```shell
# 观察 PodGroup 的状态与原因
kubectl get podgroup -A
kubectl get podgroup training-group -n default -o yaml
kubectl describe podgroup training-group -n default

# 队列
vcctl queue list
kubectl get queue

# 调度器日志(排障主入口)
kubectl logs -n volcano-system deployment/vc-scheduler --tail=200

# 调度器配置
kubectl get configmap -n volcano-system volcano-scheduler-configmap -o yaml
```

PodGroup 的 `status.phase` 取值与含义:

```shell
Pending    还没凑齐,或资源不足
Inqueue    已通过校验,等待绑定
Running    已达到 minMember
Unknown    一部分在跑,另一部分调度不上,等控制器恢复
Completed  结束
```

`status.conditions` 里会出现 `Unschedulable` / `Scheduled`,失败原因常见的有 `NotEnoughResources`、`NotEnoughTasks`(对应 `minMember` 未满足)。看到 PodGroup 卡在 Pending 且带 `Unschedulable`,基本就是资源不够或被队列配额挡住。

### 注意

1. **PodGroup 的 `v1alpha2` 已经被移除**,现在只有 `scheduling.volcano.sh/v1beta1`。老清单里的 `v1alpha2` 会直接报 `no matches for kind`。
2. **gang scheduling 必须配 `minMember` 才有意义**。不写 `minMember`(或写 0)时 PodGroup 不构成约束,调度行为和普通 Pod 没区别 —— 「装了 Volcano 就自动 gang」是误解。
3. **`minMember` 不满足时 Pod 会一直 Pending**,这是**预期行为而不是故障**。集群资源碎片化时最容易出现:总空闲资源够,但没有任何一台机器能同时容纳所有任务。此时应减少 `minMember`、调整资源请求,或引入抢占。
4. **gang scheduling 的注解是 `scheduling.k8s.io/group-name`**。写成 `scheduling.volcano.sh/group-name` 通常也能被识别(API 里保留了该常量),但控制器实际使用的是前者,以它为准。
5. **`spec.queue` 默认是 `default`**。集群里没有名为 `default` 的 Queue 时,PodGroup 无法入队,表现为无缘无故的 Pending,而且日志里不会特别强调「队列不存在」。
6. **默认 `actions` 不含抢占与回收**。想要 `preempt`/`reclaim` 必须在 `volcano-scheduler-configmap` 里显式加到 `actions` 列表,并确认对应插件已启用。
7. **Volcano 只调度 `schedulerName: volcano` 的 Pod**。没写这个字段的工作负载仍然走 kube-scheduler —— 这既是优点(可以灰度、可以共存),也是坑:以为「装完 Volcano 全体生效」,结果业务 Pod 根本没进它的队列,自然也没有 gang 保护。
8. **vcjob 的 `schedulerName` 默认就是 `volcano`**,而普通 Deployment 默认是 `default-scheduler`,两者行为不一致,加注解时别忘了同时改 `schedulerName`。
9. **队列层级只能用于叶子队列**。给一个「下面还有子队列」或者「自己已经在跑作业」的队列建子队列会导致行为异常;而且必须先开 `capacity` 插件的 `enableHierarchy`,否则 `parent` 字段不生效。
10. **v1.15.2 是安全版本,在用 v1.15.0/v1.15.1 的应立即升级**;更早的版本族里,v1.14.1 及以下、v1.13.2 及以下、v1.12.3 及以下都有 Webhook OOM 的问题,对应修复版是 v1.14.2 / v1.13.3 / v1.12.4。
11. **`--lock-object-namespace` 已废弃**,改用 `--leader-elect-resource-namespace`;照抄老参数会看到弃用警告。
12. **`vcctl` 与 `vcancel`/`vresume`/`vsuspend` 是两套东西**。`vcctl` 的子命令是 `job`、`queue`、`jobtemplate`、`jobflow`、`pod`、`version`;而 `vcancel`、`vresume`、`vsuspend`、`vjobs`、`vqueues`、`vsub` 是**独立的可执行文件**,不是 `vcctl` 的子命令。
13. **多集群场景走的是另一个子项目**。跨集群调度由 `volcano-sh/volcano-global`(基于 Karmada)承担,单集群的 Volcano 不负责这些。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kube-scheduler` — 默认调度器,与Volcano按schedulerName分工
- `pod` — 最小调度单元
- `priority-class` — 抢占优先级的基础
- `resource-quota` — 命名空间级配额,与Queue的维度不同
- `crd` — PodGroup/Queue/Job都是自定义资源
- `mpi-operator` — 典型的gang scheduling使用方
- `training-operator` — 训练作业可通过Volcano做gang scheduling
- `ray-operator` — Ray集群的多Pod协同同样依赖gang调度
- `node` — 节点资源与拓扑影响队列配额

### 参考链接

- [Volcano 官方文档](https://volcano.sh/en/docs/)
- [Volcano 仓库](https://github.com/volcano-sh/volcano)
- [安装文档](https://volcano.sh/en/docs/installation/)
- [vcjob 用户指南](https://volcano.sh/en/docs/vcjob/)
- [调度器配置](https://volcano.sh/en/docs/scheduler/)
- [层级队列](https://volcano.sh/en/docs/hierarchical_queue/)
- [Release 列表(含安全公告)](https://github.com/volcano-sh/volcano/releases)
- [CNCF 项目页](https://www.cncf.io/projects/volcano/)
