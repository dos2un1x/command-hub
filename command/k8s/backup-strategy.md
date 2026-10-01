backup-strategy
===

备份策略设计:频率、保留、3-2-1、不可变备份与恢复演练

## 补充说明

**备份策略**要回答四个问题:**备什么、多久备一次、留多久、怎么证明能恢复**。技术选型(Velero、Longhorn、存储快照)只是把这四个问题的答案落地。

策略设计中最常见的两个错误是**一刀切**(全集群每天一次,既不满足核心业务的 RPO,又为日志类数据浪费存储)和**只做不验**(任务天天成功,从没人恢复过)。本页给出可执行的策略框架,具体备份内容见 `cluster-backup`。

### 从 RPO 反推频率

频率不是拍脑袋定的,而是从业务能容忍丢多少数据倒推:

| 业务等级 | RPO | 备份频率 | 备份方式 |
| --- | --- | --- | --- |
| 核心交易 | 0 | 同步复制 | 多活 + 存储复制,备份只作为兜底 |
| 重要业务 | ≤ 1h | 每小时 | Velero schedule + CSI 快照 |
| 一般业务 | ≤ 24h | 每天 | Velero schedule + 文件系统备份 |
| 内部工具 | ≤ 7d | 每周 | 全集群备份 |

注意 RPO 与**备份耗时**的关系:一次全量备份要跑 3 小时,那每小时一次的策略根本排不开。频率提高的前提是增量能力(Kopia 的增量上传、CSI 快照的增量位图),否则只会得到一堆互相追赶、永远跑不完的任务。

### 备份分层

按命名空间与资源类型分层,而不是全集群一个策略:

```shell
# 全集群兜底:每周一次,保留久,用于灾难场景重建
velero schedule create weekly-cluster --schedule="0 2 * * 0" \
  --include-cluster-resources=true --ttl 2160h

# 核心业务:每小时一次,保留 7 天,带卷数据
velero schedule create hourly-pay --schedule="0 * * * *" \
  --include-namespaces payment,order \
  --default-volumes-to-fs-backup --ttl 168h

# 一般业务:每天一次,保留 30 天
velero schedule create daily-app --schedule="30 1 * * *" \
  --include-namespaces app,web --ttl 720h

# 明确排除:可重建的、体量大的
velero schedule create weekly-cluster --schedule="0 2 * * 0" \
  --exclude-namespaces logging,monitoring --exclude-resources events
```

`logging`、`monitoring` 这类命名空间的数据往往可以重建或不需要长期保留,排除它们能显著降低备份体积与对象存储成本。

### 3-2-1 与 3-2-1-1-0

经典的备份黄金法则,后面那个「1-0」是勒索软件时代补上的:

```shell
3   至少 3 份副本(1 份生产 + 2 份备份)
2   至少 2 种不同介质或存储系统
1   至少 1 份异地存放
1   至少 1 份离线 / 不可变(immutable)副本 —— 应对勒索软件
0   至少有 1 次成功恢复验证 —— 备份必须被验证过
```

在 Kubernetes 语境下,「异地」不只是换区域,还包括**换账号/换云**:同一个云账号下的跨区对象存储,在账号被盗时同样一起没。

### 保留策略

保留要同时满足三个约束:恢复需要(能回到多久之前)、合规要求(某些行业要求 7 年)、成本上限。常用的是**祖父-父-子(GFS)**结构:

```shell
最近 24 份小时级   覆盖最近一天的误操作
最近 7 份每日级    覆盖一周内的逻辑错误
最近 4-12 份每周级 覆盖月度问题
每年 1 份归档级    合规留存
```

在 Velero 里落地要注意:`--ttl` 是**每份备份**的存活时间,不是「保留多少份」。`--ttl 720h` 意思是每份备份 30 天后自动删除。想实现 GFS,就用多个 schedule 配不同 TTL,而不是指望单个 TTL 变出层级。

同时要避免**双重清理**:Velero 的 TTL 删除与对象存储的 Lifecycle 规则同时生效时,谁先到期谁删,可能出现「备份文件被生命周期删了,但 Velero 里还记录着」的不一致状态。用对象存储生命周期时,规则应比 Velero TTL 更宽松。

### 不可变备份(WORM)

勒索软件的标准打法是先潜伏、再加密生产数据、最后把备份一起删掉。**只有不可变副本能挡这一步**:

```shell
# AWS S3 Object Lock(桶必须开启版本控制,锁在对象写入时指定)
#   GOVERNANCE 模式:有特殊权限者可解除,适合日常
#   COMPLIANCE 模式:到期前任何人都无法删除,连 root 也不行
aws s3api put-object-retention \
  --bucket velero-backups \
  --key backups/daily-app/xxx.tar.gz \
  --retention '{"Mode":"COMPLIANCE","RetainUntilDate":"2026-12-31T00:00:00Z"}'

# MinIO 需要建桶时就启用 object locking,事后无法补开
mc mb --with-lock myminio/velero-backups
mc retention set --default COMPLIANCE 30d myminio/velero-backups
```

不可变与 TTL 会打架:对象还在锁定期内时 Velero 的删除请求会被拒绝,表现为备份「删不掉、越堆越多」。设计时应让 **Velero TTL ≥ 对象锁定期**,或者只对归档级备份启用锁。

### 监控:备份必须被观测

「备份任务连续失败三天没人发现」是最典型的备份事故。Velero 在服务端 `8085` 端口暴露 Prometheus 指标:

```shell
# 关键指标
velero_backup_last_successful_timestamp   最近一次成功备份的时间戳(带 schedule 标签)
velero_backup_last_status                 最近一次备份结果:1 成功 / 0 失败
velero_backup_success_total               成功计数(计数器)
velero_backup_failure_total               失败计数(计数器)
velero_backup_location_status_gauge       备份存储位置可用性,1 可用 / 0 不可用

# 告警思路(备份超过 25 小时未成功即报警)
time() - velero_backup_last_successful_timestamp{schedule!=""} > 90000

# 备份存储不可用立即报警
velero_backup_location_status_gauge == 0
```

指标之外,**还要盯住备份内容**:备份对象大小突然从 200 GB 变成 2 GB,说明卷数据没进去,但任务状态依然是 `Completed`。定期抽查 `velero backup describe <name> --details` 里的卷快照或 FS 备份数量。

### 恢复演练制度化

把演练变成有排期、有验收、有记录的制度:

```shell
1. 排期      核心业务每季度、一般业务每半年,写进日历而不是写在文档里
2. 隔离环境  独立集群或独立命名空间,禁止在生产集群直接覆盖恢复
3. 验收      由业务方按业务口径验收(能登录、能下单、数据条数对得上)
4. 计时      记录从「决定恢复」到「业务可用」的真实耗时,用来修正 RTO
5. 复盘      演练中的每个卡点都要有对应的修复项与负责人
```

演练结果要能回答:**最近一次成功恢复是什么时候、用的哪份备份、耗时多久**。回答不上来,说明演练没有留下证据。

### 备份窗口与并发调优

备份不是免费的,它消耗节点 CPU、网络带宽与对象存储的请求配额。几个真正会影响成败的参数:

```shell
# 备份超时:默认 4 小时,超时后正在进行的 PodVolumeBackup 会被取消
# 大卷或弱网环境必须调大,否则表现为备份长期 PartiallyFailed
velero install ... --fs-backup-timeout 8h

# 每个卷的并行文件处理数:默认取节点的 CPU 核数
velero backup create app-backup --parallel-files-upload 4
velero restore create --from-backup app-backup --parallel-files-download 4

# node-agent 的并发线程数、超时等,只能在安装时通过 ConfigMap 指定
velero install --use-node-agent --node-agent-configmap node-agent-config
```

多个 schedule 要**错峰**。把五个 schedule 都写成 `0 * * * *`,每小时整点会同时启动五份备份,一起争抢带宽与 API 请求,结果是全部变慢甚至超时 —— 把它们错开到 `0`、`10`、`20`、`30`、`40` 分即可。

**备份仓库的维护同样要纳入规划**。Velero 从 v1.14 起把仓库维护从服务端进程解耦,改为在 Velero 命名空间里启动独立的 Kubernetes Job(v1.14 之前在主进程内执行,曾因消耗大量 CPU/内存把 Velero server 拖到 OOM)。v1.15 起可以用 `--repo-maintenance-job-configmap` 指定维护 Job 的资源配置与节点亲和:

```shell
# 备份仓库(BackupRepository)需要定期维护来回收空间
kubectl -n velero get backuprepositories.velero.io
kubectl -n velero get job | grep repo-maintenance
```

维护 Job 长期失败时,仓库会持续膨胀,最终把对象存储的容量与成本拖垮。

### 策略的文档化

备份策略属于**业务决策**,必须落成可评审、可追溯的文档,而不是留在某个人的脑子里或控制台的历史命令里。每一条策略至少记录以下字段:

```shell
范围       哪些命名空间/资源类型,是否包含集群级资源与卷数据
频率       cron 表达式与理由(对应哪个业务等级的 RPO)
保留       每份备份的 TTL,以及是否需要归档级别的长期留存
存放       对象存储位置、区域、账号,是否启用对象锁
加密       备份文件是否加密、密钥在哪里、谁能取用
责任       谁是这条策略的负责人,谁有权批准修改
演练       最近一次成功恢复的时间、耗时、参与人
```

这份文档要和生产配置一起进版本控制。否则半年后没人能回答「这个 schedule 为什么是每小时一次」「那个桶里的备份能不能删」。

### 注意

1. **没有恢复演练的备份等于没有备份**。备份任务的「成功」只证明写入了对象存储,不证明恢复链路可用。恢复时才暴露的典型问题:卷数据没被包含、CRD 缺失、目标集群 StorageClass 名字不同、镜像拉不到。
2. **不要只保留最近一份**。勒索软件与逻辑错误(误删表、错误的数据迁移)都需要回到**污染发生之前**的时间点。只留一份「最新」等于每次备份都在把已被污染的数据复制一遍。
3. **`--ttl` 不是保留份数**。它是每份备份的存活时长,且由 Velero 服务端在备份到期后删除对象存储中的数据,删除不可撤销。想要层级保留必须用多个 schedule。
4. **对象锁与 TTL 冲突会导致备份删不掉**。锁定期长于 TTL 时 Velero 的删除会失败并重试,存储持续增长。两者必须成对设计,否则半年后会发现成本翻了几倍。
5. **快照不能替代备份**。CSI `VolumeSnapshot`、Longhorn 快照、云盘快照大多与原卷在同一存储系统、同一账号下,误删、账号失陷、存储池故障时会一起消失。快照的价值是快速回滚,不是灾备。
6. **命名空间级备份会漏掉集群级资源**。CRD、ClusterRole、StorageClass、PriorityClass、Webhook 配置都不属于任何命名空间,只按命名空间备份时它们不会被包含,恢复出来的自定义资源会直接失败。
7. **备份窗口要与业务高峰错开**。文件系统备份会持续消耗节点 CPU 与网络带宽,默认 4 小时的备份超时(`fs-backup-timeout`)在高负载时容易被触发,表现为备份 `PartiallyFailed`。
8. **备份存储的凭据本身要单独保护**。对象存储的 AK/SK 写在集群内的 Secret 里,攻击者拿到集群就等于拿到备份的删除权 —— 这正是需要不可变副本的原因。
9. **跨集群恢复要提前确认存储类与镜像**。目标集群没有同名 StorageClass 时 PVC 会一直 Pending;私有仓库里没有对应镜像时 Pod 会 ImagePullBackOff。这些都应该在演练里被发现,而不是在真实灾难里。
10. **备份不是归档**。合规要求「保存 7 年」时,靠提高 Velero TTL 会让元数据无限膨胀、查询变慢。长期留存应导出到独立的归档存储并单独管理生命周期。
11. **策略要写进代码并接受评审**。备份范围与保留期是业务决策,应该像其他配置一样进 Git、可追溯变更,而不是某个人在控制台上敲出来的一次性命令。

### 相关命令

- `velero` — 备份计划、TTL 与恢复操作
- `cluster-backup` — 需要备份的具体内容清单
- `disaster-recovery` — RTO/RPO 与恢复演练方法论
- `etcd` — 控制面快照策略
- `longhorn` — 存储层备份与 RecurringJob
- `volume-snapshot` — CSI 快照与保留
- `prometheus` — 备份指标告警
- `minio` — 自建对象存储与对象锁

### 参考链接

- [Velero 官方文档:备份计划与 TTL](https://velero.io/docs/main/backup-reference/)
- [Velero 指标定义(pkg/metrics 源码)](https://github.com/velero-io/velero/blob/main/pkg/metrics/metrics.go)
- [Velero 备份仓库维护](https://velero.io/docs/main/repository-maintenance/)
- [Velero 资源过滤与备份范围](https://velero.io/docs/main/resource-filtering/)
- [AWS S3 Object Lock 文档](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html)
- [MinIO 对象锁与保留](https://min.io/docs/minio/linux/administration/object-management/object-retention.html)
- [Kubernetes 官方文档:etcd 备份与恢复](https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/)
