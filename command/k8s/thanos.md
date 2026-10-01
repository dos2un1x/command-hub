thanos
===

为Prometheus提供长期存储与全局查询能力的高可用方案

## 补充说明

**Thanos** 是一组构建在 Prometheus 之上的组件集合,解决 Prometheus 自身的三个硬伤:

```shell
本地存储有限        Thanos 把 TSDB 块上传到对象存储,理论上无限容量
单实例无法横向扩展   多个 Prometheus 副本的数据可由 Thanos Query 统一查询
没有全局视图        跨集群、跨副本的指标可以在一个入口查询
```

它**不替换 Prometheus**,而是让 Prometheus 继续做抓取与规则评估,Thanos 负责存储、聚合与查询。组件构成:

```shell
sidecar      与 Prometheus 同 Pod 部署,上传 TSDB 块、代理 StoreAPI
receive      Prometheus 通过 remote_write 直接写入,无需本地 TSDB
query        聚合各 StoreAPI,提供 PromQL 查询与去重
query-frontend  查询拆分、下推与结果缓存
store gateway   从对象存储读取历史块,提供 StoreAPI
compactor    压缩、降采样、执行保留期删除
ruler        基于 Thanos Query 的全局视图评估规则
bucket web   对象存储桶的浏览界面
```

### Sidecar 模式与 Receiver 模式的取舍

这是选型时最关键的一个决定,两者是**互斥的存储路径**:

```shell
Sidecar    Prometheus 抓取 → 本地 TSDB(2h 块)→ sidecar 上传对象存储
           优点:改动小,Prometheus 仍可独立工作;缺点:依赖本地磁盘,上传有延迟
Receiver   Prometheus 抓取 → remote_write → Thanos Receive → 对象存储
           优点:Prometheus 完全无状态,可随时重建;缺点:引入远程写链路,需自行保证接收端高可用
```

**Sidecar 模式的数据流**:Prometheus 每 2 小时切出一个块,sidecar 检测到新块后上传到对象存储,同时自己保留最近块以提供「近实时」查询。**Receiver 模式**则让 Prometheus 配置 `remoteWrite` 指向 Thanos Receive,Receive 用哈希环把数据分片并复制(通常 3 副本)后再写入对象存储。

选择建议:**已有稳定的 Prometheus 且能接受本地磁盘**,用 Sidecar;**Prometheus 实例频繁迁移、需要彻底无状态**,用 Receiver。

### 安装

```shell
# 社区维护的 Chart(与 prometheus-community 不是同一个仓库)
helm repo add thanos-community https://thanos-community.github.io/helm-charts
helm repo update

# 安装全部组件,对象存储配置引用已有 Secret
helm install thanos thanos-community/thanos \
  -n monitoring --create-namespace \
  --set global.objstore.secretName=thanos-objstore-config \
  --set global.objstore.createSecret=false

# 查看默认值,确认 Secret 期望的键名
helm show values thanos-community/thanos > thanos-values.yaml
```

**注意 Bitnami 的 thanos Chart 已不再公开维护**。2025 年 8 月起 Bitnami 停止提供免费的加固镜像,该 Chart 的公开更新也随之中止,继续使用会遇到镜像拉取失败与版本停滞。新部署应选择社区 Chart 或直接使用 Prometheus Operator 的 `ThanosRuler` CRD。

对象存储配置以 Secret 形式提供,**键名必须与 Chart 期望的一致**(用 `helm show values` 查看 `global.objstore` 段确认,社区 Chart 通常用 `objstore.yml`;prometheus-operator 侧则习惯用 `thanos.yaml`):

```shell
kubectl create secret generic thanos-objstore-config -n monitoring \
  --from-file=objstore.yml=/dev/stdin <<'EOF'
type: S3
config:
  bucket: thanos-metrics
  endpoint: s3.amazonaws.com
  region: us-east-1
  access_key: AKIAxxxxxxxx
  secret_key: xxxxxxxx
  insecure: false
EOF
```

### 与 kube-prometheus-stack 集成(Sidecar 模式)

这是生产中最常见的组合。打开 Prometheus 的 thanos 字段后,Operator 会自动注入 sidecar 容器:

```shell
prometheus:
  thanosService:
    enabled: true              # 暴露 sidecar 的 gRPC 端口供 Query 连接
  thanosServiceMonitor:
    enabled: true
  prometheusSpec:
    replicas: 2
    externalLabels:
      cluster: prod            # 必须:多集群场景下用于区分数据来源
    thanos:
      image: quay.io/thanos/thanos
      version: v0.39.0
      objectStorageConfig:
        existingSecret:
          name: thanos-objstore-config
          key: thanos.yaml
      resources:
        requests: { cpu: 100m, memory: 256Mi }
        limits:   { memory: 1Gi }
    # 抓取与上传的时间要对齐,块边界越整齐,上传越及时
    retention: 2d
    storageSpec:
      volumeClaimTemplate:
        spec:
          resources:
            requests:
              storage: 50Gi
```

启用 sidecar 后,Prometheus 需要把块切分周期固定为 2 小时。配置了 `spec.thanos` 时 Operator 会自动加上相应参数;**自行部署 Prometheus 时必须手工加上**:

```shell
--storage.tsdb.min-block-duration=2h
--storage.tsdb.max-block-duration=2h
```

否则块永远不会被切出,sidecar 也就永远没有东西可上传 —— 表现为本地磁盘被写满而对象存储里空空如也。

### 查询与去重

Thanos Query 通过 StoreAPI(gRPC)聚合各个数据源。Kubernetes 中靠 headless Service 的 SRV 记录发现:

```shell
--http-address=0.0.0.0:10902
--grpc-address=0.0.0.0:10901
--store=dnssrv+_grpc._tcp.thanos-storegateway.monitoring.svc.cluster.local
--store=dnssrv+_grpc._tcp.thanos-receive.monitoring.svc.cluster.local
--store=dnssrv+_grpc._tcp.prometheus-operated.monitoring.svc.cluster.local
--query.replica-label=prometheus_replica        # 去重关键
--query.replica-label=replica
--query.timeout=2m
--query.max-concurrent=20
```

**去重是 Query 的核心能力**。当 Prometheus 以 2 副本运行(或用 Receiver 3 副本)时,同一份数据存在多份,只有告诉 Query「哪个标签标识副本」,它才会把重复序列合并:

```shell
--query.replica-label=prometheus_replica   # prometheus-operator 自动打的副本标签
```

再看降采样数据的查询效果:

```shell
# 直接查 Query 的 PromQL 接口
kubectl port-forward -n monitoring svc/thanos-query 10902:9090
curl -s 'localhost:10902/api/v1/query?query=up' | python3 -m json.tool | head -30

# 查看已连接的数据源
curl -s localhost:10902/api/v1/stores | python3 -m json.tool

# 查看 Query 自身的指标
curl -s localhost:10902/metrics | grep -E "thanos_query_stores|thanos_query_gate"

# 查看对象存储中的块
kubectl port-forward -n monitoring svc/thanos-bucketweb 8080:8080
```

### Compactor 与保留策略

**所有保留期删除与降采样都由 compactor 完成**,它从对象存储读取块,合并小块、生成 5 分钟与 1 小时分辨率的降采样副本、并按保留策略删除过期数据:

```shell
--http-address=0.0.0.0:10902
--data-dir=/var/thanos/compactor
--objstore.config-file=/etc/thanos/objstore.yaml
--retention.resolution-raw=30d        # 原始分辨率保留 30 天
--retention.resolution-5m=90d         # 5 分钟降采样保留 90 天
--retention.resolution-1h=365d        # 1 小时降采样保留 1 年
--wait                                # 上传完成后再删除,防止下采样丢数据
--delete-delay=48h                    # 延迟删除,留出纠错窗口
--compact.concurrency=1
--downsample.concurrency=1
```

### 规则的全局评估(ThanosRuler)

Prometheus 的告警规则只能看到本实例的数据。需要跨集群、跨副本评估时,用 `ThanosRuler` CRD 把规则指向 Thanos Query:

```shell
apiVersion: monitoring.coreos.com/v1
kind: ThanosRuler
metadata:
  name: thanos-ruler
  namespace: monitoring
spec:
  replicas: 2
  ruleSelector:
    matchLabels:
      role: thanos-rules
  ruleNamespaceSelector: {}
  queryEndpoints:
    - dnssrv+_http._tcp.thanos-query.monitoring.svc.cluster.local
  alertmanagers:
    - dnssrv+_web._tcp.alertmanager-operated.monitoring.svc.cluster.local
  objectStorageConfig:
    existingSecret:
      name: thanos-objstore-config
      key: thanos.yaml
```

### 排障

```shell
# 各组件状态
kubectl get po -n monitoring | grep thanos
kubectl get sts -n monitoring | grep thanos

# sidecar 是否在上传
kubectl logs -n monitoring prometheus-prometheus-kube-prometheus-prometheus-0 -c thanos-sidecar --tail=100
kubectl exec -n monitoring prometheus-prometheus-kube-prometheus-prometheus-0 -c thanos-sidecar -- \
  wget -qO- localhost:10902/metrics | grep -E "thanos_sidecar_uploaded_blocks|thanos_objstore_bucket_operations_total"

# Query 连上了哪些数据源、每个源的时间范围
curl -s localhost:10902/api/v1/stores | python3 -m json.tool

# Store Gateway 是否覆盖了历史数据
kubectl logs -n monitoring sts/thanos-storegateway --tail=100
curl -s localhost:10902/api/v1/blocks | head -c 1500

# Compactor 的删除与降采样进度
kubectl logs -n monitoring sts/thanos-compactor | grep -iE "delete|downsample|compact"
```

### 注意

1. **Compactor 全局只能有一个实例**。同一份对象存储上的多个 compactor 会同时改写块、互相覆盖,造成**不可逆的数据损坏**。Chart 里必须保证 `compactor.replicas: 1`,并且用 `--wait` 让它在上传完成后再删除源块。这是 Thanos 最严重的坑,没有之一。
2. **Sidecar 依赖 2 小时的块切分周期**。Prometheus 默认只在 WAL 达到一定大小时切块,不设置 `--storage.tsdb.min-block-duration=2h` 与 `--storage.tsdb.max-block-duration=2h`,sidecar 可能几小时都上传不了一次,本地磁盘先被写满。Operator 会自动处理,自建 Prometheus 必须手加。
3. **不加 `--query.replica-label` 会看到重复数据**。Prometheus 双副本、Receiver 多副本都会产生内容相同但副本标签不同的序列。Query 侧不配置去重标签时,Grafana 图表上会出现两条重叠曲线,`sum()` 出来的数字直接翻倍。
4. **`externalLabels` 必须设置且必须唯一**。Sidecar 依赖 Prometheus 的 `external_labels` 来区分不同集群/实例,不设置时多个集群的数据会混在一起无法区分,Compactor 侧也可能把不同来源的同名序列合并。
5. **`--store=dnssrv+...` 需要 headless Service**。SRV 记录要求 Service 的 `clusterIP: None`。用普通 ClusterIP Service 时 DNS 查询不会返回 SRV 记录,Query 表现为「一个数据源都连不上」但日志里没有明显错误。
6. **Store Gateway 需要本地磁盘做索引缓存**。它会下载块的索引到本地,不给持久化卷时每次重启都要重新拉取,大集群下要几十分钟才能提供服务。生产应配置 PVC 并给足索引缓存空间(建议用 memcached)。
7. **Store Gateway 应设置 `--min-time` 与 `--max-time`**。让它只负责历史块,不去扫最近的数据,否则会和 sidecar 的职责重叠,既浪费内存又拖慢查询。
8. **Sidecar 不会删除对象存储里的数据**。Prometheus 的 `retention` 只影响本地 TSDB,对象存储上的块只能由 compactor 按保留策略删除。只配 Prometheus 保留期而不管 compactor,存储会无限增长。
9. **降采样由 compactor 生成,不运行 compactor 就只有原始分辨率**。查询大时间范围时会扫描海量原始样本,Query 内存暴涨甚至 OOM。5 分钟与 1 小时降采样是长时间范围查询的前提。
10. **对象存储的生命周期策略会与 Thanos 冲突**。在桶上配置了「30 天后自动删除」之类的规则,可能删掉 compactor 还没处理完的块,导致数据永久丢失或元数据不一致。Thanos 的保留策略应当只由 compactor 执行。
11. **查询大范围时 Query 会吃很多内存**。`--query.max-concurrent` 与 `--query.timeout` 决定了并发查询数与单查询上限,配合 `query-frontend` 做查询拆分与结果缓存能显著降低内存压力。
12. **`--delete-delay` 与对象存储的一致性**。删除标记需要一段时间才能被所有组件看到,设置过短会让 store gateway 在删除过程中读到半删除状态的数据,表现为查询报错或结果残缺。
13. **集群时间必须同步**。Thanos 的块元数据、删除标记、降采样都依赖时间戳,节点间时钟偏移会导致块重叠判断错误。确保所有节点运行 NTP/chrony。
14. **`objstore` 配置的键名要匹配**。社区 Chart 用 `global.objstore.secretName` 引用 Secret 并要求 `global.objstore.createSecret=false`,而 prometheus-operator 用 `objectStorageConfig.existingSecret.name/key`。两处期望的键名(常见为 `objstore.yml` 与 `thanos.yaml`)不一致时,容器会以 `no such file` 启动失败;所有组件都会挂载同一个 Secret,错误会在每个组件上重复出现。
15. **ThanosRuler 不是 Prometheus 的替代品**。它只做规则评估,不做抓取。如果把抓取也交给它,规则会因为查不到数据而全部变成 `NoData`。

### 相关命令

- `prometheus` — Kubernetes集群监控系统与时间序列数据库
- `victoriametrics` — 高性能时间序列数据库与监控方案
- `alertmanager` — Prometheus 告警路由与去重组件
- `grafana` — 指标可视化与大盘平台
- `helm` — Kubernetes包管理器

### 参考链接

- [Thanos 官方文档](https://thanos.io/tip/thanos/getting-started.md/)
- [Thanos Sidecar 说明](https://thanos.io/tip/components/sidecar.md/)
- [Thanos Receive 说明](https://thanos.io/tip/components/receive.md/)
- [Thanos Compactor 与降采样](https://thanos.io/tip/components/compactor.md/)
- [thanos-community/helm-charts](https://github.com/thanos-community/helm-charts)
