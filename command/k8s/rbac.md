rbac
===

Kubernetes基于角色的访问控制授权机制

## 补充说明

**RBAC**(Role-Based Access Control)是 Kubernetes 默认启用的授权模式,用于决定「谁可以对哪些资源做哪些操作」。它通过 API 对象而非配置文件来定义权限,可在线修改并即时生效。

RBAC 的核心是四条组合规则:**角色**定义权限集合,**绑定**把权限授予主体。

| 资源 | 作用域 | 说明 |
| --- | --- | --- |
| Role | 命名空间级 | 只能授予本命名空间内资源的权限 |
| ClusterRole | 集群级 | 可授予集群级资源(如 node、pv),也可授予跨命名空间权限 |
| RoleBinding | 命名空间级 | 把 Role 或 ClusterRole 的权限授予主体,仅在本命名空间生效 |
| ClusterRoleBinding | 集群级 | 把 ClusterRole 的权限授予主体,在全部命名空间生效 |

主体(Subject)有三类:`User`(外部用户)、`Group`(用户组)、`ServiceAccount`(Pod 身份)。Kubernetes 本身不存储用户对象,用户名来自认证层(证书 CN、OIDC claim 等)。

### 语法

```shell
kubectl create role <名称> --verb=<动词> --resource=<资源> [--resource-name=<名称>]
kubectl create clusterrole <名称> --verb=<动词> --resource=<资源>
kubectl create rolebinding <名称> --role=<角色> --user=<用户> -n <命名空间>
kubectl create rolebinding <名称> --clusterrole=<集群角色> --serviceaccount=<命名空间>:<账户>
kubectl create clusterrolebinding <名称> --clusterrole=<集群角色> --user=<用户>
kubectl auth can-i <动词> <资源> [--as=<用户>] [-n <命名空间>]
```

常用动词(verb):

```shell
get         读取单个资源
list        列出资源集合
watch       监听资源变化
create      创建资源
update      整体更新资源
patch       局部更新资源
delete      删除单个资源
deletecollection  批量删除
use         使用 podsecuritypolicies 等资源
bind        创建绑定(用于授予他人权限)
escalate    提升权限(用于创建超出自身权限的角色)
impersonate 模拟其他用户
```

### Role 清单示例

Role 必须指定 `namespace`,只对本命名空间的资源有效。

```shell
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: dev
  name: pod-reader
rules:
- apiGroups: [""]              # 空字符串代表 core API 组
  resources: ["pods", "pods/log"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["apps"]
  resources: ["deployments"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
# resourceNames 可把权限限制到具体对象,但仅对 get/update/patch/delete 等有效
- apiGroups: [""]
  resources: ["configmaps"]
  resourceNames: ["app-config"]
  verbs: ["get", "update"]
```

### ClusterRole 清单示例

```shell
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: node-reader
rules:
- apiGroups: [""]
  resources: ["nodes", "nodes/status", "persistentvolumes"]
  verbs: ["get", "list", "watch"]
- nonResourceURLs: ["/healthz", "/metrics"]   # 非资源型 URL
  verbs: ["get"]
```

聚合 ClusterRole:控制器会把所有匹配标签的 ClusterRole 规则合并进来,适合给 Operator 或监控系统动态扩权。

```shell
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: monitoring
aggregationRule:
  clusterRoleSelectors:
  - matchLabels:
      rbac.example.com/aggregate-to-monitoring: "true"
rules: []   # 留空,由控制器自动填充
```

### 绑定清单示例

```shell
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: read-pods
  namespace: dev
subjects:
- kind: User
  name: jane
  apiGroup: rbac.authorization.k8s.io
- kind: ServiceAccount
  name: build-bot
  namespace: dev
roleRef:
  kind: Role          # 只能是 Role 或 ClusterRole
  name: pod-reader
  apiGroup: rbac.authorization.k8s.io
```

```shell
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: cluster-monitoring
subjects:
- kind: ServiceAccount
  name: prometheus
  namespace: monitoring
roleRef:
  kind: ClusterRole
  name: cluster-admin
  apiGroup: rbac.authorization.k8s.io
```

### 常用操作

```shell
# 创建角色与绑定
kubectl create role pod-reader --verb=get,list,watch --resource=pods -n dev
kubectl create clusterrole node-reader --verb=get,list,watch --resource=nodes
kubectl create rolebinding read-pods --clusterrole=view --user=jane -n dev
kubectl create rolebinding bot-read --role=pod-reader \
  --serviceaccount=dev:build-bot -n dev
kubectl create clusterrolebinding monitoring-admin \
  --clusterrole=cluster-admin --serviceaccount=monitoring:prometheus

# 生成 YAML 后再修改(不直接创建)
kubectl create role pod-reader --verb=get,list --resource=pods -n dev \
  --dry-run=client -o yaml > role.yaml

# 查看与排查
kubectl get roles,rolebindings -n dev
kubectl get clusterroles,clusterrolebindings
kubectl describe clusterrole edit
kubectl describe rolebinding read-pods -n dev

# 权限自检:最常用的排障命令
kubectl auth can-i create deployments -n dev
kubectl auth can-i '*' '*' --all-namespaces
kubectl auth can-i list pods --as=system:serviceaccount:dev:build-bot -n dev
kubectl auth can-i get pods --as=jane --as-group=developers
kubectl auth whoami

# 找出权限过大的 ClusterRole(含通配符动词)
kubectl get clusterroles -o json | \
  jq -r '.items[] | select(.rules[]?.verbs[]? == "*") | .metadata.name'

# 查询资源是否属于命名空间级
kubectl api-resources --namespaced=true
kubectl api-resources --namespaced=false

# 声明式管理:reconcile 会补齐缺失并删除多余项
kubectl auth reconcile -f rbac.yaml --dry-run=client
kubectl auth reconcile -f rbac.yaml

# 仅回收多余的权限与主体,不新增
kubectl auth reconcile -f rbac.yaml --remove-extra-permissions --remove-extra-subjects
```

### 内置 ClusterRole

集群初始化时会自动创建一组系统角色,直接绑定即可,不必重复造轮子:

```shell
cluster-admin   超级权限,绑定即拥有全部资源的所有操作
admin           命名空间管理员,不含 ResourceQuota 与 Namespace 本身的写权限
edit            可读写绝大多数资源,不能查看或修改 RBAC
view            只读权限,不能读取 Secret
system:discovery        允许访问 API 发现接口
system:basic-user       允许查看自己的身份信息
system:public-info-viewer  允许读取 /healthz、/version 等公开信息
```

```shell
# 授予某人在 dev 命名空间的管理员权限
kubectl create rolebinding dev-admin --clusterrole=admin --user=jane -n dev

# 所有已认证用户可读的默认角色
kubectl describe clusterrole system:discovery
```

### 注意

1. **Role 是命名空间级,ClusterRole 是集群级**。RoleBinding 引用 ClusterRole 时,只会把该 ClusterRole 的权限限制在当前命名空间内 —— 这是复用 `view`/`edit` 的标准做法,不要误以为这样会授予全集群权限。
2. **RoleBinding 不能引用 Role 以外的命名空间**。跨命名空间复用只能绑定 ClusterRole。
3. **`roleRef` 创建后不可修改**。想更换绑定的角色必须删除并重建 Binding,`kubectl apply` 修改 roleRef 会直接报错。
4. 权限是**纯增量**的,没有「拒绝」规则。一旦被某个绑定授予权限,无法用另一条规则收回,只能删除授予它的绑定。
5. `kubectl auth can-i` 默认以当前 kubeconfig 身份检查;`--as` 模拟需要自身拥有 `impersonate` 权限,否则报 `Forbidden`。
6. `resourceNames` 只能限制 `get`/`update`/`patch`/`delete` 等针对单个对象的动词,**对 `list`、`watch`、`create` 无效**,写了也会被忽略。
7. `secrets` 的读取权限等同于获取该 ServiceAccount 的身份,给 `view` 之类的只读角色单独放开 Secret 时需谨慎。
8. 删除 `ServiceAccount` 会让绑定到它的主体失去身份,但 RoleBinding 对象不会自动删除,会留下悬空引用,建议用 `kubectl auth reconcile` 清理。
9. 内置的 `system:` 前缀 ClusterRole 由控制器维护,手工改动可能被覆盖,扩展权限应新建角色并用聚合标签合并。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `serviceaccount` — 服务账户与 Pod 身份
- `kubeadm` — Kubernetes集群安装工具
- `kube-bench` — CIS 安全基线检查

### 参考链接

- [RBAC 授权官方文档](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)
- [使用 RBAC 鉴权](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)
- [kubectl auth 命令参考](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_auth/)
- [默认角色与角色绑定](https://kubernetes.io/docs/reference/access-authn-authz/rbac/#default-roles-and-role-bindings)
