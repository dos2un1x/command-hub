namespace
===

Kubernetes中用于多租户隔离与资源分组的逻辑划分单元

## 补充说明

**Namespace(命名空间)** 是 Kubernetes 用来在同一套物理集群上划分虚拟集群的机制。它为资源名称提供作用域、为 RBAC 提供授权边界、为资源配额提供统计单位,是团队与项目之间做逻辑隔离的基本手段。

命名空间隔离的是**名字、权限与配额**,而不是网络与计算资源。不同命名空间的 Pod 默认可以互相访问(除非用 NetworkPolicy 限制),也可以调度到同一台节点上抢占 CPU。把它当成强隔离的安全边界是常见的误解 —— 真正的强隔离需要虚拟集群或独立节点池。

绝大多数资源都是命名空间级的(Pod、Service、Deployment、ConfigMap、PVC),而少数是集群级的(Node、PV、StorageClass、ClusterRole、Namespace 自身)。

### 系统预置命名空间

```shell
default           未指定命名空间时的默认归属,生产环境不建议把业务直接放在这里
kube-system       Kubernetes 自身组件:apiserver、CoreDNS、kube-proxy、CNI 等
kube-public       所有用户可读,用于存放集群公共信息
kube-node-lease   节点心跳租约对象,规模大时可减轻 apiserver 压力
```

这四个命名空间**无法被删除**,尝试删除会一直卡在 Terminating。

### 语法

```shell
kubectl get namespaces
kubectl create namespace [名称]
kubectl describe namespace [名称]
kubectl delete namespace [名称]
kubectl config set-context --current --namespace=[名称]
```

### YAML 清单

基础命名空间:

```shell
apiVersion: v1
kind: Namespace
metadata:
  name: dev
  labels:
    name: dev
    env: development
    team: platform
```

带资源配额的命名空间,限制整体可用的资源总量:

```shell
apiVersion: v1
kind: Namespace
metadata:
  name: team-a
```

```shell
apiVersion: v1
kind: ResourceQuota
metadata:
  name: team-a-quota
  namespace: team-a
spec:
  hard:
    requests.cpu: "20"
    requests.memory: 40Gi
    limits.cpu: "40"
    limits.memory: 80Gi
    pods: "50"
    services: "20"
    services.loadbalancers: "2"
    services.nodeports: "5"
    persistentvolumeclaims: "10"
    requests.storage: 500Gi
    count/deployments.apps: "20"
    count/configmaps: "50"
```

LimitRange,为没有显式声明资源的容器设置默认值与上下限:

```shell
apiVersion: v1
kind: LimitRange
metadata:
  name: team-a-limits
  namespace: team-a
spec:
  limits:
    - type: Container
      default:                 # 未写 limits 时的默认上限
        cpu: "500m"
        memory: 512Mi
      defaultRequest:          # 未写 requests 时的默认请求
        cpu: "100m"
        memory: 128Mi
      max:                     # 单个容器不得超过
        cpu: "2"
        memory: 2Gi
      min:                     # 单个容器不得低于
        cpu: "10m"
        memory: 32Mi
```

### 常用操作

```shell
# 查看所有命名空间(STATUS 为 Active 才可用)
kubectl get namespaces
kubectl get ns

# 查看命名空间下的资源
kubectl get all -n dev
kubectl get pods,svc,deploy,cm,secret -n dev

# 创建
kubectl create namespace dev
kubectl create namespace staging --dry-run=client -o yaml > staging.yaml

# 删除(会连带删除其中所有资源,且不可恢复)
kubectl delete namespace dev

# 查看命名空间详情与资源配额使用情况
kubectl describe namespace dev
kubectl describe resourcequota team-a-quota -n dev

# 查看 LimitRange 生效情况
kubectl describe limitrange team-a-limits -n dev

# 切换当前上下文的默认命名空间
kubectl config set-context --current --namespace=dev
kubectl config view --minify | grep namespace

# 临时对某个命名空间操作(不改变默认值)
kubectl get pods -n kube-system
kubectl get pods --all-namespaces
kubectl get pods -A
```

### 在 YAML 中指定命名空间

资源清单里用 `metadata.namespace` 指定归属,不写则落到当前上下文的默认命名空间。更推荐的做法是 YAML 中不写 namespace,统一由命令行指定,这样同一份 YAML 可以直接部署到多个环境:

```shell
kubectl apply -f deployment.yaml -n staging
```

### 跨命名空间访问

Service 的 DNS 名称带上命名空间即可跨空间访问:

```shell
# 同命名空间
curl http://web-svc

# 跨命名空间
curl http://web-svc.team-a

# 全限定域名
curl http://web-svc.team-a.svc.cluster.local
```

许多资源引用是**不能跨命名空间**的:

```shell
Ingress 的 backend     只能指向同命名空间的 Service
Pod 的 configMapRef    只能引用同命名空间的 ConfigMap
Pod 的 secretRef       只能引用同命名空间的 Secret
Pod 的 claimName       只能挂载同命名空间的 PVC
Pod 的 imagePullSecrets 只能引用同命名空间的 Secret
```

### RBAC 授权到命名空间

```shell
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: pod-reader
  namespace: team-a
rules:
  - apiGroups: [""]
    resources: ["pods", "pods/log"]
    verbs: ["get", "list", "watch"]
```

```shell
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: pod-reader-binding
  namespace: team-a
subjects:
  - kind: User
    name: alice
    apiGroup: rbac.authorization.k8s.io
roleRef:
  kind: Role
  name: pod-reader
  apiGroup: rbac.authorization.k8s.io
```

### 排障

```shell
# 1. 命名空间卡在 Terminating
kubectl get namespace dev -o json | jq '.status'
kubectl get namespace dev -o json | jq '.spec.finalizers'

# 查找命名空间中尚未清理的资源(常见的是 APIService 或 CRD 实例)
kubectl api-resources --verbs=list --namespaced -o name | \
  xargs -n 1 kubectl get --show-kind --ignore-not-found -n dev

# 2. 资源创建被拒绝 —— 多半是配额用尽
kubectl describe resourcequota -n dev
kubectl get events -n dev --field-selector reason=FailedCreate

# 3. 配额存在但 Pod 创建失败,提示 must specify limits
kubectl get resourcequota team-a-quota -n dev -o yaml

# 4. Service 删除后残留 LoadBalancer
kubectl get svc -n dev
kubectl get events -n dev --field-selector reason=DeletingLoadBalancer
```

### 删除卡住的命名空间

命名空间删除是**异步**的:控制器会先清空其中的所有资源,全部清完才真正移除。若某个 CRD 的控制器已卸载,其自定义资源会永远删不掉,命名空间就一直停在 Terminating,此时只能手工清 finalizer:

```shell
kubectl get namespace dev -o json | jq '.spec.finalizers = []' | \
  kubectl replace --raw /api/v1/namespaces/dev/finalize -f -
```

### 注意

1. **namespace 不是安全边界**。不同命名空间的 Pod 默认网络互通,只要知道 DNS 名称就能互相访问。真正的隔离需要 NetworkPolicy 限制流量,以及 RBAC 限制权限。
2. **`kube-system`、`default`、`kube-public`、`kube-node-lease` 无法删除**。对它们执行 `kubectl delete namespace` 会一直卡在 Terminating,且可能导致集群组件异常。
3. **删除命名空间会连带删除其中所有资源,且不可恢复**。PVC 是否删除底层数据取决于 PV 的回收策略;生产环境删除前务必先备份 YAML 与数据。
4. **命名空间删除是异步的**,`kubectl delete ns` 命令会立刻返回,但实际清理可能需要几分钟甚至永久卡住。看到 Terminating 不代表删除完成。
5. **CRD 的自定义资源会阻塞命名空间删除**。控制器已卸载时尤其明显,此时只能手工清 finalizer,清理后要确认没有留下孤儿资源。
6. **ResourceQuota 生效后,新建的 Pod 必须显式声明 requests 与 limits**,否则会被拒绝并提示 `must specify limits.cpu`。此时需要配合 LimitRange 提供默认值,否则会大面积创建失败。
7. **ResourceQuota 与 LimitRange 只对本命名空间内新建的资源生效**,对已存在的资源不做回溯校验,也不会强制修改已有 Pod。
8. **跨命名空间引用大多不被支持**。Ingress 的后端、Pod 的 ConfigMap/Secret/PVC 引用都必须是同命名空间的,这个限制经常在拆分配置时被忽略。
9. **同一份 YAML 部署到多个命名空间时要注意硬编码的引用**。若 YAML 中写死了 `namespace: dev`,用 `-n staging` 会因为冲突而报错,建议 YAML 中不写 namespace,统一由命令行指定。
10. **`kubectl get pods` 不带 `-n` 只显示当前上下文的默认命名空间**,排查问题时经常误以为 Pod 消失了,养成用 `-A` 的习惯。
11. **命名空间名称必须符合 DNS-1123 规范**:小写字母、数字与短横线,最长 63 字符,不能以短横线开头或结尾。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `networkpolicy` — 实现命名空间之间的网络隔离
- `configmap` — 命名空间级的配置资源
- `secret` — 命名空间级的敏感信息资源
- `pvc` — 命名空间级的存储申请
- `kubeadm` — Kubernetes集群安装与生命周期管理工具

### 参考链接

- [Namespace 官方文档](https://kubernetes.io/docs/concepts/overview/working-with-objects/namespaces/)
- [使用命名空间共享集群](https://kubernetes.io/docs/tasks/administer-cluster/namespaces-walkthrough/)
- [资源配额 ResourceQuota](https://kubernetes.io/docs/concepts/policy/resource-quotas/)
- [LimitRange 限制范围](https://kubernetes.io/docs/concepts/policy/limit-range/)
