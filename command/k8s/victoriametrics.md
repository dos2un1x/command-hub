victoriametrics
===

高性能时间序列数据库,兼容Prometheus生态的监控存储方案

## 补充说明

**VictoriaMetrics**(简称 VM)是一个高性能、低资源占用的时间序列数据库与监控解决方案。它同时兼容 Prometheus 的**抓取配置、remote_write 协议、PromQL 查询 API 与告警规则格式**,因此可以在几乎不改动现有监控体系的前提下替换或补充 Prometheus。

在 Kubernetes 中它由若干可独立部署的组件构成:

```shell
vmagent    指标抓取代理,读取 Prometheus 抓取配置或 CRD,remote_write 到存储
vmsingle   单节点存储,all-in-one,适合中小规模与边缘集群
vmcluster  集群版,由 vminsert / vmselect / vmstorage 三类组件组成
vmalert    规则评估与告警,取代 Prometheus 的 rules 与 Alertmanager 上游
vmauth     统一鉴权入口,多租户场景使用
vmbackup / vmrestore   基于对象存储的备份与恢复
```

它最常被拿来和 Prometheus + Thanos 对比,核心差异是:

```shell
存储        VM 用自有格式,压缩率更高,单机即可支撑高基数场景
水平扩展    VM 集群版靠复制因子做 HA;Prometheus 靠多副本 + 去重
对象存储    VM 的数据主要在本地磁盘,归档靠 vmbackup;Thanos 直接以对象存储为后端
查询语言    MetricsQL,是 PromQL 的超集
```

**MetricsQL 是 PromQL 的超集**,绝大多数 PromQL 原样可用,但行为并非完全一致(例如 `rate()` 在样本不足时的返回值),迁移前必须复核告警阈值。

### 安装

```shell
helm repo add vm https://victoriametrics.github.io/helm-charts/
helm repo update

# 方案一:一体化监控栈(含 Operator、vmagent、vmalert、Grafana、node-exporter 等)
helm install vmks vm/victoria-metrics-k8s-stack -n monitoring --create-namespace

# 方案二:单节点存储
helm install vmsingle vm/victoria-metrics-single -n monitoring --create-namespace \
  --set server.retentionPeriod=90d \
  --set server.persistentVolume.enabled=true \
  --set server.persistentVolume.size=100Gi

# 方案三:集群版
helm install vmcluster vm/victoria-metrics-cluster -n monitoring --create-namespace \
  --set vmselect.replicaCount=2 \
  --set vmstorage.replicaCount=3 \
  --set vmstorage.retentionPeriod=90d \
  --set vmstorage.replicationFactor=2
```

Chart 命名需要留意:**没有名为 `vmagent` 的 Chart**,抓取代理对应的是 `victoria-metrics-agent`:

```shell
victoria-metrics-k8s-stack        完整监控栈
victoria-metrics-single           单节点
victoria-metrics-cluster          集群版
victoria-metrics-operator         Operator 与 CRD
victoria-metrics-operator-crds    仅 CRD,便于 GitOps 分步安装
victoria-metrics-agent            抓取代理(vmagent)
victoria-metrics-alert            告警(vmalert)
victoria-metrics-auth             鉴权入口(vmauth)
victoria-logs-single / -cluster   VictoriaLogs
victoria-traces-single / -cluster VictoriaTraces
```

### CRD 一览

VictoriaMetrics Operator 提供的 CRD 与 prometheus-operator 一一对应,并且 **`VMServiceScrape` 被官方定义为 ServiceMonitor 的直接替代品**:

```shell
VMServiceScrape       对应 ServiceMonitor,抓取 Service
VMPodScrape           对应 PodMonitor
VMNodeScrape          节点级抓取(kubelet、node-exporter)
VMStaticScrape        静态目标
VMProbe               黑盒探测
VMScrapeConfig        原生 scrape_config 逃生通道
VMRule                告警与记录规则
VMAgent                抓取代理实例
VMSingle               单节点存储实例
VMCluster              集群版实例
VMAlert                 规则评估实例
VMAlertmanager          告警路由实例
VMAlertmanagerConfig    按命名空间分发的告警配置
VMAuth / VMUser         鉴权与租户
```

示例:

```shell
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMServiceScrape
metadata:
  name: my-app
  namespace: monitoring
  labels:
    release: vmks               # 必须匹配 VMAgent 的 serviceScrapeSelector
spec:
  namespaceSelector:
    matchNames:
      - default
  selector:
    matchLabels:
      app: my-app
  endpoints:
    - port: metrics
      path: /metrics
      interval: 30s
      scrapeTimeout: 10s
      relabelConfigs:
        - sourceLabels: [__meta_kubernetes_pod_node_name]
          targetLabel: node
```

规则:

```shell
apiVersion: operator.victoriametrics.com/v1beta1
kind: VMRule
metadata:
  name: my-app-rules
  namespace: monitoring
  labels:
    release: vmks
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
            / sum(rate(http_requests_total[5m])) > 0.05
          for: 10m
          keep_firing_for: 5m
          labels:
            severity: critical
          annotations:
            summary: "{{ $labels.job }} 错误率超过 5%"
```

注意 `apiVersion` 是 `operator.victoriametrics.com/v1beta1`,与 prometheus-operator 的 `monitoring.coreos.com/v1` 完全不同,迁移时 YAML 需要整体替换。

### 抓取与写入

**vmagent** 有两种配置来源:Prometheus 风格的抓取配置文件,或 Kubernetes CRD。

```shell
# 使用 CRD(由 Operator 渲染成最终配置)
vmagent:
  spec:
    selectAllByDefault: true
    serviceScrapeSelector: {}
    serviceScrapeNamespaceSelector: {}
    podScrapeSelector: {}
    externalLabels:
      cluster: prod
    remoteWrite:
      - url: http://vmsingle-victoria-metrics-single.monitoring.svc:8428/api/v1/write
    resources:
      requests: { cpu: 100m, memory: 256Mi }
      limits:   { memory: 1Gi }
```

**Prometheus 直接 remote_write 到 VictoriaMetrics** 也是完全支持的,写入端点为:

```shell
http://vmsingle-victoria-metrics-single.monitoring.svc:8428/api/v1/write
```

在 `kube-prometheus-stack` 的 values 中加上同样的地址即可:

```shell
prometheus:
  prometheusSpec:
    remoteWrite:
      - url: http://vmsingle-victoria-metrics-single.monitoring.svc:8428/api/v1/write
```

查询 API 与 Prometheus 完全兼容,Grafana 里可以直接选择 Prometheus 类型的数据源:

```shell
http://vmsingle-victoria-metrics-single.monitoring.svc:8428    # Prometheus 兼容 API 根路径
/api/v1/query
/api/v1/query_range
/api/v1/series
/api/v1/labels
/api/v1/targets        由 vmagent 提供
```

### 保留期与备份

```shell
# VMSingle / vmstorage 的保留期
spec:
  retentionPeriod: 90d        # 支持 1、30d、1y 等写法
  storageDataPath: /storage
  storage:
    volumeClaimTemplate:
      spec:
        resources:
          requests:
            storage: 200Gi
```

**VictoriaMetrics 没有 Thanos 那样的对象存储分层**。数据落在 vmstorage 的本地磁盘,长期归档必须用 `vmbackup`。为了一致性,备份前应先创建快照:

```shell
# 创建快照
kubectl exec -n monitoring vmsingle-victoria-metrics-single-0 -- \
  wget -qO- 'localhost:8428/snapshot/create'

# 用 vmbackup 把快照传到对象存储
vmbackup -snapshot.createURL=http://localhost:8428/snapshot/create \
  -storageDataPath=/storage \
  -dst=s3://my-bucket/vm-backup

# 恢复
vmrestore -src=s3://my-bucket/vm-backup -storageDataPath=/storage
```

### 验证与排障

```shell
kubectl get po,svc -n monitoring | grep -E "vm|victoria"
kubectl get vmsingle,vmcluster,vmagent,vmalert -n monitoring
kubectl get vmservicescrape,vmrule -A

# 直接查询存储
kubectl port-forward -n monitoring svc/vmsingle-victoria-metrics-single 8428:8428
curl -s 'localhost:8428/api/v1/query?query=up' | python3 -m json.tool | head -30

# 查看存储状态与基数
curl -s 'localhost:8428/api/v1/status/tsdb' | python3 -m json.tool | head -40
curl -s localhost:8428/metrics | grep -E "vm_rows|vm_data_size"

# 查看抓取目标(vmagent,默认 8429 端口)
kubectl port-forward -n monitoring svc/vmagent-victoria-metrics-agent 8429:8429
curl -s localhost:8429/targets | head -c 2000
curl -s localhost:8429/metrics | grep -E "vmagent_remotewrite|vm_persistentqueue"
```

### 注意

1. **`VMServiceScrape` 用 `operator.victoriametrics.com/v1beta1`**,不是 prometheus-operator 的 `monitoring.coreos.com/v1`。虽然字段几乎一样,但两套 CRD 属于不同 Operator,写错 apiVersion 会直接被 API Server 拒绝。
2. **`selectAllByDefault` 决定选择器行为,与 prometheus-operator 相反**。VictoriaMetrics Operator 支持 `-selectAllByDefault`(或在 `VMAgent` spec 里设 `selectAllByDefault: true`),开启后所有 CR 都会被选中**无需任何标签**。这与 prometheus-operator 默认按 Helm release label 过滤的行为截然不同,直接照搬 Prometheus 的排障经验会找错方向。
3. **`victoria-metrics-k8s-stack` 不能再与 `kube-prometheus-stack` 共存**。两者都会部署 node-exporter、kube-state-metrics、Grafana 等同名组件,DaemonSet 名称与端口冲突,Prometheus 规则 CRD 也会互相干扰。迁移时应当先卸载一套再装另一套。
4. **集群版的数据可靠性靠复制因子,不是靠对象存储**。`replicationFactor: 2` 表示每条数据写入两个 vmstorage;设为 1 时任意一个 vmstorage 宕机都会造成数据缺失。同时 vmselect 会向所有 vmstorage 扇出查询,只要有一个不可用,相关时间段的查询就会直接报错。生产建议 3 副本 + `replicationFactor: 2`。
5. **`rate()` 的行为与 PromQL 不同**。MetricsQL 的 `rate()` 会自动处理样本不足与计数器重置的情况,返回的是「外推后的速率」而不会像 Prometheus 那样因为窗口内样本太少而返回空值。从 Prometheus 迁移过来的告警表达式阈值需要重新校准,否则会突然出现大量误报。
6. **`vmalert` 的告警规则里 `keep_firing_for` 是 VM 扩展字段**。它能让告警在条件不再满足后继续保持一段时间的 Firing 状态,避免抖动。反向迁移回 Prometheus 时该字段会被忽略或报错。
7. **自动降采样是 Enterprise 特性**。开源版不提供 Thanos 那样的 5 分钟/1 小时降采样,大时间范围查询的性能完全依赖压缩率与索引。长时间跨度的图表要么调大 `retentionPeriod` 并接受查询变慢,要么用 recording rules 预聚合成低分辨率指标。
8. **`retentionPeriod` 只有一个全局值**。无法像 Thanos 那样按分辨率分别设置(原始 30 天 / 降采样 1 年)。所有数据的保留期一致,容量规划时必须按最高分辨率的数据量估算。
9. **备份必须用 `vmbackup`,且要先做快照**。直接复制 `storageDataPath` 目录会得到不一致的数据(写入正在进行)。`-snapshot.createURL` 让 vmbackup 先触发快照再传输,是唯一被官方推荐的在线备份方式。
10. **`vmagent` 的持久化队列默认可能未开启**。存储端不可用时,vmagent 默认在内存中缓冲,重启即丢。生产要开启 `-remoteWrite.tmpDataPath` 并把该路径放在持久化卷上,同时用 `-remoteWrite.maxDiskUsagePerURL` 限制磁盘占用。
11. **`vmagent` 比 Prometheus 省资源,但抓取语义有细微差别**。它不做本地 TSDB 落盘(除非开启队列持久化),因此没有 Prometheus 那样的「抓取后本地可查」能力,所有查询都走远端存储。抓取失败时也看不到 Prometheus 那种本地 `up` 历史。
12. **依赖 `vmagent` 的 `/targets` 页面排查抓取问题**。VM 的 target 状态由 vmagent 暴露(默认 8429 端口),不在存储组件上。查不到目标时先确认 vmagent 有没有正确加载 CR。
13. **Grafana 数据源仍选「Prometheus」类型**。VictoriaMetrics 提供的是 Prometheus 兼容 API,不需要也不存在专门的 VM 数据源插件;填错类型或路径(漏了根路径)会导致查询报 404。
14. **多租户要额外部署 vmauth 或 vmcluster 的租户参数**。单节点版没有租户隔离,所有数据在一个命名空间下;集群版通过 URL 路径中的 `<accountID>` 区分租户,配合 `vmauth` 做鉴权。

### 相关命令

- `prometheus` — Kubernetes集群监控系统与时间序列数据库
- `thanos` — 为 Prometheus 提供长期存储与全局查询能力的高可用方案
- `alertmanager` — Prometheus 告警路由与去重组件
- `grafana` — 指标可视化与大盘平台
- `helm` — Kubernetes包管理器

### 参考链接

- [VictoriaMetrics 官方文档](https://docs.victoriametrics.com/)
- [VictoriaMetrics Operator](https://docs.victoriametrics.com/operator/)
- [VMServiceScrape 参考](https://docs.victoriametrics.com/operator/resources/vmservicescrape/)
- [MetricsQL 与 PromQL 的差异](https://docs.victoriametrics.com/metricsql/)
- [VictoriaMetrics Helm Charts](https://docs.victoriametrics.com/helm/)
