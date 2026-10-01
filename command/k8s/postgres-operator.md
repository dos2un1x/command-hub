postgres-operator
===

在Kubernetes上以Operator方式运行管理PostgreSQL高可用集群

## 补充说明

**postgres-operator** 至少有四个互不兼容的同名项目,这是选型时最容易踩的坑。本文写的是 **Zalando 的 postgres-operator**(CRD 组 `acid.zalan.do`,集群对象叫 `postgresql`),理由是它社区体量最大、仍在活跃发版,并且 CRD 足够简单,适合作为理解「Operator 管数据库」的入口。

| 项目 | 集群 kind | apiVersion | 说明 |
| --- | --- | --- | --- |
| **Zalando postgres-operator** | `postgresql`(短名 `pg`) | `acid.zalan.do/v1` | 本文主角,最新 v2.0.2,支持 PG 14→18 |
| Crunchy Data PGO(现称 CPK) | `PostgresCluster` | `postgres-operator.crunchydata.com/v1beta1`(v6 起有 `v1`) | 功能最全,pgBackRest + PGUpgrade CRD;2025 年被 Snowflake 收购后仍在发版 |
| StackGres | `SGCluster` 等 `SG*` 对象 | `stackgres.io/v1` | 全栈方案,自带连接池与监控 |
| Crunchy PGO v4 及更早 | `pgcluster` | `crunchydata.com/v1` | 已过时,不要照着老文档写 |

Zalando 这套的分工要分清:**高可用是 Patroni 在做**(选主、流复制、故障切换),Operator 只负责把 `postgresql` 这个 CR 变成 StatefulSet、Service、Secret 和 Endpoints,并通过 Patroni 的 REST API 观察集群成员状态。所以排障时一半时间在看 Operator 日志,另一半时间在看 Patroni。

### 安装

```shell
# Helm(注意仓库地址以 chart 名结尾)
helm repo add postgres-operator-charts \
  https://opensource.zalando.com/postgres-operator/charts/postgres-operator
helm repo update

helm install postgres-operator postgres-operator-charts/postgres-operator \
  --namespace postgres-operator --create-namespace

# v2 起也提供 OCI 制品
helm install postgres-operator oci://ghcr.io/zalando/charts/postgres-operator \
  --version 2.0.2 -n postgres-operator --create-namespace

kubectl get pods -n postgres-operator
kubectl get crd | grep zalando
```

### CRD 家族

```shell
acid.zalan.do/v1
  postgresql             PostgreSQL 集群(短名 pg,注意 kind 是全小写)
  operatorconfiguration  Operator 自身配置(短名 opconfig)
  postgresteam           团队与成员权限(短名 pgteam)
```

### 集群清单

```shell
apiVersion: acid.zalan.do/v1
kind: postgresql
metadata:
  name: acid-minimal-cluster
spec:
  teamId: "acid"                   # 必填,归属团队
  numberOfInstances: 3             # 1 主 + 2 从
  postgresql:
    version: "17"                  # 主版本号字符串,创建后改动即触发大版本升级
    parameters:
      max_connections: "200"
      shared_buffers: "1GB"
  volume:
    size: 100Gi
    storageClass: fast
  resources:
    requests:
      cpu: 500m
      memory: 1Gi
    limits:
      memory: 2Gi
  tls:
    secretName: acid-minimal-cluster-ssl
  connectionPooler:
    numberOfInstances: 2
    mode: transaction              # transaction | session
  enableLogicalBackup: false       # 默认 false,开启后走 CronJob 逻辑备份
```

```shell
kubectl apply -f cluster.yaml -n postgres

# CRD 自带打印列,一眼能看到 Team / Version / Pods / Volume / Status
kubectl get postgresql -n postgres
kubectl get pg acid-minimal-cluster -n postgres -o wide
```

### 连接方式

```shell
# 主库(可写):Service 名就是集群名
acid-minimal-cluster.postgres.svc.cluster.local:5432

# 只读:集群名加 -repl 后缀
acid-minimal-cluster-repl.postgres.svc.cluster.local:5432

# 连接池(配置了 connectionPooler 后才有)
acid-minimal-cluster-pooler.postgres.svc.cluster.local:5432
```

```shell
# 取用户密码
kubectl get secret postgres.acid-minimal-cluster.credentials.postgresql.acid.zalan.do \
  -n postgres -o jsonpath='{.data.password}' | base64 -d

# 默认强制 TLS,不带 SSL 会被 pg_hba 拒绝
kubectl run -it --rm psql --image=postgres:17 --restart=Never -- \
  env PGSSLMODE=require PGPASSWORD=<password> \
  psql -h acid-minimal-cluster -U postgres -c '\l'
```

### 扩缩容

```shell
# 唯一的副本数字段
kubectl patch postgresql acid-minimal-cluster -n postgres --type merge \
  -p '{"spec":{"numberOfInstances":5}}'
```

扩容时 Operator 只改 StatefulSet 副本数,新成员由 **Patroni 负责克隆数据并加入复制**;从库数据量大时这一步很慢,要盯 Patroni 日志而不是只看 Pod 是否 Running。缩容时 Operator 会先让 Patroni 把节点移出集群再删 Pod。

### 存储与 PVC

```shell
# 每个实例一套 PVC
kubectl get pvc -n postgres

# 只能扩,不能缩(缩小不生效)
kubectl patch postgresql acid-minimal-cluster -n postgres --type merge \
  -p '{"spec":{"volume":{"size":"200Gi"}}}'
```

**缩容默认保留 PVC**,但**删除 postgresql 清单默认会连 PVC 一起删** —— 这是两套开关,别搞混:

```shell
# 定义在 operator 配置里(retention policy 默认 when_deleted: retain、when_scaled: retain)
persistent_volume_claim_retention_policy:
  when_deleted: retain
  when_scaled: retain
```

```shell
# 但 Operator 默认还会主动删 PVC —— 想保住数据必须关掉
enable_persistent_volume_claim_deletion: false
```

### 备份与恢复

Zalando 这套**没有备份 CRD**,备份能力由 Operator 配置项与集群清单共同决定,两条路:

```shell
# 1) 连续归档(WAL):把归档送到对象存储,是 PITR 的前提
#    operator 配置项,文档仍写作 WAL-E,现役 Spilo 用的是 WAL-G;还需注入 AWS 凭据
wal_s3_bucket: my-wal-bucket
```

```shell
# 2) 逻辑备份:Operator 会创建 CronJob,定期 pg_dump 并上传
spec:
  enableLogicalBackup: true
  logicalBackupSchedule: "30 00 * * *"    # 默认值
```

恢复到某个时间点靠**克隆**实现:新建一个集群,把源集群与目标时间写进 `spec.clone`。

```shell
apiVersion: acid.zalan.do/v1
kind: postgresql
metadata:
  name: acid-restored
spec:
  teamId: "acid"
  numberOfInstances: 3
  postgresql:
    version: "17"
  volume:
    size: 100Gi
  clone:
    cluster: "acid-minimal-cluster"       # 源集群名(或 S3 上的 key)
    timestamp: "2026-09-18T02:00:00+00:00" # 非包含式恢复目标,必须带时区
```

不做时间点恢复、只复制一个集群时,省掉 `timestamp` 即可(同 namespace 内走 `pg_basebackup`);要从 S3 克隆则给出 `uid` 与 `s3_wal_path`。**新集群的 `version` 必须不低于源集群**。

### 升级

```shell
# 1. 先手动升级 CRD —— Helm 不会升级 CRD,这是官方明确提示的
kubectl apply -f https://raw.githubusercontent.com/zalando/postgres-operator/v2.0.2/charts/postgres-operator/crds/postgresqls.yaml
kubectl apply -f https://raw.githubusercontent.com/zalando/postgres-operator/v2.0.2/charts/postgres-operator/crds/operatorconfigurations.yaml
kubectl apply -f https://raw.githubusercontent.com/zalando/postgres-operator/v2.0.2/charts/postgres-operator/crds/postgresteams.yaml

# 2. 升级 Operator
helm upgrade postgres-operator postgres-operator-charts/postgres-operator \
  -n postgres-operator
```

小版本升级就是换 Spilo 镜像,Operator 做滚动更新加一次受控 switchover,通常只有几秒不可写,但客户端必须能重连。

**大版本升级改的是 `spec.postgresql.version`**,没有额外的 annotation 开关:

```shell
# 由 Operator 配置项 major_version_upgrade_mode 控制
#   off    = 不升级
#   manual = 清单里改了才升(chart 默认值)
#   full   = 清单改动或低于 minimal_major_version 都会升
major_version_upgrade_mode: "manual"
```

```shell
kubectl patch postgresql acid-minimal-cluster -n postgres --type merge \
  -p '{"spec":{"postgresql":{"version":"18"}}}'

# 升级结果会写回 CR 的 annotation
kubectl get pg acid-minimal-cluster -n postgres \
  -o jsonpath='{.metadata.annotations.last\-major\-upgrade\-success}'
```

升级动作由主库内的 `inplace_upgrade.py` 完成,执行前 Operator 会检查:是否在 `maintenanceWindows` 内、是否 standby 集群、所有 Pod 是否 Running、副本复制延迟是否小于 16 MiB。任一不满足就跳过,失败过的集群会被打上 `last-major-upgrade-failure` 注解并不再自动重试。

### 监控

三个层级要分清:

```shell
# 1) Patroni 暴露集群自身的指标(Prometheus 格式)
kubectl exec -n postgres acid-minimal-cluster-0 -- curl -s localhost:8008/metrics | head

# 2) PostgreSQL 业务指标要自己挂 exporter sidecar(端口 9187)
spec:
  sidecars:
    - name: exporter
      image: prometheuscommunity/postgres-exporter:v0.16.0
      ports:
        - name: exporter
          containerPort: 9187
      env:
        - name: DATA_SOURCE_URI
          value: "localhost:5432/postgres?sslmode=require"

# 3) Operator 自身只有 8080 上的诊断 API(/status、/clusters 等),不提供 Prometheus 指标
kubectl port-forward -n postgres-operator svc/postgres-operator 8080:8080
```

配好 sidecar 与 `podAnnotations` 后,再用 ServiceMonitor / PodMonitor 抓 9187 与 8008 两个端口。

### 注意

1. **同名项目是最大的坑**。本文用的是 Zalando 版(`kubectl get postgresql`、`acid.zalan.do/v1`);Crunchy PGO 用的是 `kubectl get postgrescluster`、`postgres-operator.crunchydata.com/v1beta1`;StackGres 是 `SG*` 对象。三套文档互相不能照抄。
2. **Helm 升级不升级 CRD**。官方原话提示:不先更新 CRD,会遇到「new Postgres manifest or configuration options being unknown」—— 新字段被 API Server 直接截断,报错完全指不到根因。升级前必须先 `kubectl apply` 对应版本的 `crds/` 目录。
3. **删除清单会删掉 PVC**。`enable_persistent_volume_claim_deletion` 默认为 `true`,它会**无视** StatefulSet 上的 `retain` 策略,把 PVC 一并删除。要保住数据必须显式设为 `false`。
4. **大版本升级默认是「改了就升」**。chart 默认 `major_version_upgrade_mode: "manual"`,只要动了 `spec.postgresql.version` 就会真的执行 `pg_upgrade`,而**一旦开始就无法回滚**。改版本号前请确认备份可用、且在维护窗口内。
5. **连接默认强制 TLS**。不加 `PGSSLMODE=require` 会直接被拒,典型报错是 `no pg_hba.conf entry for host ..., no encryption`。
6. **卷只能扩不能缩**。Operator 只支持扩大 `spec.volume.size`,缩小会给出警告且不生效;真要缩小只能重建 PVC 与 Pod,等于重建实例。
7. **集群名不能超过 58 个字符**。只读 Service 会在集群名后加 `-repl`,而 Service 名上限 63 字符,因此集群名被限制在 58 以内,名字太长会导致资源创建失败。
8. **standby 集群不参与大版本升级**。官方明确跳过 standby 集群,需要先删除 standby,升完主集群再按新版本重建。
9. **复制延迟超过 16 MiB 会跳过升级**。Operator 用这个阈值判断集群是否「安静」,跨机房或大事务场景下很容易一直不满足,升级会一直不执行。
10. **`maintenanceWindows` 不配置就没有窗口限制**。字段名容易写错(是复数 `maintenanceWindows`),写错的后果是升级可能在业务高峰自动执行。
11. **改 namespace 等于新建一个集群**。Operator 不支持迁移,把 CR 丢到另一个 namespace 会创建一套全新实例,原数据不会跟过去。
12. **Operator 升级会连带滚动一次数据库**。官方不保证升级过程零中断,建议同样安排在维护窗口,并确认客户端具备重连能力。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `statefulset` — PostgreSQL 实例的实际载体
- `pvc` — 持久卷声明,数据盘
- `storageclass` — 存储类,决定数据库存储性能
- `helm` — Kubernetes包管理器
- `secret` — 存放数据库用户与对象存储凭据
- `prometheus` — 抓取 Patroni 与 exporter 指标

### 参考链接

- [Zalando postgres-operator 文档](https://postgres-operator.readthedocs.io/en/latest/)
- [快速开始与安装](https://postgres-operator.readthedocs.io/en/latest/quickstart/)
- [集群清单字段参考](https://postgres-operator.readthedocs.io/en/latest/reference/cluster_manifest/)
- [Operator 参数(备份/PVC/升级策略)](https://postgres-operator.readthedocs.io/en/latest/reference/operator_parameters/)
- [管理员指南(CRD 与大版本升级)](https://postgres-operator.readthedocs.io/en/latest/administrator/)
- [Crunchy Data PGO(同名项目)](https://access.crunchydata.com/documentation/postgres-operator/latest/)
