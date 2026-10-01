qos
===

Kubernetes中根据Pod资源声明划分的服务质量等级

## 补充说明

**QoS(Quality of Service,服务质量)** 不是一种可以创建的资源对象,而是 Kubernetes 根据 Pod 的 `resources` 声明**自动推导**出来的一个等级,记录在 `status.qosClass` 字段中。它决定了节点资源紧张时 Pod 的处境。

三个等级:

```shell
Guaranteed   完全保障。requests 与 limits 相等且都不为零,最不容易被驱逐
Burstable    部分保障。至少有一个容器声明了 requests 或 limits,但没达到 Guaranteed
BestEffort   无保障。所有容器都没有声明任何 CPU/内存的 requests 与 limits
```

QoS 的作用在于节点资源耗尽时决定**先牺牲谁**:

```shell
驱逐顺序        BestEffort  →  Burstable  →  Guaranteed
OOM 优先级      BestEffort 的 OOM 得分最高,内核最先杀它
```

注意「驱逐」与「OOM」是两套机制:驱逐由 kubelet 按 QoS 与优先级排序执行,而 OOM 由 Linux 内核按 `oom_score_adj` 执行,两者的排序依据不完全相同。

### 判定规则

**Guaranteed** 需要同时满足(对 Pod 内**每一个**容器,包括 init 容器和 Sidecar):

```shell
1. 必须有内存 limit 与内存 request,且都大于 0
2. 每个容器的内存 limit 必须等于内存 request
3. 必须有 CPU limit 与 CPU request,且都大于 0
4. 每个容器的 CPU limit 必须等于 CPU request
```

**Burstable** 满足:

```shell
1. 不满足 Guaranteed 的条件
2. 且 Pod 中至少有一个容器声明了 CPU 或内存的 request 或 limit
```

**BestEffort** 满足:

```shell
Pod 中没有任何容器声明 CPU 或内存的 request 或 limit
(声明了其他资源如 ephemeral-storage、hugepages 不影响判定)
```

### 三个等级的清单对比

Guaranteed —— 每个容器 limits 与 requests 完全相等:

```shell
apiVersion: v1
kind: Pod
metadata:
  name: qos-guaranteed
spec:
  containers:
    - name: app
      image: nginx:1.27
      resources:
        requests:
          cpu: "1"
          memory: 512Mi
        limits:
          cpu: "1"          # 必须等于 requests.cpu
          memory: 512Mi     # 必须等于 requests.memory
```

Burstable —— 只声明了 requests,或 limit 与 request 不相等:

```shell
apiVersion: v1
kind: Pod
metadata:
  name: qos-burstable
spec:
  containers:
    - name: app
      image: nginx:1.27
      resources:
        requests:
          cpu: 100m
          memory: 128Mi
        limits:
          cpu: 500m         # 与 request 不相等
          memory: 256Mi
```

BestEffort —— 完全不写 resources:

```shell
apiVersion: v1
kind: Pod
metadata:
  name: qos-besteffort
spec:
  containers:
    - name: app
      image: nginx:1.27
```

### 混合容器的判定

多容器 Pod 只要**有一个**容器不满足 Guaranteed,整个 Pod 就降级:

```shell
spec:
  containers:
    - name: app
      image: myapp:1.0
      resources:
        requests: {cpu: "1", memory: 512Mi}
        limits:   {cpu: "1", memory: 512Mi}    # 这个容器是 Guaranteed
    - name: istio-proxy
      image: proxyv2
      resources:
        requests: {cpu: 100m, memory: 128Mi}   # 只有 request,没有 limit
```

整个 Pod 的 QoS 是 **Burstable**,而不是 Guaranteed。注入 Sidecar 的 Service Mesh 环境里,这一点经常让「明明主容器写得很规范」的服务降级。

### 只写 limit 不写 request 会发生什么

```shell
spec:
  containers:
    - name: app
      image: nginx:1.27
      resources:
        limits:
          cpu: "1"
          memory: 512Mi
```

若没有任何准入机制(如 LimitRange 的 `defaultRequest`)补上 request,API Server 会**把 limit 复制为 request**,最终 Pod 的 request 与 limit 相等,判定为 **Guaranteed**。

但一旦 LimitRange 提供了不同的 `defaultRequest`,复制行为就不会发生,Pod 变成 **Burstable**。所以同一个清单在不同命名空间里可能得到不同的 QoS 等级,排查时必须看**创建后**的 `spec`,而不是原始 YAML。

### 查看 QoS 等级

```shell
# 单个 Pod
kubectl get pod nginx -o jsonpath='{.status.qosClass}'
# Guaranteed

# 按等级筛选
kubectl get pods -A -o custom-columns=\
'NS:.metadata.namespace,NAME:.metadata.name,QOS:.status.qosClass'

# 找出所有 BestEffort 的 Pod(最脆弱的一批)
kubectl get pods -A -o jsonpath=\
'{range .items[?(@.status.qosClass=="BestEffort")]}{.metadata.namespace}/{.metadata.name}{"\n"}{end}'

# 查看容器实际的 resources 声明
kubectl get pod nginx -o jsonpath='{.spec.containers[*].resources}' | jq .

# 查看节点的资源压力状况
kubectl describe node node1 | grep -A5 Conditions
kubectl describe node node1 | grep -A8 "Allocated resources"
```

### 驱逐与 OOM 的排序细节

```shell
节点资源压力驱逐(kubelet 发起)
  第一优先   BestEffort
  第二优先   Burstable,且实际用量超过 requests
  最后       Guaranteed
  另外:同一等级内,Pod 优先级(priority)低的先被驱逐

内核 OOM Killer(oom_score_adj 决定)
  Guaranteed   -997            几乎不会被杀
  BestEffort   1000            最先被杀
  Burstable    2 ~ 999         由内存 request 占节点总内存的比例决定
                               公式:min(max(2, 1000 - 1000 × request/节点内存), 999)
```

Burstable 的公式意味着:**request 填得越大越安全**。一个 request 写了 1Gi 的 Burstable Pod,比同样使用但只写 128Mi 的 Pod 更难被 OOM 杀掉。

### 常用操作

```shell
# 统计各命名空间的 QoS 分布
kubectl get pods -A -o json | jq -r \
  '.items[] | "\(.metadata.namespace) \(.status.qosClass)"' | sort | uniq -c | sort -rn

# 找出声明了 limits 但没声明 requests 的容器
kubectl get pods -A -o json | jq -r \
  '.items[] | select(.spec.containers[]? | (.resources.limits != null) and (.resources.requests == null)) | .metadata.name'

# 观察节点压力事件
kubectl get events -A --field-selector reason=Evicted
kubectl get events -A --field-selector reason=OOMKilling

# 查看 Pod 是否被 OOM 杀过
kubectl describe pod nginx | grep -i -A2 "Last State"
kubectl get pod nginx -o jsonpath='{.status.containerStatuses[*].lastState}'
```

### 注意

1. **Guaranteed 要求 CPU 和内存同时满足,缺一不可**。只给内存配了相等的 requests/limits,CPU 完全不写,判定结果是 **Burstable** 而不是 Guaranteed。很多人以为「内存对齐了就稳了」,其实还差一半。

2. **`limits` 与 `requests` 必须完全相等,而不是「差不多」**。`requests: 500m` 配 `limits: 0.5` 在数值上相等(都是 0.5 核),换算成同一单位后确实相等,可以判定为 Guaranteed;但 `500m` 与 `501m` 这种看似接近的写法会直接掉到 Burstable。

3. **init 容器和 Sidecar 也参与判定**。任何 init 容器的资源声明不满足 Guaranteed 条件,整个 Pod 都会降级。注入 Sidecar 的环境里应检查 Sidecar 的资源配置,它常常是降级的真凶。

4. **`BestEffort` 是最危险的等级**。这类 Pod 没有任何资源声明,节点一紧张就第一个被驱逐,同时也让调度器无法感知它的资源占用,把大量 BestEffort Pod 挤到同一节点会造成连锁驱逐。生产环境不应出现 BestEffort 业务 Pod。

5. **QoS 等级创建后不可修改**。它由资源声明推导而来,而 `resources` 虽可在部分场景下原地更新,但已运行的 Pod 不会因为改了声明就重新计算等级;实务中要改变 QoS 只能重建 Pod。

6. **Pod 级资源(Pod-level resources)会改变判定方式**。当 Pod 使用 `spec.resources`(Pod 级)而非容器级资源时,Guaranteed 的判定改为检查 Pod 级的内存/CPU limit 与 request 是否相等,这是较新版本才支持的能力,老集群上不可用。

7. **QoS 不保证「一定不会被驱逐」**。Guaranteed 只是排序上的最后一名,当节点整体资源耗尽、或节点被 `drain`、或 kubelet 判定需要回收时,Guaranteed Pod 同样会被驱逐。它降低的是概率,不是提供豁免。

8. **驱逐时的判定依据是「实际用量是否超过 requests」**。Burstable Pod 只有在用量超过自己声明的 requests 时才会成为驱逐候选;因此把 requests 压得很低虽然能塞进更多 Pod,却会让自己在压力下最先出局,是一笔明显的风险交换。

9. **QoS 与 PodDisruptionBudget 完全无关**。PDB 管的是自愿中断的并发数量,QoS 管的是节点资源压力下的排序,两者不互相影响,不要指望 PDB 能保护 BestEffort Pod。

10. **`kubectl top` 看到的是实际用量,与 QoS 无关**。判断一个 Pod 会不会被驱逐要看它的 `requests` 与实际用量的关系,而不是看它当前用了多少 CPU 或内存。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `pod` — QoS等级的载体
- `resource-quota` — 与QoS共同决定资源约束的配额
- `limitrange` — 通过注入默认值改变QoS等级
- `hpa` — 依赖requests计算利用率的控制器
- `vpa` — 自动调整requests从而影响QoS等级

### 参考链接

- [Pod 服务质量等级](https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/)
- [节点压力驱逐](https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/)
- [为 Pod 和容器管理资源](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
- [Pod 优先级与抢占](https://kubernetes.io/docs/concepts/scheduling-eviction/pod-priority-preemption/)
