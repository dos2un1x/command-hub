clickhouse-operator
===

在Kubernetes上以Operator方式运行管理ClickHouse集群

## 补充说明

**clickhouse-operator** 有两个同名项目,本文写的是社区使用最广、仍在活跃发版的 **Altinity Kubernetes Operator for ClickHouse**(CRD 组 `clickhouse.altinity.com`,集群对象的短名是 `chi`)。

另一个是 **ClickHouse 官方的 `ClickHouse/clickhouse-operator`**:CRD 组为 `clickhouse.com`(kind `ClickHouseCluster` / `KeeperCluster`),2025 年才开始发布、版本号还停在 `v0.0.x`,依赖 cert-manager 提供 webhook 证书,属于早期阶段。两者的 CRD 名称、字段结构完全不同,查文档时务必先看清是哪一个。

Altinity 这个 Operator 的核心是把「**分片(shard)+ 副本(replica)**」这套拓扑声明式化:

```shell
ClickHouseInstallation          集群本体,短名 chi
ClickHouseInstallationTemplate  可复用的 spec 模板片段
ClickHouseOperatorConfiguration Operator 自身配置
ClickHouseKeeperInstallation    ClickHouse Keeper,短名 chk
```

需要注意:**Operator 只负责建 Pod、Service、PVC 和生成 `remote_servers` / `zookeeper` 配置**,表结构不归它管。Replicated 表、Distributed 表都要你自己在客户端里用 `ON CLUSTER` 建。

### 安装

```shell
# Helm(推荐)
helm repo add altinity https://helm.altinity.com
helm repo update
helm upgrade --install clickhouse-operator altinity/altinity-clickhouse-operator \
  --version 0.27.3 --namespace clickhouse --create-namespace

# 或用安装脚本
curl -s https://raw.githubusercontent.com/Altinity/clickhouse-operator/master/deploy/operator-web-installer/clickhouse-operator-install.sh \
  | OPERATOR_NAMESPACE=clickhouse bash

# 或用 bundle 清单
kubectl apply -f https://raw.githubusercontent.com/Altinity/clickhouse-operator/release-0.27.3/deploy/operator/clickhouse-operator-install-bundle.yaml

kubectl get pods -n clickhouse
kubectl get crd | grep altinity
```

### 集群清单

2 分片 × 2 副本 = 4 个 ClickHouse 节点:

```shell
apiVersion: clickhouse.altinity.com/v1
kind: ClickHouseInstallation
metadata:
  name: cluster01
spec:
  templates:
    podTemplates:
      - name: clickhouse-pod
        spec:
          containers:
            - name: clickhouse
              image: altinity/clickhouse-server:25.8.16.10002.altinitystable
    volumeClaimTemplates:
      - name: data
        spec:
          storageClassName: fast
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: 500Gi
  defaults:
    templates:
      podTemplate: clickhouse-pod
      dataVolumeClaimTemplate: data
  configuration:
    zookeeper:
      nodes:
        - host: keeper-clickhouse-keeper.clickhouse.svc.cluster.local
          port: 2181
    clusters:
      - name: cluster01
        layout:
          shardsCount: 2
          replicasCount: 2
```

```shell
kubectl apply -f cluster01.yaml -n clickhouse

# 状态:In Progress → Completed
kubectl get chi -n clickhouse -o wide
kubectl get chi cluster01 -n clickhouse -o jsonpath='{.status}'

# Pod 名形如 chi-cluster01-cluster01-0-0-0(shard-replica 编号在名字里)
kubectl get pods -n clickhouse
```

### 分片与副本

`layout` 有两种写法:

```shell
# 紧凑写法:所有分片副本数一致
layout:
  shardsCount: 3
  replicasCount: 2

# 展开写法:逐个分片定义,可以给不同分片配不同的模板与副本数
layout:
  shards:
    - name: shard-a
      replicasCount: 2
    - name: shard-b
      replicasCount: 1
      weight: 2
      internalReplication: "true"
```

**`shardsCount × replicasCount` 等于最终的 host 总数**(2×2 就是 4 个 Pod、4 个 Service),不是「2 个分片总共 2 个副本」。

分片数不是越多越好,官方建议**数据量不到 5 TB 就不要分片** —— 分片意味着跨节点的分布式查询与数据搬迁,小集群加分片只会让查询更慢。

建表必须在客户端完成:

```shell
-- 单机表(每个分片各自一份)
CREATE TABLE analytics.page_views ON CLUSTER cluster01 (...)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/page_views', '{replica}')
ORDER BY ...;

-- 分布式表:统一查询入口
CREATE TABLE analytics.page_views_distributed ON CLUSTER cluster01
AS analytics.page_views
ENGINE = Distributed(cluster01, analytics, page_views, rand());
```

### Keeper

ClickHouse 的 Replicated 表依赖 Keeper(或 ZooKeeper)做元数据协调,`replicasCount > 1` 时必须有。Altinity Operator 用独立的 CRD 部署 Keeper,注意它属于**另一个 API 组**:

```shell
apiVersion: clickhouse-keeper.altinity.com/v1
kind: ClickHouseKeeperInstallation
metadata:
  name: clickhouse-keeper
spec:
  configuration:
    clusters:
      - name: keeper
        layout:
          replicasCount: 3
```

```shell
kubectl apply -f keeper.yaml -n clickhouse

# 关键:chi 里 zookeeper.nodes[].host 必须等于这里返回的 endpoint
kubectl get chk clickhouse-keeper -n clickhouse -o jsonpath='{.status.endpoint}'
```

### 存储与 PVC

```shell
# 每个 host 一套 PVC
kubectl get pvc -n clickhouse
kubectl get chi -n clickhouse -o jsonpath='{.status.pvc}'

# 临时停掉整个集群但保留数据:StatefulSet 缩到 0,PVC 不删
spec:
  stop: true
```

存储扩容需要 StorageClass 支持 `allowVolumeExpansion`,改 `volumeClaimTemplates` 里的 `resources.requests.storage` 后重新 `kubectl apply`。

### 备份与恢复

**Altinity Operator 没有备份 CRD**。不要去找 `ClickHouseBackup` 这类对象,它只是社区里提过的一个提案,并未实现。可用的两条路:

```shell
# 1) 原生 SQL(ClickHouse 22.7+ 内置,配置最简单)
BACKUP TABLE analytics.page_views TO Disk('backups', 'page_views.zip');
RESTORE TABLE analytics.page_views FROM Disk('backups', 'page_views.zip');

# 2) clickhouse-backup 工具(可备份 RBAC/配置,支持增量与对象存储)
clickhouse-backup create
clickhouse-backup upload
clickhouse-backup list
clickhouse-backup restore <backup-name>
```

原生 `BACKUP`/`RESTORE` 支持 Local / S3 / GCS / Azure,但**不覆盖 RBAC 与配置文件**;需要连用户权限一起备份时用 clickhouse-backup,它支持 Local、S3、GCS、Azure、FTP、SFTP、rsync 等目标。生产环境建议落到对象存储。

### 监控

两个端口要分清:

```shell
8888     ClickHouse 指标(metrics-exporter sidecar 抓 system 表)
9999     Operator 自身指标(端口名 op-metrics)
```

安装时 Operator 会给 Pod 打上抓取注解:

```shell
prometheus.io/scrape: "true"
prometheus.io/port: "8888"
clickhouse-operator-metrics/scrape: "true"
clickhouse-operator-metrics/port: "9999"
```

用 Prometheus Operator 时,0.27.3 起的 Helm Chart 直接提供了开关:

```shell
--set serviceMonitor.enabled=true
--set serviceMonitor.keeperMetrics.enabled=true
```

集群内还有名为 `clickhouse-operator-metrics` 的 Service 暴露 8888/TCP。

### 升级

```shell
# Operator
helm repo update altinity
helm upgrade clickhouse-operator altinity/altinity-clickhouse-operator -n clickhouse --version 0.27.3

# CRD 不会被 Helm 升级,需要单独 apply
kubectl apply -f https://raw.githubusercontent.com/Altinity/clickhouse-operator/release-0.27.3/deploy/operator/parts/crd.yaml

# ClickHouse 版本升级:改 podTemplate 里的镜像,apply 后 Operator 滚动重建
kubectl apply -f cluster01.yaml -n clickhouse
kubectl get pods -n clickhouse -w
```

### 注意

1. **绝对不要删除 CRD**。官方对此有明确警告:`kubectl delete crd clickhouseinstallations.clickhouse.altinity.com` 会导致 Kubernetes 连带删除集群里**所有** `chi` 与 `chk` 对象,相当于把整个 ClickHouse 集群的定义一次性抹掉。卸载 Operator 时要连带检查 CRD。
2. **`helm upgrade` 不升级 CRD**。Chart 里的 CRD 只走 pre-install hook,升级时若含新字段,不手动 `kubectl apply` 对应版本的 `crd.yaml`,新字段会被 API Server 静默丢弃,报错信息完全指不到根因。
3. **分片数与副本数容易算错**。`shardsCount: 2` + `replicasCount: 2` 是 4 个 host(4 份存储、4 个 Pod),不是 2 个。规划容量时按乘积算。
4. **没有 Keeper 时 `replicasCount > 1` 没有意义**。Replicated 引擎依赖 Keeper 协调,而且 `configuration.zookeeper.nodes[].host` 必须**等于** `chk` 对象的 `status.endpoint`,写错的话副本之间无法建立复制,建表会直接报错。
5. **表和 Distributed 表都要自己建**。Operator 不会替你执行 DDL,扩容分片后需要自己在新的分片上补建本地表,再补 Distributed 表。
6. **`clickhouse_operator` 的默认密码必须改**。Operator 用这个账号做指标采集、schema 维护、清 DNS 缓存,默认值 `clickhouse_operator` / `clickhouse_operator_password` 是公开的。
7. **没配 `volumeClaimTemplates` 就会丢数据**。默认存储不是持久卷,Pod 重建后数据全没;生产必须显式定义 PVC 模板。
8. **0.26.3 ~ 0.27.2 的镜像升级会中断查询**。这几个版本的 Operator 在做镜像滚动升级时**没有先把节点从负载均衡里摘除**,正在执行的查询会直接被切断;0.27.3 才修复为「先排空(drain)、再从 `remote_servers` 里降权、等 in-flight 查询结束」。停留在这些版本时要挑低峰期升级。
9. **`spec.stop: true` 是停集群不是删集群**。它把 StatefulSet 副本数缩到 0 但保留 PVC,适用于临时释放算力;恢复时改回 `false` 即可,数据仍在。
10. **小集群不要开分片**。官方给出的经验值是数据量 5 TB 以下不要用分片,单分片多副本已经足够,分片只会引入跨节点查询开销。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `statefulset` — ClickHouse host 的实际载体
- `pvc` — 持久卷声明,数据盘
- `storageclass` — 存储类,决定 ClickHouse 磁盘性能
- `helm` — Kubernetes包管理器
- `prometheus` — 抓取 8888 / 9999 指标

### 参考链接

- [Altinity Kubernetes Operator for ClickHouse 文档](https://docs.altinity.com/altinitykubernetesoperator/)
- [快速安装](https://docs.altinity.com/altinitykubernetesoperator/quickstartinstallation/)
- [集群配置字段参考](https://docs.altinity.com/altinitykubernetesoperator/kubernetesoperatorguide/clustersettings/)
- [Operator 升级](https://docs.altinity.com/altinitykubernetesoperator/upgrade/)
- [clickhouse-backup 备份工具](https://github.com/Altinity/clickhouse-backup)
- [ClickHouse 官方 Operator(同名项目,CRD 组为 clickhouse.com)](https://github.com/ClickHouse/clickhouse-operator)
