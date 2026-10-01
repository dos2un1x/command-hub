taints-tolerations
===

Kubernetes中让节点排斥Pod的污点机制与Pod侧的容忍声明

## 补充说明

**Taint(污点)** 是打在**节点**上的标记,表示「这个节点不欢迎某些 Pod」;**Toleration(容忍)** 是写在**Pod** 上的声明,表示「我能接受这种污点」。两者配合,实现与亲和性方向相反的调度控制:亲和性是 Pod 主动挑选节点,污点是节点拒绝 Pod。

调度器处理污点的逻辑像一道**过滤器**:

```shell
1. 取出节点上的全部污点
2. 划掉 Pod 有对应容忍的那些污点
3. 剩下未被容忍的污点按 effect 生效:
     NoSchedule        → 不把 Pod 调度到该节点
     PreferNoSchedule  → 尽量不调度,但资源不够时仍可调度
     NoExecute         → 不调度;已运行的 Pod 会被驱逐
```

一个关键前提:**污点可以阻止调度,但不能吸引 Pod**。想让 Pod 只去某类节点,必须同时用 `nodeAffinity` 或 `nodeSelector` 把它们「吸」过去,只靠污点会把 Pod 卡在 Pending。

### 语法

```shell
kubectl taint nodes <node-name> <key>[=<value>]:<effect> [flags]
```

添加与删除:

```shell
# 添加污点
kubectl taint nodes node1 key1=value1:NoSchedule
kubectl taint nodes node1 key1=value1:NoExecute
kubectl taint nodes node1 dedicated=gpu:NoSchedule

# 不带 value 的污点
kubectl taint nodes node1 key1:NoSchedule

# 删除污点(在末尾加一个减号)
kubectl taint nodes node1 key1=value1:NoSchedule-
kubectl taint nodes node1 key1:NoSchedule-

# 按标签批量操作
kubectl taint nodes -l disktype=ssd dedicated=gpu:NoSchedule

# 删除所有节点上的控制平面污点(仅单机测试集群这么做)
kubectl taint nodes --all node-role.kubernetes.io/control-plane-
```

### 三种 effect 的行为

```shell
NoSchedule
  新 Pod:      不容忍则不调度
  已运行 Pod:  不动,继续留在节点上
  典型用途:    专用节点、控制平面节点

PreferNoSchedule
  新 Pod:      尽量不调度,资源紧张时仍会调度上去
  已运行 Pod:  不动
  典型用途:    软性的容量预留,不希望但可以接受

NoExecute
  新 Pod:      不容忍则不调度
  已运行 Pod:  立刻驱逐
  容忍但无 tolerationSeconds:  永久留在节点上
  容忍且有 tolerationSeconds:  再待 N 秒后由节点生命周期控制器驱逐
  典型用途:    节点故障(not-ready / unreachable)、节点下线前的腾空
```

### Toleration 字段

```shell
spec:
  tolerations:
    - key: "key1"
      operator: "Equal"
      value: "value1"
      effect: "NoSchedule"
    - key: "key2"
      operator: "Exists"
      effect: "NoExecute"
      tolerationSeconds: 3600
```

字段规则:

```shell
key                 污点的键;留空时必须搭配 operator: Exists,表示匹配所有键
operator            Equal(默认)或 Exists
value               operator 为 Exists 时不应填写
effect              留空表示匹配所有 effect
tolerationSeconds   仅对 NoExecute 有意义,表示被驱逐前还能停留多久
```

一个常见的误解是 `operator: Exists` 表示「容忍任意值」。准确的说法是:**`key` 为空且 `operator: Exists` 时才匹配所有键和值**,此时 `effect` 依然要单独匹配。

### 容忍全部污点

```shell
spec:
  tolerations:
    - operator: Exists
```

这条容忍的 `key`、`value`、`effect` 全部为空,可以容忍节点上的任何污点,常用于 DaemonSet 或运维专用负载。它的副作用是让节点上的 `NoExecute` 故障污点也失效,节点失联时 Pod 不会被迁移,使用前要想清楚。

### 只容忍某一类 effect

```shell
spec:
  tolerations:
    # 容忍控制平面污点,允许在控制平面节点上运行
    - key: node-role.kubernetes.io/control-plane
      operator: Exists
      effect: NoSchedule
    # 容忍"节点未就绪"污点 60 秒,给短暂抖动留出恢复时间
    - key: node.kubernetes.io/not-ready
      operator: Exists
      effect: NoExecute
      tolerationSeconds: 60
```

### 内置污点

节点控制器与 kubelet 会按节点状况(condition)自动打上污点,直到状况恢复才移除:

```shell
node.kubernetes.io/not-ready              NoExecute    Ready 条件为 False
node.kubernetes.io/unreachable            NoExecute    Ready 条件为 Unknown(节点失联)
node.kubernetes.io/memory-pressure        NoSchedule   内存压力
node.kubernetes.io/disk-pressure          NoSchedule   磁盘压力
node.kubernetes.io/pid-pressure           NoSchedule   PID 压力
node.kubernetes.io/network-unavailable    NoSchedule   节点网络未就绪(主要影响 hostNetwork Pod)
node.kubernetes.io/unschedulable          NoSchedule   节点被 cordon
node.cloudprovider.kubernetes.io/uninitialized  NoSchedule  云厂商尚未完成节点初始化
```

此外 kubeadm 会给控制平面节点打上 `node-role.kubernetes.io/control-plane:NoSchedule`。

### 自动注入的容忍

很多「我没写容忍,为什么能调度上去」的疑惑都来自这两处自动注入:

```shell
DefaultTolerationSeconds 准入控制器(apiserver)
  给所有未显式声明的 Pod 注入:
    node.kubernetes.io/not-ready    NoExecute  tolerationSeconds: 300
    node.kubernetes.io/unreachable  NoExecute  tolerationSeconds: 300
  可用 apiserver 的 --default-not-ready-toleration-seconds 与
  --default-unreachable-toleration-seconds 调整(默认均为 300)

DaemonSet 控制器
  给 DaemonSet 创建的 Pod 自动注入:
    not-ready / unreachable                     NoExecute(带 tolerationSeconds: 300)
    disk-pressure / memory-pressure / pid-pressure / unschedulable   NoSchedule
    network-unavailable                         NoSchedule(hostNetwork Pod)
```

这也解释了为什么节点宕机后,业务 Pod 要等约 5 分钟才开始漂移 —— 那正是默认的 300 秒容忍窗口。

### 常用操作

```shell
# 查看节点上的污点
kubectl describe node node1 | grep -A2 Taints
kubectl get node node1 -o jsonpath='{.spec.taints}' | jq .

# 以表格形式列出所有节点的污点
kubectl get nodes -o custom-columns='NAME:.metadata.name,TAINTS:.spec.taints'

# 查看 Pod 上的容忍
kubectl get pod nginx -o jsonpath='{.spec.tolerations}' | jq .

# 驱逐节点上的 Pod 后打上不可调度污点(节点维护标准流程)
kubectl drain node1 --ignore-daemonsets --delete-emptydir-data
kubectl cordon node1
kubectl uncordon node1

# 观察节点污点变化的实时过程
kubectl get nodes -w -o custom-columns='NAME:.metadata.name,TAINTS:.spec.taints'
```

### 排障

```shell
# Pod 因污点无法调度时,事件里会明确列出是哪个污点
kubectl describe pod nginx | sed -n '/Events/,$p'
# 0/3 nodes are available: 1 node(s) had untolerated taint {dedicated: gpu},
#                            2 node(s) had untolerated taint {node-role.kubernetes.io/control-plane: }

# 确认节点当前是否真的带这个污点
kubectl get node node1 -o jsonpath='{.spec.taints[?(@.key=="dedicated")]}'

# Pod 被 NoExecute 驱逐时,事件原因是 TaintManagerEviction
kubectl get events -A --field-selector reason=TaintManagerEviction
```

### 注意

1. **三种 effect 对「已运行 Pod」的行为完全不同**。`NoSchedule` 只管新调度,**不会**动已运行的 Pod;`PreferNoSchedule` 更弱,连新调度都拦不住;只有 `NoExecute` 会驱逐已运行的 Pod。给在线业务节点加污点时若误用了 `NoExecute`,会造成正在服务的 Pod 被立即赶走。

2. **`tolerationSeconds` 只对 `NoExecute` 有意义**。写在 `NoSchedule` 或 `PreferNoSchedule` 的容忍里不会报错,但完全不起作用,是典型的「配了但没效果」的坑。

3. **容错了不等于会被调度上去**。容忍只解除「污点这一层的拒绝」,节点资源不足、亲和性不匹配、节点被 cordon 等因素依然会阻止调度。容忍是必要条件,不是充分条件。

4. **手工指定 `spec.nodeName` 会绕过调度器**,污点中的 `NoSchedule` 也就拦不住;但若该节点有 Pod 未容忍的 `NoExecute` 污点,**kubelet 仍会把 Pod 驱逐掉**。直接指定 `nodeName` 时应格外小心。

5. **`kubectl drain` 依赖污点机制,但两者不是一回事**。`drain` 会给节点打上 `node.kubernetes.io/unschedulable` 污点再驱逐 Pod,而单纯 `cordon` 只打污点、不驱逐。要对节点做维护,必须用 `drain`。

6. **DaemonSet 的 Pod 会自动获得大量容忍**,所以它们不会因为节点打上 `memory-pressure` 等污点而被赶走。这也是容器网络、日志采集这类组件能在故障节点上继续运行的原因,排查「DaemonSet 为什么没被驱逐」时先想到这一点。

7. **默认 300 秒的容忍窗口意味着故障发现延迟**。节点宕机后 Pod 要等约 5 分钟才被判定失联并重建,无法满足严格的 RTO 要求;需要更快时可以调小 apiserver 的 `--default-not-ready-toleration-seconds` 等参数,或在 Pod 上显式声明更短的 `tolerationSeconds`。

8. **删除污点必须连值一起匹配**。`kubectl taint nodes node1 key1=value1:NoSchedule-` 才能删掉带值的污点;只写 `key1:NoSchedule-` 在某些情况下匹配不到,移除后建议用 `kubectl describe node` 再确认一次。

9. **污点不限制已有 Pod 占用的资源**,也不改变节点上已运行 Pod 的行为。给节点加 `NoSchedule` 后,该节点上的旧 Pod 会继续占用资源,新 Pod 进不来,容易形成「资源看着够、调度却不进去」的错觉。

10. **不建议在普通业务节点上滥用 `NoExecute`**。节点压力导致的 `NoExecute` 由 kubelet 自动管理,人工再加 `NoExecute` 会让 Pod 在节点间来回迁移,配合 `descheduler` 或集群自动伸缩时尤其容易产生震荡。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `node` — 污点的作用对象
- `pod` — 容忍声明的载体
- `affinity` — 与污点方向相反的调度控制机制
- `kube-scheduler` — 执行污点与容忍判定的调度器
- `poddisruptionbudget` — 节点腾空时保护可用副本数
- `descheduler` — 纠正运行后不再符合容忍规则的Pod

### 参考链接

- [污点和容忍度](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/)
- [节点状况与污点](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/#taint-nodes-by-condition)
- [安全的驱逐节点](https://kubernetes.io/docs/tasks/administer-cluster/safely-drain-node/)
- [kubectl taint 参考](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_taint/)
