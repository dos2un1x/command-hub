mysql-operator
===

在Kubernetes上以Operator方式运行管理Percona XtraDB Cluster集群

## 补充说明

**mysql-operator** 这个名字在社区里对应着至少三个互不兼容的项目,本文写的是其中最主流、仍在活跃发版的一个 —— **Percona Operator for MySQL based on Percona XtraDB Cluster**(社区简称 **PXC Operator**)。它的 CRD 组是 `pxc.percona.com`,集群对象叫 `PerconaXtraDBCluster`。

选它之前请先对号入座,三者完全不同,kind 与 apiVersion 都不通用:

| 项目 | 集群 kind | apiVersion | 现状 |
| --- | --- | --- | --- |
| **Percona PXC Operator** | `PerconaXtraDBCluster` | `pxc.percona.com/v1` | 活跃,本文主角 |
| Bitpoke mysql-operator | `MysqlCluster` | `mysql.presslabs.org/v1alpha1` | 最后一个版本停在 2023-05,维护力度有限 |
| Oracle MySQL Operator | `InnoDBCluster` | `mysql.oracle.com/v2` | 由 MySQL 官方在 `github.com/mysql/mysql-operator` 维护(旧的 `oracle/mysql-operator` 仓库已归档) |

另外 Percona 自己还有一个「Percona Operator for MySQL based on Percona Server for MySQL」,CRD 组是 `ps.percona.com`,与本文的 `pxc` 组也不是一回事。

PXC 的复制方式是 **Galera 同步多主**,不是异步主从:任意节点都可写,写入需要在多数派节点上达成一致(认证),因此**节点数与 quorum 直接相关**。Operator 负责的正是把 `PerconaXtraDBCluster` 这个 CR 调谐成 StatefulSet、Service、Secret,并处理扩缩容、备份、恢复与升级。

### 安装

```shell
# Helm(推荐)
helm repo add percona https://percona.github.io/percona-helm-charts/
helm repo update
helm install my-op percona/pxc-operator --namespace pxc --create-namespace

# 用 Chart 顺带装一个示例集群
helm install my-db percona/pxc-db --namespace pxc

# 或纯 kubectl:一次装齐 CRD + Operator
kubectl apply -f https://raw.githubusercontent.com/percona/percona-xtradb-cluster-operator/v1.20.0/deploy/bundle.yaml
kubectl apply -f https://raw.githubusercontent.com/percona/percona-xtradb-cluster-operator/v1.20.0/deploy/cr.yaml

kubectl get pods -n pxc
kubectl get pxc -n pxc
```

### CRD 家族

```shell
pxc.percona.com/v1
  PerconaXtraDBCluster          集群本体(短名 pxc / pxcs)
  PerconaXtraDBClusterBackup    一次按需备份(短名 pxc-backup / pxc-backups)
  PerconaXtraDBClusterRestore   一次恢复任务(短名 pxc-restore / pxc-restores)
```

三个 CRD 的 apiVersion **都是 `pxc.percona.com/v1`**(不是 `v1alpha1`,照抄老文档会踩坑)。定时备份不存在独立 CRD 中,而是写在集群 CR 的 `spec.backup.schedule[]` 里。

### 集群清单

```shell
apiVersion: pxc.percona.com/v1
kind: PerconaXtraDBCluster
metadata:
  name: cluster1
spec:
  crVersion: 1.20.0                 # 必须与 Operator 版本一致,升级后要手工改
  updateStrategy: SmartUpdate       # SmartUpdate | RollingUpdate | OnDelete
  pxc:
    size: 3                         # 必须为 3 或 5
    image: percona/percona-xtradb-cluster:8.4.8-8.1
    volumeSpec:
      persistentVolumeClaim:
        resources:
          requests:
            storage: 100Gi
    affinity:
      antiAffinityTopologyKey: kubernetes.io/hostname   # 注意在 affinity 下面
    configuration: |
      [mysqld]
      max_connections=1024
  haproxy:
    enabled: true                   # 默认开启,提供读写入口
    size: 3
  proxysql:
    enabled: false                  # 默认关闭,需要 ProxySQL 才打开
  tls:
    enabled: true
  backup:
    storages:
      s3-backup:
        type: s3                    # s3 | azure | filesystem
        s3:
          bucket: my-bucket
          region: us-west-2
          credentialsSecret: s3-secret
    schedule:
      - name: nightly
        schedule: "0 4 * * *"
        storageName: s3-backup
        retention:
          count: 7
          deleteFromStorage: true
```

```shell
kubectl apply -f cluster1.yaml -n pxc

# 三个 PXC 节点 + 三个 HAProxy
kubectl get pods -n pxc
kubectl get pxc cluster1 -n pxc -o jsonpath='{.status.pxc.ready}'

# 连接入口
# cluster1-haproxy        读写(经 HAProxy)
# cluster1-haproxy-replicas  只读
# cluster1-pxc            PXC 节点之间的 Headless Service
kubectl get svc -n pxc
```

### 扩缩容

```shell
# 改 spec.pxc.size,或直接 scale
kubectl patch pxc cluster1 -n pxc --type merge -p '{"spec":{"pxc":{"size":5}}}'
kubectl scale --replicas=5 pxc/cluster1 -n pxc
```

`spec.pxc.size` **只允许 3 或 5**(HA 场景),写别的值会被校验拒绝,除非打开 `spec.unsafeFlags.pxcSize: true` —— 那等于放弃 quorum 保护。扩缩容时 Operator 会对节点做一次 SST/IST 同步,大库耗时很长。

### 备份

备份由 `spec.backup.storages` 定义目标存储,再由集群 CR 的 `spec.backup.schedule[]` 定时,或提交一个 `PerconaXtraDBClusterBackup` 按需触发:

```shell
apiVersion: pxc.percona.com/v1
kind: PerconaXtraDBClusterBackup
metadata:
  name: on-demand
spec:
  pxcCluster: cluster1              # 目标集群
  storageName: s3-backup            # 引用 spec.backup.storages 中的名字
```

```shell
kubectl apply -f backup.yaml -n pxc

# 跟踪状态,到 Succeeded 才算完成
kubectl get pxc-backup -n pxc -w
kubectl get pxc-backup on-demand -n pxc -o jsonpath='{.status}'
```

`PerconaXtraDBClusterBackup` 里**没有 `schedule` 字段**,写了也不会报错、更不会定时执行 —— 定时备份只能配在集群 CR 上。备份工具是 XtraBackup,除了 `type: filesystem`(PV)外都需要对象存储;开启 XtraBackup sidecar 时**只支持云存储**。

### 恢复

```shell
apiVersion: pxc.percona.com/v1
kind: PerconaXtraDBClusterRestore
metadata:
  name: restore1
spec:
  pxcCluster: cluster1
  backupName: on-demand             # 与 backupSource 二选一
  # backupSource:                   # 从对象存储里已有备份恢复时使用
  #   destination: s3://my-bucket/backup
```

```shell
# PITR 前必须先关掉 pitr,否则恢复作业会和 binlog 上传互相干扰
kubectl patch pxc cluster1 -n pxc --type merge -p '{"spec":{"backup":{"pitr":{"enabled":false}}}}'

kubectl apply -f restore.yaml -n pxc
kubectl get pxc-restore -n pxc -w
```

带时间点的恢复把 `pitr` 写进 Restore 对象:

```shell
spec:
  pxcCluster: cluster1
  backupName: nightly
  pitr:
    type: date                      # date | transaction | latest | skip
    date: "2026-09-18 10:00:00"     # type=date 时使用,不能超过 status.latestRestorableTime
```

### 升级

```shell
# 1. 先升级 CRD 与 RBAC(必须 --server-side,CRD 太大无法用客户端 apply)
kubectl apply --server-side -f https://raw.githubusercontent.com/percona/percona-xtradb-cluster-operator/v1.20.0/deploy/crd.yaml
kubectl apply --server-side -f https://raw.githubusercontent.com/percona/percona-xtradb-cluster-operator/v1.20.0/deploy/rbac.yaml

# 2. 升级 Operator
helm upgrade my-op percona/pxc-operator --version 1.20.0 -n pxc

# 3. 修改集群 CR 的 crVersion 与各组件镜像,Operator 才会按新版本逻辑调和
kubectl patch pxc cluster1 -n pxc --type merge -p '{"spec":{"crVersion":"1.20.0"}}'
```

MySQL 大版本升级由 `spec.upgradeOptions` 控制:

```shell
spec:
  upgradeOptions:
    versionServiceEndpoint: https://check.percona.com
    apply: Recommended             # Never | Disabled | Recommended | Latest | 具体版本号
    schedule: "0 4 * * *"
```

### 监控

内置集成的是 Percona Monitoring and Management(PMM),客户端以 sidecar 形式跑在 PXC Pod 内:

```shell
spec:
  pmm:
    enabled: true
    image: percona/pmm-client:3.8.0
    serverHost: monitoring-service    # 必填,且必须集群内可达
```

不看 PMM 时,排障主要靠这些端口:

```shell
# PXC 节点
3306    mysql
4567    write-set 复制(Galera 通信)
4568    IST
4444    SST
33062   mysql-admin
33060   mysqlx

# HAProxy
3306    读写入口
3307    只读入口(replicas)
3309    proxy-protocol,客户端直连会握手失败
8404    HAProxy 自身统计页

# ProxySQL
3306    读写入口
6032    admin 管理端口
6070    stats
```

`pxc-monit` 不是 PXC 节点里的容器,而是 **HAProxy / ProxySQL Pod 内的 sidecar**,用 `peer-list` 动态维护后端节点列表,它自己不暴露业务端口。`mysqld_exporter`(:9104)也不是内置的,需要自己以 `spec.pxc.sidecars` 挂进去。

### 注意

1. **同名项目先认清**。`kubectl get pxc` 只有本文这个 Operator 能用;Bitpoke 的是 `kubectl get mysqlcluster`,`mysql.presslabs.org/v1alpha1`;Oracle 的是 `kubectl get innodbcluster`,`mysql.oracle.com/v2`。混用文档一定会失败。
2. **升级 Operator 后忘记改 `spec.crVersion`**。这个字段决定 Operator 用哪套逻辑调和集群,不改的话新版本的行为不会生效,是升级流程里最常漏的一步。
3. **`antiAffinityTopologyKey` 写错层级**。正确路径是 `spec.pxc.affinity.antiAffinityTopologyKey`,写成 `spec.pxc.antiAffinityTopologyKey` 会被静默忽略,三个节点可能全落到同一台机器上,反亲和形同虚设。
4. **节点数必须 3 或 5**。Galera 靠多数派 quorum,偶数节点只会增加开销而不会提高容错。用 `spec.unsafeFlags.pxcSize: true` 强行绕过的代价是随时可能失去 quorum。
5. **全集群崩溃后不要随手 force bootstrap**。当所有节点的 `grastate.dat` 都是 `seqno: -1` 时强行 bootstrap,被选中的节点会认为自己是最新的并且**不再尝试加入其它节点**,造成脑裂甚至数据丢失。优先依赖默认开启的 `spec.pxc.autoRecovery: true`;半自动方式是在目标节点执行 `kubectl exec cluster1-pxc-2 -c pxc -- sh -c 'kill -s USR1 1'`(该节点 5 分钟内不参与选举);最后才人工比对 `wsrep-recover` 的 seqno 挑最大的那个。
6. **备份 CR 里写 `schedule` 没用**。`PerconaXtraDBClusterBackup` 没有这个字段,定时备份必须写进集群 CR 的 `spec.backup.schedule[]`。
7. **PITR 恢复前要先关 pitr**。不先 `spec.backup.pitr.enabled: false` 就提交 Restore,恢复作业与 binlog 上传会互相干扰;若期间还轮换过密码,还需要匹配的 user-password Secret(官方已知限制)。
8. **缩容不会删除 PVC**。PVC 来自 StatefulSet 的 volumeClaimTemplates,缩容后 Kubernetes 不会回收,磁盘会一直被占用;确认数据无用后手工删除。删除整个集群时可以用 `percona.com/delete-pxc-pvc` finalizer 让 Operator 帮忙清理,备份对象则用 `percona.com/delete-backup`。
9. **ProxySQL 默认是关的**。默认 CR 只开 HAProxy。要用 ProxySQL 必须显式 `spec.proxysql.enabled: true`,否则按 ProxySQL 的端口去连会连不上。
10. **`spec.upgradeOptions.apply` 别乱开 `Latest`**。它会自动把数据库升到最新推荐版本,大版本升级不可回退;生产建议 `Recommended`,并且确保升级前有可用备份。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `statefulset` — PXC 节点的实际载体
- `pvc` — 持久卷声明,数据库数据盘
- `storageclass` — 存储类,决定数据库存储性能
- `helm` — Kubernetes包管理器
- `secret` — 存放数据库密码与对象存储凭据
- `prometheus` — 采集 PMM 或 exporter 指标

### 参考链接

- [Percona Operator for MySQL 文档](https://docs.percona.com/percona-operator-for-mysql/pxc/)
- [Helm 安装](https://docs.percona.com/percona-operator-for-mysql/pxc/helm.html)
- [CR 字段参考](https://docs.percona.com/percona-operator-for-mysql/pxc/operator.html)
- [备份与恢复](https://docs.percona.com/percona-operator-for-mysql/pxc/backups-restore.html)
- [升级 Operator 与 CRD](https://docs.percona.com/percona-operator-for-mysql/pxc/update-operator.html)
