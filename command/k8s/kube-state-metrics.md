kube-state-metrics
===

Kubernetes对象状态指标导出器

## 补充说明

**kube-state-metrics(KSM)** 监听 Kubernetes API Server,把集群中的**对象状态**转换成 Prometheus 指标暴露出来。它不采集资源用量,只回答「集群里有哪些对象、它们处于什么状态」:有多少 Deployment 的期望副本数没被满足、有多少 Pod 处于 Pending、哪些 PVC 还没绑定、哪些节点被封锁了。

它擅长回答的问题:

- 某个 Deployment 期望 3 副本,实际可用几个?
- 集群里有多少容器处于 `CrashLoopBackOff`?
- 哪些 PVC 仍是 `Pending`,哪些 PV 已释放?
- 哪些节点被 `cordon` 或带着 `disk-pressure` 污点?
- Job 上次成功是什么时候?HPA 当前的目标副本数是多少?

部署形态(通常放在 `kube-system` 或独立的 `monitoring` 命名空间):

```shell
Deployment/kube-state-metrics      主进程,ListWatch 各类资源并生成指标
Service/kube-state-metrics         暴露 /metrics 供 Prometheus 抓取
ServiceAccount + ClusterRole       只读权限,需要 list/watch 绝大多数资源
```

暴露的端口:

```shell
8080   业务指标 /metrics,由 --port 控制
8081   自身运行指标 /metrics,由 --telemetry-port 控制
```

KSM 自身**不存储任何数据**,它只是把 API 对象翻译成指标;历史趋势由 Prometheus 负责。

### 安装

```shell
# 方式一:Helm(推荐)
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm upgrade --install kube-state-metrics prometheus-community/kube-state-metrics \
  --namespace monitoring --create-namespace

# 方式二:官方示例清单(仓库里没有发布版清单文件,需要先克隆)
git clone https://github.com/kubernetes/kube-state-metrics.git
kubectl apply -f kube-state-metrics/examples/standard

# kube-prometheus-stack 已内置 KSM,不要再单独装一份
helm list -A | grep kube-prometheus-stack
```

验证:

```shell
kubectl get deploy,svc -n monitoring -l app.kubernetes.io/name=kube-state-metrics
kubectl port-forward -n monitoring svc/kube-state-metrics 8080:8080

# 在新终端里拉取指标
curl -s localhost:8080/metrics | head -50
curl -s localhost:8080/metrics | grep '^kube_node_status_condition'
curl -s localhost:8081/metrics | grep kube_state_metrics

# 确认 RBAC 是否足够(权限不足时指标会静默变少)
kubectl auth can-i list pods --as=system:serviceaccount:monitoring:kube-state-metrics -A
```

### 常用启动参数

```shell
--port=8080                          业务指标端口
--telemetry-port=8081                自身指标端口
--resources=...                      启用的资源类型,默认已包含绝大多数内置资源
--namespaces=...                     只监听指定命名空间,减少规模
--namespaces-denylist=...            排除指定命名空间
--metric-allowlist=...               白名单,与 denylist 互斥
--metric-denylist=...                黑名单,与 allowlist 互斥
--metric-labels-allowlist=...        把指定的 Kubernetes 标签提升为指标的 label
--metric-annotations-allowlist=...   把指定的注解提升为指标的 label
--metric-opt-in-list=...             启用默认关闭的指标
--custom-resource-state-config-file  自定义资源指标配置
--custom-resource-state-only         只暴露自定义资源指标
--auth-filter                        对 /metrics 启用认证鉴权
--use-apiserver-cache                ListWatch 走 apiserver 缓存,降低 etcd 压力
--shard=0 --total-shards=1           分片,大集群下横向扩展
--tls-config=...                     TLS 配置
```

标签白名单的写法是把资源名和标签键成对列出:

```shell
--metric-labels-allowlist=pods=[app,version],namespaces=[team]
--metric-annotations-allowlist=pods=[owner],deployments=[team]
```

**默认情况下 KSM 不暴露 `kube_pod_labels` 里的业务标签**,只暴露 `pod`、`namespace` 等基础标签 —— 想按 `app`、`team` 做聚合必须显式配置白名单,这是初次接入时最常踩的坑。

### 核心指标

节点相关:

```shell
kube_node_info                     节点基本信息(kubelet 版本、运行时、内核、内网 IP)
kube_node_status_condition         节点 Condition,label 为 condition 与 status(true/false/unknown)
kube_node_spec_unschedulable       节点是否被封锁(cordon)
kube_node_spec_taint               节点污点,label 为 key、value、effect
kube_node_status_capacity          节点总容量,label 为 resource、unit
kube_node_status_allocatable       节点可分配资源,label 为 resource、unit
kube_node_role                     节点角色,label 为 role
kube_node_created                  节点对象创建时间
```

Pod 与容器相关:

```shell
kube_pod_info                               Pod 基本信息,含 node、pod_ip、created_by_kind
kube_pod_status_phase                       Pod 阶段,label 为 phase(Pending/Running/Succeeded/Failed/Unknown)
kube_pod_status_ready                       Pod 是否就绪,label 为 condition
kube_pod_status_scheduled                   Pod 是否已调度
kube_pod_status_unschedulable               是否因调度失败被标记为不可调度
kube_pod_status_reason                      Pod 状态原因(Evicted、NodeLost、Shutdown 等)
kube_pod_container_status_waiting_reason    容器等待原因,label 为 reason
kube_pod_container_status_last_terminated_reason  容器上次终止原因(OOMKilled、Error 等)
kube_pod_container_status_restarts_total    容器重启次数(Counter)
kube_pod_container_status_ready             容器就绪探针是否通过
kube_pod_container_resource_requests        容器的 requests,label 为 resource、unit
kube_pod_container_resource_limits          容器的 limits,label 为 resource、unit
kube_pod_owner                              Pod 的属主(owner_kind / owner_name)
kube_pod_created / kube_pod_start_time      Pod 的创建与启动时间
```

工作负载与存储:

```shell
kube_deployment_status_replicas            期望副本数
kube_deployment_status_replicas_available  可用副本数
kube_deployment_status_replicas_unavailable 不可用副本数
kube_deployment_status_condition           Deployment 状况
kube_deployment_spec_replicas              期望副本数(spec)
kube_daemonset_status_number_ready          DaemonSet 就绪数
kube_statefulset_status_replicas_ready      StatefulSet 就绪数
kube_job_status_succeeded / kube_job_status_failed  Job 成功与失败数
kube_persistentvolumeclaim_status_phase     PVC 阶段(Pending/Bound/Lost)
kube_persistentvolume_status_phase          PV 阶段
kube_horizontalpodautoscaler_status_current_replicas  HPA 当前副本数
kube_poddisruptionbudget_status_current_healthy       PDB 当前健康副本数
```

指标状态分三档,升级 KSM 大版本前应当关注 `EXPERIMENTAL` 与 `DEPRECATED` 的部分:

| 状态 | 含义 |
| --- | --- |
| `STABLE` | 除大版本外极少有破坏性变更,可以放心依赖 |
| `EXPERIMENTAL` | 对应 alpha 字段,可能随时变化或删除 |
| `DEPRECATED` | 已废弃,将在既定时间点移除 |

### 与 metrics-server 的分工

两者名字相近,定位完全不同,经常被混为一谈:

| 组件 | 数据内容 | 数据来源 | 典型用途 |
| --- | --- | --- | --- |
| `metrics-server` | 实时**资源用量**(CPU、内存实际占用) | kubelet Summary API | `kubectl top`、HPA |
| `kube-state-metrics` | **对象状态**(副本数、状态、条件、数量) | API Server 中的对象 | 监控大盘、告警规则 |
| cAdvisor / kubelet | 容器级资源用量原始数据 | 容器运行时 | Prometheus 抓取用量指标 |

关键区别:**KSM 不提供资源用量**。`kube_pod_container_resource_requests` 是容器**申请**的资源,不是实际消耗。要做 CPU/内存使用率监控,需要另行抓取 kubelet 的 cAdvisor 指标(如 `container_cpu_usage_seconds_total`),再与 KSM 的 requests 指标做关联查询。

### 自定义资源指标

KSM 支持把 CRD 的状态导出为指标,通过 `--custom-resource-state-config-file` 指定配置文件:

```shell
kubectl create configmap ksm-crs-config --from-file=crs-config.yaml -n monitoring
```

```shell
kind: CustomResourceStateMetrics
spec:
  resources:
    - groupVersionKind:
        group: cert-manager.io
        version: v1
        kind: Certificate
      metrics:
        - name: "certmanager_certificate_expiration_timestamp_seconds"
          help: "证书过期时间戳"
          each:
            type: Gauge
            gauge:
              path: [status, notAfter]
              valueMultiplier: 1
```

需要注意:`custom-resource-state` 已被上游标记为**特性冻结**,官方推荐迁移到 `resource-state-metrics` 项目。新接入的项目应当评估这个方向。

### 常用 PromQL 示例

```shell
# 期望副本数与可用副本数不一致的 Deployment
kube_deployment_spec_replicas - kube_deployment_status_replicas_available != 0

# 处于 Pending 的 Pod
sum by (namespace, pod) (kube_pod_status_phase{phase="Pending"}) > 0

# 正在崩溃循环的容器
kube_pod_container_status_waiting_reason{reason="CrashLoopBackOff"} > 0

# 被 cordon 的节点
kube_node_spec_unschedulable > 0

# 带磁盘压力的节点
kube_node_status_condition{condition="DiskPressure", status="true"} > 0

# 未被绑定的 PVC
kube_persistentvolumeclaim_status_phase{phase="Pending"} > 0

# 容器重启次数增长最快的 Pod
topk(10, sum by (namespace, pod) (increase(kube_pod_container_status_restarts_total[1h])))

# 最近一小时内被 OOMKilled 的容器
kube_pod_container_status_last_terminated_reason{reason="OOMKilled"} > 0

# 关联 KSM 与用量指标:某个 namespace 的实际内存用量与 requests 之比
sum(container_memory_working_set_bytes{namespace="dev"})
  / sum(kube_pod_container_resource_requests{namespace="dev", resource="memory"})
```

### 注意

1. **kube-state-metrics 与 metrics-server 完全不同**。KSM 只反映对象状态,不提供 CPU/内存实际用量。想用 `kube_pod_container_resource_requests` 替代 `kubectl top`,或者反过来想用 KSM 算使用率,都是方向性错误。
2. **业务标签默认不暴露**。`kube_pod_labels`、`kube_deployment_labels` 只带 `pod`、`namespace` 等基础标签,`app`、`team` 这类标签必须通过 `--metric-labels-allowlist` 显式放行,否则按业务维度聚合的告警全部失效。
3. **`--metric-labels-allowlist` 用通配符 `=pods=[*]` 会严重拖慢性能**,在高基数标签(如 `pod-template-hash`)上尤其明显,还可能造成 Prometheus 侧的时间序列爆炸。应按需列出具体标签键。
4. **`--metric-allowlist` 与 `--metric-denylist` 互斥**,同时配置会导致启动失败。
5. **不要与 kube-prometheus-stack 重复部署**。该 Chart 已经内置 KSM,再单独装一份会出现两个 Service 争抢抓取目标,面板数据出现重复或抖动。
6. **RBAC 权限不足时不会报错,只会静默少指标**。某个资源类型没有 `list`/`watch` 权限,对应的 `kube_*` 指标就整段消失,排查时应先看 KSM 日志中的 `forbidden` 字样。
7. **`kube_node_status_condition` 是「每个 status 一条序列」**,`true`/`false`/`unknown` 各占一条。查询时必须写 `status="true"`,否则同一条告警会同时命中 `false` 序列而误报。
8. **`kube_pod_status_phase` 无法区分 `Terminating` 与 `Unknown`**,因为这两个状态不存在于 `Pod.Status` 字段里,需要组合 `kube_pod_deletion_timestamp` 与 `kube_pod_status_reason` 才能推导出来。
9. **大集群需要分片**。KSM 对每个对象都要维护一份内存中的状态,数万 Pod 时单实例很容易吃满内存,应使用 `--shard` / `--total-shards` 拆分,或配合 `--namespaces` 限定范围。
10. **`kube_pod_container_resource_requests` 与调度器视角存在偏差**。上游已推荐改用 kube-scheduler 在 `/metrics/resources` 暴露的 `kube_pod_resource_request`,后者计算的是包含 Pod 级资源和 init 容器取大值之后的**有效**资源需求,更精确。
11. **KSM 升级大版本会移除指标**。1.x 到 2.x 移除了大量 `kube_*` 旧指标,升级前务必对照发布说明检查告警规则与大盘表达式。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `metrics-server` — 集群资源指标采集组件,与 KSM 互补
- `prometheus` — 指标存储与查询系统,抓取 KSM 的 /metrics
- `hpa` — 水平自动扩缩容,依赖 metrics-server
- `kubelet` — 节点代理,资源用量的原始来源

### 参考链接

- [kube-state-metrics GitHub 仓库](https://github.com/kubernetes/kube-state-metrics)
- [KSM 指标文档](https://github.com/kubernetes/kube-state-metrics/tree/main/docs)
- [KSM 命令行参数](https://github.com/kubernetes/kube-state-metrics/blob/main/docs/developer/cli-arguments.md)
- [KSM 自定义资源指标](https://github.com/kubernetes/kube-state-metrics/blob/main/docs/metrics/extend/customresourcestate-metrics.md)
- [资源指标管道官方文档](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/)
