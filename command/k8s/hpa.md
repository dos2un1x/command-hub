hpa
===

Kubernetes水平自动扩缩容控制器

## 补充说明

**HorizontalPodAutoscaler**(简称 HPA)根据观测到的指标自动调整工作负载的副本数。它周期性地(默认每 15 秒)从 Metrics API 读取指标,计算出期望副本数,再写回目标对象的 `scale` 子资源。

HPA 的扩缩容公式为:

```shell
desiredReplicas = ceil[currentReplicas × (currentMetricValue / desiredMetricValue)]
```

例如当前 3 个副本、CPU 平均利用率 90%、目标 60%,则期望副本数为 `ceil(3 × 90/60) = ceil(4.5) = 5`。为避免抖动,当比值与 1 的差距在 **10%(默认容差)** 以内时不做任何调整。

HPA 依赖 **metrics-server** 提供 CPU/内存指标。没有部署 metrics-server 时,`kubectl top` 会报错,HPA 的 `TARGETS` 列会显示 `<unknown>`,且**不会执行任何扩缩容**。这是 HPA「不生效」最常见的原因。

HPA 只能作用于提供 `scale` 子资源的对象,因此可以用于 Deployment、StatefulSet、ReplicaSet,也支持自定义资源;DaemonSet 不支持。

### 语法

```shell
kubectl [command] hpa [flags]
```

HPA 的常用简写为 `hpa`(无更短别名):

```shell
kubectl get hpa
kubectl describe hpa nginx-hpa
```

### 部署 metrics-server

```shell
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

# 自签证书的集群需要放宽 kubelet 证书校验
kubectl patch deployment metrics-server -n kube-system --type=json \
  -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'

# 验证指标是否可用
kubectl top nodes
kubectl top pods
```

### 基于 CPU 的 HPA 清单

```shell
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: nginx-hpa
  namespace: default
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: nginx
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization        # 相对于 requests 的百分比
          averageUtilization: 60
```

使用 `Utilization` 时,**目标工作负载必须设置 `resources.requests.cpu`**,否则 HPA 无法计算利用率,会一直报 `missing request for cpu`。

创建与查看:

```shell
kubectl apply -f hpa.yaml

# 也可以用命令直接创建
kubectl autoscale deployment nginx --min=2 --max=10 --cpu-percent=60

kubectl get hpa
kubectl get hpa -o wide
kubectl describe hpa nginx-hpa
kubectl get hpa nginx-hpa -o yaml
```

### 基于内存的 HPA

```shell
spec:
  metrics:
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 75
```

内存指标需要 `resources.requests.memory`。需要注意:内存不像 CPU 那样会被回收,基于内存的扩缩容易产生震荡,通常只在明确知道应用内存模型时才使用。

### 同时使用多个指标

配置多个指标时,HPA 会**分别计算每个指标的期望副本数,并取最大值**执行,保证所有指标都被满足:

```shell
spec:
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60
    - type: Pods
      pods:
        metric:
          name: http_requests_per_second
        target:
          type: AverageValue
          averageValue: "100"
    - type: External
      external:
        metric:
          name: sqs_queue_length
          selector:
            matchLabels:
              queue: critical
        target:
          type: AverageValue
          averageValue: "30"
```

### 自定义扩缩容行为

`behavior` 用于抑制抖动:扩容可以激进,缩容必须保守。

```shell
spec:
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0          # 立即响应
      policies:
        - type: Percent
          value: 100                          # 每次最多翻一倍
          periodSeconds: 60
        - type: Pods
          value: 4                            # 或每次最多加 4 个
          periodSeconds: 60
      selectPolicy: Max                       # 多策略时取变化最大的
    scaleDown:
      stabilizationWindowSeconds: 300         # 缩容前观察 5 分钟
      policies:
        - type: Percent
          value: 10                           # 每分钟最多减少 10%
          periodSeconds: 60
      selectPolicy: Min
```

`stabilizationWindowSeconds` 表示「回看窗口内所有推荐值中的极端值才是最终决策」:缩容窗口内取**最大**推荐值,扩容窗口内取**最小**推荐值。默认缩容窗口是 300 秒,扩容窗口是 0 秒。

### 常用操作

```shell
# 查看当前指标与副本数
kubectl get hpa

# 查看 HPA 的决策事件(最有用的排障手段)
kubectl describe hpa nginx-hpa

# 修改副本数范围
kubectl patch hpa nginx-hpa -p '{"spec":{"maxReplicas":20}}'

# 删除 HPA 后手动 scale 的副本数才会被保留
kubectl delete hpa nginx-hpa
```

### 压测验证

```shell
# 用 busybox 制造 CPU 压力
kubectl run -it --rm load-generator --image=busybox:1.36 --restart=Never -- \
  /bin/sh -c "while true; do wget -q -O- http://nginx.default.svc.cluster.local; done"

# 另开一个终端观察副本数上升
kubectl get hpa nginx-hpa -w
kubectl get pods -l app=nginx -w
```

### 注意

1. **必须部署 metrics-server**,否则 HPA 完全不工作,`TARGETS` 显示 `<unknown>`。这是 HPA 排障的第一检查项。
2. 目标工作负载**必须设置 `resources.requests`**。使用 `Utilization` 类型时缺少 requests 会导致 HPA 报错并停止扩缩容。
3. **不要同时使用 HPA 和 VPA 控制同一项指标**(如都基于 CPU),两者会互相抢夺副本数与资源配额,产生不可预测的震荡。
4. HPA **会覆盖手动 `kubectl scale` 的结果**。手工扩容后,下一个同步周期 HPA 就会把副本数改回它计算出的值。
5. 同时使用 HPA 与 GitOps(如 Argo CD)时,如果在清单里写死了 `replicas`,会与 HPA 持续冲突,应当在清单中移除 `replicas` 字段。
6. 缩容有 **300 秒默认稳定窗口**,因此负载下降后不会立刻缩容,这是有意设计,不是故障。
7. HPA 扩容有**上限速率**:如果最近 3 分钟内没有扩缩容,可以一次扩容到 4 倍或 4 个副本中的较大者;否则最多按 min(2 倍, 4 个)增长。
8. 缩容到 `minReplicas` 之前,如果 Pod 处于 `NotReady` 或正在启动,HPA 的计算会被跳过,避免在滚动更新期间误判。
9. `autoscaling/v2beta2` 在 v1.26 已被移除,请一律使用 `autoscaling/v2`。
10. HPA 只负责**副本数**;如果目标已经达到 `maxReplicas` 仍扛不住流量,需要人工提高上限或优化单副本性能。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `deployment` — 无状态工作负载控制器
- `statefulset` — 有状态工作负载控制器
- `replicaset` — Pod 副本控制器
- `pod` — 最小调度单元

### 参考链接

- [HorizontalPodAutoscaler 官方文档](https://kubernetes.io/docs/concepts/workloads/autoscaling/)
- [HPA 演练教程](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale-walkthrough/)
- [HPA 扩缩容算法细节](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)
- [metrics-server 项目](https://github.com/kubernetes-sigs/metrics-server)
