secret
===

Kubernetes中存放密码、令牌与证书等敏感信息的资源对象

## 补充说明

**Secret** 用于存放密码、API Token、SSH 密钥、TLS 证书等敏感数据,用法与 ConfigMap 几乎一致,但独立成一种资源是为了施加更严格的管控:可以单独授权 RBAC、可以配合 etcd 静态加密、在 `kubectl describe` 中也不会直接展开内容。

需要特别强调的是:**Secret 默认只是 base64 编码,不是加密**。任何能读取该 Secret 的人都可以一条命令还原出明文。它的安全性来自访问控制(RBAC)与 etcd 加密配置,而不是编码本身。把 Secret 当成「加密过的 ConfigMap」是极其危险的误解。

### 类型

```shell
Opaque                            默认类型,任意键值对
kubernetes.io/service-account-token  服务账号令牌,由控制器自动创建
kubernetes.io/dockerconfigjson    私有镜像仓库的认证信息
kubernetes.io/tls                 TLS 证书与私钥,key 必须为 tls.crt 与 tls.key
kubernetes.io/basic-auth          用户名密码,key 为 username 与 password
kubernetes.io/ssh-auth            SSH 私钥,key 为 ssh-privatekey
bootstrap.kubernetes.io/token     节点引导令牌
```

### 创建方式

```shell
# 从字面量创建(值会自动 base64 编码)
kubectl create secret generic db-secret \
  --from-literal=username=admin \
  --from-literal=password='S3cr3t!'

# 从文件创建
kubectl create secret generic tls-secret --from-file=./cert.pem

# 从 env 文件创建
kubectl create secret generic app-secret --from-env-file=secret.env

# 创建 TLS 类型
kubectl create secret tls example-tls --cert=tls.crt --key=tls.key

# 创建镜像仓库认证
kubectl create secret docker-registry regcred \
  --docker-server=registry.example.com \
  --docker-username=admin \
  --docker-password='S3cr3t!' \
  --docker-email=admin@example.com

# 从已有 docker 配置创建
kubectl create secret generic regcred \
  --from-file=.dockerconfigjson=$HOME/.docker/config.json \
  --type=kubernetes.io/dockerconfigjson
```

### 语法

```shell
kubectl get secret [名称] [选项]
kubectl describe secret [名称]
kubectl create secret [类型] [名称] [数据来源] [选项]
kubectl delete secret [名称]
```

### YAML 清单

Opaque 类型,`data` 中的值必须是 base64 编码:

```shell
apiVersion: v1
kind: Secret
metadata:
  name: db-secret
  namespace: default
type: Opaque
data:
  username: YWRtaW4=                 # echo -n 'admin' | base64
  password: UzNjcjN0IQ==             # echo -n 'S3cr3t!' | base64
```

`stringData` 可以直接写明文,apiserver 会在写入时自动编码并合并进 `data`,**但读取时不会显示出来**:

```shell
apiVersion: v1
kind: Secret
metadata:
  name: db-secret-plain
type: Opaque
stringData:
  username: admin
  password: "S3cr3t!"
```

TLS 证书类型:

```shell
apiVersion: v1
kind: Secret
metadata:
  name: example-tls
type: kubernetes.io/tls
data:
  tls.crt: LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0t...
  tls.key: LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0t...
```

### 在 Pod 中使用

注入为环境变量:

```shell
apiVersion: v1
kind: Pod
metadata:
  name: secret-env-demo
spec:
  containers:
    - name: app
      image: busybox:1.36
      command: ["sh", "-c", "sleep 3600"]
      env:
        - name: DB_USERNAME
          valueFrom:
            secretKeyRef:
              name: db-secret
              key: username
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: db-secret
              key: password
      envFrom:
        - secretRef:
            name: db-secret
            optional: false
```

挂载为文件,适合证书与配置文件:

```shell
apiVersion: v1
kind: Pod
metadata:
  name: secret-volume-demo
spec:
  containers:
    - name: app
      image: nginx:1.27
      volumeMounts:
        - name: tls-volume
          mountPath: /etc/nginx/certs
          readOnly: true
  volumes:
    - name: tls-volume
      secret:
        secretName: example-tls
        defaultMode: 0400             # 私钥建议收紧权限
        items:
          - key: tls.crt
            path: server.crt
          - key: tls.key
            path: server.key
            mode: 0400
```

拉取私有镜像时引用 `imagePullSecrets`,写在 `spec.template.spec` 下:

```shell
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  replicas: 2
  selector:
    matchLabels:
      app: app
  template:
    metadata:
      labels:
        app: app
    spec:
      imagePullSecrets:
        - name: regcred
      containers:
        - name: app
          image: registry.example.com/team/app:1.0.0
          envFrom:
            - secretRef:
                name: db-secret
```

### 查看与解码

```shell
# 查看列表(只显示 key 数量与大小,不显示内容)
kubectl get secret -A
kubectl describe secret db-secret

# 取出某个 key 并解码
kubectl get secret db-secret -o jsonpath='{.data.password}' | base64 -d
echo "UzNjcjN0IQ==" | base64 -d

# 一次性解码所有 key
kubectl get secret db-secret -o go-template='{{range $k,$v := .data}}{{$k}}={{$v|base64decode}}{{"\n"}}{{end}}'

# 转为可读的明文视图
kubectl view-secret db-secret          # 需安装 view-secret 插件
```

### 静态加密

Secret 默认以明文存放在 etcd 中,开启静态加密需要在 apiserver 上配置 `EncryptionConfiguration`,并用 `--encryption-provider-config` 指向该文件。配置完成后,已存在的 Secret 必须重写一遍才会真正加密:

```shell
head -c 32 /dev/urandom | base64                    # 生成 aescbc 密钥

kubectl get secrets -A -o json | kubectl replace -f -
```

### 注意

1. **Secret 默认只是 base64 编码,不是加密**。`kubectl get secret -o jsonpath='{.data}' | base64 -d` 即可还原明文,任何拥有读取权限(包括能创建 Pod 的人)都能拿到。真正的防护来自 RBAC 最小授权与 etcd 静态加密。
2. **能创建 Pod 的人几乎等价于能读取所有 Secret**。挂载 Secret 的 Pod 可以由攻击者自己创建,所以务必用 RBAC 限制谁能创建 Pod、谁只能用指定的 ServiceAccount。
3. **Secret 必须与引用它的 Pod 在同一命名空间**,不能跨命名空间引用。`imagePullSecrets` 也一样,每个命名空间需要各建一份。
4. **以环境变量注入的 Secret 不会自动更新**,且环境变量容易被 `kubectl exec env`、崩溃日志、子进程继承等方式泄露。能挂载就优先挂载为文件。
5. **`stringData` 是只写的**。用它写入的值会被合并进 `data`,但 `kubectl get -o yaml` 只会显示 `data`,看不到 `stringData`,不要以为数据丢了。
6. **`kubectl create secret --dry-run=client -o yaml` 输出的仍是 base64**,纳入 Git 之前务必确认没有把明文密钥提交上去;生产环境应使用 SealedSecrets、External Secrets 或 SOPS 之类的方案。
7. **Secret 大小上限约 1MiB**,与 ConfigMap 相同,受 etcd 请求大小限制。大证书链或多文件配置应拆分成多个 Secret。
8. **TLS 类型的 key 名是固定的**,必须是 `tls.crt` 与 `tls.key`,写成 `cert`/`key` 不会被 Ingress 识别,证书不会生效且不报错。
9. **挂载的 Secret 会自动更新(约 1 分钟),用 `subPath` 挂载的则不会**,与 ConfigMap 行为一致。应用需要自行监听文件变化并重载。
10. **删除 Secret 前先确认没有 Pod 在引用**。正在运行的 Pod 的挂载内容不会立即消失,但重建、扩缩容时会卡在 `CreateContainerConfigError`,排查时容易被误导。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `configmap` — 存放非敏感配置的同类资源
- `service` — 与之配合的ServiceAccount令牌来源
- `namespace` — Secret的作用域边界
- `kubeadm` — Kubernetes集群安装与生命周期管理工具

### 参考链接

- [Secret 官方文档](https://kubernetes.io/docs/concepts/configuration/secret/)
- [为 Pod 配置 Secret](https://kubernetes.io/docs/tasks/configure-pod-container/configure-pod-configmap/)
- [加密 Secret 数据](https://kubernetes.io/docs/tasks/administer-cluster/encrypt-data/)
- [从私有仓库拉取镜像](https://kubernetes.io/docs/tasks/configure-pod-container/pull-image-private-registry/)
