loki
===

受Prometheus启发的水平可扩展日志聚合系统

## 补充说明

**Loki** 是 Grafana Labs 开发的日志聚合系统,设计理念是「**只索引标签,不索引内容**」——这一点与 Elasticsearch 截然相反。它把日志正文压缩后作为块(Chunk)存进对象存储,只对标签(Label)建立索引,因此存储成本与运维复杂度远低于全文索引方案。

代价是查询必须**先按标签缩小范围**,再对正文做过滤。这意味着:

- 标签选择器写得好,查询快且便宜;写得差(或不做标签规划),查询会扫描海量数据
- 日志正文里的字段在写入时不可检索,只能在查询时用 `|=`、`|~`、`| json` 等管道过滤器现场解析

在 Kubernetes 中的部署形态由 `deploymentMode` 决定,三种模式的能力与代价差距很大:

```shell
Monolithic       单进程全功能,适合每天几十 GB 以内。默认值
SimpleScalable   read / write / backend 三组,已废弃,Loki 4 中移除
Distributed      微服务拆分,每个组件独立伸缩,超过约 1TB/天时使用
```

**SimpleScalable 与 Distributed 都强制要求对象存储**(S3、GCS、Azure Blob、MinIO 等);只有 Monolithic 可以用文件系统。

组件构成(Distributed 模式):

```shell
distributor       接收写入,校验、限流、哈希后转发
ingester          在内存/本地盘聚合日志块,定期刷入对象存储
querier           执行 LogQL 查询
query-frontend    查询排队、拆分、结果缓存
query-scheduler   查询调度(多 querier 时避免争抢)
compactor         合并索引、执行保留期删除
index-gateway     提供索引查询(可选)
ruler             日志告警规则
gateway           nginx 反向代理,统一入口(Chart 的一部分)
```

数据流:`客户端(Alloy/Promtail/fluent-bit) → gateway → distributor → ingester → 对象存储 → querier → Grafana`

### 安装

```shell
# Chart 仓库(2026 年 1 月起 Loki Chart 由社区维护)
helm repo add grafana-community https://grafana-community.github.io/helm-charts
helm repo update

# 官方仓库(历史版本仍在,长期看应迁移)
helm repo add grafana https://grafana.github.io/helm-charts

# 最小可用:Monolithic + 文件系统 + 内置 MinIO
helm install loki grafana-community/loki \
  -n monitoring --create-namespace \
  --set deploymentMode=Monolithic \
  --set loki.useTestSchema=true \
  --set singleBinary.persistence.enabled=true \
  --set singleBinary.persistence.size=50Gi \
  --set minio.enabled=true

# 生产:Distributed + S3
helm install loki grafana-community/loki \
  -n monitoring --create-namespace \
  --set deploymentMode=Distributed \
  --set loki.storage.type=s3 \
  --set loki.storage.bucketNames.chunks=loki-chunks \
  --set loki.storage.bucketNames.ruler=loki-ruler \
  --set loki.storage.s3.endpoint=s3.amazonaws.com \
  --set loki.storage.s3.region=us-east-1

# 查看组件与入口
kubectl get po,svc -n monitoring -l app.kubernetes.io/name=loki
kubectl get svc -n monitoring loki-gateway
```

### 存储与 Schema 配置

Loki 3.x 推荐使用 TSDB 作为索引、对象存储作为块存储。Schema 是**按时间段累加**的,不能修改已生效的时段:

```shell
loki:
  auth_enabled: true
  commonConfig:
    replication_factor: 3
    path_prefix: /var/loki
  storage:
    type: s3
    bucketNames:
      chunks: loki-chunks
      ruler: loki-ruler
      admin: loki-admin
    s3:
      endpoint: s3.amazonaws.com
      region: us-east-1
      s3ForcePathStyle: false
  schemaConfig:
    configs:
      - from: "2024-04-01"
        store: tsdb
        object_store: s3
        schema: v13
        index:
          prefix: loki_index_
          period: 24h
  limits_config:
    retention_period: 30d
    ingestion_rate_mb: 16
    ingestion_burst_size_mb: 32
    max_query_series: 5000
    max_query_parallelism: 32
    max_streams_per_user: 10000
    reject_old_samples: true
    reject_old_samples_max_age: 168h
  compactor:
    retention_enabled: true
    delete_request_store: s3
    compaction_interval: 10m
```

对象存储的密钥**不要明文写进 values**(会进入 Helm release Secret)。Loki Chart 没有 S3 专用的 `existingSecret` 字段,标准做法是环境变量占位 + `-config.expand-env=true`:

```shell
kubectl create secret generic loki-s3 -n monitoring \
  --from-literal=accessKeyId=xxx --from-literal=secretAccessKey=yyy

# values 中:用占位符引用,并给每个组件打开变量展开
loki:
  storage:
    s3:
      accessKeyId: "${LOKI_S3_ACCESS_KEY_ID}"
      secretAccessKey: "${LOKI_S3_SECRET_ACCESS_KEY}"
backend:
  extraArgs: ["-config.expand-env=true"]
  extraEnvFrom: [{ secretRef: { name: loki-s3 } }]
```

### 缓存与性能

Distributed / SimpleScalable 模式下,`chunksCache` 与 `resultsCache` 是性能关键,Chart 默认用 memcached 部署:

```shell
chunksCache:
  enabled: true
  allocatedMemory: 2048
  maxItemMemory: 5            # 单个缓存项上限(MB),按最大日志块调整
  writebackParallelism: 1

resultsCache:
  enabled: true
  allocatedMemory: 1024
  maxItemMemory: 5
```

查询相关的可调项:

```shell
query_range:
  align_queries_with_step: true
  cache_results: true
  results_cache:
    cache:
      embedded_cache:
        enabled: true
        max_size_mb: 500

querier:
  max_concurrent: 8
  multi_tenant_queries_enabled: true
```

### 客户端接入

Loki 的写入端点(经 gateway):

```shell
http://loki-gateway.monitoring.svc/loki/api/v1/push      # 写入
http://loki-gateway.monitoring.svc/loki/api/v1/query_range  # 范围查询
http://loki-gateway.monitoring.svc/loki/api/v1/labels       # 标签列表
http://loki-gateway.monitoring.svc/ready                    # 就绪探针
```

直接推送一条日志用于验证:

```shell
kubectl run loki-test --rm -it --restart=Never --image=curlimages/curl -- \
  curl -H "Content-Type: application/json" \
  -H "X-Scope-OrgID: fake" \
  -X POST http://loki-gateway.monitoring.svc/loki/api/v1/push \
  -d '{"streams":[{"stream":{"job":"test","namespace":"default"},"values":[["'"$(date +%s)000000000"'","hello loki"]]}]}'
```

### LogQL 速查

```shell
# 基础选择器
{namespace="default", app="nginx"}

# 正文包含(大小写敏感),再排除
{app="nginx"} |= "error" != "favicon"

# 正则匹配
{app="nginx"} |~ "(?i)timeout|refused"

# 解析 JSON 并过滤字段
{app="my-app"} | json | level="error" | duration > 1000

# 解析日志行格式
{app="nginx"} | pattern `<_> - - [<_>] "<method> <uri> <_>" <status> <size>`

# 统计每分钟错误数
sum by (app) (count_over_time({namespace="default"} |= "ERROR" [1m]))

# 日志速率 / 找出日志量最大的 Pod
sum by (namespace) (rate({namespace=~".+"}[5m]))
topk(10, sum by (pod) (rate({namespace="default"}[5m])))

# 按 JSON 字段聚合
sum by (level) (count_over_time({app="my-app"} | json [5m]))
```

### 排障

```shell
# 组件健康
kubectl get po -n monitoring -l app.kubernetes.io/name=loki
kubectl logs -n monitoring sts/loki-backend --tail=100
kubectl logs -n monitoring deploy/loki-gateway --tail=50

# ready 端点(会检查对象存储连通性)
kubectl port-forward -n monitoring svc/loki-gateway 3100:80
curl -s localhost:3100/ready

# 401 或 "no org id" —— auth_enabled 为 true 时必须带租户头
curl -s -H "X-Scope-OrgID: fake" localhost:3100/loki/api/v1/labels

# 查询被拒:查看限流原因
kubectl logs -n monitoring deploy/loki-distributor | grep -i "limit"
curl -s -H "X-Scope-OrgID: fake" localhost:3100/metrics | grep -i "discarded"

# 查看当前生效的配置与已刷出的块数量
curl -s -H "X-Scope-OrgID: fake" localhost:3100/loki/api/v1/status/config | head -50
curl -s -H "X-Scope-OrgID: fake" localhost:3100/metrics | grep loki_ingester_chunks_flushed_total
```

### 注意

1. **`loki-stack` Chart 已废弃**。官方仓库中的 `loki-stack` 页面明确写着「This chart is deprecated and will no longer receive updates or support」,并指向 `grafana-community/helm-charts` 下的 `loki` Chart。继续使用 `loki-stack` 无法升级 Loki 主版本。
2. **SimpleScalable 模式已废弃,Loki 4 中移除**。新部署不要选它,要么 `Monolithic`(小规模),要么 `Distributed`。
3. **SimpleScalable 与 Distributed 必须使用对象存储**。用 `filesystem` 存储时这两类模式无法正常工作,因为 ingester、querier、compactor 分布在多个 Pod/节点上,本地盘不共享。本地开发才用 `Monolithic` + `filesystem`。
4. **`auth_enabled: true` 是默认值**,所有 API 请求必须携带 `X-Scope-OrgID` 头,否则返回 401 `no org id`。用 curl 手工调试时最容易卡在这里。单租户环境可以设为 `false` 省去这个头。
5. **标签基数决定一切**。Loki 只索引标签,把 `pod_name`、`request_id`、`trace_id`、`user_id` 这类高基数取值做成标签会导致索引爆炸、写入被拒(`max_streams_per_user`)。标签应当控制在「namespace / app / container / level」这类有限取值的维度上。
6. **保留期需要同时打开两处开关**。只设 `limits_config.retention_period` 不会真的删除数据,还必须设置 `compactor.retention_enabled: true`,并且在 TSDB/boltdb-shipper 场景下补上 `compactor.delete_request_store`,否则 compactor 不知道去哪里写删除标记。
7. **Schema 是累加的,不能改历史**。同一时间段的 `store`、`schema` 版本一旦有数据写入就不能变更;要换索引类型只能新增一个 `from` 更晚的 schema 段落。
8. **`reject_old_samples` 默认会拒绝老日志**。默认拒绝超过一定年龄的样本,补传历史日志时会看到 `entry too far behind`;需要临时调大 `reject_old_samples_max_age` 或关闭该开关。
9. **`resultsCache` 不要在多个 Loki 集群间共用**。缓存键不包含集群标识,共用会导致跨集群返回错误结果。每个 Loki 集群应使用独立的 memcached 实例,或至少使用互不相同的 key 前缀。
10. **`chunksCache.maxItemMemory` 要大于最大日志块**。设置过小时大块日志无法缓存,表现为查询延迟居高不下且 `loki_cache_store_chunk` 错误数上升。
11. **ingester 的 `replication_factor` 不能超过 ingester 副本数**。Distributed 模式设 `replication_factor: 3` 而 ingester 只有 2 个副本时,写入会持续失败并报 `at least 2 live replicas required`。
12. **`max_query_series` 与 `max_query_length` 限制了单次查询规模**。大范围查询报 `the query time range exceeds the limit` 时,应按官方建议拆分时间窗口或用 recording rules 预聚合,而不是简单调大上限 —— 调大只会让 querier OOM。
13. **gateway 是唯一入口**。客户端应指向 `loki-gateway`(端口 80),而不是直接指向 distributor。跳过 gateway 会绕过限流与鉴权,并且一旦组件拓扑变化就要改所有客户端配置。
14. **`minio.enabled: true` 只适合验证**。Chart 内置的 MinIO 是单副本、无持久化保证的开发用途,生产必须换成真实对象存储或独立部署的高可用 MinIO。
15. **Monolithic 模式只有单副本可写**。`singleBinary.replicas` 大于 1 时各副本数据独立,不会组成集群;需要横向扩展必须切到 Distributed。

### 相关命令

- `promtail` — Loki 官方日志采集代理
- `fluent-bit` — 轻量级日志与指标采集器
- `grafana` — 指标可视化与大盘平台
- `prometheus` — Kubernetes集群监控系统与时间序列数据库
- `helm` — Kubernetes包管理器

### 参考链接

- [Loki 官方文档](https://grafana.com/docs/loki/latest/)
- [Loki 存储与 Schema 配置](https://grafana.com/docs/loki/latest/configure/storage/)
- [LogQL 查询语言](https://grafana.com/docs/loki/latest/query/)
- [Loki 保留期与 Compactor](https://grafana.com/docs/loki/latest/operations/storage/retention/)
- [grafana-community/helm-charts](https://github.com/grafana-community/helm-charts)
