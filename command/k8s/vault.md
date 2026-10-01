vault
===

HashiCorp密钥管理平台,在Kubernetes中安全下发与轮换敏感数据

## 补充说明

**Vault** 是 HashiCorp 的密钥管理平台,把「谁在什么条件下能拿到哪份密钥」集中管理,并提供租期(lease)、动态凭据与完整的审计日志。

它与 `secret` 页讲的原生 Secret 是互补关系:原生 Secret 解决「集群内怎么用密钥」,Vault 解决「密钥从哪来、谁能取、多久换一次」。

在 Kubernetes 里,Vault 更常见的角色不是「存密钥」而是「**发密钥**」:

```shell
静态场景   业务把数据库密码存进 Vault,Pod 通过注解或 CRD 拉取
动态场景   Vault 按需向数据库申请一个临时账号,租期到期自动注销
```

两个必须先了解的项目背景:

```shell
许可   2023 年 8 月起从 MPL 2.0 改为 BSL 1.1,社区分支是 OpenBao(MPL 2.0)
归属   HashiCorp 已被 IBM 收购(2025 年 2 月完成),主版本号从 1.21 直接跳到 2.0
```

另外,托管服务 HCP Vault Secrets 已于 2026 年 7 月 1 日停止服务;自建或自管的 Vault 不受影响。

### 安装

```shell
helm repo add hashicorp https://helm.releases.hashicorp.com
helm repo update

# 生产推荐:HA + Raft 存储,不依赖 Consul
helm install vault hashicorp/vault -n vault --create-namespace \
  --set='server.ha.enabled=true' \
  --set='server.ha.raft.enabled=true'

# 单机模式(chart 默认,file 存储,不适合生产)
helm install vault hashicorp/vault -n vault --create-namespace

# 开发模式:自动初始化并解封,内存存储,重启即丢
helm install vault hashicorp/vault -n vault --create-namespace \
  --set='server.dev.enabled=true'
```

### 初始化与解封

Vault 启动后默认处于 **Sealed(已封存)** 状态,不完成 unseal 就无法读写任何密钥。**这是自建 Vault 最容易漏掉的一步**,表现为 Pod 明明 Running,但所有操作都报 `Vault is sealed`。

```shell
# 查看状态,Sealed 为 true 时不可用
kubectl exec -n vault vault-0 -- vault status

# 初始化:生成 5 个 unseal key 与 1 个 root token
kubectl exec -n vault vault-0 -- vault operator init

# 用其中 3 个 key 解封(默认阈值 3/5)
kubectl exec -n vault vault-0 -- vault operator unseal <key-1>
kubectl exec -n vault vault-0 -- vault operator unseal <key-2>
kubectl exec -n vault vault-0 -- vault operator unseal <key-3>

# 多副本时,每个 Pod 都要各自解封
kubectl exec -n vault vault-1 -- vault operator unseal <key-1>
kubectl exec -n vault vault-1 -- vault operator unseal <key-2>
kubectl exec -n vault vault-1 -- vault operator unseal <key-3>
```

`init` 输出的 unseal key 与 root token **只显示一次**,必须当场离线保存。root token 权限过大,建议只用于初始配置,之后立即吊销,日常操作改用带具体策略的令牌。

手工 unseal 在生产里不可接受 —— 任何一次 Pod 重启都会让 Vault 回到封存状态。生产环境应配置**自动解封**,用云厂商 KMS 或另一套 Vault 的 Transit 引擎托管master key;Helm chart 里对应 `server.seal.<类型>` 一组值(如 `awskms`、`azurekeyvault`、`gcpckms`)。

### Kubernetes 认证

让 Pod 用 ServiceAccount 换取 Vault 令牌,避免在集群里存长期凭据:

```shell
# 启用 Kubernetes 认证
kubectl exec -n vault vault-0 -- vault auth enable kubernetes

# 告诉 Vault 如何校验 ServiceAccount 令牌
kubectl exec -n vault vault-0 -- vault write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc:443"

# 写一条只读策略(policy.hcl 从标准输入传入)
kubectl exec -i -n vault vault-0 -- vault policy write app-ro - < policy.hcl

# 绑定 ServiceAccount 与策略
kubectl exec -n vault vault-0 -- vault write auth/kubernetes/role/app \
  bound_service_account_names=app \
  bound_service_account_namespaces=default \
  policies=app-ro \
  ttl=1h
```

策略文件 `policy.hcl`:

```shell
path "secret/data/app/*" {
  capabilities = ["read"]
}
```

### 读写密钥(KV v2)

```shell
kubectl exec -n vault vault-0 -- vault kv put secret/app/config \
  username=admin password='S3cr3t!'

kubectl exec -n vault vault-0 -- vault kv get secret/app/config
kubectl exec -n vault vault-0 -- vault kv metadata get secret/app/config
kubectl exec -n vault vault-0 -- vault kv list secret/app

# 删除最新版本(可恢复)
kubectl exec -n vault vault-0 -- vault kv delete secret/app/config

# 彻底销毁所有版本与元数据
kubectl exec -n vault vault-0 -- vault kv destroy -versions=1 secret/app/config
kubectl exec -n vault vault-0 -- vault kv metadata delete secret/app/config
```

注意 KV v2 的路径在 API 与策略里要多一层 `data`:`secret/data/app/config`,而 CLI 里写的是 `secret/app/config`。

### 三种集成方式

| 方式 | 原理 | 特点 |
| --- | --- | --- |
| Agent Injector | 准入 webhook 注入 sidecar,把密钥写进共享内存卷 | 支持模板渲染,密钥不落 etcd,但每个 Pod 多一个容器 |
| Secrets Store CSI | CSI 驱动把密钥挂载成文件 | 与 CSI 生态统一,密钥不落 etcd |
| Vault Secrets Operator | 控制器把密钥同步成原生 Secret | 无 sidecar、GitOps 友好,但密钥会进 etcd |

**Agent Injector** 用注解声明:

```shell
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app
spec:
  template:
    metadata:
      annotations:
        vault.hashicorp.com/agent-inject: "true"
        vault.hashicorp.com/role: "app"
        vault.hashicorp.com/agent-inject-secret-config.env: "secret/data/app/config"
        vault.hashicorp.com/agent-inject-template-config.env: |
          {{- with secret "secret/data/app/config" -}}
          DB_USER={{ .Data.data.username }}
          DB_PASS={{ .Data.data.password }}
          {{- end }}
    spec:
      serviceAccountName: app
      containers:
        - name: app
          image: example/app:1.0.0
          command: ["sh", "-c", "source /vault/secrets/config.env && exec ./app"]
```

密钥被写到 `/vault/secrets/` 下的 **tmpfs 共享内存卷**,不会落到 etcd。

**Secrets Store CSI Driver**:

```shell
# 1. 安装 CSI 驱动
helm repo add secrets-store-csi-driver https://kubernetes-sigs.github.io/secrets-store-csi-driver/charts
helm install csi-secrets-store secrets-store-csi-driver/secrets-store-csi-driver \
  -n kube-system

# 2. Vault Helm chart 内置了 CSI Provider,打开开关即可
helm upgrade vault hashicorp/vault -n vault --set='csi.enabled=true'
```

```shell
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: vault-db
spec:
  provider: vault
  parameters:
    vaultAddress: "http://vault.vault.svc:8200"
    roleName: "app"
    objects: |
      - objectName: "password"
        secretPath: "secret/data/app/config"
        secretKey: "password"
```

**Vault Secrets Operator(VSO)**:

```shell
helm install vault-secrets-operator hashicorp/vault-secrets-operator \
  -n vault-secrets-operator-system --create-namespace
```

```shell
apiVersion: secrets.hashicorp.com/v1beta1
kind: VaultStaticSecret
metadata:
  name: app-config
  namespace: default
spec:
  vaultAuthRef: app-auth
  mount: secret
  type: kv-v2
  path: app/config
  destination:
    name: app-config
    create: true
  refreshAfter: 60s
  rolloutRestartTargets:
    - kind: Deployment
      name: app
```

### 常用操作

```shell
# 状态与集群成员
kubectl exec -n vault vault-0 -- vault status
kubectl exec -n vault vault-0 -- vault operator members

# 查看已启用的引擎与认证方式
kubectl exec -n vault vault-0 -- vault secrets list
kubectl exec -n vault vault-0 -- vault auth list

# 开启审计日志(强烈建议,应作为上线必做项)
kubectl exec -n vault vault-0 -- vault audit enable file file_path=/vault/logs/audit.log
kubectl exec -n vault vault-0 -- vault audit list

# 查看租期
kubectl exec -n vault vault-0 -- vault list sys/leases/lookup/auth/kubernetes/role/app
```

### 注意

1. **初始化后必须 unseal,重启后还要再 unseal**。Shamir 模式下每个 Vault 进程重启都会回到 Sealed 状态,多副本要逐个解封。生产环境必须配置自动解封(KMS 或 Transit),否则一次节点重启就会让整个密钥体系不可用,所有依赖 Vault 的 Pod 都会卡在启动阶段。
2. **unseal key 与 root token 只显示一次**。`vault operator init` 的输出必须当场离线保存。丢了 unseal key 等于丢了整个 Vault;root token 丢失还能用 unseal key 重新生成,但密文本身无法恢复。
3. **不要用单机或开发模式上生产**。`server.dev.enabled=true` 是内存存储、自动解封、固定 root token 的组合,重启即全部丢失;chart 默认的单机模式用 file 存储,也不具备高可用与故障转移。
4. **Agent Injector 与 CSI 不落 etcd,VSO 会**。VSO 把密钥同步成**原生 Secret**,任何能读该 Secret(或能创建 Pod)的人都能拿到明文。安全模型要求「密钥绝不进 etcd」时,应当用 Injector 或 CSI;用 VSO 则必须配合 etcd 静态加密与严格的 RBAC。
5. **Agent Injector 的 sidecar 会带来生命周期问题**。Pod 里多出一个容器之后,`kubectl exec` 进错容器、日志被 sidecar 淹没、Job 因为 sidecar 不退出而永远不完成,都是常见麻烦。VSO 用控制器集中同步,没有这些问题,官方文档也把 VSO 列为更适合多数 Kubernetes 场景的方式。
6. **`kubernetes_host` 必须填 Pod 内可达的地址**。写 `https://kubernetes.default.svc:443`,不要照抄集群外部的 apiserver 地址;自建 CA 或关闭了 issuer 校验的集群,还需要显式提供 `kubernetes_ca_cert`。
7. **`bound_service_account_namespaces` 是安全边界**。写成 `*` 意味着**任意命名空间**里同名的 ServiceAccount 都能拿到对应策略,等于把权限开放给整个集群;务必写死命名空间。
8. **KV v2 的路径有两套写法**。策略里写 `secret/data/app/*`,CLI 里写 `secret/app/config`(vault CLI 会自动补 `data`)。策略写错路径的表现是 `permission denied` 而不是 `path not found`,很容易误判成令牌问题。
9. **策略只做授权,没有拒绝规则**。与 RBAC 一样,Vault policy 是纯叠加的允许模型:一旦某条策略授予了权限,就无法用另一条策略收回,只能删掉授予它的那条。
10. **动态凭据有租期,应用必须能处理失效**。用 database secrets engine 生成的账号会在 TTL 到期后被注销,应用不能把它当作长期凭据;需要续约(lease renewal)或到期重新获取。这也是动态凭据最大的落地难点 —— 很多应用只会在启动时读一次配置。
11. **Vault 的许可与归属已经变化**。2023 年 8 月起 Vault 使用 BSL 1.1(不再是 MPL 2.0),2025 年 2 月 HashiCorp 被 IBM 完成收购,主版本进入 2.x。若 BSL 与合规要求冲突,社区分支 **OpenBao** 是 MPL 2.0 的替代选择。另外 HCP Vault Secrets(SaaS)已于 2026 年 7 月 1 日 EOL,自建 Vault 不受影响。
12. **不开审计日志,Vault 的价值少一半**。可审计是集中式密钥管理的核心收益,不启用 audit device 就没有任何取用记录。上线时应把 `vault audit enable file` 作为必做项,并把日志送到独立的收集端。

### 相关命令

- `secret` — Kubernetes原生Secret对象
- `serviceaccount` — Kubernetes认证方式的身份来源
- `rbac` — 与之配合的集群内权限控制
- `helm` — 部署Vault与VSO的主要方式
- `kubectl` — Kubernetes集群管理工具

### 参考链接

- [Vault 官方文档](https://developer.hashicorp.com/vault/docs)
- [在 Kubernetes 上部署 Vault](https://developer.hashicorp.com/vault/docs/deploy/kubernetes)
- [Vault Helm Chart](https://developer.hashicorp.com/vault/docs/deploy/kubernetes/helm)
- [Kubernetes 集成方式对比](https://developer.hashicorp.com/vault/docs/deploy/kubernetes/comparisons)
- [Vault Secrets Operator](https://developer.hashicorp.com/vault/docs/deploy/kubernetes/vso)
