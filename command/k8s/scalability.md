scalability
===

Kubernetes 大规模集群的规模上限、SLO 与瓶颈定位

## 补充说明

**scalability** 是 Kubernetes 的规模话题:集群能装多少节点、多少 Pod、多少对象,官方承诺什么样的响应延迟,以及最先撑不住的通常是哪个组件。

Kubernetes 的规模承诺建立在"你保证、我保证"的框架上 —— 官方在 [Kubernetes 社区仓库](https://github.com/kubernetes/community/blob/master/sig-scalability/slos/slos.md)里写得很直白:**如果你正确配置集群、合理使用扩展能力、把负载控制在推荐阈值内,那么我们保证 SLO 达标**。反过来,超阈值不意味着集群立刻挂掉,而是"性能开始劣化、SLO 不再有保证"。

这份文档的数值来自 SIG-Scalability 的官方文件(`sig-scalability/configs-and-limits/thresholds.md` 与 `sig-scalability/slos/slos.md`),不是经验值。

### 官方规模目标

Kubernetes 设计上支持同时满足以下**全部**条件的集群:

| 维度 | 上限 |
|---|---|
| 节点数 | 5,000 |
| Pod 总数 | 150,000 |
| 容器总数 | 300,000 |
| 单节点 Pod 数 | 110 |

单节点 Pod 数在社区阈值文件里的写法更细:`min(110, 10 × 该节点核数)` —— 也就是说 8 核节点建议不超过 80 个 Pod,而不是无脑顶到 110。

### 按资源类型的阈值

集群级阈值(超出后 SLO 不再保证),取自 `sig-scalability/configs-and-limits/thresholds.md`:

| 资源 | 命名空间级 | 集群级 |
|---|---|---|
| 节点 | — | 5,000 |
| 命名空间 | — | 10,000 |
| Pod | 3,000 | 150,000 |
| 单节点 Pod | — | min(110, 10 × 核数) |
| Service | 5,000 | 10,000 |
| 单个 Service 的 Endpoint | 250 | — |
| Deployment | 2,000 | — |
| ServiceAccount Token | 2,000 | 2,000 |
| Token 校验 | — | 5,000 QPS |
| 单类型对象数(不含 Event) | — | 150,000 |
| Event 对象数(按类型) | — | 1,000,000 |
| 单个对象大小 | 1.5MB | 1.5MB |
| 单类型对象总大小 | 1.5GB | — |

三条容易忽略的说明:

1. 阈值是**按资源类型**算的 —— 150,000 指的是"某一种资源"的对象数量上限(`pods`、`secrets` 各算各的)。
2. 表中集群级数值是给**最大规模集群**的;集群更小,对应的限制也按比例更小。
3. 阈值随版本演进,以上为社区主干版本(文档中标注 Kubernetes head / v1.37)的数值。

### SLO:官方承诺什么

| 指标 | 目标 |
|---|---|
| 变更类 API 调用(每 resource/verb 对) | 99 分位 ≤ 1s(按 cluster-day 统计) |
| 只读非流式 API 调用,`scope=resource` | 99 分位 ≤ 1s |
| 只读非流式 API 调用,`scope=namespace`/`scope=cluster` | 99 分位 ≤ 30s(大范围 list 本来就慢) |
| 无状态 Pod 启动延迟(创建到全部容器 started 并被 watch 观察到,不含拉镜像与 init 容器) | 99 分位 ≤ 5s |
| 集群 churn | ≤ 20 /秒 |

churn 的定义是:每秒 `Pod spec 创建 + 更新 + 删除` 的次数,加上用户发起的请求数。这是最容易被忽视的一条 —— 大量短命 Job、滚动更新风暴、或者一个不停 reconcile 的控制器,都能在节点数没变的情况下把 churn 打爆。

### 官方 SLO 的前置条件

社区文档列出的环境要求,不满足就不必指望 SLO:

- **Event 存放在独立的 etcd 实例**(或独立集群)中 —— 大规模集群里 Event 写入量极大,和核心数据挤在一起会拖垮整个控制面;
- 所有 etcd 实例运行在控制平面机器上,且有充足资源(见 `etcd-tuning`);
- 使用扩展能力要"合理":webhook 必须高可用且低延迟,CRD/CR 数量控制在阈值内;
- 控制平面需要足够的算力,先纵向扩(更大的机器),再考虑横向扩(更多副本)。

### 实践中的瓶颈顺序

规模上不去时,通常按下面的顺序撞墙:

1. **etcd**:所有写入最终都落到这里,磁盘 fsync 延迟直接决定写路径上限。看到 `etcd_disk_backend_commit_duration_seconds` 抬头、`etcd_server_leader_changes_seen_total` 增长,先查磁盘和 compaction,而不是加 apiserver。
2. **kube-apiserver**:CPU 花在序列化/反序列化、鉴权、watch 分发上;内存主要被 watch cache 吃掉(每个资源类型的缓存常驻内存,`list` 大对象时会进一步放大)。表现为 `apiserver_request_duration_seconds` 上升、请求排队。
3. **kube-controller-manager**:单实例(默认),QPS 与 worker 数有限;`--kube-api-qps` / `--kube-api-burst` 太小会让控制器明显滞后,表现为"Pod 删了但 ReplicaSet 半天不补"。
4. **kube-scheduler**:默认单实例,吞吐受 `percentageOfNodesToScore` 影响;节点多了以后每个 Pod 都要遍历可行节点,调度延迟会上升。
5. **kubelet / 节点**:Pod 密度过高时,状态上报、cgroup 操作、日志轮转都会变慢,节点更容易 NotReady。
6. **DNS 与网络**:CoreDNS QPS、conntrack 表大小、Service/Endpoint 数量,都是大规模集群的经典瓶颈。

### 测量这些 SLO

SLO 不是口号,是可以被算出来的。下面是最接近官方口径的查询方式:

```shell
# 1. 变更类请求的 99 分位(按 resource / verb 分组,看是谁在拖后腿)
histogram_quantile(0.99, sum by (le, resource, verb) (
  rate(apiserver_request_duration_seconds_bucket{verb=~"POST|PUT|PATCH|DELETE"}[5m])))

# 2. 只读请求要按 scope 分开看:resource 级目标 1s,namespace/cluster 级目标 30s
histogram_quantile(0.99, sum by (le, resource, scope) (
  rate(apiserver_request_duration_seconds_bucket{verb=~"GET|LIST"}[5m])))

# 3. 当前在途请求与长时间运行请求(watch、exec)的数量
apiserver_current_inflight_requests
apiserver_longrunning_requests

# 4. churn 的近似:每秒的 Pod spec 变更数 + 用户请求数
sum(rate(apiserver_request_total{resource="pods",verb=~"POST|PUT|PATCH|DELETE"}[1m]))
```

```shell
# 5. 对象数量要逐个资源类型统计 —— 这才是最容易超限的维度
for r in pods services secrets configmaps serviceaccounts pvcs; do
  printf '%-16s %s\n' "$r" "$(kubectl get "$r" -A --no-headers 2>/dev/null | wc -l)"
done

# 6. CRD 也要单独数一遍(它们不受官方 SLO 保护,最容易失控)
kubectl get crd --no-headers | wc -l
kubectl get crd -o custom-columns=NAME:.metadata.name | tail -n +2 | while read c; do
  printf '%-40s %s\n' "$c" "$(kubectl get "$c" -A --no-headers 2>/dev/null | wc -l)"
done
```

### 控制面扩容策略

```shell
# 先看当前控制面负载,再决定是"加机器"还是"加副本"
kubectl top node -l node-role.kubernetes.io/control-plane
kubectl get --raw /metrics | grep -E 'apiserver_current_inflight_requests|process_resident_memory_bytes'
```

- **纵向优先**:官方建议先把控制面机器加大(CPU 与内存),再考虑横向加 apiserver 副本。原因是 etcd 无法通过加成员扩容,而 apiserver 的瓶颈常常就在等 etcd。
- **横向加副本的前提是瓶颈在 apiserver 自身**(CPU 打满、请求排队),而不是在 etcd 或外部依赖。
- **每个副本都持有完整 watch cache**,副本数 × 缓存内存才是真实内存需求;必要时用反亲和性把副本分散到不同物理机。
- **etcd 单独纵向扩**:换低延迟 SSD、提升 IOPS、把 Event 分流出去,收益通常比加 apiserver 副本大得多。

### 调优清单

```shell
# 1. Event 分离到独立 etcd —— apiserver 侧的写法
--etcd-servers-overrides=/events#https://etcd-events-1:2379;https://etcd-events-2:2379

# 2. 给控制面组件更高的 QPS 预算(controller-manager / scheduler)
--kube-api-qps=100 --kube-api-burst=200

# 3. 让关键组件不被驱逐、优先调度
#    CoreDNS、metrics-server 等:priorityClassName: system-cluster-critical
#    每节点守护进程:priorityClassName: system-node-critical

# 4. 检查当前实际规模
kubectl get nodes --no-headers | wc -l
kubectl get pods -A --no-headers | wc -l
kubectl get svc -A --no-headers | wc -l
kubectl get ns --no-headers | wc -l
kubectl get crd --no-headers | wc -l
```

```shell
# 5. 观察 apiserver 的实际负载与延迟
kubectl get --raw /metrics | grep -E 'apiserver_current_inflight_requests|apiserver_request_total'
kubectl get --raw /metrics | grep apiserver_request_duration_seconds_bucket | head

# 6. 观察 etcd 的大小与延迟
etcdctl endpoint status --write-out=table --cluster
etcdctl endpoint health --write-out=table --cluster
```

```shell
# 7. 检查是否有对象逼近 1.5MB 上限
kubectl get secrets -A -o json | jq '.items[] | select((.data|tostring|length) > 1000000) | .metadata.name'

# 8. 确认节点上的 Pod 数是否超过建议密度
kubectl get pods -A --field-selector spec.nodeName=<node> --no-headers | wc -l
```

### 大规模集群的运维要点

- **扩容要分批**:云厂商对实例创建、磁盘、IP、负载均衡都有配额与限流,一次性拉起几百个节点通常会被打回;官方建议分批推进并在批之间留观察窗口。
- **附加组件(addon)的 requests/limits 是按中小集群的经验值设的**,大集群里 CoreDNS、metrics-server、日志采集很容易因为限额太低被 OOMKilled 或持续限流,必须按实际规模上调。
- **横向扩控制面不等于扩容 etcd**:apiserver 可以随便加副本(无状态),但 etcd 是 Raft 集群,成员加多了反而降低写性能。写瓶颈要靠更好的磁盘和更强的机器,而不是更多成员。
- **垂直优先**:官方明确建议先把控制面机器加大,再考虑加副本。

### 注意

1. **5,000 节点是"设计目标",不是"硬限制"**。超过它不会立刻崩,但 SLO 不再有保证,而且社区也不再针对那个规模做发布阻断测试 —— 也就是说,超规模的问题需要你自己兜底。
2. **规模是一条包络线,不是一个立方体**。节点数、Pod 数、对象数、churn 是相互挤压的:5000 个节点但在跑超大规模滚动更新,和 5000 个节点静默运行,完全是两回事。单看某一个维度判断"我们还没超"是常见误判。
3. **阈值是总体口径**。表格里的 150,000 是集群总量;如果你的集群只有 500 个节点,对应阈值按比例也要小得多,不能照搬。
4. **别只看节点数和 Pod 数**。对象数量(Secrets、ConfigMaps、ServiceAccounts、CRD 实例)是最常见的隐性超限项 —— 例如 Helm 每发一次版就写一个 Secret,几年下来单个 `secrets` 类型就能吃掉几十万。上面给的检查命令值得定期跑。
5. `scope=namespace` / `scope=cluster` 的只读请求 SLO 是 **30 秒**而不是 1 秒。全集群 list(比如没有加 `--field-selector` 的 `kubectl get pods -A`)慢是设计使然,不是 bug;要快就加过滤条件或改用 informer。
6. **CRD 与聚合 API 不在 SLO 保护范围内**(官方 SLO 明确排除了 virtual、aggregated resources 与 Custom Resource Definitions)。CRD 写得多、写 webhook 慢,都会直接拖垮 apiserver,而这类问题不算 Kubernetes 的账。
7. **webhook 必须是高可用 + 低延迟**。这是 SLO 的前置条件之一:单副本的 admission webhook 挂掉,整个集群的写入都会卡住甚至失败。
8. **Event 必须分离 etcd**。官方 SLO 文档把它列为环境前提,而不是"最佳实践"。没分离的话,Event 的高写入量会持续制造 etcd 碎片、推高 fsync 延迟,最终表现为"什么都没改但集群变慢"。
9. **单对象 1.5MB 是硬约束**,不是建议值:它来自 etcd 的 `--max-request-bytes` 默认 1.5MiB 与 apiserver `--max-request-bytes` 默认 3MiB 的配套。放不进去的对象(常见于超大 ConfigMap、内嵌证书的 Secret、巨型 CR)会在写入时报 request too large,只能拆分。
10. **控制面副本数不是越多越好**。apiserver 加副本能分摊读,但每个副本都持有完整的 watch cache(内存开销成倍增加),且都会连同一套 etcd。加副本前先确认瓶颈不在 etcd 与缓存内存。
11. 大规模压测的结论只对**压测的配置**成立。官方发布阻断测试跑在特定的 etcd 分片配置与 kops 集群上,换一套 CNI、换一种存储、开着加密(encryption at rest),规模表现完全不同。
12. 真要冲规模,先建立**可量化的基线**:定期采集 `apiserver_request_duration_seconds`、`etcd_disk_backend_commit_duration_seconds`、调度延迟与 Pod 启动延迟的 p99,这样才能在劣化发生时立刻指出是哪一层先动的。
13. **SLO 的统计口径是 cluster-day**,即"一天里 99% 的分钟达标",而不是"任何时刻都不许超标"。偶发抖动是允许的,持续劣化才是问题;告警要基于较长的窗口(如 5–30 分钟),而不是单点毛刺,否则你会被噪声淹没。
14. **节点数增加会线性放大控制面负载**。每个节点的 kubelet 都在 watch pod、node、lease,节点翻倍意味着 watch 数、心跳、状态更新同步翻倍。加节点前先确认 apiserver 的 CPU 与 watch cache 内存还有余量。
15. **在几千节点的集群上,`kubectl get pods -A` 本身就是一次压测**。排查问题时尽量加 `-l`、`--field-selector` 或指定命名空间;同理,少用不带过滤条件的全量 list 写脚本做巡检,那会把 apiserver 与 etcd 一起拖慢。
16. **阈值不等于"健康线"**。社区阈值描述的是"还能保证 SLO 的边界",贴着阈值运行意味着任何一点波动都会越界,留 20%–30% 的余量才是稳妥的运维姿势。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `etcd` — 集群数据存储
- `kube-apiserver` — 集群 API 服务器
- `kube-scheduler` — 调度器
- `metrics-server` — 集群资源指标
- `cluster-autoscaler` — 节点自动扩缩容
- `watch-cache` — apiserver 的 watch 缓存机制
- `capacity-planning` — 节点规格与容量规划

### 参考链接

- [大规模集群的注意事项](https://kubernetes.io/docs/setup/best-practices/cluster-large/)
- [Kubernetes 可扩展性阈值](https://github.com/kubernetes/community/blob/master/sig-scalability/configs-and-limits/thresholds.md)
- [Scalability SLIs/SLOs](https://github.com/kubernetes/community/blob/master/sig-scalability/slos/slos.md)
- [为 Kubernetes 运维 etcd 集群](https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/)
