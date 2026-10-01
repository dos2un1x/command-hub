poddisruptionbudget
===

Kubernetes中限制自愿中断时同时不可用Pod数量的可用性保障对象

## 补充说明

**PodDisruptionBudget(简称 PDB)** 用于限制**自愿中断(voluntary disruption)**期间,一组 Pod 中同时不可用的数量上限。它不阻止中断发生,而是给中断加上一个「配额」。

理解 PDB 的前提是把中断分成两类:

```shell
自愿中断    由人或运维动作发起,会走 Eviction API
            kubectl drain、节点排空、集群自动伸缩缩容、descheduler 驱逐

非自愿中断  不可预期、不走 Eviction API,PDB 完全无能为力
            节点宕机、硬件故障、内核 panic、节点资源压力驱逐、OOMKilled
```

因此 PDB **不是高可用方案**,它只是「让你在主动维护时别把服务一次性打垮」的协调机制。真正的可用性来自多副本 + 反亲和 + 足够的容量冗余。

PDB 的判定对象是「健康副本数」与「期望副本数」。期望副本数取自管理这些 Pod 的控制器(Deployment、StatefulSet 等)的 `scale` 子资源。

### 语法

```shell
kubectl get poddisruptionbudget [名称] [选项]
kubectl describe poddisruptionbudget [名称]
kubectl delete poddisruptionbudget [名称]
```

常用简写为 `pdb`:

```shell
kubectl get pdb
kubectl describe pdb nginx-pdb
```

### YAML 清单

保证至少 2 个副本可用:

```shell
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: nginx-pdb
  namespace: default
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: nginx
```

按百分比保证可用(向上取整):

```shell
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: frontend-pdb
spec:
  minAvailable: "50%"
  selector:
    matchLabels:
      app: frontend
```

限制最多中断 1 个(适合 etcd、Consul 这类有 quorum 的系统):

```shell
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: quorum-pdb
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      app: consul
```

`minAvailable` 与 `maxUnavailable` **只能二选一**,同时写会被 API Server 拒绝。

创建与查看:

```shell
kubectl apply -f pdb.yaml

kubectl get pdb
# NAME        MIN AVAILABLE   MAX UNAVAILABLE   ALLOWED DISRUPTIONS   AGE
# nginx-pdb   2               N/A               1                     10s

kubectl get pdb -A
kubectl describe pdb nginx-pdb
```

`ALLOWED DISRUPTIONS` 是 PDB 最有价值的一列:**它是当前还可以安全驱逐的 Pod 数量**。为 0 时任何驱逐都会被拒绝。

### 百分比的计算方式

```shell
期望副本数 7,minAvailable: "50%"   →  必须保留 ceil(7 × 0.5) = 4 个,可中断 3 个
期望副本数 7,maxUnavailable: "50%"  →  最多中断 ceil(7 × 0.5) = 4 个
```

两者都是**向上取整**,但语义方向相反:`minAvailable` 向上取整让约束更严,`maxUnavailable` 向上取整让约束更松,这一点官方文档明确提示过,「中断数可能超过你设置的百分比」。

### 不健康 Pod 的驱逐策略

`unhealthyPodEvictionPolicy` 决定「已经不健康(未 Ready)的 Pod 能不能绕过预算被驱逐」:

```shell
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: stateful-pdb
spec:
  minAvailable: 2
  unhealthyPodEvictionPolicy: IfHealthyBudget
  selector:
    matchLabels:
      app: my-stateful-app
```

```shell
AlwaysAllow       默认值。不健康的 Pod 可以被驱逐,即使这会突破预算
IfHealthyBudget   只有预算仍然满足时,才允许驱逐不健康的 Pod
```

`AlwaysAllow` 的默认行为其实很合理:故障中的 Pod 本来就该被清掉,不值得为它保留配额。而 `IfHealthyBudget` 适合那些「Pod 不健康时绝不能动它」的有状态服务,避免运维动作把最后一点数据可用性也带走。

### 常用操作

```shell
# 查看所有 PDB 及剩余可驱逐数量
kubectl get pdb -A
kubectl get pdb -A -o wide

# 查看 PDB 选中了哪些 Pod,以及当前计数
kubectl describe pdb nginx-pdb

# 用 JSONPath 快速检查是否还能驱逐
kubectl get pdb nginx-pdb -o jsonpath='{.status.disruptionsAllowed}'

# 查看期望副本数与当前健康数
kubectl get pdb nginx-pdb -o jsonpath=\
'{.status.expectedPods}{" expected / "}{.status.currentHealthy}{" healthy / "}{.status.desiredHealthy}{" desired"}'

# 排空节点(会自动遵循 PDB)
kubectl drain node1 --ignore-daemonsets --delete-emptydir-data

# 临时放开限制(维护窗口内)
kubectl delete pdb nginx-pdb
```

PDB 被触发时,`kubectl drain` 会持续重试并在超时后报错:

```shell
error: unable to drain node "node1", aborting command...
There are pending nodes to be drained:
 node1
error: cannot delete Pods with local storage (use --delete-emptydir-data to override)
error: Cannot evict pod as it would violate the pod's disruption budget.
```

### 注意

1. **PDB 只拦得住 Eviction API,拦不住直接删除**。`kubectl delete pod`、`kubectl delete deployment`、滚动更新、缩容副本数都**不会**经过 Eviction API,PDB 对它们**毫无约束力**。PDB 生效的前提是操作方主动走驱逐接口(如 `kubectl drain`、集群自动伸缩、descheduler)。

2. **`minAvailable` 等于副本数会让节点永远排空不了**。例如 3 副本配 `minAvailable: 3`,任何驱逐都会让可用数低于预算,**`kubectl drain` 会无限重试直至超时**。这是 PDB 最常见的「事故」,维护单副本有状态服务时尤其要小心。

3. **`policy/v1` 与 `policy/v1beta1` 的空选择器语义完全相反**。`policy/v1` 中空的 `selector: {}` 表示**匹配命名空间内所有 Pod**;而 `policy/v1beta1` 中表示**匹配零个 Pod**。从旧版本迁移时如果沿用了空选择器,PDB 的作用范围会瞬间扩大到整个命名空间。

4. **`maxUnavailable` 只对「同一个控制器管理的 Pod」有意义**。官方文档明确指出它只能用于控制那些由同一个控制器管理的 Pod 的驱逐。选择器如果同时选中了多个 Deployment 的 Pod,预算计算会变得难以预期。

5. **单副本 + `maxUnavailable: 0` 等于彻底锁死**。官方推荐的模式是「用 `maxUnavailable: 0` 表达『必须先联系我』,需要维护时先删掉 PDB,事后重建」,而不是指望它自动放行。

6. **节点故障、OOM、资源压力驱逐都不受 PDB 保护**。这些属于非自愿中断,PDB 完全不参与。看到「配了 PDB 服务还是挂了」时,先确认中断到底是不是自愿中断。

7. **PDB 不保证相应数量的 Pod 一定可用**。它只是限制并发中断的许可数,如果 Pod 因为镜像拉取失败、探针不过、资源不足而长期起不来,PDB 无法创造可用性。

8. **`ALLOWED DISRUPTIONS` 为 0 不等于出故障**。当副本刚好达到下限、或正处于滚动更新中时该值为 0 是正常的。真正要关注的是 `status.currentHealthy` 是否长期低于 `status.desiredHealthy`。

9. **PDB 不适用于裸 Pod**。没有被控制器管理的 Pod 没有 `scale` 子资源,无法计算「期望副本数」,PDB 对它们的行为不可靠。

10. **集群自动伸缩、节点升级、descheduler 都依赖 PDB**。若集群里大量 PDB 都被卡在 0 许可,会自动导致节点缩容失败、Kubernetes 版本升级停滞、descheduler 驱逐被跳过,这类「什么都没坏但什么都推不动」的现象往往就出在这里。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `deployment` — 提供期望副本数的控制器
- `statefulset` — 有状态工作负载,PDB 的典型使用场景
- `replicaset` — Pod 副本控制器
- `pod` — PDB 选择器的作用对象
- `taints-tolerations` — 节点排空时配合使用的机制
- `descheduler` — 驱逐 Pod 时会遵循 PDB 的组件
- `cluster-autoscaler` — 缩容节点时会遵循 PDB 的组件

### 参考链接

- [Pod 中断预算](https://kubernetes.io/docs/tasks/run-application/configure-pdb/)
- [自愿中断与非自愿中断](https://kubernetes.io/docs/concepts/workloads/pods/disruptions/)
- [安全地排空节点](https://kubernetes.io/docs/tasks/administer-cluster/safely-drain-node/)
- [PodDisruptionBudget API 参考](https://kubernetes.io/docs/reference/kubernetes-api/policy-resources/pod-disruption-budget-v1/)
