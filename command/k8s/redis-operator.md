redis-operator
===

在Kubernetes上以Operator方式运行管理Redis集群

## 补充说明

**redis-operator** 同样有多个同名项目,本文写的是 **OpsTree(OT-CONTAINER-KIT)的 redis-operator**,CRD 组为 `redis.redis.opstreelabs.in`,并且是少数**同时覆盖 Cluster、主从、Sentinel、单机**四种形态的 Operator。

另一个常被搜到的同名项目 **spotahome/redis-operator**(CRD 为 `RedisFailover`,`databases.spotahome.com/v1`)**已于 2026-06-11 归档只读**,最后一个稳定版停在 2022-12-28,而且**只支持 Sentinel 模式,完全不支持 Redis Cluster**。两者不要混用,`kubectl get redisfailover` 和 `kubectl get rediscluster` 是两套东西。

四种部署形态对应四个 CRD,按需要选一个即可:

| 形态 | kind | 说明 |
| --- | --- | --- |
| Cluster | `RedisCluster` | 分片集群,16384 个槽位由 Operator 分配 |
| 主从 | `RedisReplication` | 1 主 N 从,可内嵌 sentinel |
| 哨兵 | `RedisSentinel` | 独立的 Sentinel 集群 |
| 单机 | `Redis` | 单体实例,适合开发测试 |

Operator 的职责是把这些 CR 调谐成 StatefulSet、Service、ConfigMap 与 Secret,并持续做**故障转移**:Cluster 模式下重建失效节点并重新分配槽位,主从模式下提升新的 master。

### 安装

```shell
helm repo add ot-helm https://ot-container-kit.github.io/helm-charts
helm repo update

helm install redis-operator ot-helm/redis-operator \
  --namespace redis-operator --create-namespace

kubectl get pods -n redis-operator
kubectl get crd | grep opstreelabs
```

### CRD 家族

```shell
redis.redis.opstreelabs.in/v1beta2
  RedisCluster       分片集群
  RedisReplication   主从复制
  RedisSentinel      哨兵
  Redis              单机
```

### 部署 Cluster

```shell
apiVersion: redis.redis.opstreelabs.in/v1beta2
kind: RedisCluster
metadata:
  name: redis-cluster
spec:
  clusterSize: 3                    # leader + follower 的默认副本数
  clusterVersion: v7                # v6 | v7 | v8,必须与镜像大版本一致
  port: 6379
  persistenceEnabled: true
  redisLeader:
    replicas: 3                     # 3 个 master,各自负责一段槽位
  redisFollower:
    replicas: 3                     # 每个 master 一个 replica
  kubernetesConfig:
    image: quay.io/opstree/redis:v7.0.15
    imagePullPolicy: IfNotPresent
    resources:
      requests:
        cpu: 200m
        memory: 512Mi
      limits:
        memory: 1Gi
  storage:
    nodeConfVolumeClaimTemplate:
      spec:
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 20Gi
  redisExporter:
    enabled: true                   # 每个 Pod 带一个 redis_exporter
```

```shell
kubectl apply -f redis-cluster.yaml -n redis
kubectl get rediscluster -n redis
kubectl get pods -n redis

# 集群状态与就绪的副本数
kubectl get rediscluster redis-cluster -n redis -o jsonpath='{.status.state}'
kubectl get rediscluster redis-cluster -n redis -o jsonpath='{.status.readyLeaderReplicas}'

# 进 Pod 里看槽位分配情况
kubectl exec -n redis redis-cluster-leader-0 -- redis-cli cluster nodes
kubectl exec -n redis redis-cluster-leader-0 -- redis-cli cluster info
```

`status.state` 会经历 `Initializing` → `Bootstrap` → `Ready`,`Failed` 表示 Operator 反复调和失败。

### 部署主从与哨兵

```shell
apiVersion: redis.redis.opstreelabs.in/v1beta2
kind: RedisReplication
metadata:
  name: redis-replication
spec:
  clusterSize: 3                    # 1 主 + 2 从
  clusterVersion: v7
  kubernetesConfig:
    image: quay.io/opstree/redis:v7.0.15
---
apiVersion: redis.redis.opstreelabs.in/v1beta2
kind: RedisSentinel
metadata:
  name: redis-sentinel
spec:
  clusterSize: 3                    # 字段名是 clusterSize,不是 size
  kubernetesConfig:
    image: quay.io/opstree/redis-sentinel:v7.0.15
```

```shell
# 当前的主节点是谁
kubectl get redisreplication redis-replication -n redis -o jsonpath='{.status.masterNode}'

# 连接信息(host / port / masterName)
kubectl get redisreplication redis-replication -n redis -o jsonpath='{.status.connectionInfo}'
```

### 扩缩容

```shell
# Cluster:分别调整 leader 与 follower
kubectl patch rediscluster redis-cluster -n redis --type merge \
  -p '{"spec":{"redisLeader":{"replicas":6},"redisFollower":{"replicas":6}}}'

# 主从:clusterSize 就是总节点数
kubectl patch redisreplication redis-replication -n redis --type merge \
  -p '{"spec":{"clusterSize":5}}'
```

Cluster 模式下,扩出来的新 master **不会自动分到槽位**,需要把现有槽位迁一部分过去;反之缩容前要先迁走槽位,否则那段槽位会整体不可用。这不是 Operator 能替你决定的事,官方提供的是重建节点与故障恢复的自动化,槽位再平衡仍需 `redis-cli --cluster reshard` 或 `reshard` 子命令人工介入。

### 存储与持久化

```shell
# 关闭持久化就是纯内存,Pod 重建数据全丢,仅测试环境可接受
spec:
  persistenceEnabled: true
  storage:
    nodeConfVolumeClaimTemplate:      # 节点配置文件的 PVC 模板
      spec:
        storageClassName: fast
        accessModes: ["ReadWriteOnce"]
        resources:
          requests:
            storage: 20Gi
```

RDB/AOF 的具体参数写在 `spec.redisConfig.dynamicConfig[]` 里,透传给 `CONFIG SET`。

### 升级

```shell
# Operator 自身
helm repo update ot-helm
helm upgrade redis-operator ot-helm/redis-operator -n redis-operator

# Redis 版本:clusterVersion 与镜像 tag 必须一起改,且大版本要对得上
kubectl patch rediscluster redis-cluster -n redis --type merge \
  -p '{"spec":{"clusterVersion":"v8","kubernetesConfig":{"image":"quay.io/opstree/redis:v8.0.2"}}}'

kubectl get pods -n redis -w
```

`clusterVersion` 取值为 `v6`/`v7`/`v8`,它不只是个标签:v7 及以上会启用 hostname 形式的集群公告与 `CLUSTER ADDSLOTSRANGE` 命令,填错会直接导致集群组建失败。

### 监控

```shell
spec:
  redisExporter:
    enabled: true
    image: quay.io/opstree/redis-exporter:latest
```

启用后每个 Redis Pod 内会多一个 exporter 容器,暴露标准的 Redis 指标(`redis_up`、`redis_connected_clients`、`redis_memory_used_bytes`、`redis_cluster_state` 等),直接给 Prometheus 抓取即可。Cluster 模式下重点看 `redis_cluster_state` 与各分片的槽位覆盖情况。

### 注意

1. **同名项目别混用**。本文的 CRD 是 `redis.redis.opstreelabs.in/v1beta2`;已归档的 spotahome 项目用的是 `RedisFailover`(`databases.spotahome.com/v1`),只支持 Sentinel,没有 Cluster。按老文档装的 `redisfailover` 在这里不存在。
2. **槽位数不可配置**。Redis Cluster 的 16384 个槽是 Redis 自身的固定设计,Operator 只负责把它们分配到各个 master(`CLUSTER ADDSLOTS` / `CLUSTER ADDSLOTSRANGE`),没有任何 spec 字段能改这个数字。
3. **扩容出来的 master 默认没有槽位**。加了 `redisLeader.replicas` 之后新节点会加入集群成为 master,但槽位仍集中在老节点上,需要手工 reshard;缩容则必须先把待删节点的槽位迁走。
4. **`clusterVersion` 必须与镜像大版本一致**。镜像给 v7 而 `clusterVersion: v6` 会导致集群公告方式不匹配,节点间握手失败。
5. **Cluster 至少 3 个 master**。少于 3 个 master 无法构成有意义的多数派,任一 master 故障就会丢失槽位覆盖,集群整体不可用;实践中至少 3 主 3 从。
6. **Sentinel 数量要奇数**。Sentinel 靠多数派选举新 master,2 个 Sentinel 在故障时无法达成一致;`RedisSentinel` 的默认值是 3,不要随手改小。
7. **`podManagementPolicy` 创建后不可变**。它是 StatefulSet 的字段,想从 `OrderedReady` 改成 `Parallel` 必须让 Operator 重建 StatefulSet(加注解 `redis.opstreelabs.in/recreate-statefulset`),直接改 spec 会被静默忽略。
8. **缩容不会删除 PVC**。PVC 由 StatefulSet 的 volumeClaimTemplates 生成,Kubernetes 不会随缩容回收,磁盘一直计费;确认数据无用后手工删。
9. **没有内置的对象存储备份与 PITR**。CRD 里没有任何 S3/快照相关字段,长期备份要自己接 RDB 落盘 + 外部上传工具,或使用独立的备份方案 —— 不要指望 `kubectl get redisbackup` 这类对象存在。
10. **Operator 升级不会升级 CRD**。Helm 的 crds 只在首次安装生效,跨版本升级前先手动 `kubectl apply` 仓库里对应版本的 CRD,否则新字段会被 API Server 截断。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `statefulset` — Redis Pod 的实际载体
- `pvc` — 持久卷声明,持久化数据盘
- `storageclass` — 存储类,决定持久化性能
- `helm` — Kubernetes包管理器
- `prometheus` — 抓取 redis_exporter 指标

### 参考链接

- [redis-operator 官方文档](https://redis-operator.opstree.dev/docs/)
- [安装说明](https://redis-operator.opstree.dev/docs/installation/)
- [RedisCluster 配置](https://redis-operator.opstree.dev/docs/configuration/rediscluster/)
- [Helm Charts 仓库](https://github.com/OT-CONTAINER-KIT/helm-charts)
- [已归档的 spotahome/redis-operator(仅 Sentinel)](https://github.com/spotahome/redis-operator)
