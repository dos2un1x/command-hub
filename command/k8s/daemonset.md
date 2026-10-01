daemonset
===

Kubernetes每节点守护进程控制器

## 补充说明

**DaemonSet** 保证在集群的每个(或指定的部分)节点上都运行一个 Pod 副本。当有新节点加入集群时,DaemonSet 会自动在新节点上创建 Pod;当节点被移除时,对应的 Pod 也会被回收。

DaemonSet 用于运行节点级别的系统守护进程,典型场景包括:

- 日志采集:Filebeat、Fluent Bit、Vector
- 监控采集:node-exporter、cAdvisor
- 网络插件:kube-proxy、Calico、Cilium 的节点组件
- 存储插件:CSI 的节点插件
- 安全与审计:入侵检测、合规扫描 agent

这些进程必须运行在每一个节点上才能覆盖全部工作负载,用 Deployment 只能靠副本数猜测,无法保证「每个节点恰好一个」。

### 语法

```shell
kubectl [command] daemonset [flags]
```

DaemonSet 的常用简写为 `ds`:

```shell
kubectl get ds
kubectl describe ds fluent-bit
```

### 完整的 DaemonSet 清单

```shell
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-exporter
  namespace: monitoring
  labels:
    app: node-exporter
spec:
  selector:
    matchLabels:
      app: node-exporter
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 1        # 或使用 maxSurge(v1.22+)
  template:
    metadata:
      labels:
        app: node-exporter
    spec:
      hostNetwork: true        # 使用宿主机网络,便于抓取真实网卡指标
      hostPID: true
      tolerations:             # 容忍控制平面节点的污点
        - key: node-role.kubernetes.io/control-plane
          operator: Exists
          effect: NoSchedule
      containers:
        - name: node-exporter
          image: prom/node-exporter:v1.8.2
          args:
            - --path.procfs=/host/proc
            - --path.sysfs=/host/sys
          ports:
            - name: metrics
              containerPort: 9100
              hostPort: 9100
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 200m
              memory: 128Mi
          volumeMounts:
            - name: proc
              mountPath: /host/proc
              readOnly: true
            - name: sys
              mountPath: /host/sys
              readOnly: true
      volumes:
        - name: proc
          hostPath:
            path: /proc
        - name: sys
          hostPath:
            path: /sys
```

DaemonSet **不需要**填写 `spec.replicas`,副本数由匹配的节点数量决定。

创建与查看:

```shell
kubectl apply -f daemonset.yaml

kubectl get daemonset -n monitoring
kubectl get pods -n monitoring -o wide
kubectl describe daemonset node-exporter -n monitoring
```

### 只在部分节点上运行

DaemonSet 默认在所有节点上创建 Pod,可以通过 `nodeSelector`、`affinity` 与 `tolerations` 限定范围。

```shell
# 只在带 disktype=ssd 标签的节点上运行
spec:
  template:
    spec:
      nodeSelector:
        disktype: ssd
```

只跑在特定类型节点上时,通常还需要**反向**容忍 —— 让 Pod 容忍该类型节点上的污点:

```shell
      tolerations:
        - key: dedicated
          operator: Equal
          value: gpu
          effect: NoSchedule
```

如果希望 DaemonSet 不要占用某类节点,可以给节点打上污点(`kubectl taint nodes node1 sku=gpu:NoSchedule`),而 DaemonSet 只要没有对应 toleration 就会被排除。

### 更新策略

```shell
# 查看滚动更新进度
kubectl rollout status daemonset/node-exporter -n monitoring

# 查看历史版本
kubectl rollout history daemonset/node-exporter -n monitoring

# 回滚到上一个版本
kubectl rollout undo daemonset/node-exporter -n monitoring

# 回滚到指定版本
kubectl rollout undo daemonset/node-exporter -n monitoring --to-revision=2
```

`maxUnavailable` 控制滚动更新时同时不可用的 Pod 数量,默认是 1。替代方案 `maxSurge`(v1.22 起可用)允许先创建新 Pod 再删除旧的:

```shell
spec:
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 0
      maxUnavailable: 10%
```

设为 `OnDelete` 时,DaemonSet 只在新节点加入时创建 Pod,已有 Pod 必须手动删除才会更新 —— 适合需要人工控制升级节奏的底层组件:

```shell
spec:
  updateStrategy:
    type: OnDelete

# 手动触发某个节点的更新
kubectl delete pod node-exporter-abcde -n monitoring
```

### 常用操作

```shell
# 查看每个节点的 DaemonSet Pod 分布
kubectl get pods -n monitoring -o wide --sort-by=.spec.nodeName

# 查看某节点上运行的所有 Pod
kubectl get pods -A --field-selector spec.nodeName=node1

# 查看 DaemonSet 的期望副本数与就绪数
kubectl get ds -n monitoring -o custom-columns=\
NAME:.metadata.name,DESIRED:.status.desiredNumberScheduled,\
READY:.status.numberReady,AVAILABLE:.status.numberAvailable

# 临时在某个 Pod 上调试
kubectl exec -it node-exporter-abcde -n monitoring -- sh

# 删除 DaemonSet(会一并删除其 Pod)
kubectl delete -f daemonset.yaml
```

### 注意

1. DaemonSet 的 Pod **绕过了默认调度器的常规打分流程**(新版本中由调度器配合 node affinity 完成),因此不要试图用 `kubectl cordon` 阻止它调度 —— 排空节点必须加 `--ignore-daemonsets`。
2. `kubectl drain <node>` 不加 `--ignore-daemonsets` 会直接失败,这是最常见的踩坑点。
3. 删除了某个 DaemonSet Pod 后它会立刻在**同一个节点**上重建,想彻底移除某个节点的 Pod 只能改 nodeSelector 或给节点打污点。
4. `hostNetwork: true` 时 Pod 内的 `containerPort` 会直接占用宿主机端口,同一节点上不能有两个 DaemonSet Pod 抢同一个端口。
5. 使用 `hostPath` 挂载的宿主机路径必须真实存在,否则 Pod 会卡在 `ContainerCreating`。
6. DaemonSet 的 `spec.selector` 与 Deployment 一样是**不可变**的,创建后无法修改。
7. 控制平面节点默认带 `node-role.kubernetes.io/control-plane:NoSchedule` 污点,想让 DaemonSet 覆盖到控制平面需要显式添加 toleration。
8. 只声明了 `limits` 而没有 `requests` 时,Kubernetes 会把 `requests` 默认设为等于 `limits`,可能造成节点资源被大量预留。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `deployment` — 无状态工作负载控制器
- `statefulset` — 有状态工作负载控制器
- `pod` — 最小调度单元
- `kubelet` — 节点代理,负责启动 Pod

### 参考链接

- [DaemonSet 官方文档](https://kubernetes.io/docs/concepts/workloads/controllers/daemonset/)
- [使用 DaemonSet 在每个节点上运行 Pod](https://kubernetes.io/docs/tasks/manage-daemon/update-daemon-set/)
- [在 DaemonSet 上执行滚动更新](https://kubernetes.io/docs/tasks/manage-daemon/update-daemon-set/)
- [节点污点与容忍](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/)
