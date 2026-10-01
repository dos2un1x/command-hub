cluster-autoscaler
===

Kubernetes中根据待调度Pod自动调整节点数量的集群自动伸缩组件

## 补充说明

**Cluster Autoscaler(简称 CA)** 是 Kubernetes 的集群级自动伸缩组件,它调整的是**节点数量**,与调整 Pod 副本数的 HPA 正好互补:

```shell
HPA   调整 Pod 副本数      "业务忙了,多开几个 Pod"
CA    调整节点数           "Pod 调度不下了,多加几台机器"
```

CA 的决策逻辑可以概括为两条:

```shell
扩容:存在因资源不足而 Pending 的 Pod,且某个节点组扩容后能容纳它
      →  增加该节点组的节点数

缩容:某节点的资源请求率长期低于阈值,且其上的 Pod 都能搬到别处
      →  驱逐该节点上的 Pod,然后摘除节点
```

CA 依赖云厂商(或 Cluster API)提供的节点组能力,**必须配合 `--node-group-auto-discovery` 或云厂商特定的节点组配置**才能工作。它不能凭空造出机器,只能调用已有节点组的伸缩接口。

CA 与调度器是**互补而非替代**关系:节点加进来之后,由 kube-scheduler 决定 Pod 具体落到哪台机器上。

### 语法

```shell
cluster-autoscaler [flags]
```

CA 以 Deployment 的形式运行在 `kube-system` 命名空间中,通过启动参数配置:

```shell
--cloud-provider string              云厂商实现,如 aws、gce、azure
--node-group-auto-discovery strings  节点组自动发现规则
--expander string                    多个节点组都可用时的选择策略,默认 least-waste
--scan-interval duration             重新评估的间隔,默认 10s
--scale-down-enabled                 是否允许缩容,默认 true(该项已废弃,应改用 --scale-down-disabled=false)
```

### 扩容相关参数

```shell
--max-node-provision-time duration      等待节点就绪的最长时间,默认 15m
                                        超过后放弃这一轮扩容尝试
--ok-total-unready-count int            允许的未就绪节点数量,默认 3
--max-total-unready-percentage int      未就绪节点占比上限,默认 45
                                        超过后 CA 停止一切操作
--new-pod-scale-up-delay duration       新 Pod 出现后等待多久才开始扩容
                                        用于避开批处理任务的瞬时峰值
--balance-similar-node-groups           在多组相似的节点组之间均衡节点数
```

`--ok-total-unready-count` 与 `--max-total-unready-percentage` 是**保护阀**:集群里未就绪节点过多时 CA 会暂停动作,避免在集群已经异常时继续扩容放大问题。看到「CA 不动了」先检查这两个条件。

### 缩容相关参数

```shell
--scale-down-utilization-threshold float   节点资源请求率低于该值时视为可缩容,默认 0.5
--scale-down-unneeded-time duration        节点需要持续"不必要"多久才缩容,默认 10m
--scale-down-delay-after-add duration      扩容后多久恢复缩容评估,默认 10m
--scale-down-delay-after-delete duration   删节点后多久恢复缩容评估,默认 0s
--scale-down-delay-after-failure duration  缩容失败后多久恢复评估,默认 3m
--skip-nodes-with-local-storage            带本地存储的节点不缩容,默认 true
--skip-nodes-with-system-pods              带 kube-system Pod 的节点不缩容,默认 true
```

这里的「利用率」指的是 **sum(requests) / allocatable**,只看请求量,不看实际使用量。工作负载普遍不写 requests 时,利用率会被严重低估,导致节点被误判为空闲。

### 缩容的完整条件

一个节点要被缩容,**必须同时满足**以下所有条件,缺一不可:

```shell
1. 资源请求率持续低于 --scale-down-utilization-threshold
2. 持续时间超过 --scale-down-unneeded-time(默认 10 分钟)
3. 距离最近一次扩容已超过 --scale-down-delay-after-add
4. 节点上没有 --skip-nodes-with-local-storage 保护的本地存储 Pod
5. 节点上没有 --skip-nodes-with-system-pods 保护的 kube-system Pod
6. 节点上所有 Pod 都能被搬到其他节点(用调度器预演)
7. 节点上所有 Pod 的 PodDisruptionBudget 都允许被驱逐
8. 节点上没有阻止缩容的注解
```

第 7 条是实践中最常见的卡点:一个 `minAvailable` 等于副本数的 PDB,会让节点**永远无法缩容**。

### 扩容器的选择

当多个节点组都能满足 Pending Pod 时,由 `--expander` 决定选哪个:

```shell
random          随机挑一个
most-pods       选能容纳最多 Pending Pod 的节点组
least-waste     默认。选扩容后资源浪费最少的节点组
price           选成本最低的节点组(需云厂商支持)
priority        按节点组上的 cluster-autoscaler.kubernetes.io/priority 注解选择
grpc            通过 gRPC 调用外部扩展决定
```

多个值可以用逗号串起来形成决策链,例如 `--expander=priority,least-waste` 表示先按优先级分组,再在其中选浪费最少的。

### 节点组自动发现

以 AWS 为例,通过 EC2 标签自动发现所有需要纳管的 ASG:

```shell
--node-group-auto-discovery=asg:tag=k8s.io/cluster-autoscaler/enabled,k8s.io/cluster-autoscaler/my-cluster
```

GCE 与 Azure 使用各自的发现语法。使用自动发现时,节点组的**最小/最大规模由云平台侧的 ASG 配置决定**,CA 只在其允许的区间内伸缩。

### 常用注解

CA 的行为可以通过注解精细控制:

```shell
# 标注在 Pod 上:阻止该 Pod 所在的节点被缩容
metadata:
  annotations:
    cluster-autoscaler.kubernetes.io/safe-to-evict: "false"

# 标注在 Pod 上:允许带这些本地卷的 Pod 被搬迁
metadata:
  annotations:
    cluster-autoscaler.kubernetes.io/safe-to-evict-local-volumes: "volume-1,volume-2"

# 标注在 Pod 上:为该 Pod 单独设置扩容延迟
metadata:
  annotations:
    cluster-autoscaler.kubernetes.io/pod-scale-up-delay: "600s"

# 标注在 Node 上:让该节点退出缩容候选
kubectl annotate node node1 cluster-autoscaler.kubernetes.io/scale-down-disabled=true

# 标注在 DaemonSet 的 Pod 上:允许 CA 驱逐它
metadata:
  annotations:
    cluster-autoscaler.kubernetes.io/enable-ds-eviction: "true"
```

`safe-to-evict: "false"` 是**双刃剑**:它能保住 Pod 不被因缩容而驱逐,但如果大量 Pod 都加上这个注解,集群会彻底失去缩容能力,账单失控。只应对真正不能动的 Pod 使用。

### 与 PodDisruptionBudget 的配合

CA 缩容时**完全遵循 PDB**,流程如下:

```shell
1. 选定候选节点
2. 检查节点上所有 Pod 对应的 PDB,确认移除至少一个副本是允许的
3. 通过 Eviction API 逐个驱逐,失败则重试,最长重试约 2 分钟
4. 重试期间 CA 的其他活动全部暂停
5. 驱逐失败  →  放弃该节点(节点被"保下来"),稍后再试
6. 全部驱逐成功  →  调用云接口摘除节点
```

因此:

```shell
PDB 的 minAvailable 等于副本数  →  节点永远缩不掉,CA 日志反复出现
                                   "cannot remove node ... would violate PDB"
单副本服务没有 PDB            →  CA 会直接驱逐,造成短暂中断
单副本服务配 maxUnavailable: 0  →  节点同样缩不掉
```

官方建议给所有会被缩容影响的工作负载配 PDB,并且**至少留出 1 个可中断配额**(例如 `maxUnavailable: 1` 而不是 `minAvailable: 副本数`)。

### 常用操作

```shell
# 查看 CA 是否在运行
kubectl get pods -n kube-system -l app=cluster-autoscaler
kubectl get deployment -n kube-system cluster-autoscaler

# 查看 CA 日志(缩容被阻塞的原因都在这里)
kubectl logs -n kube-system -l app=cluster-autoscaler --tail=200
kubectl logs -n kube-system -l app=cluster-autoscaler | grep -i "scale down"

# 过滤出被 PodDisruptionBudget 阻塞的记录
kubectl logs -n kube-system -l app=cluster-autoscaler | grep -i "poddisruptionbudget"

# 查看当前节点数与节点组规模
kubectl get nodes
kubectl get nodes -L topology.kubernetes.io/zone -L node.kubernetes.io/instance-type

# 查看 Pending Pod(CA 扩容的直接触发条件)
kubectl get pods -A --field-selector status.phase=Pending

# 查看 CA 暴露的指标
kubectl get --raw /metrics | grep cluster_autoscaler
```

CA 的关键指标:

```shell
cluster_autoscaler_nodes_count                          当前节点数
cluster_autoscaler_unschedulable_pods_count             等待扩容的 Pod 数
cluster_autoscaler_last_activity                        最近一次扩缩容动作的时间戳
cluster_autoscaler_scale_down_in_cooldown               是否处于缩容冷却期
cluster_autoscaler_failed_scale_ups_total               扩容失败次数
```

### 排障

```shell
# 1. Pending Pod 没有触发扩容:看 CA 日志里的原因
kubectl logs -n kube-system -l app=cluster-autoscaler | grep -i "no node group"
# 常见原因
#   no node group can fit the pod            没有节点组满足 Pod 的节点选择器/亲和性
#   pod is not backed by a controller        裸 Pod 不触发扩容
#   node group at max size                   节点组已达上限
#   not enough resources in node group       节点组规格不够大

# 2. 节点缩不掉
kubectl logs -n kube-system -l app=cluster-autoscaler | grep -iE "cannot remove|not empty"
kubectl describe node node1 | grep -A5 "Allocated resources"
kubectl get pdb -A     # 检查是否有 PDB 卡在 0 许可

# 3. 节点一直处于 NotReady,CA 停止工作
kubectl get nodes | grep -v Ready
kubectl describe node <not-ready-node> | grep -A5 Conditions
# 未就绪节点超过 --ok-total-unready-count 或 --max-total-unready-percentage 时 CA 会停摆

# 4. 确认节点组的规模上下限
kubectl -n kube-system get configmap cluster-autoscaler-status -o yaml
```

### 注意

1. **CA 只处理「因资源不足而 Pending」的 Pod**。被节点选择器、亲和性、污点、资源配额、PDB 卡住的 Pod 不会触发扩容 —— 即便加了节点也无济于事。看到 Pending 就认定「CA 坏了」是最常见的误判,应先看 Pod 事件里的 `FailedScheduling` 原因。

2. **没有控制器管理的裸 Pod 不触发扩容**。CA 只统计由 Deployment、StatefulSet、Job 等控制器创建的 Pending Pod。裸 Pod 会一直 Pending 而集群毫无反应。

3. **PDB 会直接决定节点能否缩容**。`minAvailable` 等于副本数的 PDB 会让节点永远缩不掉,表现为「账单降不下来但什么都正常」。给工作负载配 PDB 时,一定要留出至少 1 个可中断副本。

4. **`--skip-nodes-with-system-pods` 默认为 true**,这让运行着 kube-system Pod 的节点难以缩容。DaemonSet 的 Pod 通常被自动忽略,但其他系统组件(如 metrics-server、CoreDNS 的普通 Pod)会阻止缩容。给系统组件也配 PDB 是官方推荐的解法。

5. **`--skip-nodes-with-local-storage` 默认为 true**,带 `emptyDir` 或 `hostPath` 的 Pod 会阻止节点缩容。确实需要缩容时,可以用 `safe-to-evict-local-volumes` 注解把安全的卷显式列出来。

6. **缩容速度天生比扩容慢得多**。默认要「持续 10 分钟不必要」才动手,再加上扩容后的 10 分钟冷却,一次缩容决策可能需要 20 分钟以上。这是有意为之的防抖设计,不要为了「响应快」把它调得极小,否则会陷入反复扩缩容的震荡。

7. **`--scale-down-utilization-threshold` 衡量的是请求量占比**。所有工作负载都不写 requests 时,节点利用率看起来永远接近 0,CA 会疯狂缩容;反之 requests 写得虚高时,节点永远缩不掉。部署 CA 前先确保 requests 真实可信。

8. **`--balance-similar-node-groups` 需要节点组之间真的「相似」**。相似意味着实例类型、标签、污点、可用区配置一致;配置差异大的节点组之间强行均衡会得到难以预期的结果。

9. **CA 与 descheduler 可能互相打架**。descheduler 驱逐 Pod 引发 CA 扩容,新节点又触发 CA 缩容与 descheduler 再平衡,参数配置不当时会形成震荡。两者同时使用时应当错开执行时间并保守设置阈值。

10. **CA 不是「有 Pod 就加机器」的无限资源池**。节点组的最大规模由云平台配置决定,达到上限后 Pending 会持续存在。CA 扩容失败时应当用 `cluster_autoscaler_failed_scale_ups_total` 指标报警,而不是等到业务受影响才发现。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `hpa` — 调整Pod副本数的横向伸缩,与CA互补
- `vpa` — 调整Pod资源请求,间接影响CA的利用率判断
- `poddisruptionbudget` — 缩容时必须遵守的可用性约束
- `descheduler` — 需要与CA协调参数的再平衡组件
- `taints-tolerations` — 影响节点是否被纳入伸缩范围
- `node` — CA伸缩的作用对象
- `kube-scheduler` — 把Pod安排到CA新拉起的节点上

### 参考链接

- [Cluster Autoscaler 项目](https://github.com/kubernetes/autoscaler/tree/master/cluster-autoscaler)
- [Cluster Autoscaler 常见问题](https://github.com/kubernetes/autoscaler/blob/master/cluster-autoscaler/FAQ.md)
- [节点自动伸缩](https://kubernetes.io/docs/concepts/cluster-administration/node-autoscaling/)
- [Pod 中断预算](https://kubernetes.io/docs/tasks/run-application/configure-pdb/)
