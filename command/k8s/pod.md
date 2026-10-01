pod
===

Kubernetes中最小的可调度计算单元

## 补充说明

**Pod** 是 Kubernetes 中能够创建、调度和管理的最小计算单元。一个 Pod 包含一个或多个容器,这些容器共享网络命名空间、UTS 命名空间、IPC 命名空间以及挂载的存储卷,因此它们可以通过 `localhost` 互相通信,并且看到相同的主机名。

Pod 是「一次性的」:它不会被修复,只会被替换。当节点故障或容器崩溃时,控制器会创建一个全新的 Pod,而不是把旧的救回来。Pod 内的容器也不应该假设自己会长期存活。

在实际使用中,**很少直接创建裸 Pod**。裸 Pod(即没有控制器管理的 Pod)在节点故障后不会自动重建,也没有副本数与滚动更新的能力。生产环境应当使用 Deployment、StatefulSet、DaemonSet 或 Job 这类工作负载资源来管理 Pod。

### 语法

```shell
kubectl [command] pod [flags]
```

Pod 的常用简写为 `po`:

```shell
kubectl get po
kubectl describe po nginx
```

### 最小的 Pod 清单

```shell
apiVersion: v1
kind: Pod
metadata:
  name: nginx-pod
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
```

保存为 `pod.yaml` 后创建:

```shell
kubectl apply -f pod.yaml

# 也可以直接用命令行创建单个 Pod
kubectl run nginx-pod --image=nginx:1.27 --port=80

# 创建一个用完即弃的调试 Pod
kubectl run tmp-shell --image=busybox:1.36 --rm -it --restart=Never -- sh
```

### 多容器 Pod

同一个 Pod 中的容器共享网络与存储,常用于 Sidecar 模式(日志收集、代理、配置同步):

```shell
apiVersion: v1
kind: Pod
metadata:
  name: web-with-sidecar
spec:
  containers:
    - name: web
      image: nginx:1.27
      volumeMounts:
        - name: logs
          mountPath: /var/log/nginx
    - name: log-tailer
      image: busybox:1.36
      args: [/bin/sh, -c, 'tail -f /var/log/nginx/access.log']
      volumeMounts:
        - name: logs
          mountPath: /var/log/nginx
  volumes:
    - name: logs
      emptyDir: {}
```

### 初始化容器

`initContainers` 按顺序串行执行,全部成功后才启动业务容器,适合做依赖等待、目录初始化等前置工作:

```shell
spec:
  initContainers:
    - name: wait-for-db
      image: busybox:1.36
      command: ['sh', '-c', 'until nc -z mysql 3306; do echo waiting; sleep 2; done']
  containers:
    - name: app
      image: myapp:1.0
```

### 健康检查

```shell
spec:
  containers:
    - name: app
      image: myapp:1.0
      startupProbe:            # 启动探针,成功前不执行其他探针
        httpGet:
          path: /healthz
          port: 8080
        failureThreshold: 30
        periodSeconds: 10
      readinessProbe:          # 就绪探针,失败时从 Service Endpoints 摘除
        httpGet:
          path: /ready
          port: 8080
        initialDelaySeconds: 3
        periodSeconds: 5
      livenessProbe:           # 存活探针,失败时重启容器
        tcpSocket:
          port: 8080
        initialDelaySeconds: 10
        periodSeconds: 10
        failureThreshold: 3
```

### 调度约束

```shell
spec:
  nodeSelector:
    disktype: ssd
  tolerations:
    - key: node-role.kubernetes.io/control-plane
      operator: Exists
      effect: NoSchedule
```

### 常用操作

```shell
# 查看 Pod 列表
kubectl get pods
kubectl get pods -o wide
kubectl get pods -A
kubectl get pods -l app=nginx
kubectl get pods --field-selector spec.nodeName=node1

# 查看详情与事件
kubectl describe pod nginx-pod

# 查看完整定义
kubectl get pod nginx-pod -o yaml

# 查看单个字段
kubectl get pod nginx-pod -o jsonpath='{.status.podIP}'
kubectl get pod nginx-pod -o jsonpath='{.spec.nodeName}'

# 查看日志
kubectl logs nginx-pod
kubectl logs -f nginx-pod
kubectl logs nginx-pod -c log-tailer      # 指定容器
kubectl logs nginx-pod --previous         # 查看上一次崩溃的日志
kubectl logs -l app=nginx --tail=50       # 按标签查看多个 Pod

# 进入容器
kubectl exec -it nginx-pod -- /bin/bash
kubectl exec -it nginx-pod -c log-tailer -- sh

# 端口转发到本地
kubectl port-forward pod/nginx-pod 8080:80

# 复制文件
kubectl cp nginx-pod:/etc/nginx/nginx.conf ./nginx.conf

# 等待 Pod 就绪
kubectl wait --for=condition=Ready pod/nginx-pod --timeout=60s

# 查看资源占用(需部署 metrics-server)
kubectl top pod

# 删除 Pod
kubectl delete pod nginx-pod
kubectl delete -f pod.yaml

# 强制删除卡在 Terminating 的 Pod
kubectl delete pod nginx-pod --grace-period=0 --force
```

### 注意

1. **裸 Pod 没有自愈能力**。节点宕机后裸 Pod 不会重建,生产环境请使用 Deployment 等控制器。
2. Pod 的 `metadata.name`、`namespace`、`spec.containers` 等大部分字段**创建后不可修改**,只有 `image`、`activeDeadlineSeconds`、`tolerations` 等少数字段允许原地更新。
3. 同一个 Pod 内的容器不能使用相同的 `name`,也不能重复映射同一个 `containerPort`(相同协议下)。
4. `restartPolicy` 默认是 `Always`;只有 Job/CronJob 才允许设置为 `Never` 或 `OnFailure`。
5. 不设置 `resources.requests` 时,调度器无法准确评估节点余量,Pod 可能被调度到资源紧张的节点。
6. 内存 `limits` 被超出会触发 `OOMKilled`,而 CPU `limits` 只会被限流(throttling),不会杀死容器。
7. `kubectl logs --previous` 只能看到上一次容器实例的日志,容器重启多次时会丢失更早的记录。
8. Pod 处于 `Terminating` 且长时间不消失,通常是 finalizer 未清理或节点失联所致,先排查节点状态再考虑 `--force`。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `deployment` — 无状态工作负载控制器
- `statefulset` — 有状态工作负载控制器
- `kubelet` — 节点代理,负责启动 Pod
- `crictl` — 容器运行时调试工具

### 参考链接

- [Pod 官方文档](https://kubernetes.io/docs/concepts/workloads/pods/)
- [Pod 生命周期](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
- [配置存活、就绪和启动探针](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
- [Init 容器](https://kubernetes.io/docs/concepts/workloads/pods/init-containers/)
