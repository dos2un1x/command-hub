priority-class
===

Kubernetes中定义Pod调度优先级与抢占行为的集群级对象

## 补充说明

**PriorityClass** 是一个**集群级(非命名空间)**对象,把「优先级」这个抽象概念映射成一个整数。Pod 通过 `spec.priorityClassName` 引用它,优先级准入控制器再把对应的整数值写入 Pod 的 `spec.priority` 字段。

优先级在两个环节起作用:

```shell
1. 调度排队   优先级高的 Pending Pod 排在队列前面,更早获得调度机会
2. 抢占       高优先级 Pod 无法调度时,调度器尝试驱逐节点上优先级更低的 Pod 腾位置
```

`value` 越大优先级越高。用户可创建的值上限是 **1000000000(10 亿)**,再往上留给系统内置的两个 PriorityClass。

### 语法

```shell
kubectl get priorityclass [名称] [选项]
kubectl describe priorityclass [名称]
kubectl delete priorityclass [名称]
```

PriorityClass 的简写是 `pc`:

```shell
kubectl get pc
kubectl describe pc high-priority
```

### YAML 清单

```shell
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: high-priority
value: 1000000
globalDefault: false
description: "用于核心交易链路,可抢占其他业务 Pod"
```

创建并查看:

```shell
kubectl apply -f priorityclass.yaml

kubectl get priorityclass
# NAME                      VALUE        GLOBAL-DEFAULT   AGE
# high-priority             1000000      false            5s
# system-cluster-critical   2000000000   false            30d
# system-node-critical      2000001000   false            30d

kubectl get pc high-priority -o yaml
```

### 在 Pod 中使用

```shell
apiVersion: v1
kind: Pod
metadata:
  name: nginx-high
spec:
  priorityClassName: high-priority
  containers:
    - name: nginx
      image: nginx:1.27
```

创建后可以验证解析结果:

```shell
kubectl get pod nginx-high -o jsonpath='{.spec.priority}'
# 1000000

kubectl get pods -o custom-columns='NAME:.metadata.name,PRIORITY:.spec.priority'
```

若引用的 PriorityClass 不存在,Pod 会被**直接拒绝创建**,错误信息为 `no PriorityClass with name xxx was found`。

### 字段说明

```shell
value             必填。32 位整数,有效范围 -2147483648 ~ 1000000000
globalDefault     可选。为 true 时作为未指定 priorityClassName 的 Pod 的默认值
                  整个集群最多只能有一个 PriorityClass 设置 globalDefault: true
description       可选。说明该优先级适用于哪些场景,建议认真填写
preemptionPolicy  可选。PreemptLowerPriority(默认)或 Never
```

`metadata.name` 不能以 `system-` 开头,该前缀保留给系统组件。

### 不抢占的高优先级

有的场景希望 Pod 排在队首、但不要挤掉别人,可以设 `preemptionPolicy: Never`:

```shell
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: high-priority-nonpreempting
value: 1000000
preemptionPolicy: Never
globalDefault: false
description: "排队优先,但不抢占任何 Pod"
```

这类 Pod 在调度队列里排在低优先级 Pod **之前**,但**不能**抢占任何 Pod,只能等资源自然释放。

### 全局默认优先级

```shell
apiVersion: scheduling.k8s.io/v1
kind: PriorityClass
metadata:
  name: default-priority
value: 1000
globalDefault: true
description: "集群默认优先级"
```

两个必须注意的行为:

```shell
1. 全集群只允许一个 globalDefault: true,再建第二个会被拒绝
2. 设置它不会改变已存在 Pod 的优先级,只影响之后创建的 Pod
```

如果集群里没有任何 `globalDefault`,未写 `priorityClassName` 的 Pod 优先级为 **0**。

### 用 ResourceQuota 限制高优先级 Pod

优先级可以被滥用:任何有 Pod 创建权限的用户都能建一个超高优先级的 Pod 挤掉别人的工作负载。管理员可以用带 `scopeSelector` 的 ResourceQuota 加以约束:

```shell
apiVersion: v1
kind: ResourceQuota
metadata:
  name: high-priority-quota
  namespace: default
spec:
  hard:
    pods: "4"
  scopeSelector:
    matchExpressions:
      - operator: In
        scopeName: PriorityClass
        values:
          - high-priority
```

这条配额表示「default 命名空间里,使用 high-priority 的 Pod 最多 4 个」。

### 常用操作

```shell
# 查看所有优先级类
kubectl get priorityclass
kubectl get pc -o custom-columns='NAME:.metadata.name,VALUE:.value,DEFAULT:.globalDefault'

# 按优先级查看 Pod 排序(排查谁挤掉了谁)
kubectl get pods --sort-by=.spec.priority
kubectl get pods -A --sort-by=.spec.priority

# 查看某个 Pod 解析出的实际优先级
kubectl get pod nginx -o jsonpath='{.spec.priorityClassName}{"\n"}{.spec.priority}{"\n"}'

# 修改优先级类的值(只影响之后创建的 Pod)
kubectl patch pc high-priority --type=merge -p '{"value":2000000}'

# 查看抢占事件
kubectl get events -A --field-selector reason=Preempted

# 删除优先级类
kubectl delete pc high-priority
```

Pod 未被调度时会给出抢占结果,`kubectl describe pod` 中可以看到:

```shell
# 能看到候选节点与拟驱逐的 Pod 列表
Status: Pending
Events:
  Type     Reason            Message
  ----     ------            -------
  Normal   Preempting        Preempting pods to make room for this pod
  Warning  FailedScheduling  0/3 nodes are available: 3 Insufficient cpu
  Normal   Scheduled         Successfully assigned default/nginx to node2
```

### 抢占的执行过程

```shell
1. 高优先级 Pod 调度失败,进入 postFilter 阶段
2. 调度器为每个候选节点挑选一批"受害者"(优先级更低、数量最少的一组)
3. 选定节点后,在 Pod 上写入 status.nominatedNodeName(提名节点)
4. 调度器发起驱逐请求,受害者进入终止流程(默认 30 秒宽限期)
5. 资源释放后,被提名的 Pod 在下一轮调度中绑定到该节点
```

注意第 3 步:**被提名不等于被绑定**。若在宽限期内有别的 Pod 抢先占用了资源,提名会被撤销,Pod 重新回到队列,可能再次发起抢占。

### 注意

1. **抢占是「尽力而为」,不保证成功**。调度器会尽量避免选到会违反 PodDisruptionBudget 的受害者,但 PDB **不能阻止**抢占。也就是说,受 PDB 保护的低优先级 Pod 依然可能被高优先级 Pod 挤掉。

2. **`preemptionPolicy: Never` 只免除「抢占别人」,不免除「被别人抢占」**。这类 Pod 排队靠前、但完全可以被更高优先级的 Pod 驱逐,不要把它当成保护机制。

3. **优先级不解决资源不足的根因**。抢占只是把问题从「高优先级 Pod Pending」转移成「低优先级 Pod 被驱逐」,集群总容量并没有增加。长期依赖抢占会掩盖容量规划问题。

4. **`globalDefault: true` 只影响之后创建的 Pod**,已运行 Pod 的 `spec.priority` 不会被回填。切换默认优先级时要清楚这一点,否则会看到新旧 Pod 行为不一致。

5. **`metadata.name` 不能以 `system-` 开头**,并且 `value` 必须是整数类型。写成字符串 `"1000000"` 会被拒绝;超过 1000000000 也会报错 `value must be an integer less than or equal to 1000000000`。

6. **删除 PriorityClass 后,已使用它的 Pod 不受影响**,但**无法再创建**引用该名字的新 Pod。滚动更新时若 PriorityClass 已被删除,新 Pod 会因为找不到类而全部创建失败,升级前务必确认引用仍然有效。

7. **优先级会连带影响 kubelet 的资源驱逐排序**。节点资源紧张时,kubelet 除了看 QoS 等级,也会优先驱逐优先级更低的 Pod,因此把低优先级设得过低会让这些 Pod 在节点压力下最先被牺牲。

8. **系统内置的两个优先级类不要修改或删除**。`system-cluster-critical`(2000000000)用于关键集群插件,`system-node-critical`(2000001000)用于必须运行在每个节点上的组件,它们的值都在用户上限之上,是调度器保障控制面稳定性的基础。

9. **同优先级之间不会互相抢占**。所有 Pod 优先级都为 0(即未配置任何 PriorityClass)时,抢占完全不会发生,新 Pod 只能一直 Pending。

10. **优先级不是安全边界**。任何能创建 Pod 的用户都能选择任意已存在的 PriorityClass,若集群是多租户的,必须用 ResourceQuota 的 `scopeSelector` 限制高优先级 Pod 的数量,或配合准入策略加以管控。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kube-scheduler` — 依据优先级排序与执行抢占的组件
- `pod` — 优先级的作用对象
- `poddisruptionbudget` — 抢占时会被尽量避让的可用性约束
- `resource-quota` — 限制高优先级Pod数量的手段
- `affinity` — 与优先级共同决定调度结果的规则

### 参考链接

- [Pod 优先级与抢占](https://kubernetes.io/docs/concepts/scheduling-eviction/pod-priority-preemption/)
- [为 Pod 配置优先级](https://kubernetes.io/docs/tasks/configure-pod-container/configure-pod-priority-preemption/)
- [限制高优先级 Pod 的消耗](https://kubernetes.io/docs/concepts/policy/resource-quotas/#limit-priority-class-consumption-by-default)
- [PriorityClass API 参考](https://kubernetes.io/docs/reference/kubernetes-api/scheduling-resources/priority-class-v1/)
