opentelemetry
===

云原生可观测性标准与OpenTelemetry Collector采集流水线

## 补充说明

**OpenTelemetry**(简称 OTel)是 CNCF 的可观测性标准项目,统一了指标(Metrics)、链路(Traces)、日志(Logs)三类遥测数据的采集协议、SDK 与语义约定。它要解决的问题是:过去每个后端都有自己的 agent 与协议(Nagios、StatsD、Jaeger、Prometheus exporter……),换个厂商就要重写埋点;**OTel 让应用只埋一次,后端随意切换**。

在 Kubernetes 语境下,OTel 有三个相互独立的落点,容易混淆:

```shell
OpenTelemetry Collector   采集与处理遥测数据的中间层(本页重点)
OpenTelemetry Operator    用 CRD 管理 Collector 与自动注入的 Operator
Instrumentation CRD       声明式配置应用的自动埋点(SDK 注入)
```

**Collector 的核心概念是 Pipeline(流水线)**。一条 pipeline 由三部分组成,由 `service.pipelines` 串起来:

```shell
receivers    接收数据。otlp、prometheus、filelog、kubeletstats、jaeger、zipkin、hostmetrics
processors   加工数据。memory_limiter、batch、k8sattributes、resourcedetection、filter、transform
exporters    发出数据。otlp、otlphttp、prometheusremotewrite、loki、debug、kafka

service:
  pipelines:
    traces:  接收器 → 处理器 → 导出器
    metrics: 接收器 → 处理器 → 导出器
    logs:    接收器 → 处理器 → 导出器
```

同一个 Collector 可以同时跑多条 pipeline,不同 pipeline 之间完全独立 —— traces 发给 Jaeger、metrics 发给 Prometheus、logs 发给 Loki 是标准用法。**没有被任何 pipeline 引用的 receiver 不会启动,也不会报错**,这是配置调试时的常见陷阱。

典型部署拓扑:

```shell
Agent(每节点 DaemonSet)    采集节点级数据:filelog、hostmetrics、kubeletstats
   ↓ OTLP
Gateway(中心 Deployment)    统一处理:tail_sampling、k8sattributes、批量导出
   ↓
后端                        Tempo / Jaeger / Prometheus / Loki / 商业 APM
```

### 安装

```shell
helm repo add open-telemetry https://open-telemetry.github.io/opentelemetry-helm-charts
helm repo update

# 安装 Collector(务必显式指定 mode)
helm install otel-collector open-telemetry/opentelemetry-collector \
  -n observability --create-namespace \
  --set mode=daemonset

# 安装 Operator(用 CRD 管理 Collector 与自动埋点)
helm install otel-operator open-telemetry/opentelemetry-operator \
  -n observability --create-namespace \
  --set admissionWebhooks.certManager.enabled=false \
  --set admissionWebhooks.autoGenerateCert.enabled=true

# 查看可用 Chart
helm search repo open-telemetry
```

仓库中的 Chart:

```shell
opentelemetry-collector                Collector 本体(最常用)
opentelemetry-operator                 提供 OpenTelemetryCollector / Instrumentation 等 CRD
opentelemetry-demo                     官方微服务演示环境
opentelemetry-ebpf-instrumentation     基于 eBPF 的零侵入采集
```

### Collector 配置结构

`mode` 决定工作负载类型,取值 `daemonset`、`deployment`、`statefulset`:

```shell
mode: daemonset
replicaCount: 1                 # 仅 deployment 模式下生效
image:
  repository: ""                # 留空时使用 Chart 默认镜像
resources: {}                   # 默认没有任何 requests/limits
presets:
  logsCollection: { enabled: false }        # 采集容器日志
  hostMetrics: { enabled: false }           # 主机指标
  kubernetesAttributes: { enabled: false }  # Pod 元数据
  kubeletMetrics: { enabled: false }        # kubelet 指标
  resourceDetection: { enabled: true }      # 默认开启
config:
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: 0.0.0.0:4317
        http:
          endpoint: 0.0.0.0:4318
  processors:
    memory_limiter:
      check_interval: 5s
      limit_percentage: 80
      spike_limit_percentage: 25
    batch: {}
  exporters:
    debug: {}
  service:
    pipelines:
      traces:
        receivers: [otlp]
        processors: [memory_limiter, batch]
        exporters: [debug]
```

Chart 默认的 `exporters` 只有 `debug`,`pipelines` 的三条( logs / metrics / traces )全部指向它 —— 也就是说**默认配置只会把数据打到标准输出**,必须替换成真实后端。

### 端口

```shell
4317    OTLP gRPC
4318    OTLP HTTP
6831 / 14250 / 14268   Jaeger 兼容接收(legacy)
9411    Zipkin
8888    自身遥测指标(默认关闭,需显式开启 metrics 端口)
13133   健康检查
55679   zpages 调试页面
```

### 用 Operator 管理

Operator 提供 `OpenTelemetryCollector` CRD,配置直接内嵌 Collector 的 config:

```shell
apiVersion: opentelemetry.io/v1beta1
kind: OpenTelemetryCollector
metadata:
  name: otel
  namespace: observability
spec:
  mode: daemonset
  image: otel/opentelemetry-collector-contrib:0.110.0
  volumeMounts:
    - name: varlogpods
      mountPath: /var/log/pods
      readOnly: true
  volumes:
    - name: varlogpods
      hostPath:
        path: /var/log/pods
  config:
    receivers:
      filelog:
        include: [/var/log/pods/*/*/*.log]
        start_at: end
        include_file_path: true
        operators:
          - type: container
            id: container-parser
      otlp:
        protocols:
          grpc: {}
          http: {}
    processors:
      k8sattributes:
        auth_type: serviceAccount
        passthrough: false
        extract:
          metadata: [k8s.namespace.name, k8s.pod.name, k8s.container.name]
      memory_limiter:
        check_interval: 5s
        limit_percentage: 80
        spike_limit_percentage: 25
      batch: {}
    exporters:
      otlphttp/loki:
        endpoint: http://loki-gateway.observability.svc:80/otlp
      otlp/tempo:
        endpoint: tempo.observability.svc:4317
        tls:
          insecure: true
      prometheusremotewrite:
        endpoint: http://prometheus.observability.svc:9090/api/v1/write
    service:
      pipelines:
        logs:
          receivers: [filelog]
          processors: [memory_limiter, k8sattributes, batch]
          exporters: [otlphttp/loki]
        traces:
          receivers: [otlp]
          processors: [memory_limiter, k8sattributes, batch]
          exporters: [otlp/tempo]
```

### 自动埋点(Instrumentation)

`Instrumentation` CRD 让 Operator 向业务 Pod 注入 SDK,无需改代码:

```shell
apiVersion: opentelemetry.io/v1alpha1
kind: Instrumentation
metadata:
  name: my-instrumentation
  namespace: default
spec:
  exporter:
    endpoint: http://otel-collector.observability.svc:4317
  sampler:
    type: parentbased_traceidratio
    argument: "0.1"
  propagators:
    - tracecontext
    - baggage
```

在业务 Pod 上加注解即可启用:

```shell
metadata:
  annotations:
    instrumentation.opentelemetry.io/inject-java: "true"
    # 跨命名空间时写 <namespace>/<instrumentation-name>
    instrumentation.opentelemetry.io/inject-python: "observability/my-instrumentation"
    instrumentation.opentelemetry.io/container-names: "app"
```

### 验证与排障

```shell
kubectl get po -n observability -l app.kubernetes.io/name=opentelemetry-collector
kubectl logs -n observability ds/otel-collector-opentelemetry-collector --tail=200

# 查看最终生效的配置(Chart 会做模板渲染与合并,不要只看 values)
kubectl get cm -n observability otel-collector-opentelemetry-collector -o yaml

# 查看 Collector 自身遥测(zpages 调试页面)
kubectl port-forward -n observability ds/otel-collector-opentelemetry-collector 55679:55679
curl -s localhost:55679/debug/pipelinez | head -c 2000

# 检查 Operator 是否就绪 / 自动注入是否生效
kubectl get otelcol -A
kubectl logs -n observability deploy/otel-operator --tail=100
kubectl get po <business-pod> -o jsonpath='{.spec.containers[*].env[*].name}'
```

### 注意

1. **`mode` 在 Chart 的 values 中默认为空字符串**,必须显式设置 `daemonset` / `deployment` / `statefulset`。依赖默认值会让渲染结果不符合预期,也让升级时的行为变得不可预测。
2. **`memory_limiter` 的百分比是相对容器内存上限计算的**。`limit_percentage: 80` 只有在容器设置了 `resources.limits.memory` 时才有意义;没有设 limits 时 Collector 会退化为参考节点总内存,于是限流器还没来得及介入就被节点 OOM Killer 杀掉了。**上生产必须同时设置 `resources.limits.memory` 和 `memory_limiter`**。
3. **`memory_limiter` 必须是每条 pipeline 的第一个 processor,`batch` 必须是最后一个**。顺序错了会导致限流在数据已经占用大量内存之后才生效,或者批量发送时绕过内存检查。这是官方明确给出的顺序要求。
4. **默认配置只输出到 `debug`**。Chart 的默认 `exporters` 只有 `debug`,把数据全部打进容器日志,既看不到效果又会迅速写满磁盘。装完第一件事就是替换 exporter。
5. **没有被 pipeline 引用的 receiver 不会启动,而且不报错**。配置里写了 `filelog` receiver 却忘了加进 `service.pipelines.logs.receivers`,Collector 启动正常、日志无异常,就是没有数据 —— 这是最常见的「配了没生效」。
6. **`logsCollection` preset 需要 hostPath 挂载与 RBAC**。采集容器日志要读宿主机的 `/var/log/pods`,并需要有权限列出 pods。PodSecurity 策略较严的集群会直接拒绝这个 DaemonSet。
7. **`k8sattributes` 处理器需要 RBAC 与正确的 `auth_type`**。默认 `auth_type: serviceAccount` 依赖 Pod 的 ServiceAccount 有 `get/list/watch pods` 的权限;缺失时元数据为空,日志和 Trace 里没有 `k8s.pod.name`、`k8s.namespace.name`,后端就无法按工作负载归类。
8. **`prometheus` receiver 在开启内部遥测后会被移除**。Chart 的默认配置里有注释说明:当 Collector 内部 OTLP 遥测启用时,`prometheus` receiver 会被移除,避免端口冲突。手工往这个 receiver 上加配置可能不生效。
9. **DaemonSet 与 Deployment 的职责不要混**。节点级数据(filelog、hostmetrics、kubeletstats)必须在 DaemonSet 上采;尾部采样这类需要全局视角的处理必须放在 Deployment 网关层。把 tail_sampling 放进 DaemonSet 会导致每条 Trace 被各节点**分别**判断一次,产生大量重复与截断。
10. **`tail_sampling` 的内存占用与 `num_traces` 成正比**。它要在内存里等 `decision_wait` 时间才能决策,高流量集群需要数 GB 内存。同时要注意它只能看到**经过同一个 Collector 实例**的 Span,网关层副本数大于 1 且没有按 traceID 做负载均衡时,链路会被拆分到不同实例导致决策不准。
11. **自动注入的 `Instrumentation` 必须在 Pod 所在命名空间,或使用 `<namespace>/<name>` 形式引用**。注解里只写 `"true"` 时,Operator 只会在同命名空间查找名为 `my-instrumentation` 的 CRD(名称取决于 Operator 配置),找不到就静默跳过注入。
12. **自动注入要求 Pod 使用兼容的运行时而无需重启**。Java 与 Python 的注入依赖 `JAVA_TOOL_OPTIONS` 与 `PYTHONPATH` 环境变量,是**在 Pod 创建时**由准入 Webhook 注入的 —— 已经运行的 Pod 不会被回溯注入,必须重建。
13. **OTLP 的 `otlphttp` 与 `otlp` 是两套配置**。`otlp` 走 gRPC(默认 4317),`otlphttp` 走 HTTP(默认 4318),两者的 `endpoint` 写法不同,`otlphttp` 通常要带路径(如 Loki 的 `/otlp`)。写混了会连接超时。
14. **Collector 自身的指标需要显式开启**。Chart 里 `ports.metrics.enabled` 默认是 `false`,不开的话 Prometheus 抓不到 Collector 的健康状况,也就无法知道有没有 `refused_spans`、`dropped_spans`。
15. **`transform` 与 `filter` processor 是 OTTL 语法**,与 PromQL、LogQL、jq 都不一样。写错表达式 Collector 会启动失败并在日志里报 `failed to parse`,改动前先用 `otelcol validate --config` 本地校验。

### 相关命令

- `jaeger` — 分布式链路追踪系统
- `prometheus` — Kubernetes集群监控系统与时间序列数据库
- `loki` — 水平可扩展的日志聚合系统
- `fluent-bit` — 轻量级日志与指标采集器
- `helm` — Kubernetes包管理器

### 参考链接

- [OpenTelemetry 官方文档](https://opentelemetry.io/docs/)
- [Collector 配置参考](https://opentelemetry.io/docs/collector/configuration/)
- [Collector 处理器列表](https://opentelemetry.io/docs/collector/transforming-telemetry/)
- [opentelemetry-helm-charts](https://github.com/open-telemetry/opentelemetry-helm-charts)
- [OpenTelemetry Operator](https://opentelemetry.io/docs/kubernetes/operator/)
