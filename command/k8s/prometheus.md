prometheus
===

Kubernetes集群监控与告警系统,云原生监控事实标准

## 补充说明

**Prometheus** 是 CNCF 毕业的监控系统与时间序列数据库(TSDB),在 Kubernetes 生态中是事实标准的指标采集与告警引擎。它通过 Pull 模型周期性抓取(Scrape)目标的 `/metrics` 端点,把样本写入本地 TSDB,并按规则触发告警推给 Alertmanager。

在 Kubernetes 中**几乎不会手工部署 Prometheus**,而是通过 **Prometheus Operator** 声明式管理。Operator 监听一组自定义资源(CRD),把它们翻译成 StatefulSet、Service、Secret 和 Prometheus 配置文件:

```shell
Prometheus              Prometheus 实例(生成 StatefulSet)
ServiceMonitor          Service 级抓取配置(最常用)
PodMonitor              Pod 级抓取配置(无 Service 时使用)
Probe                   黑盒探测(blackbox-exporter)
PrometheusRule          告警规则与记录规则
Alertmanager            Alertmanager 实例
AlertmanagerConfig      按命名空间分发的告警路由
ThanosRuler             Thanos 规则组件
ScrapeConfig            原生 scrape_config 逃生通道
```

数据流:`ServiceMonitor → Operator 生成配置 → Prometheus 抓取 → TSDB → 规则评估 → Alertmanager → 通知渠道`

**kube-prometheus-stack 与 Operator 的关系**:`kube-prometheus-stack` 是社区维护的 Helm Chart,内容 = Prometheus Operator + Prometheus + Alertmanager + Grafana + node-exporter + kube-state-metrics + 一套默认告警规则与大盘。Operator 是其中唯一负责「协调 CRD」的组件,Chart 里对应 `prometheusOperator.*` 那部分配置。因此**不要**在装了 `kube-prometheus-stack` 的集群里再单独装一次 `kube-prometheus-stack/charts/crds` 或 Operator,CRD 会冲突。

### 安装

```shell
# 添加仓库
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

# 一键安装完整监控栈(CRD 由 Chart 一并创建)
helm install prometheus prometheus-community/kube-prometheus-stack \
  -n monitoring --create-namespace

# 只装 Prometheus Operator(自备 Prometheus 实例时)
helm install prometheus-operator prometheus-community/kube-prometheus-stack \
  -n monitoring --create-namespace \
  --set prometheus.enabled=false \
  --set alertmanager.enabled=false \
  --set grafana.enabled=false \
  --set kubeStateMetrics.enabled=false \
  --set nodeExporter.enabled=false

# 生产常用参数:保留期、存储、资源
helm install prometheus prometheus-community/kube-prometheus-stack \
  -n monitoring --create-namespace \
  --set prometheus.prometheusSpec.retention=15d \
  --set prometheus.prometheusSpec.retentionSize=45GB \
  --set prometheus.prometheusSpec.storageSpec.volumeClaimTemplate.spec.storageClassName=fast \
  --set prometheus.prometheusSpec.storageSpec.volumeClaimTemplate.spec.resources.requests.storage=50Gi

# 查看生成的 Prometheus 实例与 CRD 对象
kubectl get prometheus,servicemonitors,podmonitors,prometheusrules -A
```

### ServiceMonitor

`ServiceMonitor` 通过 label 选择 Service,再抓取其 Endpoints。**必须存在 Service**(即使是 headless),否则不会产生抓取目标。

```shell
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: my-app
  namespace: monitoring
  labels:
    release: prometheus        # 关键:必须匹配 Prometheus 的 serviceMonitorSelector
spec:
  namespaceSelector:
    matchNames:
      - default
  selector:
    matchLabels:
      app: my-app
  endpoints:
    - port: metrics            # 对应 Service 中 port 的 name
      path: /metrics
      interval: 30s
      scrapeTimeout: 10s
      honorLabels: false
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_node_name]
          targetLabel: node
```

Pod 没有 Service 时用 `PodMonitor`,字段几乎相同,只是 `selector` 直接选 Pod:

```shell
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: my-batch
  namespace: monitoring
spec:
  selector:
    matchLabels:
      app: my-batch
  podMetricsEndpoints:
    - port: metrics
```

### PrometheusRule

```shell
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: my-app-rules
  namespace: monitoring
  labels:
    release: prometheus        # 必须匹配 Prometheus 的 ruleSelector
spec:
  groups:
    - name: my-app.rules
      interval: 30s
      rules:
        - record: job:http_requests:rate5m
          expr: sum by (job) (rate(http_requests_total[5m]))

        - alert: MyAppHighErrorRate
          expr: |
            sum(rate(http_requests_total{code=~"5.."}[5m]))
            /
            sum(rate(http_requests_total[5m])) > 0.05
          for: 10m
          labels:
            severity: critical
          annotations:
            summary: "{{ $labels.job }} 错误率超过 5%"
            description: "当前错误率 {{ $value | humanizePercentage }}"
```

验证规则语法:

```shell
kubectl exec -n monitoring prometheus-prometheus-kube-prometheus-prometheus-0 -c prometheus -- \
  promtool check rules /etc/prometheus/rules/prometheus-prometheus-rulefiles-0/*.yaml
```

### 存储与保留策略

Prometheus 默认把数据写在容器内的空目录(`emptyDir`),**Pod 重建即全部丢失**。生产必须显式配置存储:

```shell
apiVersion: monitoring.coreos.com/v1
kind: Prometheus
metadata:
  name: k8s
  namespace: monitoring
spec:
  replicas: 2
  retention: 15d
  retentionSize: 45GB           # 比磁盘容量略小,留出 WAL 与压缩空间
  walCompression: true
  resources:
    requests:
      cpu: 500m
      memory: 2Gi
    limits:
      memory: 4Gi               # 不要设 CPU limit,避免抓取限流
  storage:
    volumeClaimTemplate:
      spec:
        storageClassName: fast
        resources:
          requests:
            storage: 50Gi
  # 长期存储:远程写。本地只留短期数据
  remoteWrite:
    - url: http://victoria-metrics:8428/api/v1/write
      queueConfig:
        maxSamplesPerSend: 10000
        maxShards: 50
  # 抓取对象选择器:置为 false 表示不按 Helm release label 过滤
  serviceMonitorSelectorNilUsesHelmValues: false
  podMonitorSelectorNilUsesHelmValues: false
  ruleSelectorNilUsesHelmValues: false
  serviceMonitorSelector: {}
  serviceMonitorNamespaceSelector: {}
```

### 常用 PromQL

```shell
# 抓取目标是否存活
up
up{job="kubelet"} == 0

# 样本数暴涨说明基数失控
scrape_samples_scraped

# 容器 CPU 使用率(相对 requests)
sum(rate(container_cpu_usage_seconds_total{container!=""}[5m])) by (pod)
  / sum(kube_pod_container_resource_requests{resource="cpu"}) by (pod)

# 容器内存工作集
sum(container_memory_working_set_bytes{container!=""}) by (pod)

# Pod 重启次数
increase(kube_pod_container_status_restarts_total[1h]) > 3

# 节点 Ready 状态
kube_node_status_condition{condition="Ready",status="true"} == 0

# 文件系统剩余空间百分比
node_filesystem_avail_bytes{fstype!~"tmpfs|overlay"}
  / node_filesystem_size_bytes{fstype!~"tmpfs|overlay"} * 100 < 15

# PVC 使用率
kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes * 100 > 85

# 发布副本是否达标
kube_deployment_status_replicas_available
  != kube_deployment_spec_replicas

# 请求延迟 P99
histogram_quantile(0.99, sum by (le, job) (rate(http_request_duration_seconds_bucket[5m])))
```

### 运维与排障

```shell
# 实例与 Pod 状态
kubectl get prometheus -n monitoring
kubectl get sts,po -n monitoring -l app.kubernetes.io/name=prometheus

# 查看某目标为何没被抓到
kubectl exec -n monitoring sts/prometheus-prometheus-kube-prometheus-prometheus -c prometheus -- \
  wget -qO- 'localhost:9090/api/v1/targets?state=active'

# 看 Operator 生成的最终配置
kubectl get secret -n monitoring prometheus-prometheus-kube-prometheus-prometheus \
  -o jsonpath='{.data.prometheus\.yaml\.gz}' | base64 -d | gunzip | head -80

# 看 Operator 日志(CRD 不生效时第一现场)
kubectl logs -n monitoring deploy/prometheus-kube-prometheus-operator --tail=200

# 查看 TSDB 状态与块数
kubectl exec -n monitoring sts/prometheus-prometheus-kube-prometheus-prometheus -c prometheus -- \
  wget -qO- localhost:9090/api/v1/status/tsdb | head -c 1500
```

### 注意

1. **默认没有持久化存储**。`kube-prometheus-stack` 不给 Prometheus 配 PVC,Operator 会挂一个 emptyDir,Pod 一重启历史数据全丢。生产必须通过 `prometheus.prometheusSpec.storageSpec` 配置 `volumeClaimTemplate`,且**无法在已有实例上原地从 emptyDir 改成 PVC**——StatefulSet 的 volumeClaimTemplate 不可变,需要删除 Prometheus CR 重建(数据会丢)。
2. **ServiceMonitor 的 label 必须匹配 `serviceMonitorSelector`**。`kube-prometheus-stack` 默认 `serviceMonitorSelectorNilUsesHelmValues: true`,Operator 只选择带 `release: <helm-release-name>` 标签的 ServiceMonitor。自己写的 ServiceMonitor 漏了 `release: prometheus`(或你的 release 名)就会静默不生效,`kubectl get servicemonitor` 看得到、`/api/v1/targets` 里却没有。三选一:打对 label、把 `serviceMonitorSelectorNilUsesHelmValues` 设为 `false`、或显式写 `serviceMonitorSelector: {}`(空选择器匹配全部)。
3. **`ruleSelector` 同理**。规范是**两边都不写**:`PrometheusRule` 不带匹配 label、且 `ruleSelectorNilUsesHelmValues` 保持默认。
4. **CRD 不会被 `helm uninstall` 删除**。Chart 的 crds/ 目录资源属于 Helm 保护范畴,卸载 release 后 `servicemonitors.monitoring.coreos.com` 等 CRD 仍在集群里,残留的 CR 会让下次安装报 `already exists`。需要手工 `kubectl delete crd <name>`。
5. **基数爆炸(cardinality)是 Prometheus OOM 的头号原因**。带高基数的 label(用户 ID、URL 全路径、request_id、异常堆栈)写进指标名或 label,单条 `http_requests_total` 就能膨胀到上千万序列。先看 `scrape_samples_scraped` 和 `/api/v1/status/tsdb` 的 `seriesCountByMetricName`,再决定要不要用 `metric_relabel_configs` 丢弃,或在应用侧改用日志/链路。
6. **不要给 Prometheus 设 CPU limit**。抓取、压缩、规则评估都是突发型负载,CPU 被限流会直接导致抓取超时和 `context deadline exceeded`。设 memory limit 并留足余量(建议 limit ≈ 2 倍 request)是合适的。
7. **`retentionSize` 要小于 PVC 容量**。WAL 目录和正在压缩的块会额外占用磁盘,不留余量会触发磁盘写满导致 Prometheus 崩溃(表现为 `no space left on device`)。
8. **单实例 Prometheus 无法水平扩展做 HA**。`replicas: 2` 只是跑两个独立副本各自抓取全量数据(用于冗余,不是分片),查询侧需要 Thanos Query 之类的组件去重,否则 Grafana 会看到重复序列。
9. **`ServiceMonitor` 要求目标有 Service**。裸 Pod、Job、ExternalName Service 抓不到,应改用 `PodMonitor`。抓静态外部目标(如数据库)则用 `ScrapeConfig` 或带 `Endpoints` 的无 selector Service。
10. **改了 `interval` 后目标不会立即更新**。Operator 会重写 Secret,Prometheus 重新加载配置需要几十秒,期间 `/api/v1/targets` 里仍显示旧间隔。
11. **`honorLabels: false` 是默认值**,意味着目标自带的同名 label(`job`、`instance`)会被 Prometheus 改写。应用自己上报了 `job` 标签又想保留,必须显式设 `honorLabels: true`。
12. **删除 Prometheus CR 不会删除 PVC**。`kubectl delete prometheus` 后 StatefulSet 与 Pod 消失,但 `volumeClaimTemplate` 创建的 PVC 仍在(StatefulSet 语义),重建同名实例时会复用旧数据;要彻底清理需手工删 PVC。
13. **多副本要用 `podAntiAffinity` 分散到不同节点**,否则单节点故障会同时打掉两个副本。
14. **Operator 生成的 Service 端口名是 `http-web` 而不是 `web`**,`kubectl port-forward` 或 ServiceMonitor 里写错会直接连不上。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `helm` — Kubernetes包管理器
- `metrics-server` — Kubernetes集群资源指标采集组件
- `grafana` — 指标可视化与大盘平台
- `alertmanager` — Prometheus 告警路由与去重组件
- `node-exporter` — 节点级主机指标采集器

### 参考链接

- [Prometheus 官方文档](https://prometheus.io/docs/introduction/overview/)
- [Prometheus Operator 文档](https://prometheus-operator.dev/docs/getting-started/introduction/)
- [kube-prometheus-stack Chart](https://github.com/prometheus-community/helm-charts/tree/main/charts/kube-prometheus-stack)
- [PromQL 基础](https://prometheus.io/docs/prometheus/latest/querying/basics/)
- [Prometheus 存储与保留](https://prometheus.io/docs/prometheus/latest/storage/)
- [Prometheus 配置参考](https://prometheus.io/docs/prometheus/latest/configuration/configuration/)
