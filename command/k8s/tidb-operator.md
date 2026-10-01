tidb-operator
===

在Kubernetes上以Operator方式运行管理TiDB集群

## 补充说明

**TiDB Operator** 是 PingCAP 官方的 Kubernetes Operator,用一个 `TidbCluster` CR 描述整套分布式数据库(PD、TiKV、TiDB、TiFlash、TiCDC、TiProxy),由 Operator 负责部署、扩缩容、故障转移、备份恢复与滚动升级。

需要先看清版本线:

- **v1.6 是当前生产可用线**(最新 `v1.6.6`,2026-08-12),`TidbCluster` 属于 `pingcap.com/v1alpha1`,本文以此为准。
- **v2 线仍是 alpha/beta**(`v2.2.0-alpha.x` 持续发布中),它是一次破坏性重构:`TidbCluster` 被拆成 `Cluster` / `ComponentGroup` / `Instance` 三层 CRD(组名 `core.pingcap.com`),并且**不再支持** `TidbInitializer`、`TidbMonitor`、`TidbDashboard`、`BackupSchedule`、EBS 快照备份、跨命名空间部署等能力。新上生产不建议直接押注 v2。

TiDB 各组件职责与副本语义差别很大,这是运维时最容易混淆的地方:

| 组件 | CR 字段 | 副本语义 |
| --- | --- | --- |
| PD | `spec.pd.replicas` | Raft 成员,**必须奇数**(3 或 5) |
| TiKV | `spec.tikv.replicas` | 存储节点数,**可以偶数**;它不等于 Region 副本数 |
| TiDB | `spec.tidb.replicas` | 无状态 SQL 层,随便扩 |
| TiFlash | `spec.tiflash.replicas` | 列存副本,通常 2 |
| TiCDC | `spec.ticdc.replicas` | 变更捕获,通常 2 |

### 安装

```shell
# Helm 仓库(注意是 charts.pingcap.com)
helm repo add pingcap https://charts.pingcap.com/
helm repo update

# 1. CRD 必须单独安装:Chart 里没有 crds/ 目录
kubectl create -f https://raw.githubusercontent.com/pingcap/tidb-operator/v1.6.6/manifests/crd.yaml

# 2. 再装 Operator
helm install tidb-operator pingcap/tidb-operator \
  --namespace tidb-admin --create-namespace --version v1.6.6

kubectl get pods -n tidb-admin
kubectl get crd | grep pingcap
```

### CRD 家族

```shell
pingcap.com/v1alpha1
  TidbCluster        集群本体
  TidbMonitor        监控栈(Prometheus + Grafana)
  TidbInitializer    初始化(建库建用户、设密码)
  TidbNGMonitoring   持续性能分析
  TidbDashboard      TiDB Dashboard
  Backup             一次备份
  BackupSchedule     定时备份
  Restore            一次恢复
  CompactBackup      日志备份的压缩(TiDB v8.5.5+)
  DMCluster          数据迁移集群
```

注意备份相关的 CRD 在 v1.6 里已经**改名为 `Backup` / `Restore`**(旧的 `TidbBackup` / `TidbRestore` 名称在 v1.6 的清单里已不存在),照抄老文档会报 `no matches for kind`。

### 集群清单

```shell
apiVersion: pingcap.com/v1alpha1
kind: TidbCluster
metadata:
  name: basic
spec:
  version: v8.5.7                  # 格式是镜像 tag
  pvReclaimPolicy: Retain          # 官方建议显式设为 Retain
  enablePVReclaim: false           # 默认 false:不回收缩容遗留的 PVC
  pd:
    replicas: 3                    # 奇数
    storageClassName: fast
    requests:
      storage: 20Gi
    config: |
      [replication]
      location-labels = ["region", "zone", "host"]
  tikv:
    replicas: 3                    # 存储节点数,与 Region 副本数是两件事
    storageClassName: fast
    requests:
      storage: 500Gi
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - topologyKey: kubernetes.io/hostname
  tidb:
    replicas: 3
```

```shell
kubectl apply -f tidb-cluster.yaml -n tidb
kubectl get tidbcluster -n tidb -w
kubectl get pods -n tidb

# 各组件就绪副本
kubectl get tidbcluster basic -n tidb -o jsonpath='{.status.pd.statefulSet.readyReplicas}'
```

### 副本数与调度拓扑

**`spec.tikv.replicas` 是 TiKV 实例(store)数量,PD 的 `max-replicas` 是每个 Region 的副本数,默认 3**。两者可以完全不一样:3 个 TiKV 实例 + `max-replicas: 3` 意味着每个 Region 在 3 个节点各存一份;若把 `spec.tikv.replicas` 加到 5,Region 副本数仍然是 3,只是分布更分散。`max-replicas` **创建后不可在 CR 里改**,要用 `pd-ctl` 或 `kubectl exec` 调 PD 接口。

跨节点、跨可用区分布靠这几件事配合:

```shell
# 1) 组件级反亲和:优先把同组件 Pod 打散
spec:
  tikv:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - topologyKey: kubernetes.io/hostname
```

```shell
# 2) 拓扑分布约束:CR 里只写 topologyKey,其余由 Operator 展开
spec:
  topologySpreadConstraints:
    - topologyKey: topology.kubernetes.io/zone
  # 也可写在组件级 spec.tikv.topologySpreadConstraints
```

```shell
# 3) 给节点打标,Operator 会据此写入 PD 的 location-labels
kubectl label node node-1 topology.kubernetes.io/zone=cn-north-a
```

数据级的高可用最终由 PD 的调度决定,集群层面的反亲和只是第一步;要保证「同一个 Region 的三个副本不落在同一个可用区」,`location-labels` + 节点 label 是必需的。

### 扩缩容

```shell
# 扩容 TiKV
kubectl patch tc basic -n tidb --type merge -p '{"spec":{"tikv":{"replicas":5}}}'

# 缩容
kubectl patch tc basic -n tidb --type merge -p '{"spec":{"tikv":{"replicas":3}}}'
```

扩容是升序补 Pod,缩容是降序删。**TiKV 的缩容不是简单的删 Pod**:Operator 会先调用 PD 接口把目标实例标记为 offline 并触发数据迁移,迁完之后才删除 Pod —— 因此 TiKV 缩容通常要 **3~5 分钟**甚至更久(PD/TiDB 只需十几秒到半分钟)。

两条硬限制:

- 当 **UP store 数量 ≤ `max-replicas`** 时无法缩容,PD 会拒绝下线,否则副本数不足会丢数据;
- **缩容进行中不能再扩容**,要等数据迁移结束。

### 存储与 PVC

```shell
kubectl get pvc -n tidb

# 保留策略:官方建议 Retain,保证缩容/删除后 PV 不会被销毁
spec:
  pvReclaimPolicy: Retain
```

缩容后遗留的 PVC **不会自动清理**,而且「保留的 PVC/PV 不再由集群管理」—— 就算之后把副本数加回来,也不会复用这些旧卷,只能手工删除后再扩。`spec.enablePVReclaim`(默认 `false`)开启后 Operator 才会回收这些孤儿 PVC,开启前务必确认数据确实不要了。

### 备份与恢复

```shell
apiVersion: pingcap.com/v1alpha1
kind: Backup
metadata:
  name: basic-backup-s3
  namespace: tidb
spec:
  br:
    cluster: basic                 # 目标 TidbCluster 名字(跨命名空间时加 clusterNamespace)
  backupType: full                 # full | db | table
  s3:
    provider: aws                  # 兼容 S3 的对象存储填 ceph / 其它
    endpoint: http://minio.tidb.svc:9000
    secretName: s3-secret          # 存放 access-key / secret-key 的 Secret
    bucket: tidb-backup
    prefix: basic
```

```shell
kubectl apply -f backup.yaml -n tidb
kubectl get backup -n tidb -w
```

定时备份用 `BackupSchedule`(`spec.schedule` 是 cron 表达式)。日志备份(增量)不是 `backupType` 的取值,而是把同一个 `Backup` 对象写成 `spec.backupMode: log`,状态机通过 `spec.logSubcommand` 控制(`log-start` / `log-pause` / `log-stop`)。

恢复:

```shell
apiVersion: pingcap.com/v1alpha1
kind: Restore
metadata:
  name: basic-restore
  namespace: tidb
spec:
  br:
    cluster: basic
  backupType: full
  to:
    cluster: basic                  # 恢复到哪个集群,可与备份源不同
  s3:
    secretName: s3-secret
    bucket: tidb-backup
```

对象存储不是唯一选择(S3 兼容、GCS、Azure Blob、PV、EBS 快照都支持),但生产环境基本都用对象存储。时间点恢复(PITR)需要 **TiDB v6.3+**,并且要同时具备基础备份与日志备份;v8.5.5+ 还需要 `CompactBackup` 参与。

### 升级

```shell
# 1. 改 spec.version(格式为镜像 tag);升级前务必确认没有正在执行的 DDL
kubectl patch tc basic -n tidb --type merge -p '{"spec":{"version":"v8.5.7"}}'

# 2. 观察滚动顺序:PD → TiProxy → TiFlash → TiKV → TiDB
kubectl get pods -n tidb -w
```

滚动升级会短暂断开客户端连接,PD 与 TiKV 的 Leader 迁移由 Operator 自动完成,不需要手工驱逐。若集群卡在某个副本上,可以强行推进:

```shell
kubectl annotate --overwrite tc basic -n tidb tidb.pingcap.com/force-upgrade=true
# 升级成功后必须移除该注解,否则后续变更会被强制跳过
kubectl annotate tc basic -n tidb tidb.pingcap.com/force-upgrade-
```

**TiDB 不支持降级**(包括小版本回退),升上去只能靠备份恢复回去,这是升级前必须先做备份的直接原因。

### 监控

```shell
apiVersion: pingcap.com/v1alpha1
kind: TidbMonitor
metadata:
  name: basic-monitor
  namespace: tidb                 # 必须与 TidbCluster 同命名空间
spec:
  clusters:
    - name: basic
      namespace: tidb
  persistent: true                # 默认 false,即用 emptyDir
  storageClassName: fast
  storage: 50Gi
```

`TidbMonitor` 会部署一套 Prometheus + Grafana,并加载 TiDB 官方大盘。要监控多个集群时,把它们的 `clusters[]` 都列进来,或使用 `spec.clusterScoped: true`。注意 v2 线**完全不支持** `TidbMonitor`。

### 注意

1. **PD 必须是奇数节点**。PD 是 Raft 集群,4 个节点的容错能力与 3 个完全相同(仍要 3 个存活),只增加选举与心跳开销;3 节点容忍 1 个故障,5 节点容忍 2 个。
2. **`spec.tikv.replicas` 与 PD 的 `max-replicas` 是两回事**。前者是存储节点数、可以偶数,后者是 Region 副本数、默认 3、**不能在 CR 里改**(要用 pd-ctl)。把两者混为一谈会得出完全错误的容量与容错结论。
3. **UP store 数 ≤ `max-replicas` 时无法缩容**。PD 拒绝把 store 下线,缩容操作会一直卡住;缩容过程中也不能扩容,必须先等数据迁移完成。
4. **缩容遗留的 PVC 不会自动清理,也不会被复用**。官方明确说明保留的 PVC/PV 不再由集群管理,扩回来也是挂新卷;需要手工删除旧 PVC/PV 才能复用节点资源。
5. **`pvReclaimPolicy` 建议显式写 `Retain`**。若留给 StorageClass 默认值(很多环境是 `Delete`),一次误删 PVC 就可能导致 PV 与数据一起消失。
6. **`enablePVReclaim` 是把双刃剑**。它默认 `false`(保留孤儿 PVC),开启后 Operator 会回收缩容遗留的 PVC —— 在缩容还没确认数据可弃之前不要打开。
7. **CRD 不随 Helm 安装**。Chart 里没有 `crds/` 目录,忘了执行 `kubectl create -f manifests/crd.yaml` 会导致所有 CR 创建失败,而 `helm install` 本身不会报任何错。
8. **备份 CRD 已改名**。v1.6 里是 `Backup` / `Restore` / `BackupSchedule`,老的 `TidbBackup` / `TidbRestore` 已经不存在;`kubectl get tidbbackup` 会得到空结果或报错。
9. **`backupType` 不是 `full|incremental`**。它的取值是 `full` / `db` / `table`;增量与时间点恢复走 `spec.backupMode: log` 的日志备份,两者是不同维度。
10. **升级不可回滚,并且会断连接**。所有 TiDB 版本(包括补丁版本)都不支持降级;升级前务必确认没有正在执行的 DDL,并让客户端具备重试能力。
11. **跨可用区容灾要三件事一起做**。只配 `topologySpreadConstraints` 不够,还需要给节点打 label,并让 PD 的 `location-labels` 与之对应,否则 PD 根本不知道机架与可用区的存在。
12. **v2 的 `TidbCluster` 已经不是同一个东西**。它被拆成 `Cluster` / `ComponentGroup` / `Instance`,并且丢掉了一批 CRD(`TidbMonitor`、`TidbInitializer`、`BackupSchedule` 等)。按 v1.6 文档写 v2 集群会完全对不上。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `statefulset` — PD / TiKV / TiDB 的实际载体
- `pvc` — 持久卷声明,存储节点数据盘
- `storageclass` — 存储类,直接决定 TiKV 性能
- `topology-spread` — 跨节点/可用区打散
- `helm` — Kubernetes包管理器
- `prometheus` — 抓取 TiDB 集群指标

### 参考链接

- [TiDB Operator 文档(v1.6)](https://docs.pingcap.com/tidb-in-kubernetes/v1.6/deploy-tidb-operator)
- [备份与恢复 CR 说明](https://docs.pingcap.com/tidb-in-kubernetes/v1.6/backup-restore-cr)
- [扩缩容 TiDB 集群](https://docs.pingcap.com/tidb-in-kubernetes/v1.6/scale-a-tidb-cluster)
- [升级 TiDB 集群](https://docs.pingcap.com/tidb-in-kubernetes/v1.6/upgrade-a-tidb-cluster)
- [CRD API 参考](https://github.com/pingcap/tidb-operator/blob/v1.6.6/docs/api-references/docs.md)
- [v2 与 v1 的差异](https://docs.pingcap.com/tidb-in-kubernetes/v2.0/v2-vs-v1/)
