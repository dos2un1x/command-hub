affinity
===

Kubernetes中控制Pod调度到哪些节点的亲和性与反亲和性规则

## 补充说明

**Affinity(亲和性)** 是 Pod 上的一组调度约束,分两大类:**Node Affinity** 描述「Pod 想去什么样的节点」,**Pod Affinity / Anti-Affinity** 描述「Pod 想和哪些 Pod 待在一起、或离哪些 Pod 远一点」。

与简单的 `nodeSelector` 相比,亲和性提供了三件额外能力:表达「或」逻辑(`In` 后面跟多个值)、表达「非」逻辑(`NotIn`、`DoesNotExist`)、以及区分**硬约束**与**软约束**。

两类约束各有两种写法,名字里的两段含义必须分清:

```shell
requiredDuringSchedulingIgnoredDuringExecution    硬约束:不满足就不调度(仅 nodeAffinity/podAffinity)
preferredDuringSchedulingIgnoredDuringExecution   软约束:不满足也调度,只是打分低
```

`IgnoredDuringExecution` 表示**约束只在调度那一刻检查**。Pod 一旦运行起来,即便节点标签变了、被依赖的 Pod 被删了,调度器也**不会**把它赶走。Kubernetes **没有实现** `requiredDuringSchedulingRequiredDuringExecution`,不要照抄某些资料里的这个写法。

### 语法

```shell
kubectl [command] pod [flags]
```

亲和性是 Pod 的 `spec.affinity` 字段,没有独立的资源对象,因此没有 `kubectl get affinity` 这种用法:

```shell
kubectl get pod nginx -o jsonpath='{.spec.affinity}'
kubectl get pod nginx -o jsonpath='{.spec.affinity.nodeAffinity}'
kubectl get node node1 --show-labels
```

### Node Affinity 硬约束

```shell
apiVersion: v1
kind: Pod
metadata:
  name: with-node-affinity
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: topology.kubernetes.io/zone
                operator: In
                values:
                  - antarctica-east1
                  - antarctica-west1
  containers:
    - name: nginx
      image: nginx:1.27
```

`nodeSelectorTerms` 之间是**或(OR)**关系,同一个 term 内的多个 `matchExpressions` 之间是**与(AND)**关系。这一点极容易记反:

```shell
1 个 term 内写 3 条 matchExpressions   →  三条必须同时满足
3 个 term 各写 1 条 matchExpressions   →  满足任意一条即可
```

### Node Affinity 软约束

```shell
spec:
  affinity:
    nodeAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 80
          preference:
            matchExpressions:
              - key: disktype
                operator: In
                values:
                  - ssd
        - weight: 20
          preference:
            matchExpressions:
              - key: kubernetes.io/os
                operator: In
                values:
                  - linux
```

`weight` 取值范围是 **1-100**,多个软约束的得分按权重累加。若某条软约束的 `weight` 省略或写成 0,该条会被 API Server 拒绝。

### 支持的运算符

```shell
In            标签值在给定列表中
NotIn         标签值不在给定列表中
Exists        标签键存在(不写 values)
DoesNotExist  标签键不存在(不写 values)
Gt            标签值大于给定整数(仅 matchExpressions)
Lt            标签值小于给定整数(仅 matchExpressions)
```

`matchFields` 用于按节点字段过滤,目前主要支持 `metadata.name`:

```shell
spec:
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchFields:
              - key: metadata.name
                operator: In
                values:
                  - node1
                  - node2
```

### Pod Affinity

让 Pod 尽量靠近带指定标签的 Pod,常用于「应用要和缓存待在同一可用区」这类场景:

```shell
apiVersion: v1
kind: Pod
metadata:
  name: with-pod-affinity
spec:
  affinity:
    podAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchExpressions:
              - key: app
                operator: In
                values:
                  - redis
          topologyKey: kubernetes.io/hostname
    podAntiAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          podAffinityTerm:
            labelSelector:
              matchLabels:
                app: nginx
            topologyKey: kubernetes.io/hostname
  containers:
    - name: nginx
      image: nginx:1.27
```

注意两种形态的字段层级不同:硬约束直接写 `labelSelector` + `topologyKey`;软约束多包了一层 `podAffinityTerm`,并且额外有 `weight`。

### 跨命名空间的 Pod 亲和

```shell
spec:
  affinity:
    podAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app: mysql
          namespaces:
            - database
          topologyKey: topology.kubernetes.io/zone
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app: nginx
          namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: frontend
          topologyKey: kubernetes.io/hostname
```

关键规则:

```shell
namespaces 与 namespaceSelector 都不写     →  只在 Pod 自己所在的 namespace 里匹配
namespaces 与 namespaceSelector 同时写     →  取两者的并集,不是交集
labelSelector 写空对象 {}                  →  匹配该命名空间下的所有 Pod
namespaceSelector 写空对象 {}              →  匹配所有命名空间
```

这与 NetworkPolicy 里 `namespaceSelector` 与 `podSelector` 写在同一个数组元素时取**交集**的语义**完全不同**,两者极易混淆。

### matchLabelKeys 简化滚动更新

手工维护版本标签很容易忘记更新,`matchLabelKeys` 会自动把标签值填入选择器:

```shell
spec:
  affinity:
    podAntiAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        - labelSelector:
            matchLabels:
              app: nginx
          matchLabelKeys:
            - pod-template-hash
          topologyKey: kubernetes.io/hostname
```

`pod-template-hash` 由 Deployment 控制器自动注入,滚动更新时新旧 ReplicaSet 的哈希不同,反亲和因此**不会**把新副本排挤到无节点可用的境地。同一个 key 不能同时出现在 `matchLabelKeys` 和 `labelSelector` 中。

### 常用操作

```shell
# 查看节点都有哪些可用于拓扑的标签
kubectl get nodes --show-labels
kubectl get nodes -L topology.kubernetes.io/zone
kubectl get nodes -L kubernetes.io/hostname

# 给节点打标签(亲和性的前提)
kubectl label node node1 disktype=ssd
kubectl label node node1 disktype=ssd --overwrite
kubectl label node node1 disktype-          # 删除标签

# 查看 Pod 最终被调度到哪个节点
kubectl get pod nginx -o wide
kubectl get pod nginx -o jsonpath='{.spec.nodeName}'

# 查看调度失败原因
kubectl describe pod nginx | sed -n '/Events/,$p'
```

调度失败时事件里的提示可以直接定位问题:

```shell
node(s) didn't match Pod's node affinity/selector        节点亲和不满足
node(s) didn't match pod affinity rules                  Pod 亲和不满足
node(s) didn't match pod anti-affinity rules             Pod 反亲和不满足
node(s) didn't have free ports for the requested pod ports   端口冲突
```

### 注意

1. **`required...` 与 `preferred...` 的语义差别是本节最容易踩的坑**。`required` 不满足时 Pod **永远 Pending**,不会退化成「随便找个节点」;`preferred` 不满足时 Pod 照常运行,只是得分低。生产环境中 Pod 反亲和用 `required` 而副本数又大于可用节点数,是造成大面积 Pending 的头号原因。

2. **Pod 反亲和默认只匹配 Pod 自己所在的 namespace**。不写 `namespaces` 也不写 `namespaceSelector` 时,选择器只在同命名空间内查找,跨命名空间的同名工作负载**不会**互相排斥。想真正打散必须显式写出目标命名空间。

3. **Pod 反亲和不会匹配 Pod 自己**。调度器评估时正在调度的这个 Pod 还未绑定,因此「反亲和选择自己的标签」不会导致自我排斥,但它**会**匹配同一 Deployment 已运行的其他副本 —— 这正是打散副本的原理。

4. **`topologyKey` 在 Pod 亲和/反亲和里是必填项**,留空会被 API Server 直接拒绝;而 `nodeAffinity` **根本没有** `topologyKey` 字段,写了会报 `unknown field`。部分集群启用了 `LimitPodHardAntiAffinityTopology` 准入插件,它会限制硬性反亲和的 `topologyKey` 只能是 `kubernetes.io/hostname`。

5. **`topologyKey` 指向的标签在所有节点上必须一致存在**。若某个节点缺少 `topology.kubernetes.io/zone` 标签,带该 `topologyKey` 的硬性反亲和会让 Pod **无法调度到这些节点**上;软性约束则只是不给它们加分。

6. **只有 `required` 形态存在 `IgnoredDuringExecution` 的问题**。节点标签在 Pod 运行后被改动,已运行的 Pod **不会**被重新评估或驱逐;需要 Pod 随约束变化而迁移时,必须借助 `descheduler` 这类外部组件。

7. **节点亲和与 `nodeSelector` 是「与」的关系**。两者同时存在时都必须满足,不存在覆盖关系。从 `nodeSelector` 迁移到 `nodeAffinity` 时若忘记删除旧字段,会得到比预期严格得多的约束。

8. **`nodeSelectorTerms` 为空或为 null 时匹配不到任何节点**。写了一个空的 term 相当于「谁都不要」,Pod 会永远 Pending,而事件提示只有含糊的 `didn't match`。

9. **Pod 亲和/反亲和在大型集群中开销显著**。调度器需要为每个候选节点扫描已运行的 Pod,节点数与 Pod 数都很大时会明显拖慢调度吞吐,应尽量缩小 `labelSelector` 的范围。

10. **亲和性只影响「选点」,不影响「运行」**。它不会因为被依赖的 Pod 消失而重启或迁移自己;需要「必须与某 Pod 同节点否则不跑」这类强语义时,Kubernetes 没有直接支持,只能靠 `descheduler` 周期性纠正。

11. **`preferred` 的 `weight` 必须落在 1-100**。写成 0 或负数、超过 100 都会被拒绝,而错误信息只说 `must be in the range 1-100`,排查时容易误以为字段名写错。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `pod` — 亲和性规则所依附的资源对象
- `kube-scheduler` — 执行亲和性判定的调度器
- `taints-tolerations` — 与亲和性互补的「节点排斥 Pod」机制
- `topology-spread` — 按拓扑域均匀打散Pod的另一种手段
- `descheduler` — 纠正运行后违反亲和性的Pod
- `node` — 亲和性规则的作用目标

### 参考链接

- [将 Pod 指派给节点](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/)
- [节点亲和性](https://kubernetes.io/docs/tasks/configure-pod-container/assign-pods-nodes-using-node-affinity/)
- [污点与容忍](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/)
- [Pod 拓扑分布约束](https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/)
