descheduler
===

Kubernetes中周期性重新平衡集群、驱逐不满足策略Pod的组件

## 补充说明

**descheduler** 是 Kubernetes 官方社区维护的**附加组件**(`kubernetes-sigs/descheduler`),不属于 Kubernetes 核心。它解决的问题是:**kube-scheduler 只在 Pod 创建的那一刻做决策,之后再也不管**。

以下场景都会让集群在运行一段时间后逐渐失衡:

```shell
1. 节点标签变了,Pod 不再满足新的亲和性要求
2. 节点被删掉又加回来,新节点上挤满新 Pod,老节点仍然满载
3. 某个业务批量扩容后又缩容,Pod 分布变得零散
4. 节点的污点变了,但节点上的 Pod 是被"容忍着"留下的
5. 拓扑分布约束只在调度时计算,运行后不再维护
```

descheduler 的工作方式是:**按策略找出「不该待在这里」的 Pod,调用 Eviction API 把它们驱逐**。它**不做调度决策** —— 被驱逐的 Pod 由 kube-scheduler 重新安排去处。这是理解它的关键:如果底层约束没有改变,调度器很可能把 Pod 放回原处,循环往复却毫无改善。

descheduler 通常以 **Job**(一次性)、**CronJob**(周期性)或常驻 Deployment(靠 `--descheduling-interval` 定时循环)的形式运行在集群里。

### 语法

```shell
descheduler [flags]
```

常用参数:

```shell
--policy-config-file string          策略文件的路径
--descheduling-interval duration     常驻模式下的循环间隔,不设置则只跑一轮就退出
--dry-run                            只打印将要驱逐的 Pod,不真正执行
--leader-elect                       多副本时启用领导者选举
--client-connection-kubeconfig string 连接 API Server 的 kubeconfig
--secure-port int                    指标与健康检查端口,默认 10258
-v Level                             日志详细程度,排查时用 -v=4 以上
```

`--kubeconfig` 已被标记为废弃,新版本应使用 `--client-connection-kubeconfig`。

### 安装

```shell
# 通过 Helm 安装
helm repo add descheduler https://kubernetes-sigs.github.io/descheduler/
helm repo update

# 以 CronJob 方式安装(每天凌晨跑一次)
helm install descheduler descheduler/descheduler \
  --namespace kube-system \
  --set kind=CronJob \
  --set schedule="0 0 * * *"

# 以 Job 方式安装(只跑一次)
helm install descheduler descheduler/descheduler \
  --namespace kube-system \
  --set kind=Job
```

descheduler 需要一套 RBAC 权限:读取 Pod、Node、Namespace、PriorityClass,以及对 `pods/eviction` 子资源的创建权限。Helm chart 会一并创建,手工部署时需要自行准备。

### 策略对象

新版本的策略是一个名为 **DeschedulerPolicy** 的自定义资源:

```shell
apiVersion: "descheduler/v1alpha2"
kind: "DeschedulerPolicy"
maxNoOfPodsToEvictPerNode: 5
maxNoOfPodsToEvictPerNamespace: 10
maxNoOfPodsToEvictTotal: 50
nodeSelector: "node=node1"
gracePeriodSeconds: 60
profiles:
  - name: balance
    pluginConfig:
      - name: DefaultEvictor
        args:
          nodeFit: true
          minReplicas: 2
      - name: LowNodeUtilization
        args:
          thresholds:
            cpu: 20
            memory: 20
            pods: 20
          targetThresholds:
            cpu: 50
            memory: 50
            pods: 50
    plugins:
      balance:
        enabled:
          - LowNodeUtilization
          - RemoveDuplicates
```

顶层字段:

```shell
nodeSelector                   只处理带指定标签的节点
maxNoOfPodsToEvictPerNode      每轮每节点最多驱逐多少个 Pod
maxNoOfPodsToEvictPerNamespace 每轮每命名空间最多驱逐多少个
maxNoOfPodsToEvictTotal        每轮最多驱逐多少个(总闸)
gracePeriodSeconds             驱逐时的优雅终止时间
metricsProviders               外部指标来源(如 Prometheus),供 HighNodeUtilization 使用
profiles                       策略组合,每个 profile 有自己的插件与参数
```

### 插件列表

descheduler 的插件按扩展点分成三类:

```shell
balance(再平衡)
  RemoveDuplicates                              同一控制器的多个副本挤在同一节点时打散
  LowNodeUtilization                            把高利用率节点上的 Pod 迁到低利用率节点
  HighNodeUtilization                           把低利用率节点上的 Pod 集中,腾空节点给缩容器
  RemovePodsViolatingTopologySpreadConstraint   纠正运行后失衡的拓扑分布

deschedule(强制驱逐)
  RemovePodsViolatingInterPodAntiAffinity       违反 Pod 反亲和的 Pod
  RemovePodsViolatingNodeAffinity               违反节点亲和性的 Pod
  RemovePodsViolatingNodeTaints                 不再容忍节点污点的 Pod
  RemovePodsHavingTooManyRestarts               重启次数过多的 Pod
  PodLifeTime                                   存活时间超过阈值的 Pod
  RemoveFailedPods                              处于 Failed 状态的 Pod

evictor(驱逐闸门)
  DefaultEvictor   默认启用,在 filter 与 preEvictionFilter 两个扩展点上过滤候选 Pod
```

### 常用插件参数

```shell
# LowNodeUtilization:利用率低于 thresholds 的算"空闲节点",
# 高于 targetThresholds 的算"过载节点",把过载节点上的 Pod 迁到空闲节点
pluginConfig:
  - name: LowNodeUtilization
    args:
      thresholds:            # 判定"空闲"的下限
        cpu: 20
        memory: 20
        pods: 20
      targetThresholds:      # 判定"过载"的上限
        cpu: 50
        memory: 50
        pods: 50
      useDeviationThresholds: false
```

```shell
# PodLifeTime:清理运行过久的 Pod,常用于开发测试环境
pluginConfig:
  - name: PodLifeTime
    args:
      maxPodLifeTimeSeconds: 86400
      states:
        - Pending
        - Running
```

```shell
# DefaultEvictor:驱逐前的统一过滤条件
pluginConfig:
  - name: DefaultEvictor
    args:
      nodeFit: true          # 只有存在"能接住这个 Pod 的节点"时才驱逐,避免来回搬
      minReplicas: 2         # 副本数少于该值的控制器,其 Pod 不驱逐
```

`nodeFit: true` 是实践中最值得开启的开关:它会在驱逐前预演一次调度,确认目标节点确实容得下这个 Pod,避免「驱逐后无处可去、Pod 卡在 Pending」的雪崩。

### 老版本的 v1alpha1 策略

较老的 descheduler 使用 `strategies` 结构,插件参数直接写在每个策略下面:

```shell
apiVersion: "descheduler/v1alpha1"
kind: "DeschedulerPolicy"
strategies:
  LowNodeUtilization:
    enabled: true
    params:
      nodeResourceUtilizationThresholds:
        thresholds:
          cpu: 20
          memory: 20
          pods: 20
        targetThresholds:
          cpu: 50
          memory: 50
          pods: 50
```

两种结构差别很大,**升级前必须先对照所用版本对应的文档改写策略文件**,直接把旧文件喂给新版本会解析失败。

### 常用操作

```shell
# 先空跑,确认会驱逐哪些 Pod
descheduler --policy-config-file policy.yaml --dry-run -v=4

# 查看运行日志(最直接的观测手段)
kubectl logs -n kube-system job/descheduler
kubectl logs -n kube-system -l app.kubernetes.io/name=descheduler --tail=200

# 查看驱逐产生的事件
kubectl get events -A --field-selector reason=Evicted

# 查看策略对象
kubectl get deschedulerpolicy -A
kubectl describe deschedulerpolicy descheduler-policy

# 临时停掉 descheduler
kubectl scale deployment/descheduler -n kube-system --replicas=0
```

### 排障

```shell
# 1. 提高日志等级,日志里会逐条说明"为什么不驱逐这个 Pod"
kubectl logs -n kube-system job/descheduler --tail=500 | grep -i "not evict"

# 常见原因
#   pod is not evictable: not enough replicas                 副本数不足 minReplicas
#   pod is not evictable: node fit failed                     nodeFit 预演失败
#   pod is not evictable: pod has local storage               带 emptyDir
#   pod is not evictable: eviction would violate PDB          PDB 不允许
#   pod is not evictable: DaemonSet pod                       DaemonSet 默认被保护

# 2. 确认 RBAC 是否齐全
kubectl auth can-i create pods/eviction --as=system:serviceaccount:kube-system:descheduler

# 3. 确认策略里启用的插件确实存在于当前版本
kubectl logs -n kube-system job/descheduler | grep -i "unknown plugin"
```

### 注意

1. **descheduler 不做调度,只负责驱逐**。它把 Pod 删掉之后就撒手不管,新位置由 kube-scheduler 决定。**如果底层约束没变(比如节点标签仍然不符合亲和性、所有节点仍然资源紧张),调度器很可能把 Pod 放回原节点**,表现为「日志里一直在驱逐,分布却毫无变化」。排查这类问题要去看调度器,而不是 descheduler。

2. **它是非核心组件,不随 Kubernetes 一起升级**。API 版本、策略结构、插件参数都可能在小版本间发生变化,升级 descheduler 时必须重新核对策略文件,不能想当然沿用。

3. **v1alpha2 的 `profiles` 结构与 v1alpha1 的 `strategies` 不兼容**。两者字段层级完全不同,旧策略文件在新版本上会直接解析失败或静默忽略。

4. **默认保护 DaemonSet、带本地存储的 Pod、系统关键 Pod**。这些 Pod 不会被驱逐,日志里会给出 `pod is not evictable` 的原因。需要放开时要显式调整 DefaultEvictor 的参数,而不是以为策略没生效。

5. **驱逐走的是 Eviction API,因此会受 PodDisruptionBudget 约束**。PDB 卡住(允许中断数为 0)时 descheduler 会跳过该 Pod,这是正确行为而非故障,但要意识到「配了 PDB 的负载可能永远不被再平衡」。

6. **`LowNodeUtilization` 只看 requests,不看实际用量**。若工作负载普遍不写 requests 或写得远低于实际用量,阈值判断会完全失真,可能把已经很忙的节点判为「空闲」。启用前应先确认 requests 的可信度。

7. **`nodeFit: true` 不是万能的**。它预演的是一次静态调度判断,不覆盖驱逐之后其他 Pod 抢先占位的情况;在集群容量紧张时,即便预演通过,Pod 也可能在重新调度时被挤到 Pending。

8. **`PodLifeTime` 适合无状态场景,对有状态服务极其危险**。它会按存活时间无差别驱逐,StatefulSet、有状态的中间件、持有长连接的服务都不应套用这条策略。

9. **必须设置驱逐数量上限**。`maxNoOfPodsToEvictPerNode` 等字段是防止「一轮驱逐把整个集群打散」的保险丝,不设置时默认不限量,首次上线务必从很小的数字开始验证。

10. **不要和集群自动伸缩同时激进使用**。descheduler 驱逐触发重建,可能被 cluster-autoscaler 解读为需要扩容;扩容出来的新节点又会让 descheduler 觉得分布不均而再次驱逐,两者参数配置不当会形成震荡。上线前应先在测试集群观察一整天的节点数与副本数变化曲线。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kube-scheduler` — 负责把被驱逐的Pod重新调度到新节点
- `affinity` — descheduler依据亲和性规则判断Pod是否"错位"
- `taints-tolerations` — descheduler依据污点判断Pod是否"不再被容忍"
- `topology-spread` — 拓扑分布失衡是descheduler的典型处理对象
- `poddisruptionbudget` — 驱逐时必须遵守的可用性约束
- `cluster-autoscaler` — 需与descheduler协调参数的扩缩容组件

### 参考链接

- [descheduler 项目文档](https://github.com/kubernetes-sigs/descheduler)
- [descheduler 策略配置](https://github.com/kubernetes-sigs/descheduler/blob/master/docs/user-guide.md)
- [descheduler 命令行参数](https://github.com/kubernetes-sigs/descheduler/blob/master/docs/cli/descheduler.md)
- [Kubernetes 调度框架](https://kubernetes.io/docs/concepts/scheduling-eviction/scheduling-framework/)
