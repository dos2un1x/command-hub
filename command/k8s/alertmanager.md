alertmanager
===

Prometheus告警的去重、分组与路由分发组件

## 补充说明

**Alertmanager** 是 Prometheus 生态中的告警处理组件。Prometheus 只负责按规则**产生**告警(Alert),Alertmanager 负责后续的一切:**去重(Dedup)、分组(Grouping)、静默(Silence)、抑制(Inhibit)、路由(Route)、发送(Notify)**。

它解决的是「告警风暴」问题:同一个故障可能触发几十条 Prometheus 规则,Alertmanager 把它们合并成一条通知,再按标签路由到不同渠道(邮件、Slack、企业微信、PagerDuty、Webhook)。

在 Kubernetes 中部署形态有两种:

```shell
kube-prometheus-stack      内置 Alertmanager,通过 Alertmanager CRD 管理
prometheus-community/alertmanager   独立的 Helm Chart,通过 ConfigMap 管理配置
```

两种形态**不能混用**。前者由 Prometheus Operator 生成 StatefulSet 与 Secret,`alertmanagerSpec` 是 CRD 字段;后者是纯 Helm Chart,配置写在 `config.*` 里。

数据流:`Prometheus 规则触发 → Alert → Alertmanager 集群(gossip 去重)→ 路由树匹配 → 分组等待 → 通知渠道`

Alertmanager **不产生告警**,没有 Prometheus 规则时它永远安静;反过来 Prometheus 里的 `alerting` 段没配 `alertmanagers` 时,告警只会停留在 Prometheus UI 的 Alerts 页面。

### 安装

```shell
# 方式一:随 kube-prometheus-stack 一起安装(推荐)
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

helm install prometheus prometheus-community/kube-prometheus-stack \
  -n monitoring --create-namespace \
  --set alertmanager.alertmanagerSpec.replicas=3 \
  --set alertmanager.alertmanagerSpec.retention=120h \
  --set alertmanager.alertmanagerSpec.storage.volumeClaimTemplate.spec.resources.requests.storage=10Gi

# 方式二:独立安装(只需要 Alertmanager 时)
helm install alertmanager prometheus-community/alertmanager \
  -n monitoring --create-namespace \
  --set replicaCount=3 \
  --set persistence.size=10Gi
```

独立的 `prometheus-community/alertmanager` Chart 默认值:

```shell
replicaCount: 1
config:
  enabled: true
  global: {}
  templates:
    - '/etc/alertmanager/*.tmpl'
  receivers:
    - name: default-receiver
  route:
    group_wait: 10s
    group_interval: 5m
    receiver: default-receiver
    repeat_interval: 3h
persistence:
  enabled: true
  size: 50Mi
```

### 配置结构

Alertmanager 的配置文件是单一的 YAML,顶层四个字段:

```shell
global:            全局默认值,如 smtp_smarthost、resolve_timeout
templates:         通知模板文件路径列表
route:             路由树(单根,可嵌套 routes)
receivers:         接收器列表(每个 name 被 route 引用)
inhibit_rules:     抑制规则
```

一个完整可用的例子:

```shell
global:
  resolve_timeout: 5m
  smtp_smarthost: 'smtp.example.com:465'
  smtp_from: 'alertmanager@example.com'
  smtp_auth_username: 'alertmanager@example.com'
  smtp_auth_password_file: '/etc/alertmanager/secrets/smtp-password'
  smtp_require_tls: true

templates:
  - '/etc/alertmanager/*.tmpl'

route:
  receiver: 'default-webhook'
  group_by: ['alertname', 'namespace', 'cluster']
  group_wait: 30s          # 同组首条告警的等待时间,用于攒批
  group_interval: 5m       # 同组后续新告警的等待时间
  repeat_interval: 4h      # 未恢复告警的重复通知间隔
  routes:
    - matchers:
        - severity = critical
      receiver: 'oncall-pager'
      group_wait: 10s
      repeat_interval: 1h
      continue: false      # 命中后是否继续匹配后续兄弟路由
    - matchers:
        - namespace = "kube-system"
      receiver: 'default-webhook'
      mute_time_intervals: ['maintenance-window']

receivers:
  - name: 'default-webhook'
    webhook_configs:
      - url: 'http://alert-relay.monitoring.svc:8080/webhook'
        send_resolved: true

  - name: 'oncall-pager'
    email_configs:
      - to: 'oncall@example.com'
        send_resolved: true
    slack_configs:
      - api_url_file: '/etc/alertmanager/secrets/slack-webhook'
        channel: '#alerts'
        title: '{{ .CommonLabels.alertname }}'
        text: '{{ range .Alerts }}{{ .Annotations.summary }}\n{{ end }}'

inhibit_rules:
  - source_matchers: [severity = critical]
    target_matchers: [severity = warning]
    equal: ['alertname', 'namespace']
```

### AlertmanagerConfig CRD

在 Operator 管理的形态下,**推荐不要再写整份配置**,而是让各业务团队在自己命名空间里提交 `AlertmanagerConfig`,由 Operator 合并进最终配置:

```shell
apiVersion: monitoring.coreos.com/v1alpha1
kind: AlertmanagerConfig
metadata:
  name: my-app
  namespace: default
  labels:
    alertmanagerConfig: enabled
spec:
  route:
    receiver: 'my-app-webhook'
    groupBy: ['alertname']
    groupWait: 30s
    groupInterval: 5m
    repeatInterval: 12h
    matchers:
      - name: service
        value: my-app
        matchType: '='
  receivers:
    - name: 'my-app-webhook'
      webhookConfigs:
        - url: 'http://my-relay.default.svc:8080/alert'
          sendResolved: true
  inhibitRules:
    - sourceMatch:
        - name: severity
          value: critical
      targetMatch:
        - name: severity
          value: warning
      equal: ['alertname']
```

让 Alertmanager 实例接收这些配置,靠的是 Prometheus Operator 的三个字段:

```shell
alertmanagerConfigSelector          # 选择哪些 AlertmanagerConfig(默认按 Helm release label 过滤)
alertmanagerConfigNamespaceSelector # 允许从哪些命名空间读取
alertmanagerConfigMatcherStrategy   # OnNamespace(默认)/ None
```

### 高可用与集群

Alertmanager 多副本之间通过 **gossip 协议**(默认端口 9094)同步静默与通知日志,通知去重在**每个副本各自**完成:

```shell
--cluster.listen-address=0.0.0.0:9094   集群监听地址,置为空字符串则禁用集群
--cluster.peer=<ip>:9094                显式指定对端(Operator 会自动配置)
--cluster.advertise-address=            对外通告的地址
--cluster.gossip-interval=200ms
--cluster.settle-timeout=1m             启动后多久开始发通知,等待集群收敛
```

其余常用启动参数:

```shell
--config.file=/etc/alertmanager/config_out/alertmanager.env.yaml
--storage.path=/alertmanager            silences 与 nflog 的落盘位置
--data.retention=120h                   通知日志保留时间,默认 120h
--web.listen-address=:9093
--web.external-url=                     生成通知里的链接,走 Ingress 时必填
--web.route-prefix=/
--log.level=info
```

### 静默与操作

```shell
# 进入 amtool 交互式调试用的 Pod
kubectl exec -it -n monitoring alertmanager-prometheus-kube-prometheus-alertmanager-0 -c alertmanager -- sh

# 校验配置语法(改配置后第一件事)
amtool check-config /etc/alertmanager/config_out/alertmanager.env.yaml

# 查看当前活跃告警
amtool alert query --alertmanager.url=http://localhost:9093
amtool alert query --alertmanager.url=http://localhost:9093 --output=json

# 添加静默(--alertmanager.url 默认 http://localhost:9093)
amtool silence add alertname=NodeNotReady --duration=2h --comment="内核升级维护"
amtool silence add 'namespace=~"dev|test"' --duration=8h --comment="测试环境维护"

# 查询与过期静默
amtool silence query
amtool silence expire <silence-id>

# 查看集群状态
kubectl exec -n monitoring alertmanager-prometheus-kube-prometheus-alertmanager-0 -c alertmanager -- \
  amtool --alertmanager.url=http://localhost:9093 cluster show
```

### 排障

```shell
# 1. 告警没发出来 —— 先看配置是否加载成功
kubectl logs -n monitoring alertmanager-prometheus-kube-prometheus-alertmanager-0 -c alertmanager | grep -i error
kubectl exec -n monitoring alertmanager-prometheus-kube-prometheus-alertmanager-0 -c alertmanager -- \
  amtool check-config /etc/alertmanager/config_out/alertmanager.env.yaml

# 2. 多副本重复发送通知 —— 集群没组成
kubectl exec -n monitoring alertmanager-prometheus-kube-prometheus-alertmanager-0 -c alertmanager -- \
  amtool cluster show --alertmanager.url=http://localhost:9093
kubectl get endpoints -n monitoring alertmanager-operated   # 必须有多于一个地址

# 3. 静默不生效 —— 静默是 gossip 同步的,集群不通就各副本状态不一致
kubectl exec -n monitoring alertmanager-prometheus-kube-prometheus-alertmanager-0 -c alertmanager -- \
  amtool silence query --alertmanager.url=http://localhost:9093

# 4. 路由没匹配上 —— 用 amtool 模拟路由
amtool config routes test --config.file=alertmanager.yml \
  --verify.receivers=oncall-pager severity=critical namespace=default
amtool config routes show --config.file=alertmanager.yml
```

### 注意

1. **不要直接编辑 Operator 生成的 Secret**。`kube-prometheus-stack` 形态下 Alertmanager 配置存在 Secret `alertmanager-<name>-config` 里,由 Operator 根据 `Alertmanager` CRD 与 `AlertmanagerConfig` CRD 实时生成。`kubectl edit secret` 改完几十秒内会被覆盖回去,正确做法是改 CRD 或 values。
2. **`group_wait` / `group_interval` / `repeat_interval` 三个时间语义完全不同**,配错是「通知太吵」或「告警迟到」的主因。`group_wait` 是**新分组第一次发送前的攒批等待**(默认 30s),`group_interval` 是**同组有新告警时的最小发送间隔**(默认 5m),`repeat_interval` 是**告警未恢复时的重复提醒间隔**(默认 4h)。把 `repeat_interval` 设成 5m 会迅速被同事拉黑。
3. **多副本必须能互通 9094 端口**。NetworkPolicy 或节点防火墙挡掉 gossip 流量后,各副本会各自发送一遍通知,表现为「每条告警收到 N 份」。同时确认 Service `alertmanager-operated` 是 headless 且包含了所有副本 Pod IP。
4. **集群刚启动时不要立刻发通知**。`--cluster.settle-timeout` 默认 1m,期间集群还在收敛,设置过小会在滚动重启时产生重复通知。
5. **silence 与通知日志存在本地磁盘**。未配 PVC 时 Pod 重启会丢失全部静默记录,并且因为 nflog 丢失而重复发送「已经发过」的告警。`kube-prometheus-stack` 下用 `alertmanagerSpec.storage.volumeClaimTemplate` 配置;独立 Chart 用 `persistence.enabled`。
6. **`AlertmanagerConfig` 的 `OnNamespace` 匹配策略会自动加 `namespace` 匹配器**。默认 `alertmanagerConfigMatcherStrategy: OnNamespace`,Operator 给每个 AlertmanagerConfig 生成的子路由上强制加一条 `namespace = <该 CR 所在命名空间>`。如果你的告警没有 `namespace` 标签(例如来自集群外的 `ScrapeConfig` 目标),这条路由**永远匹配不上**,只能改用 `None` 策略或在 Prometheus 侧补 `externalLabels`。
7. **`inhibit_rules` 的 `equal` 列表必须写对**。`equal` 里的标签在源告警和目标告警上必须**完全相等**才会抑制。写 `equal: ['alertname']` 意味着只有同名告警才互相抑制,而你的 critical 和 warning 通常名字不同,应当用 `['namespace', 'service']` 之类的维度。
8. **`alertmanagerConfigSelector` 默认按 Helm release label 过滤**。自建的 AlertmanagerConfig 不带 `release: prometheus` 会被静默忽略;要么打对 label,要么设置 `alertmanagerConfigSelectorNilUsesHelmValues: false`。
9. **通知里的链接依赖 `--web.external-url`**。走 Ingress 或 `kubectl port-forward` 访问时,不设 `web.externalUrl` 生成的通知链接会指向 Pod 内部地址,点击打不开。
10. **`resolve_timeout` 影响告警的自动恢复**。默认 5m,Prometheus 侧停止发送某条告警后,Alertmanager 等这个时长才标记为 Resolved 并发送恢复通知。设得比 Prometheus 的 `evaluation_interval` 还小会导致告警反复 Resolved/Firing 抖动。
11. **配置文件里的密码应使用 `*_file` 形式**。`smtp_auth_password`、`api_url` 直接写明文会进入 Secret 并在 UI 上可见,推荐 `smtp_auth_password_file` / `api_url_file` 指向挂载的 Secret 文件。
12. **`prometheus-community/alertmanager` Chart 1.0 起**用 `prometheus-config-reloader` 替换了原来的 `configmap-reload`,老的 `configmapReload.prometheus.extraArgs` 写法不再兼容,升级时会直接报错。
13. **告警规则在 Prometheus 侧,不在 Alertmanager**。本页只处理「告警产生之后」的事情;`expr`、`for`、`labels`、`annotations` 都写在 `PrometheusRule` 里。

### 相关命令

- `prometheus` — Kubernetes集群监控系统与时间序列数据库
- `kubectl` — Kubernetes集群管理工具
- `helm` — Kubernetes包管理器
- `grafana` — 指标可视化与大盘平台

### 参考链接

- [Alertmanager 官方文档](https://prometheus.io/docs/alerting/latest/alertmanager/)
- [Alertmanager 配置参考](https://prometheus.io/docs/alerting/latest/configuration/)
- [amtool 使用文档](https://github.com/prometheus/alertmanager#amtool)
- [AlertmanagerConfig CRD 说明](https://prometheus-operator.dev/docs/developer/alerting/)
- [prometheus-community/alertmanager Chart](https://github.com/prometheus-community/helm-charts/tree/main/charts/alertmanager)
