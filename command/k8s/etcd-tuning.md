etcd-tuning
===

etcd 的性能调优:磁盘、压缩、配额与告警处理

## 补充说明

**etcd-tuning** 讲的是怎么让 etcd 这个 Kubernetes 唯一的数据库不要成为集群的瓶颈。etcd 的写入路径是"提案 → Raft 复制 → WAL fsync → 应用到 bbolt 后端",其中**任何一步都要落盘**,所以它的性能几乎完全由**磁盘**决定;而它的可用性由**多数派**决定,网络抖动会直接变成选举。

调优可以拆成三件事:

1. **别让它写太慢** —— 磁盘、CPU、网络、时间同步;
2. **别让它长得太大** —— compaction(压缩历史)与 defrag(整理碎片);
3. **别让它悄悄坏掉** —— 配额、告警、监控指标。

### 关键参数与默认值

```shell
--quota-backend-bytes=0                  # 默认配额 2GiB(0 表示用内置默认值);官方建议不超过 8GiB
--snapshot-count=100000                  # 触发一次快照的已应用条目数
--heartbeat-interval=100                 # leader 心跳间隔(毫秒)
--election-timeout=1000                  # 选举超时(毫秒),须 >= 10 倍成员间 RTT
--auto-compaction-mode=periodic          # periodic 或 revision
--auto-compaction-retention=0            # 0 表示关闭自动压缩
--max-request-bytes=1572864              # 单次请求上限 1.5MiB
--max-snapshots=5                        # 保留的快照文件数
--max-wals=5                             # 保留的 WAL 文件数
--backend-bbolt-freelist-type=map        # bbolt 空闲页管理方式
--experimental-watch-progress-notify-interval=10m
```

注意 `--quota-backend-bytes` 的 flag 默认值是 `0`,但 etcd 的**实际默认配额是 2GiB**(官方 limits 文档原文:"The default storage size limit is 2 GiB, configurable with `--quota-backend-bytes` flag")。看到 `0` 不要误以为"无限制"。

### 磁盘要求

etcd 官方给出的硬件口径(见参考链接中的 hardware 页):

| 项 | 要求 |
|---|---|
| 顺序 IOPS(最低) | 50(约等于一块 7200 转机械盘) |
| 顺序 IOPS(重负载推荐) | 500(本地 SSD 或高性能云盘) |
| 带宽 | 通常 10MB/s;大集群建议 100MB/s(15 秒恢复 1GB 数据) |
| 介质 | SSD 优先;机械盘至少 15000 转,并做 RAID 0 |
| 内存 | 通常 8GB 够用;watcher 上千、键百万级建议 16–64GB |
| CPU | 通常 2–4 核;客户端上千、QPS 上万时建议 8–16 核 |
| 网络 | 常见部署 1GbE 足够;大集群 10GbE 可缩短恢复时间 |

云盘要注意:厂商标称的 IOPS 往往是**并发** IOPS,可能是顺序 IOPS 的十倍,别拿它当依据,用 `fio` 实测。磁盘优先级也要调,官方给出的做法是:

```shell
# 提高 etcd 进程的 IO 优先级(降低其他进程抢盘的影响)
sudo ionice -c2 -n0 -p $(pgrep etcd)

# CPU 调频器设为 performance,避免省电模式带来的抖动
sudo cpupower frequency-set --governor performance
```

```shell
# 网络层面:让 Raft 成员间流量(2380)优先于客户端流量(2379)
sudo tc qdisc add dev eth0 root handle 1: prio bands 3
sudo tc filter add dev eth0 parent 1: protocol ip prio 1 u32 match ip sport 2380 0xffff flowid 1:1
sudo tc filter add dev eth0 parent 1: protocol ip prio 1 u32 match ip dport 2380 0xffff flowid 1:1
```

### 压缩与碎片整理:两个不同的动作

这是最容易混淆的一对概念:

| 动作 | 做什么 | 何时做 |
|---|---|---|
| compaction(压缩) | 删除某个 revision 之前的历史版本,**逻辑**上释放键空间 | 持续做(自动压缩或 apiserver 触发) |
| defrag(整理) | 重建 bbolt 数据库文件,把释放出来的空洞**还给文件系统** | 压缩之后、磁盘占用明显大于实际数据时 |

关键点:压缩后空间只是"etcd 内部可重用",**宿主机看到的文件不会变小**;只有 defrag 才会让它变小。而且 defrag **会阻塞该成员的读写**,必须逐成员执行。

```shell
# 1. 查看当前大小与实际使用量(差值就是待回收的碎片)
etcdctl endpoint status --write-out=table --cluster

# 2. 压缩到指定 revision(通常用最新 revision)
rev=$(etcdctl endpoint status --write-out=json | jq -r '.[0].header.revision')
etcdctl compact $rev

# 3. 逐个成员整理(不要同时做);--cluster 会依次处理所有成员
etcdctl defrag --cluster
# 或者指定单个成员
etcdctl --endpoints=https://10.0.0.11:2379 defrag

# 4. 离线整理(成员已停止时使用数据目录)
etcdutl defrag --data-dir /var/lib/etcd
```

```shell
# 自动压缩:按时间窗口保留历史
--auto-compaction-mode=periodic --auto-compaction-retention=10h

# 或者按 revision 数保留
--auto-compaction-mode=revision --auto-compaction-retention=1000
```

官方给出的经验值:写入极其频繁的键用 `1h` 或 `30m`;很少更新的用 `24h`/`48h`/`72h`;通用场景 `10h`。

### NOSPACE 告警的处理

当后端数据超过配额时,etcd 会抛出**集群范围**的 NOSPACE 告警,集群进入"只接受键读取与删除"的状态 —— 表现就是所有写操作都失败,报 `mvcc: database space exceeded`。

```shell
# 1. 查看告警
ETCDCTL_API=3 etcdctl alarm list
#    memberID:13803658152347727308 alarm:NOSPACE

# 2. 压缩 + 逐个 defrag(见上一节),否则解除后很快会再次触发
rev=$(ETCDCTL_API=3 etcdctl endpoint status --write-out=json | jq -r '.[0].header.revision')
ETCDCTL_API=3 etcdctl compact $rev
ETCDCTL_API=3 etcdctl defrag --cluster

# 3. 解除告警
ETCDCTL_API=3 etcdctl alarm disarm

# 4. 确认大小已回落
ETCDCTL_API=3 etcdctl endpoint status --write-out=table
```

### 监控指标

```shell
# 磁盘:写路径延迟,最核心的两个
etcd_disk_wal_fsync_duration_seconds
etcd_disk_backend_commit_duration_seconds

# 集群健康
etcd_server_has_leader
etcd_server_leader_changes_seen_total
etcd_server_proposals_failed_total

# 数据规模(注意区分"文件大小"和"实际使用")
etcd_mvcc_db_total_size_in_bytes
etcd_mvcc_db_total_size_in_use_in_bytes
```

```shell
# 常用告警表达式的形状
histogram_quantile(0.99, rate(etcd_disk_backend_commit_duration_seconds_bucket[5m])) > 0.025
rate(etcd_server_leader_changes_seen_total[1h]) > 3
rate(etcd_server_proposals_failed_total[5m]) > 0
etcd_mvcc_db_total_size_in_bytes / etcd_mvcc_db_total_size_in_use_in_bytes > 2
```

`etcd_mvcc_db_total_size_in_bytes` 与 `..._in_use_in_bytes` 的比值反映碎片程度,长期大于 2 说明该做 defrag 了。(v3.4 起,原来的 `etcd_debugging_mvcc_db_total_size_in_bytes` 被重命名为 `etcd_mvcc_db_total_size_in_bytes`。)

### 集群拓扑

```shell
# 成员必须是奇数:1 / 3 / 5
ETCDCTL_API=3 etcdctl member list --write-out=table

# 每个成员的状态:leader、DB 大小、配额、Raft 索引
ETCDCTL_API=3 etcdctl endpoint status --write-out=table --cluster

# 健康检查(带延迟)
ETCDCTL_API=3 etcdctl endpoint health --write-out=table --cluster
```

### 注意

1. **`--snapshot-count` 的默认值是 100000,不是 10000**。etcd 官方 tuning 页面里仍写着"default 10,000 changes",与同一站点 configuration 页的 `'100000'` 以及代码里的默认值不符 —— 以 configuration 页与 `etcd --help` 的实际输出为准。
2. **defrag 会阻塞该成员的读写**,期间该成员上的请求会变慢甚至超时。必须**逐个成员**做,不要 `--cluster` 在业务高峰期执行,也不要在多个成员上并行执行。
3. **defrag 之前必须先有 compaction**。没有压缩,历史版本还在,defrag 只是在原地重建一个一样大的文件,空间不会回收。
4. **NOSPACE 是集群级告警,只读状态会影响全部成员**。解除(`alarm disarm`)之前必须先 compact + defrag,否则写入很快又会撞上配额,进入"告警—解除—再告警"的循环。
5. **配额不是越大越好**。官方建议 8GiB 是常规环境的上限,超过后 etcd 启动会告警;而且配额越大,单次 defrag 阻塞的时间越长,故障恢复越慢。真正该做的是让对象数量受控,而不是把配额一路调大。
6. **etcd 对时间敏感,节点时间必须同步**。时钟漂移会引发无谓的选举,进而触发 leader 频繁切换。生产环境必须配 NTP/chrony,并监控时钟偏移。
7. **`--heartbeat-interval` 与 `--election-timeout` 必须全集群一致**,取值也应一致。选举超时至少要大于 10 倍成员间 RTT(跨机房部署要按最慢链路算),否则容易出现 leader 反复被踢。
8. **成员数不是越多越可靠**。Raft 需要多数派确认,成员越多写入越慢;5 个成员能容忍 2 个故障,但写性能明显低于 3 个成员。超过 5 个通常得不偿失。
9. **单对象大小受 `--max-request-bytes` 限制(默认 1.5MiB)**。apiserver 侧 `--max-request-bytes` 默认是 3MiB,留了 JSON 转 protobuf 的余量;若把 etcd 侧调大而 apiserver 侧没同步(或反之),会出现"某些对象就是写不进去"的糊涂账,两边要一起改。
10. **不要用机械盘或 NFS 跑生产 etcd**。etcd 的写入路径对 fsync 延迟极其敏感,网络存储的抖动会直接转成集群不稳定,表现为 apiserver 请求大面积超时。
11. **krb5 之外的"调优"要谨慎**:`--backend-bbolt-freelist-type` 之类的参数改动会影响存储格式的兼容性,升级/回滚时可能出问题;除非有明确的压测数据,否则保持默认。
12. **分离 Event 是 K8s 侧最有效的 etcd 优化**。大规模集群按官方建议把 Event 放进独立 etcd 实例,通过 apiserver 的 `--etcd-servers-overrides=/events#https://...` 指定,可以显著降低核心 etcd 的写入压力与碎片增速。
13. **备份策略与调优同样重要**:`etcdctl snapshot save` 产生的是 MVCC 一致快照,而直接拷贝 `/var/lib/etcd` 目录拿到的是一份不一致的镜像。备份要连同 `/etc/kubernetes/pki/etcd/` 证书一起保存。
14. **etcd 的版本也有下限**:Kubernetes 官方建议生产环境使用 etcd 3.4.29+ 或 3.5.11+,更早的版本存在已知的稳定性问题。

### 相关命令

- `etcd` — 集群数据存储
- `kube-apiserver` — 集群 API 服务器,唯一直接读写 etcd 的组件
- `kubeadm` — Kubernetes集群安装工具
- `crictl` — 容器运行时调试工具
- `kube-apiserver-tuning` — apiserver 侧的 etcd 相关参数

### 参考链接

- [etcd 调优](https://etcd.io/docs/v3.5/tuning/)
- [etcd 维护:压缩与碎片整理](https://etcd.io/docs/v3.5/op-guide/maintenance/)
- [etcd 硬件建议](https://etcd.io/docs/v3.5/op-guide/hardware/)
- [etcd 使用限制](https://etcd.io/docs/v3.5/dev-guide/limit/)
- [为 Kubernetes 运维 etcd 集群](https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/)
