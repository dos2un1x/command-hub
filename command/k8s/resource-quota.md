resource-quota
===

Kubernetes中限制命名空间内资源总量与对象数量的配额对象

## 补充说明

**ResourceQuota(资源配额)** 作用于**命名空间**,限制该命名空间内所有工作负载能消耗的资源总量,以及能创建的 API 对象数量。它由 API Server 的 `ResourceQuota` 准入控制器强制执行,是集群多租户隔离的基础手段。

ResourceQuota 管两件事:

```shell
1. 资源总量   所有非终止状态 Pod 的 requests/limits 之和,存储请求总量
2. 对象数量   Pod、Service、ConfigMap、PVC 等对象的个数
```

它是**准入时**的检查:创建或更新请求若会导致超出配额,API Server 直接返回 `403 Forbidden`,对象根本不会被创建。已经存在的对象不受影响 —— 事后调小配额不会删掉任何东西,只是让新的创建失败。

### 语法

```shell
kubectl get resourcequota [名称] [选项]
kubectl describe resourcequota [名称]
kubectl delete resourcequota [名称]
```

常用简写为 `quota`:

```shell
kubectl get quota -n default
kubectl describe quota compute-quota -n default
```

### YAML 清单

限制计算资源总量:

```shell
apiVersion: v1
kind: ResourceQuota
metadata:
  name: compute-quota
  namespace: default
spec:
  hard:
    requests.cpu: "10"
    requests.memory: 20Gi
    limits.cpu: "20"
    limits.memory: 40Gi
    requests.ephemeral-storage: 50Gi
    limits.ephemeral-storage: 100Gi
```

限制对象数量与存储:

```shell
apiVersion: v1
kind: ResourceQuota
metadata:
  name: object-counts
  namespace: default
spec:
  hard:
    pods: "20"
    services: "10"
    configmaps: "20"
    secrets: "20"
    persistentvolumeclaims: "8"
    services.loadbalancers: "2"
    services.nodeports: "5"
    requests.storage: 500Gi
    gold.storageclass.storage.k8s.io/requests.storage: 100Gi
    count/deployments.apps: "10"
    count/jobs.batch: "20"
```

应用与查看:

```shell
kubectl apply -f quota.yaml

kubectl get quota -n default
# NAME            AGE   REQUEST                                            LIMIT
# compute-quota   5s    requests.cpu: 2/10, requests.memory: 1Gi/20Gi  limits.cpu: 4/20, ...

kubectl describe quota compute-quota -n default
```

### 支持的资源名

```shell
requests.cpu                  所有非终止 Pod 的 CPU 请求之和
requests.memory               所有非终止 Pod 的内存请求之和
limits.cpu                    所有非终止 Pod 的 CPU 上限之和
limits.memory                 所有非终止 Pod 的内存上限之和
cpu / memory                  与 requests.cpu / requests.memory 等价
hugepages-<size>              指定尺寸的巨页请求总量,如 hugepages-2Mi
requests.ephemeral-storage    本地临时存储请求总量
limits.ephemeral-storage      本地临时存储上限总量
requests.storage              PVC 申请的总存储量
requests.nvidia.com/gpu       扩展资源,只能使用 requests. 前缀
<storageclass>.storageclass.storage.k8s.io/requests.storage   按 StorageClass 细分
```

扩展资源(如 GPU)**不允许超卖**,因此只支持 `requests.` 前缀的写法,写 `limits.nvidia.com/gpu` 会被拒绝。

对象数量既可以用固定的短名,也可以用通用的 `count/` 前缀:

```shell
pods  services  configmaps  secrets  persistentvolumeclaims
replicationcontrollers  resourcequotas  services.loadbalancers  services.nodeports
count/deployments.apps  count/jobs.batch  count/<资源名>.<api组>
```

### 用 scopes 限定配额的作用范围

`scopes` 让一份配额只作用于特定类型的 Pod:

```shell
apiVersion: v1
kind: ResourceQuota
metadata:
  name: besteffort-quota
  namespace: default
spec:
  hard:
    pods: "10"
  scopes:
    - BestEffort
```

```shell
Terminating        只统计 spec.activeDeadlineSeconds >= 0 的 Pod
NotTerminating     只统计未设置 activeDeadlineSeconds 的 Pod
BestEffort         只统计 QoS 为 BestEffort 的 Pod
NotBestEffort      只统计 QoS 为 Burstable 或 Guaranteed 的 Pod
PriorityClass      需配合 scopeSelector 使用,按优先级类划分
CrossNamespacePodAffinity   限制跨命名空间的 Pod 亲和/反亲和
```

### 用 scopeSelector 精确控制

按优先级类限制 Pod 数量:

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

```shell
operator 取值    In、NotIn、Exists、DoesNotExist
scopeName       PriorityClass、CrossNamespacePodAffinity
values          In / NotIn 必填;Exists / DoesNotExist 必须省略
```

### 配额存在时 Pod 必须声明 requests/limits

这是 ResourceQuota 最容易踩的规则。**一旦命名空间里存在限制 `cpu` 或 `memory` 的配额,该命名空间中每个新建 Pod 都必须为对应资源填写 `requests` 或 `limits`**:

```shell
# 配额存在时,这个 Pod 会被拒绝创建
apiVersion: v1
kind: Pod
metadata:
  name: no-resources
spec:
  containers:
    - name: app
      image: nginx:1.27
```

报错形如:

```shell
Error from server (Forbidden): error when creating "pod.yaml": pods "no-resources" is
forbidden: failed quota: compute-quota: must specify limits.cpu,limits.memory,
requests.cpu,requests.memory
```

解决办法有两种:在 Pod 模板里显式声明,或者用 LimitRange 提供默认值:

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
```

其他资源(如 ephemeral-storage)没有这条强制要求,未声明时会被配额**忽略**而不是拒绝。

### 常用操作

```shell
# 查看所有命名空间的配额
kubectl get quota -A

# 查看配额详情(包含已用与上限的对比)
kubectl describe quota -n default

# 用 JSONPath 提取剩余额度
kubectl get quota compute-quota -n default -o jsonpath='{.status.used}{"\n"}{.status.hard}{"\n"}'

# 临时提高配额(注意:不会让已失败的对象自动创建)
kubectl patch quota compute-quota -n default --type=merge \
  -p '{"spec":{"hard":{"requests.cpu":"20"}}}'
```

### 排障

```shell
# 对象创建被拒绝时,先看错误信息里提示的是哪条配额
kubectl apply -f deployment.yaml

# 检查是不是配额把某个对象挡住了(事件里会出现 FailedCreate)
kubectl get events -n default --field-selector reason=FailedCreate
```

### 注意

1. **配额生效后,新建 Pod 必须写 requests/limits**。命名空间里存在 `requests.cpu` 或 `limits.cpu` 这类配额时,任何未声明对应资源的 Pod 都会被直接拒绝。这是「配额一加上线,Deployment 就全部创建失败」的根本原因,应当同步部署 LimitRange 提供默认值。

2. **配额只做准入检查,不改动已有对象**。调小配额不会驱逐或删除已运行的 Pod,调大配额也不会让之前创建失败的对象自动重试。Deployment 会持续重试创建 Pod,但需要手动触发或等待其重新同步。

3. **Deployment 创建成功不等于 Pod 创建成功**。若配额只够创建部分副本,Deployment 对象本身会成功创建,但 Pod 只会有一部分被创建出来,剩下的反复被拒绝并在事件中留下 `FailedCreate`。判断配额问题时必须看 Pod 和事件,不能只看 Deployment 是否创建成功。

4. **`cpu` 与 `requests.cpu` 是同义词,扩展资源只能用 `requests.` 前缀**。同一份 `hard` 里同时写 `cpu` 和 `requests.cpu` 不会报错,但会让人误以为它们是两项独立额度,实际是同一个计量项;而 GPU 这类扩展资源不允许超卖,写成 `limits.nvidia.com/gpu` 会被 API Server 直接拒绝。

5. **`scopes` 的两组取值互斥**。`Terminating`/`NotTerminating` 与 `BestEffort`/`NotBestEffort` 每组只能选一个,同时写两个互斥值会让配额匹配到空集合,表面上「配额存在但从来不生效」。

6. **一个命名空间可以有多份配额,它们同时生效**。多份配额之间是「与」的关系,任何一份被突破都会拒绝请求。排查时必须逐份检查,不要只看第一条。

7. **配额不限制 DaemonSet 的部分行为,但与 `pods` 计数相关**。DaemonSet 创建的 Pod 同样计入 `pods` 数量与资源总量,若配额过小,DaemonSet 会在部分节点上无法拉起 Pod,表现为「某些节点上缺少日志/网络组件」。

8. **`CrossNamespacePodAffinity` 这个 scope 用于限制跨命名空间的 Pod 亲和**。它约束的是 Pod 亲和/反亲和里 `namespaces`/`namespaceSelector` 的使用,与资源量无关,是防止租户窥探其他命名空间 Pod 标签的安全手段。

9. **删除配额等于彻底放开**。如果配额是租户隔离的唯一手段,删除操作应当通过 RBAC 严格限制;否则任何能删配额的用户都能绕过限制。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `namespace` — 配额的作用域
- `limitrange` — 为Pod提供默认requests/limits,避免被配额拒绝
- `qos` — 与配额共同决定Pod的资源保障等级
- `pod` — 计入配额的主要对象
- `pvc` — 存储配额的作用对象
- `priority-class` — 通过scopeSelector与配额联动的优先级类

### 参考链接

- [资源配额](https://kubernetes.io/docs/concepts/policy/resource-quotas/)
- [限制范围](https://kubernetes.io/docs/concepts/policy/limit-range/)
- [为命名空间配置默认内存请求与上限](https://kubernetes.io/docs/tasks/administer-cluster/manage-resources/memory-default-namespace/)
- [ResourceQuota API 参考](https://kubernetes.io/docs/reference/kubernetes-api/policy-resources/resource-quota-v1/)
