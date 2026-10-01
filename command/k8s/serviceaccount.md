serviceaccount
===

Kubernetes服务账户与Pod身份认证

## 补充说明

**ServiceAccount**(服务账户,简称 SA)是 Kubernetes 中**给 Pod 内进程使用的身份**,与给人类用户使用的 User 账号区分开。Pod 里的应用通过它向 API Server 证明「我是谁」,再由 RBAC 决定「我能做什么」。

三者的关系可以这样理解:

- **认证(Authentication)**:ServiceAccount 是 Pod 的身份凭证。
- **授权(Authorization)**:RoleBinding / ClusterRoleBinding 把权限授予该 ServiceAccount。
- **准入(Admission)**:`serviceAccountName` 字段把身份注入 Pod,并决定是否挂载 token。

每个命名空间都有一个名为 `default` 的 ServiceAccount,Pod 未显式指定 `serviceAccountName` 时默认使用它。

### 版本差异:token 的生成方式

这是使用 ServiceAccount 最容易踩坑的地方:

```shell
1.23 及以前 创建 SA 会自动生成一个长期有效的 Secret,token 永久不过期
1.24 起     不再自动创建 Secret(LegacyServiceAccountTokenNoAutoGeneration 默认启用)
            需要 token 时必须显式用 kubectl create token 或 TokenRequest API 申请
```

获取 token 的三种方式:

```shell
# 1. 临时 token(推荐),默认有效期 1 小时
kubectl create token build-bot -n dev

# 2. 指定有效期与受众
kubectl create token build-bot -n dev --duration=24h --audience=https://vault.example.com

# 3. 绑定到具体对象,Pod 删除后 token 自动失效(安全性最高)
kubectl create token build-bot -n dev --duration=1h \
  --bound-object-kind=Pod --bound-object-name=my-pod

# 4. 需要长期固定 token 时,手工创建 Secret(v1.24+ 仍支持)
kubectl apply -f - <<'EOF'
apiVersion: v1
kind: Secret
metadata:
  name: build-bot-token
  namespace: dev
  annotations:
    kubernetes.io/service-account.name: build-bot
type: kubernetes.io/service-account-token
EOF
```

### 语法

```shell
kubectl create serviceaccount <名称> [-n <命名空间>]
kubectl create token <服务账户名> [-n <命名空间>] [--duration=<时长>]
kubectl get serviceaccount [-A]
kubectl describe serviceaccount <名称> [-n <命名空间>]
kubectl delete serviceaccount <名称> [-n <命名空间>]
```

### ServiceAccount 清单

```shell
apiVersion: v1
kind: ServiceAccount
metadata:
  name: build-bot
  namespace: dev
# 关闭 token 自动挂载,需要 token 的容器必须显式声明卷
automountServiceAccountToken: false
# 拉取私有仓库镜像时自动注入 imagePullSecrets
imagePullSecrets:
- name: my-registry-secret
```

### Pod 中引用身份

```shell
apiVersion: v1
kind: Pod
metadata:
  name: caller
  namespace: dev
spec:
  serviceAccountName: build-bot      # 1.24 起该字段创建后不可修改
  automountServiceAccountToken: false  # 可覆盖 SA 上的设置
  containers:
  - name: app
    image: my-app:1.0
    volumeMounts:
    - name: token
      mountPath: /var/run/secrets/tokens
      readOnly: true
  volumes:
  # 投影卷:由 kubelet 自动轮换的短期 token,推荐做法
  - name: token
    projected:
      sources:
      - serviceAccountToken:
          path: token
          expirationSeconds: 3600
          audience: vault
      # 同时可挂载 ConfigMap / Secret / DownwardAPI
      - configMap:
          name: app-config
```

自动挂载的 token 会被放到固定路径,容器内可直接读取:

```shell
/var/run/secrets/kubernetes.io/serviceaccount/token       # JWT
/var/run/secrets/kubernetes.io/serviceaccount/ca.crt      # 集群 CA
/var/run/secrets/kubernetes.io/serviceaccount/namespace   # 当前命名空间
```

### 常用操作

```shell
# 创建与查看
kubectl create serviceaccount build-bot -n dev
kubectl get sa -A
kubectl get sa build-bot -n dev -o yaml
kubectl describe sa build-bot -n dev

# 申请 token 并在容器内调用 API
TOKEN=$(kubectl create token build-bot -n dev)
kubectl exec -it caller -n dev -- sh -c \
  "curl -s -H 'Authorization: Bearer $TOKEN' \
   https://kubernetes.default.svc/api/v1/namespaces/dev/pods"

# 绑定权限(SA 本身不含任何权限,必须再绑定角色)
kubectl create rolebinding build-bot-edit \
  --clusterrole=edit --serviceaccount=dev:build-bot -n dev

# 校验身份能做什么
kubectl auth can-i list pods --as=system:serviceaccount:dev:build-bot -n dev
kubectl auth whoami --as=system:serviceaccount:dev:build-bot

# 给默认 SA 配置镜像拉取凭据
kubectl create secret docker-registry my-registry-secret -n dev \
  --docker-server=registry.example.com \
  --docker-username=user --docker-password=pass
kubectl patch serviceaccount default -n dev \
  -p '{"imagePullSecrets": [{"name": "my-registry-secret"}]}'

# 查看已签发的 token Secret
kubectl get secret -n dev --field-selector type=kubernetes.io/service-account-token
```

### 注意

1. **1.24 起不再自动为 ServiceAccount 生成 Secret**。升级后依赖 `kubectl get secret <sa>-token-xxxx` 取 token 的脚本会直接失效,需改用 `kubectl create token`。
2. **`kubectl create token` 签发的 token 默认只有 1 小时有效期**,不能写死在长期运行的配置文件里。需要长期 token 时应使用 `--bound-object-kind=Pod` 绑定到工作负载,由 kubelet 自动轮换。
3. **`serviceAccountName` 创建后不可修改**。Pod 是不可变对象,改身份必须重建 Pod(Deployment 会滚动更新)。
4. **ServiceAccount 不能跨命名空间使用**。`dev` 命名空间下的 Pod 只能引用 `dev` 下的 SA,写错命名空间会报 `serviceaccount "xxx" not found`。
5. **SA 本身不携带任何权限**,只提供身份。忘记创建 RoleBinding 会导致 API 调用返回 `Forbidden`,这是排查「Pod 无法访问 API」时的第一步。
6. **默认 SA 的 token 会自动挂载到每个 Pod**。业务不需要访问 API 时应设置 `automountServiceAccountToken: false`,避免 token 泄露后被用来横向移动。
7. 删除 ServiceAccount 会使其**绑定的短期 token 立即失效**;但手工创建的 `kubernetes.io/service-account-token` 类型 Secret 不会自动删除,遗留的 token 仍可能被旧 Pod 使用。
8. `imagePullSecrets` 在 SA 上配置会对该 SA 的所有 Pod 生效;若 Pod 自己声明了 `imagePullSecrets`,则 SA 上的配置**不会**被合并,需要重新列出。
9. 删除 SA 时对应的 RoleBinding 不会级联删除,会留下悬空主体,建议定期用 `kubectl auth reconcile` 收敛。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `rbac` — 基于角色的访问控制
- `kubeadm` — Kubernetes集群安装工具
- `kube-bench` — CIS 安全基线检查

### 参考链接

- [ServiceAccount 官方文档](https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/)
- [管理 ServiceAccount 的 Token](https://kubernetes.io/docs/reference/access-authn-authz/service-accounts-admin/)
- [投射卷(Projected Volume)](https://kubernetes.io/docs/concepts/storage/projected-volumes/)
- [从私有仓库拉取镜像](https://kubernetes.io/docs/tasks/configure-pod-container/pull-image-private-registry/)
