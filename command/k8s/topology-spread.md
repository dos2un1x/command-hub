topology-spread
===

Kubernetes中控制Pod在可用区、节点等拓扑域之间均匀分布的约束

## 补充说明

**topologySpreadConstraints(拓扑分布约束)** 用来让一组 Pod 在指定的拓扑域之间**尽量均匀地分布**。它解决的是 Pod 反亲和做不到的事:反亲和只能表达「一个节点上不许有两个」,无法表达「三个可用区之间副本数最多差 1 个」。

核心概念是三个词:

```shell
拓扑域(domain)     由 topologyKey 指定的节点标签划分,如 kubernetes.io/hostname
                    每个不同的标签值就是一个域;缺少该标签的节点不构成"符合条件的域"
maxSkew             目标域与全局最小值之间允许的最大差值
全局最小值          符合条件的所有域中,匹配 Pod 数量的最小值
                    (若符合条件的域数少于 minDomains,则视为 0)
```

`maxSkew` 的判定对象是**全局最小值**,不是平均值。例如三个可用区分别有 2、2、1 个匹配 Pod,`maxSkew: 1` 时全局最小值为 1,目标域最多允许 2 个,此时三个区都已经不能再加了。

### 语法

```shell
kubectl get pod <名称> -o jsonpath='{.spec.topologySpreadConstraints}'
```

拓扑分布约束是 Pod 模板里的字段,不产生独立的资源对象,也没有 `kubectl get` 形式的短命令。

### YAML 清单

在可用区之间均匀分布,并做硬性约束:

```shell
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 6
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: topology.kubernetes.io/zone
          whenUnsatisfiable: DoNotSchedule
          labelSelector:
            matchLabels:
              app: web
      containers:
        - name: web
          image: nginx:1.27
```

先在可用区层面打散,再在节点层面打散(可以同时写多条约束):

```shell
spec:
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels:
          app: web
    - maxSkew: 1
      topologyKey: kubernetes.io/hostname
      whenUnsatisfiable: ScheduleAnyway
      labelSelector:
        matchLabels:
          app: web
```

### 字段说明

```shell
maxSkew            必填。必须大于 0。允许的最大分布差值
minDomains         可选。必须大于 0,且只能与 DoNotSchedule 搭配使用
                   符合条件的域数少于该值时,全局最小值按 0 计算
                   不写时等同于 minDomains: 1
topologyKey        必填。用于划分拓扑域的节点标签键
whenUnsatisfiable  必填。DoNotSchedule(默认)或 ScheduleAnyway
labelSelector      必填。用于统计每个域里有多少个"自己人"
matchLabelKeys     可选。从 Pod 自身标签中取值的键列表,与 labelSelector 合并
nodeAffinityPolicy 可选。Honor(默认)或 Ignore
nodeTaintsPolicy   可选。Honor 或 Ignore(默认)
```

两个容易忽略的策略字段决定了「哪些节点算一个合格拓扑域」:

```shell
nodeAffinityPolicy: Honor   只把满足本 Pod nodeAffinity/nodeSelector 的节点算作合格域(默认)
                    Ignore  不理会 nodeAffinity,所有节点都算合格域

nodeTaintsPolicy:   Honor   把本 Pod 不容忍的污点所在节点排除在合格域之外
                    Ignore  不理会污点,所有节点都算合格域(默认)
```

### whenUnsatisfiable 的两个取值

```shell
DoNotSchedule   硬约束。不满足分布要求就不调度,Pod 停在 Pending
ScheduleAnyway  软约束。照常调度,但优先选择能让分布更均匀的节点
```

这是本节最重要的开关。设成 `DoNotSchedule` 后,如果所有候选节点都会突破 `maxSkew`,Pod 就会一直 Pending,而错误信息里的提示往往不够直观:

```shell
0/5 nodes are available: 5 node(s) didn't match pod topology spread constraints
```

### 用 minDomains 处理缩容场景

集群只剩 2 个可用区时,按「可用区均匀分布」的常规算法,这两个区各放一半就算满足约束,Pod 会全部挤在这两个区,第三个区恢复后也不会自动回迁。

```shell
spec:
  topologySpreadConstraints:
    - maxSkew: 1
      minDomains: 3
      topologyKey: topology.kubernetes.io/zone
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels:
          app: web
```

有了 `minDomains: 3`,当合格域不足 3 个时全局最小值按 0 计算,调度器仍会努力把 Pod 往不同域里塞,而不是认为「两个区已经够了」。

### matchLabelKeys 简化滚动更新

```shell
spec:
  topologySpreadConstraints:
    - maxSkew: 1
      topologyKey: kubernetes.io/hostname
      whenUnsatisfiable: DoNotSchedule
      labelSelector:
        matchLabels:
          app: web
      matchLabelKeys:
        - pod-template-hash
```

`pod-template-hash` 由 Deployment 控制器自动加上,滚动更新时新旧 ReplicaSet 的哈希不同,新旧 Pod 会被**分别**统计,避免旧副本占满了拓扑域导致新副本无处可去。

### 集群级默认约束

调度器配置里可以设置默认的分布约束,免去在每个 Pod 模板里重复书写:

```shell
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
profiles:
  - pluginConfig:
      - name: PodTopologySpread
        args:
          defaultConstraints:
            - maxSkew: 1
              topologyKey: topology.kubernetes.io/zone
              whenUnsatisfiable: ScheduleAnyway
          defaultingType: List
```

关键规则:

```shell
1. defaultConstraints 里的 labelSelector 必须为空,否则配置无效
   此时使用 Pod 所属 Service / RC / RS / StatefulSet 的选择器
2. defaultingType: List 表示"只用列出的约束";列表为空则不施加任何默认
3. 仅当 Pod 自己没写 topologySpreadConstraints,且属于上述控制器时才生效
```

若完全没有配置集群级默认,调度器会使用**内置默认约束**(`maxSkew: 3` 按 `kubernetes.io/hostname`、`maxSkew: 5` 按 `topology.kubernetes.io/zone`,均为 `ScheduleAnyway`)。这解释了「我什么都没配置,Pod 却自动分散到了不同节点和可用区」。

### 常用操作

```shell
# 查看节点上有哪些可用的拓扑标签
kubectl get nodes -L topology.kubernetes.io/zone
kubectl get nodes -L kubernetes.io/hostname
kubectl get nodes -L topology.kubernetes.io/region

# 统计 Pod 在各可用区的分布
kubectl get pods -l app=web -o custom-columns=\
'NAME:.metadata.name,NODE:.spec.nodeName' --no-headers | \
while read p n; do echo "$p $(kubectl get node $n -o jsonpath='{.metadata.labels.topology\.kubernetes\.io/zone}')"; done

# 更直接的写法:按节点聚合
kubectl get pods -l app=web -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}' | sort | uniq -c

# 查看调度失败原因
kubectl describe pod web-xxx | sed -n '/Events/,$p'

# 快速调整副本数验证分布行为
kubectl scale deployment web --replicas=9
```

### 注意

1. **`whenUnsatisfiable` 的两个取值决定了 Pod 会不会 Pending**。`DoNotSchedule` 是硬约束,副本数超过「域数 × (全局最小值 + maxSkew)」时必然有 Pod 卡住;`ScheduleAnyway` 则永远能调度成功,只是分布可能不均。生产上先用软约束观察,确认容量足够后再收紧。

2. **同一个 `topologyKey` 加同一个 `whenUnsatisfiable` 只能出现一次**。想在节点维度写两条不同 `maxSkew` 的约束会被拒绝;需要多条时,必须让它们落在不同的 `topologyKey` 或不同的 `whenUnsatisfiable` 组合上。

3. **缺少 `topologyKey` 标签的节点不构成合格域**。如果部分节点没有 `topology.kubernetes.io/zone` 标签,这些节点在计算域时会被忽略,Pod 可能完全无法调度到它们上面,而事件提示只有一句笼统的 not match。

4. **`maxSkew` 比的是「与全局最小值的差」,不是「与平均值」**。三个域分别有 5、5、4 个 Pod,`maxSkew: 1` 时已经饱和;而 5、1、1 这种明显不均的分布,在 `maxSkew: 4` 时反而是允许的。评估分布是否合理要看具体数值,不能只看均值。

5. **`minDomains` 只能与 `DoNotSchedule` 搭配**。写成 `whenUnsatisfiable: ScheduleAnyway` 再加 `minDomains` 会被 API Server 拒绝,因为软约束下这个字段没有任何意义。

6. **`nodeTaintsPolicy` 默认为 `Ignore`**,意味着打满污点的节点仍然会被算作一个合格的拓扑域。这会造成「域数看起来够,Pod 却调度不进去」的矛盾现象。若希望污点节点被排除,必须显式设置 `nodeTaintsPolicy: Honor`。

7. **滚动更新会和拓扑分布互相拉扯**。不配置 `matchLabelKeys` 时,新旧 ReplicaSet 的 Pod 会被统计在一起,旧副本占着位置会导致新副本无法满足 `maxSkew` 而 Pending。使用 `DoNotSchedule` 时强烈建议同时配置 `matchLabelKeys: [pod-template-hash]`。

8. **拓扑分布约束是调度期的判断,运行期不维护**。Pod 跑起来之后节点标签变化、节点被删除都不会触发重新平衡,分布会逐渐偏离。需要持续纠正时要用 `descheduler` 的 `RemovePodsViolatingTopologySpreadConstraint`。

9. **`topologySpreadConstraints` 与 Pod 反亲和功能重叠但不等价**。反亲和是「每个域最多一个」的极端 `maxSkew: 1`(且全局最小值恒为 0 时),而拓扑分布允许更宽松的比例关系,且开销更小。新集群建议优先使用拓扑分布约束。

10. **集群级默认约束容易被忽视,却真实生效**。内置默认会让 Pod 自动按节点和可用区分散,做容量规划或对比测试时要意识到这个看不见的变量存在;需要完全关闭时,应显式配置 `defaultingType: List` 并用空的 `defaultConstraints`。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `pod` — 拓扑分布约束的载体
- `affinity` — 另一类影响选点的规则
- `kube-scheduler` — 执行拓扑分布计算的调度器
- `descheduler` — 纠正运行后分布失衡的Pod
- `taints-tolerations` — 与 nodeTaintsPolicy 相关的判定输入
- `deployment` — 承载分布约束的典型工作负载

### 参考链接

- [Pod 拓扑分布约束](https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/)
- [调度器配置](https://kubernetes.io/docs/reference/scheduling/config/)
- [将 Pod 指派给节点](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/)
- [Pod API 参考](https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/pod-v1/)
