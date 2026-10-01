statefulset
===

Kubernetes有状态应用工作负载控制器

## 补充说明

**StatefulSet** 用于管理有状态应用,它为每个 Pod 提供三样 Deployment 给不了的东西:

1. **稳定的网络标识**。Pod 名字形如 `<名称>-0`、`<名称>-1`,重建后名字不变,并且每个 Pod 都有对应的 DNS 记录。
2. **稳定的独立存储**。通过 `volumeClaimTemplates` 为每个 Pod 生成独立的 PVC,Pod 被重新调度到其他节点后仍会挂载原来的存储。
3. **有序的部署与伸缩**。默认按序号从 0 到 N-1 依次创建,逆序删除,保证主从、集群成员等拓扑关系。

要让网络标识生效,必须配合一个 **Headless Service**(`clusterIP: None`)。普通 Service 只会给一组 Pod 做负载均衡,而 Headless Service 会为每个 Pod 返回独立的 A 记录,形如 `web-0.web.default.svc.cluster.local`。

StatefulSet 适合数据库(MySQL 主从、PostgreSQL、etcd)、消息队列(Kafka、RabbitMQ)以及任何需要成员间互相寻址的集群型应用。

### 语法

```shell
kubectl [command] statefulset [flags]
```

StatefulSet 的常用简写为 `sts`:

```shell
kubectl get sts
kubectl describe sts web
```

### Headless Service 清单

```shell
apiVersion: v1
kind: Service
metadata:
  name: web
  labels:
    app: nginx
spec:
  clusterIP: None          # Headless Service,不做负载均衡
  selector:
    app: nginx
  ports:
    - name: http
      port: 80
      targetPort: 80
```

### StatefulSet 清单

```shell
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: web
spec:
  serviceName: web           # 必须指向上面的 Headless Service
  replicas: 3
  podManagementPolicy: OrderedReady   # 默认;设为 Parallel 可并行创建
  updateStrategy:
    type: RollingUpdate
    rollingUpdate:
      partition: 0           # 只更新序号 >= partition 的 Pod
  selector:
    matchLabels:
      app: nginx
  template:
    metadata:
      labels:
        app: nginx
    spec:
      containers:
        - name: nginx
          image: nginx:1.27
          ports:
            - name: http
              containerPort: 80
          volumeMounts:
            - name: data
              mountPath: /usr/share/nginx/html
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: standard
        resources:
          requests:
            storage: 1Gi
```

创建与查看:

```shell
kubectl apply -f service.yaml
kubectl apply -f statefulset.yaml

# Pod 名严格递增,按序创建
kubectl get pods -l app=nginx -o wide

# 查看为每个 Pod 生成的 PVC
kubectl get pvc -l app=nginx
```

### 验证稳定网络标识

```shell
# 集群内解析单个 Pod 的 DNS
kubectl run -it --rm dns-test --image=busybox:1.36 --restart=Never -- \
  nslookup web-0.web.default.svc.cluster.local

# 在某个 Pod 内访问另一个成员
kubectl exec -it web-0 -- curl -s http://web-1.web:80
```

### 扩缩容

```shell
# 扩容:按 3、4、5 的顺序逐个创建并等待就绪
kubectl scale statefulset web --replicas=5

# 缩容:按 4、3 的顺序逆序删除
kubectl scale statefulset web --replicas=2

# 修改清单中的 replicas 后 apply 亦可
kubectl apply -f statefulset.yaml
```

### 更新策略

```shell
# 查看更新进度(逆序更新,从最大序号开始)
kubectl rollout status statefulset/web

# 查看历史版本
kubectl rollout history statefulset/web

# 回滚
kubectl rollout undo statefulset/web
kubectl rollout undo statefulset/web --to-revision=1

# 触发一次滚动重启
kubectl rollout restart statefulset/web
```

**金丝雀发布**依靠 `partition` 实现:把 `partition` 设为副本数,再逐步下调,只有序号大于等于 `partition` 的 Pod 会被更新。

```shell
# 只更新序号 >= 4 的 Pod(即 web-4)
kubectl patch statefulset web -p '{"spec":{"updateStrategy":{"rollingUpdate":{"partition":4}}}}'

# 观察 web-4 是否正常,再继续下调 partition
kubectl rollout status statefulset/web

# 确认无误后全量更新
kubectl patch statefulset web -p '{"spec":{"updateStrategy":{"rollingUpdate":{"partition":0}}}}'
```

使用 `type: OnDelete` 时,StatefulSet 不会自动更新任何 Pod,必须手动删除 Pod 才会以新模板重建:

```shell
spec:
  updateStrategy:
    type: OnDelete
```

### 注意

1. **缩容不会删除 PVC**。`kubectl scale --replicas=2` 之后,`web-2`、`web-3` 的 PVC 依然存在,重新扩容时会挂回原数据 —— 这是有意设计,但会持续占用存储,需要手动清理。
2. `serviceName` 必须指向一个已存在的 Headless Service,否则 Pod 无法获得稳定的 DNS 记录。
3. `spec.selector` **创建后不可变更**;`serviceName` 虽然技术上可以修改,但已创建的 Pod 其 DNS 记录不会随之更新,应当视为不可变。需要变更只能删除后重建(可加 `--cascade=orphan` 保留 Pod)。
4. `OrderedReady` 模式下,如果 `web-1` 起不来,`web-2` 会一直卡在 `Pending`;排查时要先看序号最小的异常 Pod。
5. 缩容时如果某个 Pod 处于不健康状态,删除会阻塞后续 Pod 的删除,可用 `--force --grace-period=0` 处理卡住的 Pod。
6. 删除 StatefulSet 时默认会级联删除 Pod,但 PVC 仍然保留;如需保留 Pod,使用 `kubectl delete sts web --cascade=orphan`。
7. `volumeClaimTemplates` 一旦创建就不可修改,扩容存储需要手工 `kubectl patch pvc` 并确认 StorageClass 支持 `allowVolumeExpansion`。
8. 访问单个 Pod 一般用 `web-0.web` 这种带序号的域名,而不是 Headless Service 名 —— 后者返回全部 Pod 的 A 记录,客户端会随机命中一个。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `deployment` — 无状态工作负载控制器
- `daemonset` — 每节点守护进程
- `pod` — 最小调度单元
- `helm` — Kubernetes包管理器

### 参考链接

- [StatefulSet 官方文档](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/)
- [StatefulSet 基础教程](https://kubernetes.io/docs/tutorials/stateful-application/basic-stateful-set/)
- [运行一个有状态的 MySQL 集群](https://kubernetes.io/docs/tasks/run-application/run-replicated-stateful-application/)
- [Service 与 Pod 的 DNS](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)
