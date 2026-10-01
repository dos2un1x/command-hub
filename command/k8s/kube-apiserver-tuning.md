kube-apiserver-tuning
===

kube-apiserver 的参数调优:并发、超时、缓存与 etcd 交互

## 补充说明

**kube-apiserver-tuning** 关注的是 apiserver 这层的参数:能开多大并发、请求能挂多久、缓存怎么用、和 etcd 之间怎么配合。apiserver 本身**无状态**,理论上加副本就能扩;但真正决定它扛不扛得住的,是下面这几组参数与它们背后的资源(CPU、内存、etcd)。

调优前先建立一个判断标准:**apiserver 变慢只有三种原因** —— 它自己 CPU 不够、它在等 etcd、或者它在等外部依赖(webhook、聚合 API、kubelet)。前两种靠参数与扩容解决,第三种只能去修那个外部依赖。

### 并发与超时参数

```shell
--max-requests-inflight=400           # 非变更请求的并发上限(开了 APF 后是"总座位数"的一半)
--max-mutating-requests-inflight=200  # 变更请求的并发上限(开了 APF 后是另一半)
--enable-priority-and-fairness=true   # 默认开启,改为 false 会退回单一全局限额
--request-timeout=60s                 # 普通请求的默认超时
--min-request-timeout=1800            # watch 请求的最小超时下限(秒),实际取该值以上的随机数
--goaway-chance=0                     # 随机发送 GOAWAY 让客户端换副本,取值区间 [0, 0.02]
--shutdown-delay-duration=0           # 优雅退出时的延迟,配合 LB 摘流量
--shutdown-send-retry-after=false     # 退出期间对新请求返回 429 + Retry-After
--shutdown-watch-termination-grace-period=0   # 等待活跃 watch 排空的最长时间
```

默认 400 + 200 = 600 是整个服务器能同时处理的请求数(座位数),APF 会把这 600 个座位按优先级分配(见 `api-priority-fairness`)。

### 存储与缓存参数

```shell
--etcd-servers=https://127.0.0.1:2379
--etcd-compaction-interval=5m         # 由 apiserver 发起的 etcd compaction 间隔,0 表示关闭
--etcd-count-metric-poll-period=1m    # 轮询各资源对象数量的间隔,0 表示关闭
--etcd-db-metric-poll-interval=30s    # 轮询 etcd DB 指标的间隔,0 表示关闭
--etcd-healthcheck-timeout=2s         # /healthz/etcd 的检查超时
--etcd-readycheck-timeout=2s          # /readyz 的 etcd 就绪检查超时
--watch-cache=true                    # 开启 watch 缓存(默认开启)
--watch-cache-sizes=                  # 只支持把某个资源设为 0 来关缓存,非 0 值已被忽略
--storage-initialization-timeout=1m   # 存储初始化(首次 list 填充缓存)的最长等待
--max-request-bytes=3145728           # 单个写入请求上限 3MiB(与 etcd 的 1.5MiB 配套)
--delete-collection-workers=1         # 处理 DeleteCollection 的 worker 数,影响命名空间清理速度
```

```shell
# 把 Event 分流到独立的 etcd 集群(大规模集群必做)
--etcd-servers-overrides=/events#https://etcd-events-1:2379;https://etcd-events-2:2379
```

`--etcd-servers-overrides` 的格式是 `group/resource#servers`,多个资源用逗号分隔、同一资源的多个地址用分号分隔,例如 `/pods#http://etcd4:2379;http://etcd5:2379,/events#http://etcd6:2379`。它只对编译进这个 apiserver 二进制的资源生效,CRD 不在其列。

### 观测与诊断参数

```shell
--profiling=true                      # 默认开启 pprof(生产环境建议按需关闭)
--contention-profiling=false          # 开启互斥锁竞争分析,开销较大
--debug-socket-path=                  # 不鉴权的 pprof unix socket,排障用,用完即关
--audit-policy-file=/etc/kubernetes/audit/policy.yaml
--audit-log-path=/var/log/kubernetes/audit.log
--v=2                                 # 日志级别
```

```shell
# 当前在途请求数(按请求类型分)
kubectl get --raw /metrics | grep apiserver_current_inflight_requests

# 请求延迟分布:定位是哪些 verb/resource 慢
kubectl get --raw /metrics | grep apiserver_request_duration_seconds_bucket

# 长期运行请求(watch、exec)数量
kubectl get --raw /metrics | grep apiserver_longrunning_requests

# 只有 apiserver 能访问的 pprof(默认只监听 localhost,可临时用 port-forward)
kubectl -n kube-system port-forward <apiserver-pod> 8001:6443
# 实际生产中更常用的是直接在控制面节点上抓
curl -sk https://127.0.0.1:6443/debug/pprof/goroutine?debug=2 | head
```

```shell
# 读写流量画像:哪些资源在被高频 list、哪些在被高频写
kubectl get --raw /metrics | grep -E 'apiserver_request_total' | head -20

# etcd 侧的请求延迟(apiserver 视角)
kubectl get --raw /metrics | grep etcd_request_duration_seconds
```

### 容量与规格

- **CPU 是主要扩缩依据**:apiserver 的绝大部分时间花在鉴权、准入、序列化/反序列化上,是 CPU 密集型。控制面节点上给它留足 CPU(通常按节点规模的千分位估算,再用实测校准)。
- **内存主要花在 watch cache 上**:每个资源类型一份常驻缓存,对象越大、类型越多,内存越高。apiserver OOM 时优先看缓存(见 `watch-cache`)。
- **加副本要先确认瓶颈不在 etcd**:apiserver 无状态,加副本能分摊读;但写路径最终都落在同一套 etcd 上,加副本对写没有帮助,反而增加 etcd 的连接数与 watch 数。
- **多副本必须前置负载均衡**:kubeconfig 与 kubelet 的 `--control-plane-endpoint` 都指向 LB,而不是某个具体实例;`--goaway-chance` 只在有 LB 的前提下才有意义。

### 常见症状与对应参数

| 症状 | 先查什么 |
|---|---|
| `kubectl` 大面积超时 | `--request-timeout`、`apiserver_request_duration_seconds`、etcd 延迟 |
| 大量 429 / 请求被拒 | APF 的 `apiserver_flowcontrol_rejected_requests_total` 与队列长度 |
| watch 频繁断开重连 | `--min-request-timeout`、LB 的空闲超时、`apiserver_longrunning_requests` |
| 大对象写不进去 | `--max-request-bytes` 与 etcd 的 `--max-request-bytes` 是否配套 |
| apiserver OOM | watch cache 容量与大对象(`apiserver_watch_cache_capacity`) |
| 命名空间删除极慢 | `--delete-collection-workers` |
| 启动后长时间不 Ready | `--storage-initialization-timeout`、etcd 是否健康 |

### 多副本与负载均衡

```shell
# apiserver 之间不直接通信,靠 etcd 保证一致性,因此前端必须有 LB
# kubeconfig 与 kubelet 的 --control-plane-endpoint 都要指向 LB 地址
kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}'

# kubelet 侧确认它连的是不是 LB
sudo grep server /etc/kubernetes/kubelet.conf
```

```shell
# 让客户端不要长期粘在一个副本上(仅在有多副本 + LB 时启用)
--goaway-chance=0.001

# 优雅退出:先让 LB 把自己摘掉,再真正停止服务
--shutdown-delay-duration=30s
--shutdown-send-retry-after=true
--shutdown-watch-termination-grace-period=30s
```

- 每个副本都是独立的限流单元:APF 的队列、座位、watch cache 都各算各的,副本数翻倍并不等于总并发翻倍。
- 副本之间版本必须一致,滚动升级期间会出现新旧行为并存(尤其是特性门控与 API 版本),升级要逐个副本进行并观察。
- 多控制平面节点上的静态 Pod 清单是各自独立的文件,改参数时**每个节点都要改**,否则会出现同一个集群里两个 apiserver 行为不一致。

### 参数速查

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--max-requests-inflight` | 400 | 读并发,和下一项一起决定总座位数 |
| `--max-mutating-requests-inflight` | 200 | 写并发 |
| `--enable-priority-and-fairness` | true | 关掉会退回单一全局限额 |
| `--request-timeout` | 60s | 普通请求超时 |
| `--min-request-timeout` | 1800 | watch 超时下限(秒) |
| `--max-request-bytes` | 3145728(3MiB) | 与 etcd 的 1.5MiB 配套 |
| `--watch-cache` | true | watch 缓存开关 |
| `--watch-cache-sizes` | 空 | 只有 `resource#0` 有意义 |
| `--default-watch-cache-size` | 100(已废弃) | no-op |
| `--storage-initialization-timeout` | 1m | 存储初始化最长等待 |
| `--etcd-compaction-interval` | 5m | 0 表示不由 apiserver 触发压缩 |
| `--etcd-count-metric-poll-period` | 1m | 对象数量轮询间隔 |
| `--etcd-db-metric-poll-interval` | 30s | etcd DB 指标轮询间隔 |
| `--etcd-healthcheck-timeout` | 2s | etcd 健康检查超时 |
| `--etcd-readycheck-timeout` | 2s | etcd 就绪检查超时 |
| `--delete-collection-workers` | 1 | 命名空间清理速度 |
| `--goaway-chance` | 0 | 上限 0.02,推荐 0.001 |
| `--profiling` | true | pprof 开关 |
| `--contention-profiling` | false | 锁竞争分析,开销大 |
| `--shutdown-delay-duration` | 0 | 优雅退出延迟 |

### 注意

1. **`--request-timeout` 调大不是万能的**。它只决定服务端等多久,调大意味着慢请求会占用更久的并发名额(座位),堆积起来反而更快打满并发。慢 list 应该用分页(`--limit` + `continue`)解决,而不是靠超时兜底。
2. **`--min-request-timeout` 是 watch 的超时下限,单位是秒**。watch 会在这个值之上取一个随机值作为连接超时,目的是把大量 watch 的重连时间打散。调得过大,客户端切换时会留下大量闲置连接;调得过小,watch 会频繁重建。
3. **`--max-request-bytes` 必须与 etcd 的 `--max-request-bytes` 协调**。apiserver 默认 3MiB、etcd 默认 1.5MiB,这个 2 倍关系是留给 JSON 转 protobuf 的余量。只调一方会出现"部分对象偶尔写失败"的诡异现象,排查成本极高。
4. **开了 APF 时,两个 in-flight 参数的含义变了**。它们不再是"读/写各自的上限",而是**求和后作为总座位数**再分配给各优先级。调这两个数等于调整整个集群的并发总量,单独调其中一个不会有你以为的效果。
5. **`--goaway-chance` 在单实例或没有 LB 的集群上不要开**。它会让客户端连接被随机断开重连,没有 LB 时客户端只会回到同一个实例,白掉一次连接。推荐起始值 `0.001`,上限 `0.02`。
6. **`--profiling` 默认为 true**。pprof 端点挂了鉴权(走 6443,需要认证),但生产环境仍建议按需关闭或限制访问;`--debug-socket-path` 打开的 socket **不做认证**,绝对不要长期保留。
7. **关掉 watch cache 是把压力直接甩给 etcd**。`--watch-cache=false` 会让每个 list/watch 都打到 etcd,显著放大 etcd 的负载与 compaction 压力,只适合排障时临时验证。
8. **`--watch-cache-sizes` 现在几乎没有调优空间**。非零值会被忽略并打日志 `Dropping watch-cache-size for ..., watchCache size is now dynamic`;唯一有意义的写法是把某个资源设为 `0` 来关闭它的缓存。同理 `--default-watch-cache-size` 已废弃且是 no-op,别再照着老文章抄。
9. **审计日志是隐藏的性能杀手**。`RequestResponse` 级别的审计会记录完整请求与响应体,磁盘 IO 与空间占用都很大;必须配轮转(`--audit-log-maxage/maxbackup/maxsize`),并把日志目录从宿主机挂进容器,否则写不出来还以为没生效。
10. **apiserver 重启后会有一段时间不 Ready**,期间 `kubectl` 报 connection refused 属于正常。改静态 Pod 清单前务必备份,起不来时只能用 `crictl` 和 `journalctl -u kubelet` 救场。
11. **不要指望 apiserver 解决 etcd 的问题**。所有写入最终都落 etcd,etc 的 fsync 延迟会原样反映到 apiserver 的写延迟上;看到写路径变慢,先查 `etcd_disk_backend_commit_duration_seconds`,而不是先加 apiserver 的 CPU。
12. **集中式限流要同时考虑客户端**。apiserver 限流后,客户端(controller-manager、kubelet、Operator)如果没配退避,会以更高频率重试,形成恶性循环。给客户端配好 QPS/Burst 与指数退避,比单方面调大服务端限额更有效。
13. **改了参数要一起改所有副本**。kubeadm 多控制平面集群里每个节点的静态 Pod 清单是独立的,漏改一个就会出现"同一个集群里两个 apiserver 行为不一致"的疑难杂症。
14. **`--etcd-compaction-interval` 设成 0 要非常小心**。它表示"apiserver 不再发起 compaction",此时必须由 etcd 自己的 `--auto-compaction-mode` / `--auto-compaction-retention` 承担起压缩职责;两边都没配,历史版本会不断堆积,数据库会一路涨到配额触发 NOSPACE。
15. **`--etcd-count-metric-poll-period` 与 `--etcd-db-metric-poll-interval` 关闭后,你只是失去了可观测性**。这两个轮询本身开销很小,关掉它们换来的是"看不到对象数量增长"和"看不到 etcd DB 大小",排障时会非常被动。
16. **聚合 API 与 webhook 是 apiserver 的外部依赖,超时会算在 apiserver 头上**。`--request-timeout` 到点时,客户端看到的是 apiserver 超时,但根因可能在 webhook 或聚合服务;用 `apiserver_request_duration_seconds` 按 resource 分组能快速区分是自己的资源还是扩展资源。
17. **调整参数前先量化**。任何"感觉慢"都应该先落到具体指标(p99 延迟、在途请求数、etcd commit 延迟),再决定改哪个参数;凭直觉调大超时与并发,通常只是把问题推迟到更难排查的时刻。

### 相关命令

- `kube-apiserver` — 集群 API 服务器
- `etcd` — 集群数据存储
- `kubelet` — 节点代理
- `kubeadm` — Kubernetes集群安装工具
- `api-priority-fairness` — apiserver 的过载保护机制
- `watch-cache` — watch 缓存机制与内存权衡
- `audit-log` — 审计日志配置

### 参考链接

- [kube-apiserver 命令行参考](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-apiserver/)
- [API 优先级和公平性](https://kubernetes.io/docs/concepts/cluster-administration/flow-control/)
- [为 Kubernetes 运维 etcd 集群](https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/)
- [大规模集群的注意事项](https://kubernetes.io/docs/setup/best-practices/cluster-large/)
- [调试 Kubernetes API 服务器](https://kubernetes.io/docs/tasks/debug/debug-cluster/)
