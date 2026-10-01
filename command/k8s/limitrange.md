limitrange
===

Kubernetes中为命名空间内的Pod设置资源上下限与默认值约束

## 补充说明

**LimitRange(限制范围)** 作用于**命名空间**,做两件事:

```shell
1. 提供默认值    Pod 未声明 resources 时,自动注入 default(上限)与 defaultRequest(请求)
2. 施加取值范围  约束单个容器/单个 Pod/PVC 的资源必须落在 min ~ max 之间
                 并可要求 limit 与 request 的比值不超过 maxLimitRequestRatio
```

它与 ResourceQuota 的分工常被混淆:

```shell
ResourceQuota   管命名空间的"总量",限制所有 Pod 加起来能用多少
LimitRange      管单个对象的"单体",限制一个容器/一个 Pod 能用多少
```

两者互补。ResourceQuota 负责「整个团队每月只能花 100 块」,LimitRange 负责「单笔消费不能超过 10 块」。

LimitRange **只在对象创建/更新时生效**,不会去修改已经存在的 Pod。这意味着调整 LimitRange 不会影响任何正在运行的负载,新策略只对之后创建的 Pod 起作用。

### 语法

```shell
kubectl get limitrange [名称] [选项]
kubectl describe limitrange [名称]
kubectl delete limitrange [名称]
```

常用简写为 `limits`:

```shell
kubectl get limits -n default
kubectl describe limits cpu-constraint -n default
```

### YAML 清单:容器级

```shell
apiVersion: v1
kind: LimitRange
metadata:
  name: cpu-memory-constraint
  namespace: default
spec:
  limits:
    - type: Container
      default:               # 未写 limits 时注入的默认上限
        cpu: 500m
        memory: 512Mi
      defaultRequest:        # 未写 requests 时注入的默认请求
        cpu: 100m
        memory: 128Mi
      max:                   # 单个容器允许的最大值
        cpu: "2"
        memory: 2Gi
      min:                   # 单个容器允许的最小值
        cpu: 50m
        memory: 64Mi
      maxLimitRequestRatio:  # limit / request 的最大比值
        cpu: "10"
        memory: "4"
```

`type: Container` 的 `min`/`max` 针对的是**每一个容器**,不是容器之和。

### YAML 清单:Pod 级

```shell
apiVersion: v1
kind: LimitRange
metadata:
  name: pod-constraint
  namespace: default
spec:
  limits:
    - type: Pod
      max:
        cpu: "4"
        memory: 4Gi
      min:
        cpu: 100m
        memory: 128Mi
```

`type: Pod` 的 `min`/`max` 针对的是**该 Pod 内所有容器之和**,包括 init 容器。这与 `type: Container` 的语义完全不同,是排查「明明没超限却被拒绝」时的关键区别。

注意 `default` 与 `defaultRequest` **不能用于 `type: Pod`**,写了会被 API Server 拒绝。

### YAML 清单:PVC 级

```shell
apiVersion: v1
kind: LimitRange
metadata:
  name: storage-constraint
  namespace: default
spec:
  limits:
    - type: PersistentVolumeClaim
      max:
        storage: 10Gi
      min:
        storage: 1Gi
```

PVC 级只支持 `storage` 这一个资源维度。`storageClassName` **不是** LimitRange 的字段,它属于 PVC 自己的 spec,限定额度时不要往这里写。

### 应用与查看

```shell
kubectl apply -f limitrange.yaml

kubectl get limitrange -n default
# NAME                    CREATED AT
# cpu-memory-constraint   2026-09-18T00:00:00Z

kubectl describe limitrange cpu-memory-constraint -n default
# Type        Resource  Min   Max  Default Request  Default Limit  Max Limit/Request Ratio
# ----        --------  ---   ---  ---------------  -------------  -----------------------
# Container   cpu       50m   2    100m             500m           10
# Container   memory    64Mi  2Gi  128Mi            512Mi          4
```

### 默认值的注入过程

```shell
1. 用户提交 Pod 清单
2. LimitRange 准入控制器检查每个容器的 resources
3. limits 未写  →  填入 default
   requests 未写 →  填入 defaultRequest
4. 用填入后的完整值去校验 min / max / maxLimitRequestRatio
5. 任一校验失败,整个 Pod 创建请求返回 403 Forbidden
```

第 3 步的顺序很重要:**先补默认值,再校验**。因此一个只写了 `requests: cpu: 700m` 的容器,会被补上 `limits: cpu: 500m`,随后因为 request 大于 limit 而被拒绝。

### 与 ResourceQuota 配合

命名空间里存在计算资源配额时,未声明 requests/limits 的 Pod 会被直接拒绝。此时 LimitRange 的默认值就成了必需项:

```shell
apiVersion: v1
kind: LimitRange
metadata:
  name: default-resources
  namespace: default
spec:
  limits:
    - type: Container
      default:
        cpu: 500m
        memory: 512Mi
      defaultRequest:
        cpu: 100m
        memory: 128Mi
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: namespace-quota
  namespace: default
spec:
  hard:
    requests.cpu: "10"
    requests.memory: 20Gi
    limits.cpu: "20"
    limits.memory: 40Gi
```

这是生产命名空间的推荐基线配置:配额防止总量失控,LimitRange 保证每个 Pod 都有可计算的资源声明。

### 常用操作

```shell
# 查看命名空间里所有的 LimitRange
kubectl get limitrange -A
kubectl get limits -n default -o yaml

# 查看某个 Pod 最终生效的资源值(LimitRange 注入后的结果)
kubectl get pod nginx -o jsonpath='{.spec.containers[*].resources}' | jq .

# 查看 Pod 的 QoS 等级(LimitRange 会直接影响它)
kubectl get pod nginx -o jsonpath='{.status.qosClass}'

# 确认命名空间里是否存在多条 LimitRange(会造成默认值不确定)
kubectl get limits -n default --no-headers | wc -l

# 演练:提交一个超限的 Pod 观察报错
kubectl run test-over --image=nginx:1.27 --restart=Never \
  --overrides='{"spec":{"containers":[{"name":"test-over","image":"nginx:1.27","resources":{"requests":{"cpu":"4"}}}]}}'
```

被 LimitRange 拒绝时的典型报错:

```shell
Error from server (Forbidden): error when creating "pod.yaml": pods "example" is forbidden:
  [maximum cpu usage per Container is 2, but request is 4,
   must be less than or equal to cpu limit]
```

### 注意

1. **LimitRange 只在创建时生效,不会改动已有 Pod**。更新 LimitRange 后,旧 Pod 保持原样,新 Pod 按新规则走。想让旧负载符合新规则,必须触发一次滚动重建。

2. **LimitRange 不校验自己给的默认值是否自洽**。如果 `default.cpu` 比用户在 Pod 里写的 `requests.cpu` 还小,补完默认值后 request 就超过了 limit,Pod 会被拒绝创建。配置默认值时应当保证 `defaultRequest <= default`,并为 `max` 留出余量。

3. **`type: Container` 与 `type: Pod` 的检查对象不同**。前者逐容器检查,后者检查所有容器之和。一个 4 容器的 Pod,每个容器都不超过容器级 max,但总和可能超过 Pod 级 max,导致整个 Pod 被拒绝。

4. **`default` 和 `defaultRequest` 不能用于 `type: Pod`**。这是 API 层面的硬性限制,写了会报 `may not be specified when type is Pod`。

5. **一个命名空间里存在多条 LimitRange 时,默认值的应用结果是「不确定的」**。官方文档明确说明此时无法确定哪个默认值会被采用。生产命名空间应当只保留一条 `type: Container` 的 LimitRange。

6. **`storageClassName` 不是 LimitRange 字段**。PVC 的存储类由 PVC 自身指定,LimitRange 只负责 `storage` 的 `min`/`max`。把存储类写进 LimitRange 会直接报未知字段。

7. **LimitRange 会悄无声息地改变 Pod 的 QoS 等级**。只设 `default` 不设 `defaultRequest` 时,容器会得到 limit 而没有 request,进而触发「limit 复制为 request」的默认行为,反而变成 Guaranteed;而同时设置 `default` 与 `defaultRequest` 且不相等时会得到 Burstable。上线前应确认目标 QoS 是否是预期的那一个。

8. **LimitRange 不限制资源数量,也不强制声明资源**。只写 `min`/`max` 时,完全不声明 resources 的 Pod 仍可创建。要强制每个 Pod 都声明资源,必须依赖 ResourceQuota(它会拒绝缺失 requests/limits 的 Pod)。

9. **`maxLimitRequestRatio` 校验的是 limit ÷ request**。例如 `cpu: "4"` 表示 limit 不能超过 request 的 4 倍。request 为 `100m` 时 limit 最大为 `400m`;若容器没写 request 且没有默认请求值,比值校验会因为缺少分母而失败。

10. **超限是「创建被拒」而不是「调度失败」**。Pod 根本不会进入调度队列,`kubectl get pods` 里看不到它,`kubectl describe pod` 也无从查起。排查这类问题时要看的是 `kubectl apply` 的返回值和 API Server 的审计日志,而不是 Pod 事件。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `resource-quota` — 命名空间级总量限制,需与LimitRange配合
- `qos` — 由requests/limits(含LimitRange注入的默认值)决定的等级
- `pod` — 被约束的主要对象
- `pvc` — 存储上下限的作用对象
- `namespace` — LimitRange的作用域

### 参考链接

- [限制范围](https://kubernetes.io/docs/concepts/policy/limit-range/)
- [资源配额](https://kubernetes.io/docs/concepts/policy/resource-quotas/)
- [为命名空间配置默认 CPU 请求与上限](https://kubernetes.io/docs/tasks/administer-cluster/manage-resources/cpu-default-namespace/)
- [LimitRange API 参考](https://kubernetes.io/docs/reference/kubernetes-api/policy-resources/limit-range-v1/)
