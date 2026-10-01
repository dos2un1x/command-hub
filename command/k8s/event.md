event
===

Kubernetes事件查询:集群故障排查的第一手线索

## 补充说明

**Event(事件)** 是 Kubernetes 中记录「集群里发生了什么」的资源对象。调度失败、镜像拉取失败、探针失败、Pod 被驱逐、节点失联……几乎所有异常都会先以事件的形式出现。排障时先看事件,往往能省掉一半时间。

事件由各个组件写入:kubelet、kube-scheduler、kube-controller-manager、各工作负载控制器等。它和日志的区别在于:**事件是结构化的、带时间戳的、按对象关联的**,而日志是各组件各写各的、分散在各个节点上。

两个 API 版本并存:

| API | 说明 |
| --- | --- |
| `v1/Event`(`core/v1`) | 传统事件,`kubectl get events` 默认读的就是它 |
| `events.k8s.io/v1` | 新的事件 API,字段更规范,`kubectl events` 使用它 |

`kubectl events` 是官方提供的独立子命令,比 `kubectl get events` 的可读性和过滤能力更好;老版本 kubectl 没有这个子命令时,需要用插件形式补充。

事件**不是**持久化审计日志。kube-apiserver 默认只保留 1 小时(`--event-ttl`),超时即删除,因此事件适合「当下排障」,不适合「事后追溯」——后者要靠审计日志或日志采集系统。

### 语法

```shell
kubectl events [(-o|--output=)json|yaml|name|...] [--for TYPE/NAME] [--watch] [--types=Normal,Warning]
```

```shell
kubectl get events [--field-selector ...] [--sort-by=.lastTimestamp]
```

### kubectl events 常用操作

```shell
# 当前命名空间的近期事件
kubectl events

# 全部命名空间(排障时的第一条命令)
kubectl events -A

# 只看告警
kubectl events --types=Warning
kubectl events -A --types=Warning

# 跟踪新事件(类似 tail -f)
kubectl events -A --watch

# 指定命名空间
kubectl events -n kube-system

# 结构化输出,便于交给 jq 处理
kubectl events -A -o json
kubectl events -A -o yaml
```

### 聚焦到单个对象

`--for` 用于把事件限定到某个具体资源上,这是排查单个 Pod 时最常用的姿势:

```shell
# 只看某个 Pod 的事件
kubectl events --for pod/my-app-7d9f8b6c5-abcde

# 边看历史边等待新事件
kubectl events --for pod/my-app-7d9f8b6c5-abcde --watch

# 其他资源同样支持
kubectl events --for deployment/my-app
kubectl events --for node/worker-1
kubectl events -A --for deployment/my-app
```

### 用 kubectl get events 过滤

`kubectl get events` 支持字段选择器,适合写成脚本或在老集群上使用:

```shell
# 按事件类型过滤
kubectl get events -A --field-selector type=Warning

# 按原因过滤(例如查看所有被驱逐的 Pod)
kubectl get events -A --field-selector reason=Evicted
kubectl get events -A --field-selector reason=FailedScheduling

# 按关联对象过滤
kubectl get events --field-selector involvedObject.name=my-app-7d9f8b6c5-abcde
kubectl get events -A --field-selector involvedObject.kind=Pod

# 多个条件是「与」的关系
kubectl get events -A --field-selector type=Warning,reason=BackOff

# 按时间排序,最新的在最后
kubectl get events -A --sort-by=.lastTimestamp
kubectl get events -A --sort-by=.metadata.creationTimestamp

# 输出更完整的信息
kubectl get events -A -o wide
```

### 事件的结构

```shell
kubectl get events -A -o json | jq '.items[0]'
```

一条事件里最值得关注的字段:

| 字段 | 含义 |
| --- | --- |
| `involvedObject` | 事件关联的对象(kind / name / namespace / uid) |
| `reason` | 机器可读的原因,如 `FailedScheduling`、`BackOff`、`Evicted` |
| `message` | 人类可读的详细说明 |
| `type` | `Normal` 或 `Warning` |
| `count` | 同一事件重复发生的次数 |
| `firstTimestamp` / `lastTimestamp` | 首次与最近一次发生时间 |
| `source` | 上报组件,如 `kubelet`、`default-scheduler` |
| `reportingComponent` | 上报组件(`events.k8s.io/v1` 中使用) |

**事件会被聚合**:同一对象上的同一类事件不会每次都新建对象,而是累加 `count` 并更新 `lastTimestamp`。所以看到 `count: 137` 要意识到这是一个持续发生的故障,而不是 137 条独立事件。

### 常见事件速查

| 事件原因 | 含义 |
| --- | --- |
| `FailedScheduling` | 调度失败:资源不足、污点不容忍、亲和性不满足、PVC 未绑定 |
| `FailedMount` / `FailedAttachVolume` | 卷挂载或挂盘失败,通常是 CSI 驱动或节点问题 |
| `BackOff` / `CrashLoopBackOff` | 容器反复退出,重启间隔指数级递增 |
| `ErrImagePull` / `ImagePullBackOff` | 镜像拉取失败:镜像名错、凭据缺失、网络不通 |
| `Unhealthy` | 存活或就绪探针失败 |
| `Evicted` | 节点资源压力,kubelet 驱逐了该 Pod |
| `FailedCreatePodSandBox` | 创建 Pod sandbox 失败,通常是 CNI 或容器运行时问题 |
| `Preempted` | 被更高优先级的 Pod 抢占 |
| `NodeNotReady` | 节点失联,控制器上报 |
| `Killing` / `Started` | 容器生命周期切换 |
| `OOMKilling` | 容器被 cgroup OOM 杀掉,kubelet 上报 |

`kubectl describe pod` 等命令会在输出末尾附带该对象的近期事件,但**只显示事件 API 里还留存的部分**,超出 TTL 的历史事件不会出现。

### 事件与审计日志的区别

两者都记录「发生了什么」,但用途完全不同,不能互相替代:

| 维度 | Event | 审计日志(Audit) |
| --- | --- | --- |
| 记录内容 | 面向对象的状态变化与异常 | 面向 API 的每一次请求 |
| 保留时间 | 默认 1 小时 | 由审计策略与日志后端决定 |
| 写入方式 | 各控制器与 kubelet 主动上报 | kube-apiserver 被动记录 |
| 典型用途 | 当下排障 | 安全审计、事后追责、合规 |
| 查询方式 | `kubectl events` / `kubectl get events` | 读取审计日志文件或日志后端 |

「三天前是谁删掉了这个 Deployment」这类问题查事件是查不到的,必须依靠审计日志。反过来,审计日志里也不会记录调度的具体失败原因,那要看事件。

### 把事件接入监控

事件本身只有 1 小时寿命,生产集群应当尽早把它导出到外部系统:

```shell
# 常见方案:kubernetes-event-exporter、eventrouter 等
# 它们以 Deployment 形式运行,ListWatch 事件对象并推送到 Elasticsearch、Loki 或消息队列
kubectl get deploy -A | grep -iE 'event-exporter|eventrouter'

# 最轻量的做法:把事件流直接落盘,供后续检索
kubectl events -A --watch -o json >> /var/log/k8s-events.jsonl

# 基于事件做告警通常不直接消费事件流,而是走 Prometheus 规则
kubectl get --raw /metrics | grep apiserver_registered_watchers
```

事件导出器的资源开销不可忽视:大集群中事件写入频率很高,导出器需要缓存整个事件列表才能感知增量,内存占用会随集群规模增长。

### 注意

1. **事件默认只保留 1 小时**。kube-apiserver 的 `--event-ttl` 默认值为 `1h`,超时后被 etcd 清理。事后追查昨天的故障,`kubectl events` 什么也看不到 —— 需要提前把事件接入日志或监控系统。
2. **`kubectl get events` 不带 `-A` 时只看当前命名空间**,而节点相关事件(如 `NodeNotReady`)往往挂在 `default` 命名空间下,排障时容易漏掉,建议一律加 `-A`。
3. **`kubectl get events` 默认按创建时间排序,不是按发生时间**。被聚合的事件 `metadata.creationTimestamp` 停留在第一次发生的时间,看起来会很旧;要按最近发生排序请用 `--sort-by=.lastTimestamp`。
4. **同一事件会被聚合计数**。`count` 很大代表故障在持续,而不是一次性的;只看单条记录会严重低估问题的持续时间。
5. **`kubectl events` 没有 `--since` / `--until` / `--watch-only` 这类时间窗口参数**。要按时间过滤只能在客户端处理:`kubectl events -A -o json | jq` 后自行筛选,或直接用 `kubectl events --watch` 跟增量。
6. **Warning 事件不代表一定有问题,没有事件也不代表一定正常**。例如探针失败一定会有 `Unhealthy`,但容器被 OOM 杀死前的内存增长过程不会有任何事件。
7. **事件数量会放大 etcd 压力**。大规模集群中高频事件(如每秒数百条探针失败)会显著增加 apiserver 与 etcd 的写入量,必要时调小 `--event-ttl` 或开启事件聚合限流。
8. **`kubectl describe` 显示的事件同样受 TTL 影响**,而且它显示的是缓存结果,可能与 `kubectl events --watch` 的实时输出有出入。
9. **`--field-selector` 只支持事件对象的少数字段**(`involvedObject.*`、`reason`、`type`、`source`、`metadata.namespace` 等),按 `message` 内容过滤是不支持的,需要 `-o json` 后交给 `jq` 处理。
10. **`involvedObject.name` 匹配的是完整名称**,Deployment 产生的事件往往挂在 ReplicaSet 或 Pod 上,而不是 Deployment 本身。查 Deployment 的事件时如果一无所获,应该往下找它的 ReplicaSet。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kubelet` — 节点代理,大量事件的上报方
- `kube-apiserver` — 事件的存储入口,`--event-ttl` 在此配置
- `kube-state-metrics` — 把对象状态转成指标,与事件互补
- `metrics-server` — 集群资源指标采集组件

### 参考链接

- [kubectl events 命令参考](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_events/)
- [kubectl get 命令参考](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_get/)
- [字段选择器](https://kubernetes.io/docs/concepts/overview/working-with-objects/field-selectors/)
- [Event API 参考(events.k8s.io/v1)](https://kubernetes.io/docs/reference/kubernetes-api/cluster-resources/event-v1/)
- [集群排障官方文档](https://kubernetes.io/docs/tasks/debug/debug-cluster/)
