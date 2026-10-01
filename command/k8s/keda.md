keda
===

Kubernetes事件驱动自动伸缩组件

## 补充说明

**KEDA**(Kubernetes Event-driven Autoscaling)是在 HPA 之上做**事件驱动伸缩**的组件。它不是 HPA 的替代品,而是 HPA 的**扩展**:KEDA 读取外部事件源(消息队列长度、数据库行数、cron 表达式等)的指标,生成并维护一个 HPA,由这个 HPA 去真正调整副本数。

相比原生 HPA,KEDA 补齐了两个关键能力:

- **按外部事件伸缩**:Kafka 堆积消息数、RabbitMQ 队列长度、Redis 列表长度、PostgreSQL 查询结果都可以作为伸缩依据。
- **缩容到零**:`minReplicaCount: 0` 时可以把工作负载缩到 0 个副本,有事件时再从 0 拉起 —— 原生 HPA 的最小副本数是 1。

核心对象(API 组为 `keda.sh/v1alpha1`):

- **ScaledObject** —— 描述「哪个工作负载」按「哪些触发器」伸缩,Deployment/StatefulSet 都适用。
- **ScaledJob** —— 面向 Job 的伸缩,每个事件创建一个 Job,不经过 HPA。
- **TriggerAuthentication** —— 命名空间级的触发器凭据。
- **ClusterTriggerAuthentication** —— 集群级的触发器凭据,可跨命名空间复用。

官方要求 Kubernetes **v1.29 及以上**。

### 安装

```shell
# 方式一:Helm(推荐)
helm repo add kedacore https://kedacore.github.io/charts
helm repo update
helm install keda kedacore/keda --namespace keda --create-namespace

# 方式二:官方 YAML(带准入 Webhook,2.17.3 为例)
kubectl apply --server-side -f \
  https://github.com/kedacore/keda/releases/download/v2.17.3/keda-2.17.3.yaml

# 不带准入 Webhook 的版本(集群无法运行 Webhook 时使用)
kubectl apply --server-side -f \
  https://github.com/kedacore/keda/releases/download/v2.17.3/keda-2.17.3-core.yaml

# 只安装 CRD(需要单独管理 CRD 时)
kubectl apply -f https://github.com/kedacore/keda/releases/download/v2.17.3/keda-2.17.3-crds.yaml

# 验证
kubectl get pods -n keda
kubectl get crd | grep keda
```

官方 YAML 安装后会出现三个工作负载:`keda-operator`(控制器)、`keda-metrics-apiserver`(指标适配层,把外部指标以 `external.metrics.k8s.io` 的形式暴露给 HPA)、`keda-admission`(准入 Webhook,仅带 Webhook 的清单包含)。用 Helm 安装时名称会带上 release 前缀,以 `kubectl get deploy -n keda` 的实际输出为准。

### ScaledObject:最小可用示例

```shell
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: order-consumer
  namespace: default
spec:
  scaleTargetRef:
    name: order-consumer          # 目标 Deployment 名称
    # 多容器 Pod 中取哪个容器的资源指标
    # envSourceContainerName: order-consumer
  # 缩容到零必须显式写 0(默认值就是 0)
  minReplicaCount: 0
  maxReplicaCount: 30
  pollingInterval: 15             # 每 15 秒查询一次事件源,默认 30
  cooldownPeriod: 120             # 最后一次触发后多久缩容,默认 300
  advanced:
    # 删除 ScaledObject 时把副本数恢复为原始值
    restoreToOriginalReplicaCount: true
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          policies:
          - type: Percent
            value: 50
            periodSeconds: 60
  triggers:
  - type: kafka
    metadata:
      bootstrapServers: kafka.default.svc.cluster.local:9092
      consumerGroup: order-consumer
      topic: orders
      lagThreshold: "100"         # 堆积超过 100 条开始扩容
      offsetResetPolicy: latest
    authenticationRef:
      name: kafka-auth
```

### TriggerAuthentication:凭据

触发器需要的密码、Token 不应写在 ScaledObject 里,而是引用 Secret:

```shell
apiVersion: keda.sh/v1alpha1
kind: TriggerAuthentication
metadata:
  name: kafka-auth
  namespace: default
spec:
  secretTargetRef:
  - parameter: sasl
    name: kafka-credentials
    key: sasl
  - parameter: username
    name: kafka-credentials
    key: username
  - parameter: password
    name: kafka-credentials
    key: password
---
apiVersion: v1
kind: Secret
metadata:
  name: kafka-credentials
  namespace: default
type: Opaque
stringData:
  sasl: plaintext
  username: keda
  password: "******"
```

跨命名空间复用同一份凭据时改用 `ClusterTriggerAuthentication`,它在 `authenticationRef` 中通过 `kind: ClusterTriggerAuthentication` 指定。

### ScaledJob:面向 Job 的伸缩

批处理任务不适合用 HPA 调副本数,而是「来一个事件起一个 Job」:

```shell
apiVersion: keda.sh/v1alpha1
kind: ScaledJob
metadata:
  name: video-transcode
  namespace: default
spec:
  jobTargetRef:
    parallelism: 1
    completions: 1
    template:
      spec:
        restartPolicy: Never
        containers:
        - name: worker
          image: registry.example.com/transcoder:1.2.0
  pollingInterval: 30
  maxReplicaCount: 20
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  scalingStrategy:
    strategy: "default"           # default / accurate / custom
  triggers:
  - type: rabbitmq
    metadata:
      protocol: amqp
      queueName: transcode
      mode: QueueLength
      value: "5"
    authenticationRef:
      name: rabbitmq-auth
```

### 常用命令

```shell
# 查看 KEDA 对象
kubectl get scaledobject -A
kubectl get scaledjob -A
kubectl get triggerauthentication -A
kubectl describe scaledobject order-consumer -n default

# KEDA 生成的 HPA(命名规则固定)
kubectl get hpa -n default
kubectl describe hpa keda-hpa-order-consumer -n default

# 当前暴露出来的外部指标(指标名由 KEDA 生成,如 s1-rabbitmq-queueName2)
kubectl get scaledobject order-consumer -n default \
  -o jsonpath='{.status.externalMetricNames}'
kubectl get --raw "/apis/external.metrics.k8s.io/v1beta1" | head -c 500

# 排查伸缩不生效
kubectl logs -n keda deploy/keda-operator --tail=200
kubectl logs -n keda deploy/keda-metrics-apiserver --tail=200

# 查看目标工作负载副本数变化
kubectl get deploy order-consumer -n default -w
```

### 卸载

```shell
# 1. 先删除所有 ScaledObject / ScaledJob(重要!)
kubectl delete scaledobject --all -A
kubectl delete scaledjob --all -A

# 2. 再卸载
helm uninstall keda --namespace keda
kubectl delete namespace keda

# 3. 如果命名空间卡在 Terminating,手工清除 finalizer
kubectl patch scaledobject <resource-name> -p '{"metadata":{"finalizers":null}}' --type=merge
kubectl patch scaledjob <resource-name> -p '{"metadata":{"finalizers":null}}' --type=merge
```

### 注意

1. **一个工作负载只能有一个 HPA 管着**。KEDA 会为每个 ScaledObject 自动创建一个 HPA,默认名为 `keda-hpa-<scaledobject 名>`(可用 `advanced.horizontalPodAutoscalerConfig.name` 覆盖);若目标工作负载上已经存在别的 HPA,必须显式让 ScaledObject 接管 —— 加上 `scaledobject.keda.sh/transfer-hpa-ownership: "true"` 注解,并把 `advanced.horizontalPodAutoscalerConfig.name` 写成那个已有 HPA 的名字,否则两者会争夺副本数,表现为副本数剧烈抖动。
2. **生成的 HPA 不要手改**。它由 ScaledObject 派生,KEDA 会持续把它同步回期望状态;要定制行为请写进 ScaledObject 的 `advanced.horizontalPodAutoscalerConfig`(如 `behavior` 的缩容策略)。
3. **卸载 KEDA 前先删掉 ScaledObject / ScaledJob**。这些对象带有 finalizer,而清理 finalizer 的正是 KEDA 控制器本身;先卸载控制器会让对象卡在 Terminating,命名空间随之无法删除。已经卡住时用 `kubectl patch scaledobject <name> -p '{"metadata":{"finalizers":null}}' --type=merge` 清除 finalizer(官方卸载文档给出的正是这条命令)。
4. **缩容到零后卸载 KEDA,服务就再也起不来了**。工作负载停在 0 副本且没有任何组件会把它拉起来,表现为「服务莫名其妙全挂」。删除 ScaledObject 前先确认 `restoreToOriginalReplicaCount` 的行为符合预期。
5. **默认 5 分钟冷却期会让压测「看起来没生效」**。`cooldownPeriod` 默认 300 秒、`pollingInterval` 默认 30 秒,压测时缩容滞后是正常现象,不要误判为故障;调参时把这两个值一并考虑。
6. **cpu / memory 触发器仍然需要 metrics-server**。KEDA 自己提供的只是 `external.metrics.k8s.io`,资源类指标走的是 `metrics.k8s.io`,缺少 metrics-server 时这类触发器会一直报错。
7. **`minReplicaCount: 0` 才叫缩容到零**。只写 `minReplicaCount: 1` 时和普通 HPA 没有区别;另外并非所有触发器都支持从零拉起,部分触发器需要额外的 `activationValue` 之类的激活阈值。
8. **缩容到零会带来冷启动**。副本归零后第一个请求要经历镜像拉取与进程启动,对延迟敏感的服务应保留 `minReplicaCount: 1` 或配置 `activationThreshold`。
9. **TriggerAuthentication 有命名空间边界**。跨命名空间复用凭据必须用 `ClusterTriggerAuthentication`,否则 ScaledObject 会报找不到认证对象。
10. **ScaledJob 产生的 Job 不会自动消失**。必须设置 `successfulJobsHistoryLimit` 与 `failedJobsHistoryLimit`,否则 Job 与 Pod 会不断累积,最终压垮 etcd。
11. **CRD 由 Chart 管理,升级老版本要当心**。KEDA 2.2.1 起 Helm Chart 自己安装并升级 CRD,从更早版本升级会出现 CRD 版本不匹配;升级前建议先备份 ScaledObject 定义。
12. **`pollingInterval` 调得过小会压垮事件源**。每个 ScaledObject 都会按自己的周期去查询事件源,大量对象 × 极短周期等于对 Kafka/数据库做压测,生产环境建议不低于 15 秒。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `hpa` — Kubernetes水平自动伸缩
- `metrics-server` — Kubernetes资源指标采集组件
- `knative` — Kubernetes无服务器运行时
- `argo-workflows` — Kubernetes原生工作流引擎

### 参考链接

- [KEDA 官方文档](https://keda.sh/docs/)
- [KEDA 部署指南](https://keda.sh/docs/2.17/deploy/)
- [ScaledObject 规格](https://keda.sh/docs/2.17/reference/scaledobject-spec/)
- [ScaledJob 规格](https://keda.sh/docs/2.17/reference/scaledjob-spec/)
- [GitHub 仓库](https://github.com/kedacore/keda)
