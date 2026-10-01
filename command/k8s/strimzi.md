strimzi
===

在Kubernetes上以Operator方式运行管理Apache Kafka集群

## 补充说明

**Strimzi** 是 CNCF 项目,通过 Operator 模式在 Kubernetes 上部署和管理 Apache Kafka。集群、Topic、用户、Connect、MirrorMaker 2 全部抽象为 CRD,由 Operator 持续调谐成实际的 StatefulSet、Service、ConfigMap 与 Secret。

Strimzi 内部同时运行三个 Operator:

| Operator | 监听的 CRD | 职责 |
| --- | --- | --- |
| Cluster Operator | `Kafka`、`KafkaNodePool`、`KafkaConnect`、`KafkaMirrorMaker2`、`KafkaBridge`、`KafkaRebalance` | 部署并管理 Kafka 集群本身 |
| Topic Operator | `KafkaTopic` | 把 CR 同步为 Kafka 中的 Topic,反向变更也同步回 CR |
| User Operator | `KafkaUser` | 管理 Kafka 用户、ACL 与客户端 TLS 证书 |

**1.x 只支持 KRaft**。Kafka 4.0 起彻底移除 ZooKeeper,Strimzi 自 **0.46** 起不再支持 ZooKeeper 模式的集群;1.0 起 CRD 只保留 `kafka.strimzi.io/v1`(`v1beta2`/`v1beta1`/`v1alpha1` 均已移除)。旧集群要升到 1.x,**必须先在 0.45.x 上完成 ZooKeeper 到 KRaft 的迁移**。

另一个 1.x 的关键变化:broker 的**副本数与存储定义在 `KafkaNodePool`**,`Kafka` 资源里已经没有 `spec.kafka.replicas` 和 `spec.kafka.storage`,旧清单必须改写。

### 安装

```shell
kubectl create namespace kafka

# 官方一键安装(最新版)
kubectl create -f 'https://strimzi.io/install/latest?namespace=kafka' -n kafka

kubectl create -f https://github.com/strimzi/strimzi-kafka-operator/releases/download/1.2.0/strimzi-cluster-operator-1.2.0.yaml -n kafka

# Helm 安装
helm repo add strimzi https://strimzi.io/charts/
helm repo update
helm install strimzi-kafka-operator strimzi/strimzi-kafka-operator -n kafka --create-namespace
```

### CRD 家族

```shell
kafka.strimzi.io/v1
  Kafka                     Kafka 集群(不含副本数与存储)
  KafkaNodePool             节点池(副本数、角色、存储)
  KafkaTopic                Topic
  KafkaUser                 用户与 ACL
  KafkaConnect              Connect 集群(另有 MirrorMaker2、Bridge)
  KafkaRebalance            Cruise Control 再均衡任务
```

### 最小 KRaft 集群

`KafkaNodePool` 通过 label `strimzi.io/cluster` 关联到 Kafka 集群。生产把 controller 与 broker 拆成两个池,这里用单池双角色演示:

```shell
apiVersion: kafka.strimzi.io/v1
kind: KafkaNodePool
metadata:
  name: dual-role
  labels:
    strimzi.io/cluster: my-cluster
spec:
  replicas: 3
  roles:
    - controller
    - broker
  storage:
    type: jbod
    volumes:
      - id: 0
        type: persistent-claim
        size: 200Gi
        class: fast
        deleteClaim: false
        kraftMetadata: shared
---
apiVersion: kafka.strimzi.io/v1
kind: Kafka
metadata:
  name: my-cluster
spec:
  kafka:
    version: 4.3.1
    metadataVersion: 4.3-IV0
    listeners:
      - name: plain
        port: 9092
        type: internal
        tls: false
    config:
      offsets.topic.replication.factor: 3
      transaction.state.log.replication.factor: 3
      min.insync.replicas: 2
  entityOperator:
    topicOperator: {}
    userOperator: {}
```

```shell
kubectl apply -f kafka.yaml -n kafka

# 等待就绪;客户端统一从 bootstrap Service 接入
kubectl get kafka -n kafka -w
kubectl get svc -n kafka my-cluster-kafka-bootstrap
```

### Topic 与 User

```shell
apiVersion: kafka.strimzi.io/v1
kind: KafkaTopic
metadata:
  name: orders
  labels:
    strimzi.io/cluster: my-cluster
spec:
  partitions: 12
  replicas: 3
---
apiVersion: kafka.strimzi.io/v1
kind: KafkaUser
metadata:
  name: order-app
  labels:
    strimzi.io/cluster: my-cluster
spec:
  authentication:
    type: tls
  authorization:
    type: simple
    acls:
      - resource: {type: topic, name: orders}
        operations: ["Read", "Write"]
```

```shell
kubectl apply -f topic.yaml -f user.yaml -n kafka

# 创建失败的原因写在 status.conditions 里;用户凭据在同名 Secret 中
kubectl get kafkatopic orders -n kafka -o jsonpath='{.status.conditions}'
kubectl get secret order-app -n kafka -o jsonpath='{.data.user\.crt}' | base64 -d
```

### 扩缩容

```shell
# 扩容 broker:改节点池副本数(生产建议 controller 与 broker 分池,缩容只对纯 broker 池生效)
kubectl patch kafkanodepool broker -n kafka --type merge -p '{"spec":{"replicas":5}}'

# 缩容:副本数改为 3
kubectl patch kafkanodepool broker -n kafka --type merge -p '{"spec":{"replicas":3}}'
```

**缩容前必须做再均衡**:Strimzi 默认会检查目标 broker 上是否还有分区副本,一旦发现有副本就**拒绝缩容**(避免丢数据),而且只允许对**纯 broker 节点池**缩容。先在 `Kafka` 的 spec 里加 `cruiseControl: {}` 启用 Cruise Control:

```shell
apiVersion: kafka.strimzi.io/v1
kind: KafkaRebalance
metadata:
  name: my-rebalance
  labels:
    strimzi.io/cluster: my-cluster
spec:
  mode: remove-brokers         # full | add-brokers | remove-brokers
  brokers: [3, 4]              # 仅 add/remove 模式需要,填 broker 的 node id
```

再均衡是两阶段的:提交后只生成方案,人工确认后才真正搬数据。

```shell
kubectl apply -f rebalance.yaml -n kafka
kubectl get kafkarebalance my-rebalance -n kafka
kubectl annotate kafkarebalance my-rebalance -n kafka strimzi.io/rebalance=approve
```

### 存储与 PVC

```shell
# 每个 Pod 一套 PVC(名字形如 data-<pool>-kafka-<seq>)
kubectl get pvc -n kafka

# 扩容(需要 StorageClass 支持 allowVolumeExpansion)
kubectl patch kafkanodepool broker -n kafka --type json -p '[{"op":"replace","path":"/spec/storage/volumes/0/size","value":"500Gi"}]'
```

`deleteClaim` 默认 `false` —— **删除集群或缩容都不会删除 PVC**,释放存储要手工 `kubectl delete pvc`。另外 Strimzi **不提供任何备份 CRD**:官方的恢复路径是靠 PV 重建(要求 PV 的 `persistentVolumeReclaimPolicy: Retain`)与 MirrorMaker 2 做跨集群复制,真正的备份要自己接 Kafka 工具链。

`spec.kafka.listeners[].type` 决定客户端接入方式:`internal`(集群内 Service)、`nodeport`、`loadbalancer`、`ingress`、`route`(OpenShift)。每个监听器会生成对应的 Service 与证书,实际地址用 `kubectl get kafka my-cluster -o jsonpath='{.status.listeners}'` 查看。

### 升级

```shell
# 1. 先升 CRD(Helm 不升 CRD)
kubectl apply -f https://github.com/strimzi/strimzi-kafka-operator/releases/download/1.2.0/strimzi-crds-1.2.0.yaml

# 2. 再升 Operator 本体(Helm 安装的改用 helm upgrade strimzi-kafka-operator strimzi/strimzi-kafka-operator -n kafka)
kubectl create -f https://github.com/strimzi/strimzi-kafka-operator/releases/download/1.2.0/strimzi-cluster-operator-1.2.0.yaml -n kafka

# 3. 最后升级 Kafka 版本,Operator 会滚动重启 broker
kubectl patch kafka my-cluster -n kafka --type merge -p '{"spec":{"kafka":{"version":"4.3.1"}}}'
kubectl get pods -n kafka -w
```

`spec.kafka.version` 是 Kafka 二进制版本,`spec.kafka.metadataVersion` 是 KRaft 元数据格式版本;**确认集群稳定后再上调 metadataVersion**,升上去之后很难回退。

### 监控

Strimzi 用 JMX Prometheus Exporter 暴露指标,Exporter 以 Java agent 跑在容器内,**默认端口 9404**。指标白名单写在 ConfigMap 里(JMX Exporter 的 `lowercaseOutputName` + `rules` 格式),再由 `Kafka` 资源引用:

```shell
apiVersion: kafka.strimzi.io/v1
kind: Kafka
metadata:
  name: my-cluster
spec:
  kafka:
    metricsConfig:
      type: jmxPrometheusExporter
      valueFrom:
        configMapKeyRef:
          name: kafka-metrics
          key: kafka-metrics-config.yml
```

Prometheus Operator 环境用 PodMonitor 抓取(Pod 上带有 `strimzi.io/kind`、`strimzi.io/cluster` 等 label):

```shell
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: kafka-resources-metrics
  namespace: monitoring
spec:
  namespaceSelector:
    matchNames:
      - kafka                    # PodMonitor 默认只选自身命名空间,必须放开
  selector:
    matchExpressions:
      - key: strimzi.io/kind
        operator: In
        values: ["Kafka"]
  podMetricsEndpoints:
    - path: /metrics
      port: tcp-prometheus       # 即容器上的 9404
```

`KafkaExporter`(`spec.kafkaExporter: {}`)另外提供消费组延迟与分区偏移等业务指标,但它只对非 TLS 的监听器生效。

### 注意

1. **1.x 不支持 ZooKeeper**。ZooKeeper 模式在 0.46 被移除,Kafka 4.0 起只有 KRaft。迁移窗口只有 **0.39 ~ 0.45**(官方迁移步骤写在 0.45.x 文档里),要先把集群升到这段区间完成迁移,再升 1.x,**没有从 ZooKeeper 直升 1.x 的捷径**。
2. **CRD 版本 1.0 起只有 `v1`**。旧清单里的 `apiVersion: kafka.strimzi.io/v1beta2` 会被拒绝,升级前须用官方 `strimzi-v1-api-conversion` 工具批量转换,否则升级后所有 CR 一起失联。
3. **`spec.kafka.replicas` 与 `spec.kafka.storage` 已不存在**。副本数与存储都在 `KafkaNodePool` 上,照抄旧文档会报未知字段或被静默忽略。
4. **controller 数必须为奇数**(3 或 5)。偶数 controller 在 KRaft 下凑不出稳定多数派,一次网络抖动就可能失去 quorum。
5. **缩容会被保护检查挡住**。Strimzi 默认检查目标 broker 是否还有分区副本,有就拒绝缩容;只对纯 broker 节点池生效。要么先用 Cruise Control 的 `remove-brokers` 迁走数据,要么用 `strimzi.io/skip-broker-scaledown-check="true"` 强行绕过 —— 后者官方明确警告会导致调和失败与数据丢失风险。
6. **缩容与删除集群都不删 PVC**。`deleteClaim` 默认 `false`,磁盘会持续计费,确认不要了再手工删 PVC。
7. **`helm upgrade` 不升级 CRD**。Helm 的 `crds/` 只在首次安装生效,新版本若增删了字段,不先 `kubectl apply -f strimzi-crds-<version>.yaml` 就会被 API Server 截断,Operator 报错时看不出根因。
8. **`metadataVersion` 只能升不能随意降**。它决定 KRaft 元数据落盘格式,升上去后想回退旧版 Kafka 会非常麻烦。
9. **节点池 label 写错就成了孤儿**。`KafkaNodePool` 缺少或写错 `strimzi.io/cluster`,不会被任何集群接管,Pod 也不会创建。
10. **`KafkaTopic` 的 `partitions` 只增不减**。Kafka 不支持减少分区,改小不会生效;`replicas` 也不能超过 broker 数量。
11. **JMX Exporter 的指标基数很高**。默认带 `clientId`、`topic`、`partition` 标签,series 数随 Topic 数线性膨胀,务必用 ConfigMap 中的 rules 只留必要指标,否则先被压垮的是 Prometheus。
12. **`KafkaUser` 证书轮换不是全自动的**。轮换周期到达后需手动触发(可用 `strimzi.io/force-renew` 注解),客户端没及时换证书会直接认证失败。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `statefulset` — Kafka broker 的实际载体
- `pvc` — 持久卷声明,broker 数据盘
- `storageclass` — 存储类,决定 broker 存储性能
- `helm` — Kubernetes包管理器
- `prometheus` — 抓取 JMX Exporter 指标
- `poddisruptionbudget` — 保障滚动升级时的可用副本

### 参考链接

- [Strimzi 官方文档](https://strimzi.io/documentation/)
- [Strimzi 快速上手](https://strimzi.io/quickstarts/)
- [Strimzi 1.2.0 部署手册(安装与升级)](https://strimzi.io/docs/operators/1.2.0/deploying.html)
- [从 ZooKeeper 迁移到 KRaft(0.45.x)](https://strimzi.io/docs/operators/0.45.1/deploying.html)
- [Strimzi GitHub 仓库](https://github.com/strimzi/strimzi-kafka-operator)
