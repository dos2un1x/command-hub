jaeger
===

分布式链路追踪系统,CNCF毕业的端到端调用链观测平台

## 补充说明

**Jaeger** 是 Uber 开源、CNCF 毕业的分布式链路追踪系统。它把一次请求跨越多个服务的调用路径拼成一条完整的 Trace,用来回答「这个请求慢在哪一段」「哪个下游服务在报错」这类问题。

一条 Trace 由若干 **Span** 组成,每个 Span 记录一段操作的服务名、操作名、起止时间、标签与事件。Jaeger 的职责是:接收 Span、存储、按 TraceID 聚合查询、并以瀑布图展示。

在 Kubernetes 中的角色划分:

```shell
collector     接收上报的 Span,做校验与加工,写入存储
query         提供查询 API 与 Web UI
ingester      从 Kafka 消费并写存储(仅 streaming 策略使用)
all-in-one    collector + query + 内存存储,单进程,仅适合开发
```

**Jaeger v2 起,上述所有角色合并进同一个二进制**,靠 `--config` 指定的配置文件决定启用哪些组件。这也意味着 **Jaeger 自身的配置格式已经变成 OpenTelemetry Collector 的配置格式**(receivers / processors / exporters / service.pipelines),不再是 v1 那套 `--collector.*` 启动参数。老版本命令行参数与 `sampling.strategies-file` 之类的写法在新版本里不再适用。

同样在 v2 中被移除的还有 **jaeger-agent**。过去应用上报要先发给本机的 agent(6831/6832 UDP),再由 agent 批量转发给 collector;现在客户端应当直接用 **OTLP** 上报到 collector 的 4317(gRPC)或 4318(HTTP)端口。

数据流:`应用(OTLP SDK)→ Jaeger collector → 存储(ES/Cassandra/内存)→ query → UI`

### 安装

```shell
helm repo add jaegertracing https://jaegertracing.github.io/helm-charts
helm repo update

# 默认安装:以 Elasticsearch 作为存储后端
helm install jaeger jaegertracing/jaeger -n tracing --create-namespace

# 查看 Chart 默认值(不同大版本的 values 结构差异很大,务必以本版本为准)
helm show values jaegertracing/jaeger > jaeger-values.yaml

# 覆盖存储后端地址
helm install jaeger jaegertracing/jaeger -n tracing --create-namespace \
  --set storage.type=elasticsearch \
  --set storage.elasticsearch.url=http://elasticsearch-master.logging.svc:9200

# 开发环境:内存存储,重启即丢
helm install jaeger jaegertracing/jaeger -n tracing --create-namespace \
  --set storage.type=memory
```

当前 Chart 的 values 关键结构:

```shell
jaeger:
  enabled: true
  # Jaeger v2 的完整配置,直接写成 OpenTelemetry Collector 风格
  userconfig: {}
  # 传给 Jaeger 二进制的启动参数
  extraArgs: []
storage:
  type: elasticsearch            # cassandra / elasticsearch / memory
  elasticsearch:
    url: http://elasticsearch-master:9200
  cassandra:
    host: cassandra
    port: 9042
    keyspace: jaeger_v1_test
uiconfig: {}
global: {}
extraObjects: []
```

**旧版本 Chart(1.x)** 的 values 结构完全不同,使用 `provisionDataStore` / `allInOne` / `collector` / `query` / `agent` 等字段,并且可以 `--set provisionDataStore.cassandra=false` 来关闭内置的演示数据库。升级 Chart 大版本时这部分需要重写。

### 采样配置

采样是 Jaeger 最需要认真配置的部分。**默认 0.1% 的采样率**意味着绝大多数请求根本不会被记录,排查问题时往往发现「查不到那条 Trace」——这就是采样率的锅。

三种常见策略:

```shell
const           恒定采样,param 为 0 或 1。全采或全不采,只适合极低流量
probabilistic   按概率采样,param 取 0~1 之间的小数
ratelimiting    限速采样,每秒最多 param 条
```

Jaeger v1 通过 `--sampling.strategies-file` 下发按服务、按端点的策略:

```shell
{
  "service_strategies": [
    {
      "service": "my-critical-service",
      "type": "probabilistic",
      "param": 1.0
    },
    {
      "service": "high-traffic-service",
      "type": "ratelimiting",
      "param": 100
    }
  ],
  "default_strategy": {
    "type": "probabilistic",
    "param": 0.001
  }
}
```

客户端通过远端采样接口拉取策略(默认每 60 秒刷新一次):

```shell
http://jaeger-collector.tracing.svc:5778/sampling?service=my-service
```

Jaeger v2 基于 OTel 体系,采样在 Collector 侧用 processor 实现:

```shell
processors:
  # 头部采样:按概率决定是否保留整条 Trace
  probabilistic_sampler:
    sampling_percentage: 10        # 10%

  # 尾部采样:等 Trace 完整后再按条件决定,能保留错误与慢请求
  tail_sampling:
    decision_wait: 10s
    num_traces: 100000
    policies:
      - name: errors-policy
        type: status_code
        status_code: { status_codes: [ERROR] }
      - name: slow-policy
        type: latency
        latency: { threshold_ms: 500 }
      - name: baseline-policy
        type: probabilistic
        probabilistic: { sampling_percentage: 1 }

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [tail_sampling, batch]
      exporters: [otlp/jaeger]
```

### 服务端配置(v2)

```shell
--config=/jaeger/config.yaml      v2 必填,所有行为由该文件决定
--set=                            命令行覆盖配置项
```

对应的配置文件骨架:

```shell
service:
  extensions: [jaeger_storage, jaeger_query, healthcheckv2]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [jaeger_storage_exporter]

extensions:
  healthcheckv2:
    use_v2: true
    http:
      endpoint: 0.0.0.0:13133

  jaeger_query:
    storage:
      traces: some_storage

  jaeger_storage:
    backends:
      some_storage:
        memory:
          max_traces: 100000

receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

exporters:
  jaeger_storage_exporter:
    trace_storage: some_storage
```

### 端口一览

```shell
16686   Query Web UI
4317    OTLP gRPC 接收
4318    OTLP HTTP 接收
14250   Jaeger gRPC 接收(v1 遗留)
14268   Jaeger HTTP thrift 接收(v1 遗留)
5778    远端采样策略服务(v1)
8888    自身指标 HTTP
8889    自身指标 HTTP(另一组)
13133   健康检查 /status
27777   expvar 调试端点
```

验证:

```shell
kubectl get po,svc -n tracing
kubectl logs -n tracing deploy/jaeger --tail=100
kubectl port-forward -n tracing svc/jaeger-query 16686:16686
curl -s localhost:16686/api/services | python3 -m json.tool
curl -s "localhost:16686/api/traces?service=my-service&limit=20" | head -c 2000

# 健康检查
kubectl exec -n tracing deploy/jaeger -- wget -qO- localhost:13133/status

# 查看自身指标
kubectl exec -n tracing deploy/jaeger -- wget -qO- localhost:8888/metrics | grep -E "jaeger_collector_spans"
```

### 发送数据验证

用 OTLP HTTP 直接发一条 Trace,确认链路通:

```shell
kubectl run otlp-test --rm -it --restart=Never --image=curlimages/curl -- \
  curl -s -X POST http://jaeger-collector.tracing.svc:4318/v1/traces \
  -H 'Content-Type: application/json' \
  -d '{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"otlp-test"}}]},"scopeSpans":[{"spans":[{"traceId":"5B8EFFF798038103D269B633813FC60C","spanId":"EEE19B7EC3C1B174","name":"test-span","kind":1,"startTimeUnixNano":"1700000000000000000","endTimeUnixNano":"1700000001000000000"}]}]}]}'
```

### 注意

1. **默认采样率是 0.1%,绝大多数请求不会被记录**。Jaeger 客户端默认使用远端采样器,服务端 `default_strategy` 为 `probabilistic` / `param: 0.001`。这解释了「为什么 Trace 列表里几乎没有数据」。排查阶段应先把关键服务的采样率调到 1.0 或改用 `ratelimiting`,定位结束后再调回。
2. **v2 已移除 jaeger-agent**。老的 `6831/6832` UDP 上报方式在新版本中不再可用,客户端必须改用 OTLP(4317/4318)。看到 `connection refused` 到 6831 端口,先确认是不是用了过时的 SDK 配置。
3. **v2 的配置格式换成了 OTel Collector 风格**。网上大量教程仍在讲 `--collector.queue-size`、`--sampling.strategies-file` 这类 v1 启动参数,在新版本上完全不生效。升级前必须重写配置。
4. **`--config` 是 v2 的必填参数**。没有配置文件 Jaeger 无法启动,这与 v1 靠命令行参数即可运行的行为完全不同。用 Helm Chart 时要确认最终渲染出的 ConfigMap 被正确挂载。
5. **Elasticsearch 作为存储后端需要配套的索引管理**。Jaeger 会按天创建索引,不加清理策略会无限增长。ES 侧需要配置 ILM 策略或在 Jaeger 侧配置 `--es.index-prefix` 与清理任务,否则几个月后 ES 磁盘就会告警。
6. **Cassandra 的运维成本很高**。除非已有 Cassandra 集群,否则不建议为 Jaeger 单独引入;新部署优先选择 Elasticsearch / OpenSearch,或把 Jaeger 的存储交给支持 OTLP 的一体化后端(如 Tempo、ClickHouse 方案)。
7. **尾部采样(tail_sampling)极其吃内存**。它要把 Trace 在内存中缓存 `decision_wait` 时长才能做决策,`num_traces` 决定缓存条数。流量大的集群需要给 Collector 分配数 GB 内存,并把它放在**独立的 Collector 层**而不是节点上的 DaemonSet 里。
8. **`decision_wait` 太长会延迟数据可见,太短会导致 Trace 不完整**。默认 10s 对跨多个服务、涉及异步调用的链路可能不够,需要结合业务的 P99 耗时来定。
9. **SPM(服务性能监控)需要 Prometheus 兼容的指标存储**。Jaeger 的 SPM 页面不读自己的 Trace 存储,而是从 Prometheus 查询 span 指标,必须额外部署并配置好 metrics 存储,否则该页面永远是空的。
10. **服务依赖图(Service Map)需要额外的 Spark 作业**。它由 `spark-dependencies` 定期扫描存储计算并写回,不是实时生成的。没有部署这个作业时,Dependencies 页面会一直报错或无数据。
11. **`allInOne` / 内存存储只适合开发**。进程重启后所有 Trace 消失,且内存上限(`max_traces`)一旦达到就会开始淘汰。生产环境用它排查问题会得出错误结论。
12. **collector 的接收端口要对外开放到业务命名空间**。业务 Pod 需要能连到 4317/4318,NetworkPolicy 默认拒绝跨命名空间流量时会表现为 SDK 侧持续重试并打印 `failed to export`.
13. **TraceID 要在日志里带上才串得起来**。只部署 Jaeger 而不让应用把 `trace_id` 打进日志,排查时仍然要在两个系统之间手工对照。正确做法是日志里输出 trace_id 并在 Grafana 中做跳转。
14. **批量与队列参数影响采集成功率**。`batch` processor 的 `timeout` / `send_batch_size` 设置不当会在流量突增时丢数据;collector 的队列长度不足时表现为 `sending_queue is full`。
15. **UI 里看不到数据时,排查顺序是**:SDK 是否真的在发送(应用日志)→ collector 是否收到(`jaeger_collector_spans_received_total`)→ 是否被采样丢弃(采样率)→ 写入存储是否成功(exporter 错误日志)。跳过前三步直接怀疑存储是最常见的走弯路。

### 相关命令

- `opentelemetry` — 云原生可观测性数据采集标准与Collector
- `grafana` — 指标可视化与大盘平台
- `prometheus` — Kubernetes集群监控系统与时间序列数据库
- `loki` — 水平可扩展的日志聚合系统
- `helm` — Kubernetes包管理器

### 参考链接

- [Jaeger 官方文档](https://www.jaegertracing.io/docs/)
- [Jaeger 采样机制](https://www.jaegertracing.io/docs/latest/sampling/)
- [Jaeger Kubernetes 部署](https://www.jaegertracing.io/docs/latest/deployment/kubernetes/)
- [Jaeger Helm Charts](https://github.com/jaegertracing/helm-charts)
- [OpenTelemetry 协议(OTLP)](https://opentelemetry.io/docs/specs/otlp/)
