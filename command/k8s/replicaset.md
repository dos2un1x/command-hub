replicaset
===

Kubernetes Pod副本数控制器

## 补充说明

**ReplicaSet** 的职责非常单一:保证集群中**任意时刻都存在指定数量的、匹配其选择器的 Pod**。它通过 `spec.replicas` 声明期望副本数,并不断对比实际状态,少则补、多则删。

ReplicaSet 通过 `spec.selector`(支持 `matchLabels` 与 `matchExpressions`)识别自己该管哪些 Pod,这些 Pod 的 `metadata.ownerReferences` 会指向该 ReplicaSet。当 Pod 被删除、节点故障或人为扩缩容时,ReplicaSet 控制器会立即创建或删除 Pod 来回到期望状态。

**在绝大多数场景下,不应该直接创建 ReplicaSet。** Deployment 才是面向用户的抽象层:Deployment 在每次修改 Pod 模板时创建一个新的 ReplicaSet,再由新旧 ReplicaSet 的副本数此消彼长完成滚动更新。旧 ReplicaSet 被保留下来,这就是 `kubectl rollout undo` 能回滚的原理。ReplicaSet 本身不具备滚动更新能力 —— 直接修改它的 Pod 模板不会触发任何自动更新,旧 Pod 必须手动删除才会以新模板重建。

### 语法

```shell
kubectl [command] replicaset [flags]
```

ReplicaSet 的常用简写为 `rs`:

```shell
kubectl get rs
kubectl describe rs nginx-7d9c8f5b6c
```

### ReplicaSet 清单

```shell
apiVersion: apps/v1
kind: ReplicaSet
metadata:
  name: nginx-rs
  labels:
    app: nginx
    tier: frontend
spec:
  replicas: 3
  selector:
    matchLabels:
      app: nginx
    matchExpressions:
      - key: tier
        operator: In
        values: ["frontend"]
  template:
    metadata:
      labels:
        app: nginx
        tier: frontend
    spec:
      containers:
        - name: nginx
          image: nginx:1.27
          ports:
            - containerPort: 80
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 256Mi
```

创建与查看:

```shell
kubectl apply -f replicaset.yaml
kubectl get rs
kubectl get rs -o wide
kubectl describe rs nginx-rs
kubectl get pods -l app=nginx
```

### selector 的两种写法

```shell
# matchLabels:精确匹配,写法最简单
selector:
  matchLabels:
    app: nginx
    tier: frontend

# matchExpressions:支持 In / NotIn / Exists / DoesNotExist
selector:
  matchExpressions:
    - key: app
      operator: In
      values: ["nginx", "apache"]
    - key: tier
      operator: Exists
    - key: debug
      operator: DoesNotExist
```

两种写法可以混用,条件是**与**关系。ReplicaSet 的选择器通常是 Deployment 选择器加上 `pod-template-hash` 标签,以此保证不同版本的 ReplicaSet 不会互相抢 Pod:

```shell
kubectl get pods --show-labels
# app=nginx,pod-template-hash=7d9c8f5b6c
```

### 扩缩容

```shell
# 手动扩缩容
kubectl scale rs nginx-rs --replicas=5

# 缩到 0 但保留对象(便于快速恢复)
kubectl scale rs nginx-rs --replicas=0

# 直接编辑
kubectl edit rs nginx-rs

# 局部修改
kubectl patch rs nginx-rs -p '{"spec":{"replicas":2}}'
```

对裸 ReplicaSet 而言,修改 `spec.replicas` 后不会自动更新 Pod 内容,新副本才会使用新的 `template`。要让已有 Pod 也用上新模板,必须手动删除旧 Pod:

```shell
# 分批重建(注意:裸 ReplicaSet 没有滚动更新保障,会造成短暂容量下降)
kubectl delete pod -l app=nginx --wait=false
```

### 观察 Deployment 与 ReplicaSet 的关系

```shell
# Deployment 拥有若干 ReplicaSet,每个对应一次 Pod 模板变更
kubectl get deploy nginx
kubectl get rs -l app=nginx

# 查看每个 ReplicaSet 的版本注解
kubectl get rs -l app=nginx \
  -o custom-columns=NAME:.metadata.name,REVISION:.metadata.annotations.deployment\\.kubernetes\\.io/revision,DESIRED:.spec.replicas

# 查看 Pod 属于哪个 ReplicaSet
kubectl get pod nginx-7d9c8f5b6c-abcde -o jsonpath='{.metadata.ownerReferences[0].name}'

# 回滚本质上是把流量还给了某个旧 ReplicaSet
kubectl rollout undo deployment/nginx
```

### 删除与保留

```shell
# 删除 ReplicaSet,默认级联删除它管理的 Pod
kubectl delete rs nginx-rs

# 只删除 ReplicaSet,保留 Pod(--cascade=orphan)
kubectl delete rs nginx-rs --cascade=orphan

# 删除 Deployment 时保留 ReplicaSet 与 Pod
kubectl delete deploy nginx --cascade=orphan
```

`--cascade=orphan` 常用于「想接管已有 Pod」的场景:先解除控制器的归属关系,Pod 便成了裸 Pod,之后可以由新的控制器通过标签收养。

### 注意

1. **不要直接修改由 Deployment 创建的 ReplicaSet**。改动会被下一次滚动更新覆盖,而且副本数被手工改动后 Deployment 会立即把它调回去,导致反复抖动。
2. **手动删除 Deployment 的旧 ReplicaSet 会失去回滚能力**。`revisionHistoryLimit` 之外的 ReplicaSet 由 Deployment 自动清理,无需人工介入。
3. ReplicaSet 的 `spec.selector` **创建后不可变更**,写错选择器只能删除重建。
4. 选择器不能为空,且必须与 `spec.template.metadata.labels` 匹配,否则 API Server 拒绝创建。
5. ReplicaSet 会**收养没有控制器的孤儿 Pod**,只要标签匹配。因此不要给裸 Pod 打上和 ReplicaSet 选择器一致的标签,否则它会被「算进」副本数,导致实际业务副本不足。
6. 两个 ReplicaSet 的选择器**不应重叠**,否则会互相争抢 Pod,表现为 Pod 被反复创建和删除。
7. 裸 ReplicaSet **没有滚动更新、没有历史版本、没有回滚**,只有「副本数」这一个能力。需要这些能力请使用 Deployment。
8. `--cascade=orphan` 删除后 Pod 仍在运行,但失去自愈能力,节点故障不会重建,记得尽快用新的控制器接管。
9. ReplicaSet 名字会影响 Pod 名,Pod 名为 `<rs-name>-<5 位随机串>`,过长的名字可能触碰 63 字符的标签/名称长度限制。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `deployment` — 无状态工作负载控制器
- `statefulset` — 有状态工作负载控制器
- `daemonset` — 每节点守护进程
- `pod` — 最小调度单元

### 参考链接

- [ReplicaSet 官方文档](https://kubernetes.io/docs/concepts/workloads/controllers/replicaset/)
- [Deployment 与 ReplicaSet 的关系](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#replicaset)
- [标签与选择器](https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/)
- [kubectl scale 命令参考](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_scale/)
