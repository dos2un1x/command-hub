watch-cache
===

kube-apiserver 的 watch 缓存机制、容量策略与一致性权衡

## 补充说明

**watch-cache** 是 kube-apiserver 里为每个资源类型维护的一份内存缓存。它的存在理由很朴素:集群里绝大部分读操作是**重复的**——每个 kubelet 都在 watch 自己节点上的 Pod,每个控制器都在 list 自己关心的对象,如果这些请求全部落到 etcd,etc d 会被读请求淹没。

于是 apiserver 干了这样一件事:对每个资源类型起一个 reflector,**只在后台向 etcd 发一个 watch**,把事件攒进内存里的环形缓冲区(ring buffer),然后:

- **watch** 请求直接从这个缓冲区里读事件并分发给成千上万个客户端;
- **list** 请求(满足条件时)直接从缓存里的快照构建返回结果。

结果是:一万个 kubelet 的 watch 在 etcd 看来只是一次 watch。这是 Kubernetes 能扩展到几千节点的关键设计之一。

缓存默认开启(`--watch-cache=true`),每个资源类型各自一份,互不影响。

### 缓存是怎么长大的

缓存容量**不是配置出来的,而是自己伸缩的**(这直接影响你怎么调优,见下文注意事项):

| 参数 | 值 |
|---|---|
| 初始容量 | 100 个事件(`defaultLowerBoundCapacity`) |
| 容量下限 | 100 |
| 容量上限 | 102400(`100 × 1024`) |
| 扩容 | 缓存写满、且最老的事件仍在"新鲜窗口"内时,容量翻倍 |
| 缩容 | 缓存写满、且最近 1/4 容量对应的事件已超出"新鲜窗口"时,容量减半 |
| 新鲜窗口 | 由 eventsHistoryWindow 决定,默认 75 秒 |
| 单次调整幅度 | 只能 ×2 或 ÷2(所以上限也按 2 的幂放大) |

"新鲜窗口"的意义是:**缓存至少要能覆盖最近 75 秒的事件**,否则重连的客户端拿不到自己需要的历史,watch 就会因为 resourceVersion 太旧而失败。窗口设得更长时,容量上限会按 2 的幂同步放大。

```shell
# 观察每个资源类型的缓存容量与伸缩次数
kubectl get --raw /metrics | grep apiserver_watch_cache_capacity
kubectl get --raw /metrics | grep watch_cache_capacity_

# 缓存当前的 resourceVersion(高位截断,只保留低 15 位)
kubectl get --raw /metrics | grep apiserver_watch_cache_resource_version
```

### 相关参数

```shell
--watch-cache=true                    # 总开关,默认开启
--watch-cache-sizes=                  # 逐资源的设置,格式 resource[.group]#size
--default-watch-cache-size=100        # 已废弃,no-op
--storage-initialization-timeout=1m   # 等待存储初始化完成的最长时间
--min-request-timeout=1800            # watch 超时的下限(秒)
--etcd-compaction-interval=5m         # apiserver 触发 etcd compaction 的间隔
--etcd-count-metric-poll-period=1m    # 轮询对象数量的间隔
```

`--watch-cache-sizes` 的**唯一有效用法是把某个资源的缓存关掉**:

```shell
# 关闭 secrets 的 watch 缓存(该资源的所有读都会打到 etcd,慎用)
--watch-cache-sizes=secrets#0

# 关闭某个 CRD 组的资源缓存
--watch-cache-sizes=widgets.example.com#0
```

写非零值不会报错,但也不会生效,只会在日志里留下一条警告:

```shell
Dropping watch-cache-size for <resource> - watchCache size is now dynamic
```

### 一致性与 resourceVersion

缓存带来一个绕不开的问题:**从缓存读到的数据,是不是最新的?** 答案取决于客户端怎么问:

| 客户端请求 | 语义 | 数据来源 |
|---|---|---|
| `resourceVersion=""`(不指定) | 强一致读(consistent read),必须反映最新状态 | 需要 etcd 的 progress notify 确认缓存已追平,或回落到 etcd |
| `resourceVersion=0` | "不早于"某个版本即可,允许读到略旧的数据 | 直接读缓存,不需要追平 etcd |
| `resourceVersion=<具体值>` | 精确读该版本(常用于分页 continue) | 缓存中对应版本的快照,拿不到就报错 |

自 v1.31 起,"从缓存提供一致性读"(consistent reads from cache)进入 Beta 并默认启用:apiserver 借助 etcd 的 progress notify 机制确认缓存已经追平到最新 revision,从而**在缓存里**满足原本需要 etcd quorum 读的请求。官方博客给出的 5000 节点测试数据是 apiserver CPU 下降约 30%、etcd CPU 下降约 25%、Pod LIST 的 p99 从 5 秒改善到 1.5 秒。它需要 etcd 3.4.31+ 或 3.5.13+。

```shell
# 一致性读的命中与回落情况(success/fallback 两个标签说明了一切)
kubectl get --raw /metrics | grep apiserver_watch_cache_consistent_read_total

# etcd 与缓存之间的一致性校验
kubectl get --raw /metrics | grep apiserver_storage_consistency_checks_total
```

### 缓存追不上、或者太旧

两种失败必须分清楚:

**1. 请求的 resourceVersion 太旧(缓存里已经没有了)**

返回 **410 Gone**,错误信息是 `too old resource version: <请求的> (<缓存中最老的>)`。这是**客户端**的问题:它掉线太久,缓存里的历史已经被环形缓冲区挤掉了,唯一出路是重新 list 拿一份新的快照再接着 watch。使用 client-go informer 的组件会自动处理这件事(relist),手写 watch 的代码必须自己处理 410。

**2. 请求的 resourceVersion 比缓存还新**

apiserver 会阻塞等待缓存追平,`blockTimeout` 是 **3 秒**;超过之后返回 "too large resource version" 错误,并提示客户端 1 秒后重试。这类错误通常说明**写请求已经成功、但读路径还没追上**(比如刚创建完对象立刻用它的 resourceVersion 去 watch),重试即可。

### 与缓存相关的指标

```shell
# 事件流水
apiserver_watch_cache_events_received_total{group,resource}
apiserver_watch_cache_events_dispatched_total{group,resource}

# 初始化
apiserver_watch_cache_initializations_total{group,resource}
apiserver_watch_cache_initialization_errors_total{group,resource}
apiserver_watch_cache_initialization_duration_seconds{group,resource}
apiserver_watch_cache_init_events_total{group,resource}

# 等待缓存变新的耗时(过高说明缓存追不上 etcd 的写入)
apiserver_watch_cache_read_wait_seconds{group,resource}

# 被判定为无响应而关闭的 watcher 数
apiserver_terminated_watchers_total{group,resource}

# 从缓存服务的 list 请求
apiserver_cache_list_total{group,resource,index}
apiserver_cache_list_fetched_objects_total{group,resource,index}

# 事件分发各阶段耗时(storage_to_cache、cacher_queue_latency、total 等)
apiserver_watch_events_dispatch_duration_seconds{group,resource,stage}
```

```shell
# 缓存等待时间 p99,超过 1 秒基本可以判定缓存追不上写入
histogram_quantile(0.99, sum by (le, resource) (
  rate(apiserver_watch_cache_read_wait_seconds_bucket[5m])))

# 各资源缓存容量,用于评估内存占用
topk(10, apiserver_watch_cache_capacity)
```

### 服务端 list-then-watch

Kubernetes 支持让 apiserver 在响应 watch 时**先推送一份初始快照**,客户端不必先 list 再 watch,这样就不会出现"list 与 watch 之间的窗口期丢事件"的问题。客户端需要显式带上参数才会生效:

```shell
# 客户端发的请求形状
GET /api/v1/pods?watch=true&sendInitialEvents=true&resourceVersionMatch=NotOlderThan
```

apiserver 会把当前对象的 `ADDED` 事件依次推给客户端,最后用一个带 `k8s.io/initial-events-end: "true"` 注解的 bookmark 事件收尾,表示初始同步结束。这个能力受特性门控控制,且需要客户端(如 client-go 的 reflector)支持。

### 常见故障的处理路径

| 现象 | 可能原因 | 处理方向 |
|---|---|---|
| 客户端大量 410 Gone | 掉线太久,缓存里已没有对应历史 | 客户端重新 list(用 informer 可自动 relist) |
| `too large resource version` | 请求的 RV 比缓存新(刚写完就读) | 客户端重试,通常 1 秒内即可追上 |
| `apiserver_watch_cache_read_wait_seconds` 变高 | 缓存追不上 etcd 的写入速度 | 查 etcd 写延迟与写入量,而不是调缓存参数 |
| apiserver 内存持续增长 | 某个高频资源的缓存被反复扩容 | 看 `apiserver_watch_cache_capacity`,评估关掉该资源的缓存 |
| 缓存初始化耗时长 | 对象极多或单对象极大 | 看 `apiserver_watch_cache_initialization_duration_seconds` |
| watch 频繁断开重连 | 410、缓存容量不足、或 LB 空闲超时 | 分别查 410 计数、缓存容量与 LB 设置 |
| list 请求延迟高且缓存未命中 | 请求条件无法走索引快照 | 用 `-l`/`--field-selector` 缩小范围,或按命名空间拆分 |

```shell
# 一次抓齐关键指标
kubectl get --raw /metrics | grep -E \
  'apiserver_watch_cache_(capacity|read_wait_seconds_count|initialization_errors_total|consistent_read_total)|apiserver_terminated_watchers_total'
```

### 注意

1. **`--watch-cache-sizes` 已经失去调优意义**。它的帮助文本写得很直白:唯一有意义的取值是 `0`(关闭该资源的缓存),"all non-zero values are equivalent"。想靠 `--watch-cache-sizes=pods#5000` 提高缓存容量的老做法在现在的版本上只会得到一条 `watchCache size is now dynamic` 警告。
2. **`--default-watch-cache-size` 是废弃的 no-op**。它的废弃说明是 "Watch caches are sized automatically. This flag is no-op and it will be removed in a future version."。看到老文章让你调它,直接跳过。
3. **缓存吃的是 apiserver 的内存,而且比你想的多**。缓存里保存的是**解码后的对象**以及更新事件里的**前一个版本**(用于过滤和判断),单个事件槽位可能持有两份对象。一个 100KB 的 CR 在缓存里可能是几百 KB,几万个事件就是几十 GB。apiserver 的 OOM 十有八九出在这里。
4. **缓存缩容只在有事件写入时发生**。缩容逻辑挂在"新事件入队"这条路径上:突发大量事件把容量撑到高位之后,如果这个资源**长期没有新事件**,容量不会自动回落,内存也就一直占着。设计上这是为了防止抖动,但对低频资源来说意味着内存峰值长期不释放。
5. **无界写入的资源要额外小心**。如果一个资源类型持续高频写入(典型如 events),缓存会一直扩容到上限 102400 个事件;把这类资源的缓存**关掉**(`resource#0`)或者写进独立 etcd,往往比调大内存更划算。
6. **`--watch-cache-sizes` 只对 apiserver 内置资源生效**。官方帮助文本明确说 "This option is only meaningful for resources built into the apiserver, not ones defined by CRDs or aggregated from external servers"。
7. **强一致读有代价**。`resourceVersion=""` 的请求需要缓存追平 etcd(或者回落去问 etcd),延迟必然高于 `resourceVersion=0`。高频、可以容忍轻微过期的场景(如控制器 reconcile)应主动使用 `resourceVersion=0` 或在 list 时配合 `resourceVersionMatch`。
8. **410 Gone 不是故障,是客户端该 relist 的信号**。很多自研控制器把它当成错误日志狂刷,却忘了 relist,导致永远同步不上。用 client-go 的 informer/reflector 可以省掉这部分逻辑。
9. **"too large resource version" 通常是自己挖的坑**。典型场景是创建一个对象后立刻用它的 resourceVersion 去 watch 或 list,而缓存还没追平。3 秒阻塞后返回错误,客户端重试即可,不要为此调大什么参数。
10. **缓存初始化时,该资源的服务会受影响**。apiserver 启动后需要先把缓存填充起来才能服务该资源,超过 `--storage-initialization-timeout`(默认 1 分钟)仍未完成就会影响就绪状态;对象极多或单对象极大时,这段时间可以被感知到。
11. **关闭缓存不等于解决问题**。`--watch-cache=false` 会让每个客户端的每次 list/watch 都直达 etcd,读放大会把 etcd 的写入路径也拖慢(compaction、fsync 都会受影响),只应作为排障手段短时使用。
12. **`--watch-cache-sizes` 与 `--watch-cache=false` 的粒度不同**:前者按资源关闭,后者全局关闭。排障时优先用前者,影响面小得多。
13. **缓存不改变对象的存储内容**。它只是内存中的副本,重启 apiserver 后需要重新从 etcd 填充。看到"apiserver 重启后第一分钟特别慢"通常就是在做这件事。
14. **排查时先分清是"缓存追不上"还是"客户端跟不上"**。前者看 `apiserver_watch_cache_read_wait_seconds`(服务端等缓存变新),后者看 `apiserver_terminated_watchers_total`(消费不过来的 watcher 会被服务端关闭)。两者的处理方式完全相反:一个要去优化 etcd 写入,一个要去修客户端。
15. **缓存容量指标不等于内存占用**。`apiserver_watch_cache_capacity` 是事件槽位数,真实内存还要乘以每槽位持有的对象大小(含前一版本)。评估内存时应该同时看 `process_resident_memory_bytes` 与对象平均大小,而不是只看槽位数。
16. **多副本 apiserver 各自持有一份缓存**。副本数 × 单副本缓存内存才是真实的内存需求;控制面节点的内存规划必须把这一点算进去,否则加副本会直接把节点压到 OOM。

### 相关命令

- `kube-apiserver` — 集群 API 服务器
- `etcd` — 集群数据存储
- `kube-apiserver-tuning` — apiserver 参数调优
- `scalability` — 大规模集群的规模与瓶颈
- `etcd-tuning` — etcd 侧的压缩与碎片整理

### 参考链接

- [kube-apiserver 命令行参考](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-apiserver/)
- [从缓存提供一致性读取(Beta)](https://kubernetes.io/blog/2024/08/15/consistent-read-from-cache-beta/)
- [API 概念:resourceVersion 语义](https://kubernetes.io/docs/reference/using-api/api-concepts/)
- [Kubernetes 可扩展性阈值](https://github.com/kubernetes/community/blob/master/sig-scalability/configs-and-limits/thresholds.md)
