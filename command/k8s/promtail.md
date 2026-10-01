promtail
===

Loki官方日志采集代理,以DaemonSet形态采集容器日志

## 补充说明

**Promtail** 是 Grafana Loki 的官方日志采集代理。它以 DaemonSet 形态运行在每个节点上,从宿主机路径读取容器日志文件,附加 Kubernetes 元数据(Pod 名、命名空间、标签、容器名)作为 Loki 标签,再推送到 Loki 的写入端点。

Promtail 的核心工作流程:

```shell
发现目标      通过 kubernetes_sd_configs 列出节点上的 Pod
确定文件路径  把 /var/log/pods/<ns>_<pod>_<uid>/<container>/*.log 映射为 __path__
打标签        namespace / pod / container / app 等
解析与改写     pipeline_stages:cri、json、regex、multiline、labels
推送          批量推送到 Loki 的 /loki/api/v1/push
记录位点      把每个文件的读取偏移写入 positions.yaml
```

**重要:Promtail 已于 2026 年 3 月 2 日到达生命周期终点(EOL)**。官方文档明确说明「Promtail is end of life (EOL) as of March 2, 2026」,不再提供后续支持与更新,所有新功能开发已转移到 **Grafana Alloy**。新集群应直接使用 Alloy(`loki.source.file` + `loki.write` 组件),已有集群可继续运行 Promtail,但需要规划迁移。

组件构成:

```shell
DaemonSet/promtail            每个节点一个采集 Pod
ConfigMap/promtail            抓取与管道配置
ServiceAccount/promtail       需要 pods、namespaces、nodes 的读权限
ClusterRole/ClusterRoleBinding 跨命名空间发现目标
```

### 安装

```shell
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update

# 最小安装:指向同命名空间下的 loki-gateway
helm install promtail grafana/promtail \
  -n monitoring \
  --set 'config.clients[0].url=http://loki-gateway.monitoring.svc/loki/api/v1/push'

# 用已有 Secret 承载配置
helm install promtail grafana/promtail -n monitoring \
  --set configMap.create=false \
  --set 'config.clients[0].url=http://loki.monitoring.svc:3100/loki/api/v1/push'

# 导出 Chart 自带配置作为起点
helm show values grafana/promtail > promtail-values.yaml
```

Chart 默认值要点:

```shell
daemonset:
  enabled: true        # 默认以 DaemonSet 运行
deployment:
  enabled: false       # 单节点采集时改用 Deployment
config:
  clients:
    - url: http://loki-gateway/loki/api/v1/push   # 注意:这是同命名空间下的简写
  snippets:
    pipelineStages:
      - cri: {}        # Kubernetes 1.24+ 必须保留
    common:            # 设置 namespace / pod / container / job / __path__
    addScrapeJobLabel: false
    extraRelabelConfigs: []
tolerations:           # 默认容忍 master 与 control-plane 节点
  - operator: Exists
    effect: NoSchedule
    key: node-role.kubernetes.io/master
  - operator: Exists
    effect: NoSchedule
    key: node-role.kubernetes.io/control-plane
resources: {}
service:
  enabled: false       # 默认不创建 Service
```

### 配置文件结构

```shell
server:
  http_listen_port: 3101
  grpc_listen_port: 0

positions:
  filename: /run/promtail/positions.yaml

clients:
  - url: http://loki-gateway.monitoring.svc/loki/api/v1/push
    tenant_id: fake              # Loki auth_enabled 为 true 时必填
    batchwait: 1s
    batchsize: 1048576           # 单批最大字节数
    backoff_config:
      min_period: 500ms
      max_period: 5m
      max_retries: 10
    external_labels:
      cluster: prod

scrape_configs:
  - job_name: kubernetes-pods
    pipeline_stages:
      - cri: {}
    kubernetes_sd_configs:
      - role: pod
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_controller_name]
        regex: ([0-9a-z-.]+?)(-[0-9a-f]{8,10})?
        action: replace
        target_label: __tmp_controller_name
      - source_labels: [__meta_kubernetes_pod_label_app]
        target_label: app
      - source_labels: [__meta_kubernetes_namespace]
        target_label: namespace
      - source_labels: [__meta_kubernetes_pod_name]
        target_label: pod
      - source_labels: [__meta_kubernetes_pod_container_name]
        target_label: container
      - source_labels: ['__meta_kubernetes_pod_node_name']
        target_label: node
      - replacement: /var/log/pods/*$1/*.log
        separator: /
        source_labels:
          - __meta_kubernetes_pod_uid
          - __meta_kubernetes_pod_container_name
        target_label: __path__
```

### 管道阶段(Pipeline Stages)

`pipeline_stages` 按顺序处理每一行日志,是 Promtail 最常需要定制的地方:

```shell
pipeline_stages:
  # 1. 解析 CRI 格式(Kubernetes 1.24+ 默认格式)
  - cri: {}

  # 2. 多行合并(Java 堆栈、Python traceback 必配)
  - multiline:
      firstline: '^\d{4}-\d{2}-\d{2}'
      max_wait_time: 3s
      max_lines: 128

  # 3. 解析 JSON
  - json:
      expressions:
        level: level
        msg: message
        trace_id: trace_id
      drop_malformed: true

  # 4. 把解析出的字段提升为标签(谨慎:高基数会打爆 Loki)
  - labels:
      level:

  # 5. 用时间戳替换采集时间
  - timestamp:
      source: time
      format: RFC3339Nano

  # 6. 正则提取
  - regex:
      expression: '^(?P<ip>\S+) (?P<method>\S+) (?P<path>\S+) (?P<status>\d+)$'

  # 7. 按内容丢弃(降低噪声与成本)
  - drop:
      expression: '.*healthz.*'
      drop_counter_reason: healthz_probe

  # 8. 改写输出
  - output:
      source: msg
```

### 验证与排障

```shell
# 查看 Pod 是否在全部节点就绪
kubectl get ds -n monitoring promtail
kubectl get po -n monitoring -l app.kubernetes.io/name=promtail -o wide

# 查看日志:最常见的是配置解析失败与推送失败
kubectl logs -n monitoring ds/promtail --tail=100
kubectl logs -n monitoring ds/promtail | grep -iE "error|warn|level=error"

# 确认目标发现是否正常
kubectl port-forward -n monitoring ds/promtail 3101:3101
curl -s localhost:3101/targets | head -c 2000
curl -s localhost:3101/service-discovery | head -c 2000

# 查看内置指标
curl -s localhost:3101/metrics | grep -E "promtail_sent_bytes_total|promtail_dropped_bytes_total|promtail_request_duration"

# 确认位点文件
kubectl exec -n monitoring ds/promtail -- ls -l /run/promtail/
kubectl exec -n monitoring ds/promtail -- tail -5 /run/promtail/positions.yaml

# 确认挂载路径存在
kubectl exec -n monitoring ds/promtail -- ls /var/log/pods | head

# 用 dry-run 校验配置
kubectl exec -n monitoring ds/promtail -- cat /etc/promtail/config.yml
```

### 注意

1. **Promtail 已 EOL**。官方文档写明「Promtail is end of life (EOL) as of March 2, 2026」,不再有安全更新与功能迭代。新部署请直接用 Grafana Alloy;`lambda-promtail` 是唯一不在 EOL 范围内的部分。
2. **`config.clients[0].url` 的默认值是 `http://loki-gateway/loki/api/v1/push`**,这是 Helm 渲染时的相对写法,只在「Loki 与 Promtail 在同一个命名空间且 Service 就叫 `loki-gateway`」时才成立。跨命名空间部署时不在 values 里覆盖这个地址,Promtail 会持续 DNS 解析失败并把数据全部积压在本地。
3. **位点(positions)文件必须持久化**。Promtail 靠 `positions.yaml` 记录每个日志文件读到哪一行。丢失位点会导致**整份日志被重新推送一遍**(产生大量重复),或更糟 —— 被当作已完成而漏采。Chart 把 `/run/promtail` 挂成 hostPath,而许多发行版的 `/run` 是 tmpfs,**节点重启后位点即丢失**。生产应改为挂载到真实的持久化目录。
4. **`- cri: {}` 阶段不能删**。Kubernetes 1.24 移除 dockershim 后,容器运行时统一输出 CRI 格式(`2024-01-01T00:00:00.000000000Z stdout F 内容`)。没有这个阶段,日志正文里会带上一整串时间戳与流标记,而且 `timestamp` 阶段也拿不到正确时间。
5. **多行日志默认会一行一条**。Java 异常堆栈、Python traceback、SQL 语句都会被拆成几十条独立的日志行,在 Grafana 里翻起来非常痛苦。必须配置 `multiline` 阶段,且 `firstline` 正则要能匹配每条日志的起始行。
6. **不要用高基数标签**。把 `pod` 名(带随机后缀)做标签,每次发布都会产生一批新流;把 `trace_id`、`user_id`、`path` 做标签会直接打爆索引。Promtail 侧提升为标签前先问:这个字段的取值数量是否可控?
7. **`service.enabled` 默认为 `false`**,所以默认不会创建 Service。想让 Prometheus 通过 ServiceMonitor 抓 Promtail 自身指标,必须显式打开,否则 ServiceMonitor 找不到目标。
8. **Promtail 需要宿主机路径的读权限**。它要挂载 `/var/log/pods`(containerd/CRI-O)以及部分发行版的 `/var/lib/docker/containers`(Docker)。用 `securityContext.readOnlyRootFilesystem` 或受限的 PodSecurity 策略时,这些 hostPath 挂载会被拒绝。
9. **RBAC 不可少**。`kubernetes_sd_configs` 需要列出 pods、namespaces、nodes、services 的权限。手工编写清单时忘记 ClusterRole,表现为目标发现为空、`/targets` 页面一片空白,而日志里几乎看不出原因。
10. **`tolerations` 默认已覆盖 master 与 control-plane**,但**新版本 Kubernetes 的污点键是 `node-role.kubernetes.io/control-plane`**,老集群是 `master`,依赖 `operator: Exists` 才两边都能容忍。如果自己重写了 `tolerations`,记得保留这两条,否则控制平面节点的日志不会被采集。
11. **推送失败会无限重试并占用磁盘**。`clients` 里的 `backoff_config.max_retries` 默认较高,当 Loki 长时间不可用时,Promtail 会把待发送数据堆在内存中并反复重试。应当配置合理的 `max_retries` 并监控 `promtail_dropped_bytes_total`。
12. **单条日志行长度受 Loki 侧 `max_message_length` 限制**。Promtail 把整行原样推送,超过限制的日志会被 Loki 拒绝并报 `entry too long`。长行日志(如打印整个 JSON 响应体)需要在管道里用 `output` 阶段截断。
13. **`tenant_id` 必须与 Loki 的 `auth_enabled` 一致**。Loki 开启多租户时,请求必须带租户标识;Promtail 侧的 `clients[].tenant_id` 就是写入这个头。缺失时报错与直接 curl 一样是 401。
14. **`compression` 默认关闭**。跨可用区或跨机房推送日志时建议打开 `clients[].compression: gzip`,能显著降低带宽,代价是 Promtail 侧 CPU 占用上升。
15. **不要在一个集群里同时跑 Promtail 和 Alloy 采集同一批文件**。两者都会记录各自的位点,同时读取会让 Loki 收到重复日志。迁移时应当先停掉 Promtail 再启动 Alloy,并清理旧位点文件。

### 相关命令

- `loki` — 水平可扩展的日志聚合系统
- `fluent-bit` — 轻量级日志与指标采集器
- `fluentd` — 日志采集与转发守护进程
- `grafana` — 指标可视化与大盘平台
- `kubectl` — Kubernetes集群管理工具

### 参考链接

- [Promtail 官方文档](https://grafana.com/docs/loki/latest/send-data/promtail/)
- [Promtail 配置参考](https://grafana.com/docs/loki/latest/send-data/promtail/configuration/)
- [Promtail 管道阶段](https://grafana.com/docs/loki/latest/send-data/promtail/stages/)
- [从 Promtail 迁移到 Alloy](https://grafana.com/docs/loki/latest/send-data/alloy/)
- [grafana/helm-charts promtail](https://github.com/grafana/helm-charts/tree/main/charts/promtail)
