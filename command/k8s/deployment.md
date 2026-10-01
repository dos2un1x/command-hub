deployment
===

Kubernetes无状态应用工作负载控制器

## 补充说明

**Deployment** 是 Kubernetes 中最常用的工作负载控制器,用于管理无状态应用。它声明式地描述「我希望运行几个副本、用哪个镜像」,由控制器持续把实际状态调整到期望状态。

Deployment 并不直接管理 Pod,而是通过 **ReplicaSet** 间接管理:每次修改 Pod 模板(例如更换镜像)时,Deployment 会创建一个新的 ReplicaSet,再逐步把副本从旧 ReplicaSet 迁移到新的,这一过程就是**滚动更新**。旧 ReplicaSet 会被保留(保留数量由 `revisionHistoryLimit` 决定),因此可以随时回滚。

Deployment 适合无状态、可随时替换的副本型服务(Web 服务、API 网关等)。如果 Pod 之间需要稳定的网络标识与独立的存储,应当使用 StatefulSet;如果需要在每个节点上都跑一份,应当使用 DaemonSet。

### 语法

```shell
kubectl [command] deployment [flags]
```

Deployment 的常用简写为 `deploy`:

```shell
kubectl get deploy
kubectl describe deploy nginx
```

### 完整的 Deployment 清单

```shell
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx
  labels:
    app: nginx
spec:
  replicas: 3
  revisionHistoryLimit: 10
  progressDeadlineSeconds: 600
  minReadySeconds: 5
  selector:
    matchLabels:
      app: nginx
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 25%            # 更新期间允许超出 replicas 的 Pod 数
      maxUnavailable: 25%      # 更新期间允许不可用的 Pod 数
  template:
    metadata:
      labels:
        app: nginx
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
          readinessProbe:
            httpGet:
              path: /
              port: 80
            initialDelaySeconds: 3
            periodSeconds: 5
```

创建与查看:

```shell
kubectl apply -f deployment.yaml

# 也可以用命令直接生成
kubectl create deployment nginx --image=nginx:1.27 --replicas=3

kubectl get deployment
kubectl get deploy nginx -o wide
kubectl describe deploy nginx
```

### 滚动更新

```shell
# 更换镜像触发滚动更新
kubectl set image deployment/nginx nginx=nginx:1.28

# 修改资源限制等其他字段后重新 apply
kubectl apply -f deployment.yaml

# 观察更新进度
kubectl rollout status deployment/nginx
kubectl rollout status deployment/nginx --timeout=120s

# 查看 ReplicaSet 的新旧交替
kubectl get rs -l app=nginx
kubectl get pods -l app=nginx --show-labels
```

### 回滚

```shell
# 查看历史版本
kubectl rollout history deployment/nginx

# 查看某个版本的详情
kubectl rollout history deployment/nginx --revision=2

# 回滚到上一个版本
kubectl rollout undo deployment/nginx

# 回滚到指定版本
kubectl rollout undo deployment/nginx --to-revision=1
```

### 暂停与恢复

一次要改多个字段时,可以先暂停,避免每次改动都触发一轮滚动更新:

```shell
kubectl rollout pause deployment/nginx
kubectl set image deployment/nginx nginx=nginx:1.28
kubectl set resources deployment/nginx -c=nginx --limits=cpu=1,memory=512Mi
kubectl rollout resume deployment/nginx
```

### 扩缩容

```shell
# 手动扩缩容
kubectl scale deployment/nginx --replicas=5
kubectl scale deployment/nginx --replicas=5 --current-replicas=3

# 创建 HPA 做自动扩缩容
kubectl autoscale deployment/nginx --min=2 --max=10 --cpu-percent=80

# 查看 HPA 状态
kubectl get hpa
```

### 重启与重建

```shell
# 触发一次滚动重启(不改变镜像,靠注解触发)
kubectl rollout restart deployment/nginx

# 编辑后立即生效
kubectl edit deployment/nginx

# 局部修改
kubectl patch deployment/nginx -p '{"spec":{"replicas":3}}'

# 查看 Deployment 是否卡在更新中
kubectl get deploy nginx -o jsonpath='{.status.conditions}'
```

### 非滚动更新策略

`strategy.type` 设为 `Recreate` 时,会先删除全部旧 Pod 再创建新 Pod,服务会出现中断,适合不能同时存在两个版本的应用:

```shell
spec:
  strategy:
    type: Recreate
```

### 注意

1. **`spec.selector` 创建后不可变更**。它还是不可变的:如果想改 selector,只能删除 Deployment 后重建(可以加 `--cascade=orphan` 保留 Pod)。
2. `spec.selector` 必须匹配 `spec.template.metadata.labels`,否则 API Server 会直接拒绝创建。
3. 不要为同一个 Deployment 同时设置 `spec.replicas` 和 HPA,HPA 会持续改写 `replicas`,导致 GitOps 工具反复报差异。
4. `maxSurge` 与 `maxUnavailable` **不能同时为 0**,否则更新会永远无法推进。
5. 滚动更新默认不等待 Pod 真正可用,只要调度成功就继续。加上 `minReadySeconds` 并配置 `readinessProbe` 才能保证新副本真正可用后再继续。
6. 使用 `imagePullPolicy: Always` 配合 `latest` 标签时,滚动更新会正常触发,但回滚时可能拉到的仍是同一个镜像,建议使用明确版本号。
7. `kubectl rollout undo` 只回滚 **Pod 模板**(镜像、环境变量等),不会回滚 `replicas`、`strategy` 等字段。
8. 更新卡住超过 `progressDeadlineSeconds` 后会写入 `ProgressDeadlineExceeded` 事件,但这**不会自动回滚**,需要人工处理。
9. 默认 `revisionHistoryLimit` 为 10,调成 0 会导致无法回滚到任何历史版本。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `replicaset` — Pod 副本控制器
- `statefulset` — 有状态工作负载控制器
- `hpa` — 水平自动扩缩容
- `pod` — 最小调度单元

### 参考链接

- [Deployment 官方文档](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
- [Deployment 滚动更新](https://kubernetes.io/docs/tasks/run-application/run-stateless-application-deployment/)
- [kubectl rollout 命令参考](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_rollout/)
- [Deployment 故障排查](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#failed-deployment)
