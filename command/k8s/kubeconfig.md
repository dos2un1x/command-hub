kubeconfig
===

Kubernetes集群访问凭据配置文件

## 补充说明

**kubeconfig** 是 Kubernetes 的客户端配置文件,用来描述「用哪个身份、访问哪个集群、默认在哪个命名空间」。`kubectl`、`helm`、`k9s` 以及各种 Operator 和 CI 流水线读的都是它。

它本身不是一个可执行命令,而是通过 `kubectl config` 系列子命令来管理。kubeconfig 支持**多集群、多用户、多上下文**:一份文件里可以同时存放测试环境和生产环境的凭据,靠切换 context 来切换目标集群。

默认路径是 `~/.kube/config`,也可以用环境变量 `KUBECONFIG` 指定其他位置或一组文件。

### 文件结构

一份 kubeconfig 由四部分组成:

```shell
apiVersion: v1
kind: Config
preferences: {}

# 集群:API Server 的地址与 CA 证书
clusters:
  - name: prod
    cluster:
      server: https://10.0.0.10:6443
      certificate-authority-data: LS0tLS1CRUdJTi...

# 用户:身份凭据(客户端证书 / Token / exec 插件)
users:
  - name: prod-admin
    user:
      client-certificate-data: LS0tLS1CRUdJTi...
      client-key-data: LS0tLS1CRUdJTi...

# 上下文:把集群、用户、默认命名空间绑在一起
contexts:
  - name: prod
    context:
      cluster: prod
      user: prod-admin
      namespace: default

current-context: prod
```

理解要点:`clusters` 和 `users` 是零件,`contexts` 是组装好的组合,`current-context` 决定 kubectl 默认用哪一组。**切换集群,本质上就是切换 context**。

### 环境变量与路径

```shell
# 默认路径
ls -l ~/.kube/config

# 指定单个文件
export KUBECONFIG=/path/to/config
kubectl config view

# 指定多个文件(冒号分隔),kubectl 会把它们合并
export KUBECONFIG=~/.kube/config:/path/to/prod.yaml

# 临时屏蔽所有默认配置
KUBECONFIG=/dev/null kubectl config view

# 单次命令单独指定
kubectl --kubeconfig=/path/to/config get nodes
```

### 查看与切换

```shell
# 查看完整配置(敏感字段会被隐去,加 --raw 显示原始 base64)
kubectl config view
kubectl config view --raw

# 只看当前 context 相关的内容,适合分享和排查
kubectl config view --minify
kubectl config view --minify --raw

# 列出所有 context
kubectl config get-contexts

# 查看当前 context
kubectl config current-context

# 切换 context
kubectl config use-context prod

# 查看所有集群与用户条目
kubectl config get-clusters
kubectl config get-users
```

### 增删改

```shell
# 集群条目
kubectl config set-cluster prod \
  --server=https://10.0.0.10:6443 \
  --certificate-authority=/etc/kubernetes/pki/ca.crt \
  --embed-certs=true

# 用户条目(客户端证书)
kubectl config set-credentials prod-admin \
  --client-certificate=/etc/kubernetes/pki/admin.crt \
  --client-key=/etc/kubernetes/pki/admin.key \
  --embed-certs=true

# 用户条目(Token)
kubectl config set-credentials ci-bot --token=eyJhbGciOiJSUzI1NiIs...

# 上下文条目
kubectl config set-context prod \
  --cluster=prod \
  --user=prod-admin \
  --namespace=default

# 修改当前 context 的默认命名空间
kubectl config set-context --current --namespace=kube-system

# 用路径语法改单个字段
kubectl config set contexts.prod.namespace kube-system

# 删除字段
kubectl config unset users.prod-admin.client-key-data

# 重命名与删除
kubectl config rename-context prod prod-old
kubectl config delete-context prod-old
kubectl config delete-cluster prod
kubectl config delete-user prod-admin
```

### 合并多份配置

```shell
# 方式一:用 KUBECONFIG 环境变量临时合并
export KUBECONFIG=~/.kube/config:~/prod.yaml:~/dev.yaml
kubectl config get-contexts

# 方式二:合并成一份实体文件
kubectl config view --flatten > ~/.kube/merged.yaml
KUBECONFIG=~/.kube/merged.yaml kubectl config get-contexts

# 只保留当前 context,导出一份最小配置
kubectl config view --minify --flatten > ./share.yaml
```

### 提取字段

```shell
# API Server 地址
kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}'

# CA 证书解码成文件
kubectl config view --minify --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | base64 -d > ca.crt

# 所有 context 名称
kubectl config view -o jsonpath='{.contexts[*].name}'

# 所有集群名称
kubectl config view -o jsonpath='{.clusters[*].name}'
```

### 为 ServiceAccount 生成 kubeconfig

CI 流水线里常见的做法是用一个专用身份,而不是共用管理员证书:

```shell
# 1. 创建 ServiceAccount 并签发一个短期 Token
kubectl create serviceaccount ci-bot -n default
TOKEN=$(kubectl create token ci-bot -n default --duration=24h)

# 2. 取出集群地址与 CA
SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
kubectl config view --minify --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' | base64 -d > ca.crt

# 3. 组装一份独立的 kubeconfig
kubectl config set-cluster prod --server="$SERVER" \
  --certificate-authority=ca.crt --embed-certs=true --kubeconfig=./ci-bot.kubeconfig
kubectl config set-credentials ci-bot --token="$TOKEN" --kubeconfig=./ci-bot.kubeconfig
kubectl config set-context prod --cluster=prod --user=ci-bot --namespace=default \
  --kubeconfig=./ci-bot.kubeconfig
kubectl config use-context prod --kubeconfig=./ci-bot.kubeconfig

# 4. 验证
kubectl --kubeconfig=./ci-bot.kubeconfig get pods
```

### 命令行覆盖

```shell
# 单次命令临时指定,优先级高于 current-context
kubectl --context=prod get pods
kubectl --cluster=prod --user=prod-admin get nodes
kubectl --server=https://10.0.0.10:6443 get nodes

# 命名空间优先级:--namespace > context.namespace > default
kubectl get pods -n kube-system
```

### 注意

1. **kubeconfig 里存着集群的最高权限凭据**,相当于集群的私钥。文件权限应当是 `600`,并且绝不能提交到 Git 仓库。kubeadm 生成的 `admin.conf` 属于 `system:masters` 组,拿到它就等于集群管理员。
2. `kubectl config view` **默认会隐去敏感字段**(显示为占位符),需要加 `--raw` 才能看到真实的 base64 证书与密钥。
3. 用 `KUBECONFIG` 指定多个文件时是**合并**而不是覆盖:同名条目的取舍规则容易出错,而且写操作只会落到列表中的第一个文件。要合并成实体文件,请用 `kubectl config view --flatten`。
4. `--minify` 只输出当前 context 用到的 cluster、user 和 context,是分享配置和排查「为什么连错集群」的最佳工具 —— 相当一部分「kubectl 连不上」其实是 `current-context` 指错了。
5. 命名空间优先级是 `-n` > `context.namespace` > `default`。不要凭记忆,用 `kubectl config view --minify` 确认。
6. 删除 context **不会**连带删除对应的 cluster 和 user 条目。时间一长 kubeconfig 会残留大量无用条目,需要手工 `delete-cluster` / `delete-user` 清理。
7. 使用 `exec` 认证插件(如 `aws`、`gke-gcloud-auth-plugin`、`kubelogin`)时,本地必须安装对应的二进制,否则报 `executable not found`。CI 环境尤其容易踩这个坑。
8. `current-context` 为空时 kubectl 会报 `current-context is not set`,所有命令失败。多文件合并时若第一个文件里没有 `current-context`,合并结果同样为空。
9. 集群内的 Pod 访问 apiserver 靠的是 ServiceAccount Token(挂载在 `/var/run/secrets/kubernetes.io/serviceaccount/`),与 kubeconfig 无关。不要为了「让程序能访问 API」而把 kubeconfig 打进镜像。
10. kubeconfig 里的客户端证书一旦签发就**无法吊销**,只能等它过期或轮换 CA。生产环境应优先使用短期 Token 或 `exec` 插件。
11. 修改 kubeconfig 后不需要重启任何东西,kubectl 每次执行都会重新读取文件。
12. 用 `KUBECONFIG=/dev/null` 可以临时屏蔽所有默认配置,快速验证「是不是配置文件的锅」。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kubeadm` — Kubernetes集群安装工具
- `kube-apiserver` — 集群 API 服务器
- `helm` — Kubernetes包管理器

### 参考链接

- [使用 kubeconfig 文件组织集群访问](https://kubernetes.io/docs/concepts/configuration/organize-cluster-access-kubeconfig/)
- [配置多集群访问](https://kubernetes.io/docs/tasks/access-application-cluster/configure-access-multiple-clusters/)
- [kubectl config 命令参考](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_config/)
- [认证](https://kubernetes.io/docs/reference/access-authn-authz/authentication/)
