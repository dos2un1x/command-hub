sealed-secrets
===

把Kubernetes Secret加密成可安全提交到Git的SealedSecret

## 补充说明

**Sealed Secrets** 是一个「单向加密」的控制器,解决的是一个非常具体的问题:**如何把 Secret 安全地放进 Git**。

它与 `secret` 页讲的 Kubernetes 原生 Secret 对象是两回事:原生 Secret 是集群里真实存在的资源,任何有读取权限的人都能 base64 解出明文;Sealed Secrets 是**在原生 Secret 之外套的一层加密方案** —— 明文永远不进 Git,进 Git 的是只有目标集群能解开的密文。

整个方案由两部分组成:

```shell
sealed-secrets-controller   跑在集群里,持有私钥,负责解密
kubeseal                    CLI,用控制器的公钥在本地加密
```

工作流程:

```shell
1. kubeseal 从控制器取公钥(证书)
2. 在本地把 Secret 加密成 SealedSecret 清单
3. 把 SealedSecret 提交进 Git
4. 集群里的控制器用私钥解密,还原成普通 Secret 供 Pod 使用
```

加密在本地完成,**私钥始终不出集群**;密文只能由持有对应私钥的那个集群解开 —— 换个集群,或者在没备份私钥的情况下重建控制器,都无法解密。

与相近方案的分工:

| 方案 | 密钥存放位置 | 适用场景 |
| --- | --- | --- |
| Sealed Secrets | 密文进 Git,私钥在集群内 | 单集群、纯 GitOps 流程 |
| External Secrets | 明文放在外部(如 Vault、云 Secrets Manager) | 多集群、已有统一密钥库 |
| SOPS | 加密文件进 Git,密钥在 KMS 或 age | 与 CI 流程结合紧密 |

Sealed Secrets 的定位是**轻量、无外部依赖**。它不做密钥值轮换、不做审批流,也不解决「谁来保管密钥明文」的问题。

### 安装

```shell
helm repo add sealed-secrets https://bitnami.github.io/sealed-secrets
helm repo update

helm install sealed-secrets -n kube-system \
  --set-string fullnameOverride=sealed-secrets-controller \
  sealed-secrets/sealed-secrets
```

`fullnameOverride` 不是必须的,但**强烈建议照抄**:chart 默认把控制器命名为 `sealed-secrets`,而 `kubeseal` 默认去找名为 `sealed-secrets-controller` 的 Service,不覆盖名字就得每次加 `--controller-name sealed-secrets`。

安装 CLI:

```shell
# macOS
brew install kubeseal

# Linux:从 GitHub Releases 下载(以 v0.40.0 为例)
curl -LO https://github.com/bitnami/sealed-secrets/releases/download/v0.40.0/kubeseal-0.40.0-linux-amd64.tar.gz
tar -xzf kubeseal-0.40.0-linux-amd64.tar.gz
sudo install -m 755 kubeseal /usr/local/bin/kubeseal

kubeseal --version
```

确认控制器就绪:

```shell
kubectl get pods -n kube-system -l app.kubernetes.io/name=sealed-secrets
kubectl get svc -n kube-system sealed-secrets-controller
```

### 基本用法

```shell
# 1. 生成普通 Secret 清单(不要落库)
kubectl create secret generic db-secret \
  --from-literal=username=admin \
  --from-literal=password='S3cr3t!' \
  --dry-run=client -o yaml > db-secret.yaml

# 2. 加密成 SealedSecret
kubeseal -f db-secret.yaml -w db-sealed.yaml

# 3. 应用并提交
kubectl apply -f db-sealed.yaml
git add db-sealed.yaml && git commit -m "add db secret"

# 4. 控制器解密后会产生同名的普通 Secret
kubectl get secret db-secret
```

也可以直接管道,不落中间文件:

```shell
kubectl create secret generic db-secret \
  --from-literal=password='S3cr3t!' \
  --dry-run=client -o yaml | kubeseal -o yaml > db-sealed.yaml
```

生成的清单长这样:

```shell
apiVersion: bitnami.com/v1alpha1
kind: SealedSecret
metadata:
  name: db-secret
  namespace: default
spec:
  encryptedData:
    password: AgBy3i4OJSWK+PiTySYZZA9rO43cGDEq...
    username: AgCtr9F3kZ0...
  template:
    metadata:
      name: db-secret
      namespace: default
    type: Opaque
```

`spec.template` 里的元数据会被带到解密出的 Secret 上,但**不能携带明文数据**。

### 作用域

```shell
# strict(默认):名字与命名空间都参与加密,换名字或换命名空间都解不开
kubeseal --scope strict -f db-secret.yaml -w db-sealed.yaml

# namespace-wide:可在同一命名空间内自由改名字
kubeseal --scope namespace-wide -f db-secret.yaml -w db-sealed.yaml

# cluster-wide:可在任意命名空间、任意名字下解密
kubeseal --scope cluster-wide -f db-secret.yaml -w db-sealed.yaml
```

也支持注解形式,两者同时存在时 `cluster-wide` 优先:

```shell
metadata:
  annotations:
    sealedsecrets.bitnami.com/namespace-wide: "true"
```

### 离线加密与重新加密

CI 环境通常连不上集群,可以先取证书再离线加密:

```shell
# 取公钥证书(公开信息,可以进 Git)
kubeseal --fetch-cert > mycert.pem

# 离线加密
kubeseal --cert mycert.pem -f db-secret.yaml -w db-sealed.yaml

# 也可以从文件读取证书路径
export SEALED_SECRETS_CERT=mycert.pem
```

密钥轮换之后,建议把存量密文重新加密一遍:

```shell
kubeseal --re-encrypt -f db-sealed.yaml -w db-sealed-new.yaml
```

### 密钥轮换与备份

控制器每 30 天自动生成一把新的加密密钥。新密钥用于加密,**旧密钥保留用于解密**,因此轮换本身不会让已有 SealedSecret 失效。

```shell
# 查看密钥 Secret(私钥就在这里)
kubectl get secret -n kube-system -l sealedsecrets.bitnami.com/sealed-secrets-key

# 修改轮换周期:编辑 Deployment,给容器加 --key-renew-period=720h
# 值设为 0 表示关闭自动轮换
kubectl edit deployment/sealed-secrets-controller --namespace=kube-system

# 怀疑私钥泄露时,强制提前换钥(在 Deployment 上加参数)
# --key-cutoff-time="2026-01-01T00:00:00Z"
```

备份与恢复 —— **这一步不做,整个方案就是一次性的**:

```shell
# 备份
kubectl get secret -n kube-system \
  -l sealedsecrets.bitnami.com/sealed-secrets-key -o yaml > main.key

# 恢复:先停控制器,导入密钥,再让它重新读取
kubectl apply -f main.key
kubectl delete pod -n kube-system -l app.kubernetes.io/name=sealed-secrets

# 用清单方式安装时标签不同
kubectl delete pod -n kube-system -l name=sealed-secrets-controller
```

`main.key` 文件里是**未加密的私钥**,必须放到集群之外的安全位置(密码管理器、离线保险柜),并且每次密钥轮换后重新备份一次。

### 注意

1. **私钥丢了就全完了**。SealedSecret 的密文只能用集群里那把私钥解开 —— 控制器重建、集群迁移、误删 `sealed-secrets-key` Secret,都会让所有密文**永久不可解**。上线第一件事就是备份私钥并放到集群之外,且每次轮换后重新备份。
2. **SealedSecret 与命名空间、名字绑定**。默认 `strict` 作用域下,命名空间与名字是密文的一部分,把同一个 SealedSecret 复制到别的命名空间**解密必然失败**;要跨命名空间复用只能用 `cluster-wide`,但那等于放弃了隔离边界,慎用。
3. **它是「单集群专用的密文」,不是「加密过的 Secret」**。不同集群、不同控制器实例之间无法互相解密,因此也不能拿它来传递密钥值 —— 密钥值该走密码管理器还是走密码管理器。
4. **`kubeseal` 默认要能连上集群**才能取公钥。CI 里通常先用 `kubeseal --fetch-cert` 取好证书,再用 `--cert` 离线加密;证书是公开信息,可以放心进 Git。
5. **控制器需要在其所在命名空间创建和更新 Secret 的权限**。收紧了它的 RBAC、或把它放进受限命名空间,表现是「SealedSecret 建出来了,但对应的 Secret 一直不出现」,而且 `kubeseal` 侧看不出任何异常。
6. **`template` 段可以带元数据,不能带数据**。`spec.template.metadata.labels`、`annotations` 会被传递到解密出的 Secret;试图在 `template` 里直接写 `data` 会被控制器拒绝。
7. **密钥轮换不等于密钥值轮换**。30 天的自动轮换只更换加解密用的密钥对,**不会改变你存进去的数据库密码**。真正的凭据轮换仍要人工完成,并用 `kubeseal --re-encrypt` 重新生成密文。
8. **删除 SealedSecret 会连带回收它生成的 Secret**。控制器会在生成的 Secret 上设置 ownerReference,因此删除 SealedSecret 时那个 Secret 会被一并删除。若它正被 Pod 挂载,会表现为 Pod 重建失败,排查时容易误判成权限问题。
9. **Bitnami 目录调整不影响本项目**。2025 年 8 月 Broadcom 大幅缩减 Bitnami 公开镜像目录,大量镜像被移入不再维护的 `bitnamilegacy`;但官方公告明确把 **Sealed Secrets、charts-syncer 与 minideb 列为不受影响的项目**,镜像仍照常发布在 `docker.io/bitnami`。
10. **密文里没有完整性之外的保障**。SealedSecret 一旦提交进 Git,就等于把「谁能改这个密文」变成了代码评审问题 —— 必须配合分支保护与代码所有者规则,否则任何有写权限的人都能替换掉密文内容。

### 相关命令

- `secret` — Kubernetes原生Secret对象本身的用法
- `kubectl` — Kubernetes集群管理工具
- `helm` — 安装控制器的主要方式
- `kustomize` — 与密文清单配合的声明式管理
- `argocd` — 常见的GitOps落地工具

### 参考链接

- [Sealed Secrets 项目主页](https://github.com/bitnami/sealed-secrets)
- [kubeseal 用法与作用域说明](https://github.com/bitnami/sealed-secrets#usage)
- [Helm Chart 源码](https://github.com/bitnami/sealed-secrets/tree/main/helm/sealed-secrets)
- [Bitnami 目录调整公告(Sealed Secrets 不受影响)](https://github.com/bitnami/containers/issues/83267)
