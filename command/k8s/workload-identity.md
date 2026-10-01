workload-identity
===

云厂商工作负载身份,用OIDC联邦替代长期AccessKey为Pod换取云资源凭据

## 补充说明

**Workload Identity** 这个说法在不同云上有不同名字(AWS 叫 IRSA / EKS Pod Identity,GCP 叫 Workload Identity Federation for GKE,Azure 叫 Microsoft Entra Workload ID),但它们解决的是同一个问题:

```shell
把长期 AccessKey 写进 Secret  →  改为由云厂商信任集群的 OIDC 签发方
                                  运行时用投影的 ServiceAccount token 换取临时凭据
```

原理是三件事的组合:

```shell
1. 集群暴露一个 OIDC 发现端点
   /.well-known/openid-configuration   元数据
   /openid/v1/jwks                     公开签名公钥

2. Pod 拿到一个【投影的 ServiceAccount token】
   它是标准 OIDC JWT,aud 与云厂商约定好
   kubelet 会在过期前自动轮换该文件

3. 云厂商侧配置【信任策略】,只接受特定 sub 的 token
   sub 形如 system:serviceaccount:<namespace>:<serviceaccount>
   然后换取临时云凭据
```

这套机制的价值在于:**凭据不再落盘、不再需要人工轮换、泄露后有效期只有几分钟到几小时,并且可以通过 CloudTrail / Cloud Audit Logs 精确审计到是哪个 Pod。**

### 三种方案的共性

```shell
共同点
  - 身份载体都是 ServiceAccount,权限绑定到 SA 而非节点
  - 都需要在云侧建立对集群 OIDC 签发方的信任
  - 都支持「一个 SA 对应一个云身份」,也支持多对一
  - Pod 都需要通过投影卷拿到 token(由 webhook 或自行声明)

差异点
  - 信任的是【集群 OIDC】还是【云厂商自己的服务主体】
  - token 的 aud 取值不同
  - 是否需要修改 IAM 角色的信任策略(这是运维成本的分水岭)
```

### AWS IRSA

IRSA(IAM Roles for Service Accounts)是最早普及的方案,**依赖集群的 OIDC 签发方**。

先给集群建 IAM OIDC provider:

```shell
# 取出集群的 OIDC issuer
aws eks describe-cluster --name my-cluster \
  --query "cluster.identity.oidc.issuer" --output text
# https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE

# 在 IAM 里注册为 OIDC provider
eksctl utils associate-iam-oidc-provider --cluster my-cluster --approve
```

角色的信任策略必须写成这样,两个条件缺一不可:

```shell
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::123456789012:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE:aud": "sts.amazonaws.com",
          "oidc.eks.us-east-1.amazonaws.com/id/EXAMPLED539D4633E53DE1B71EXAMPLE:sub": "system:serviceaccount:default:my-service-account"
        }
      }
    }
  ]
}
```

注意条件键是 **`<issuer-host><path>:sub`** 形式 —— 把 issuer 去掉 `https://` 前缀后,整串拼接 `:sub` / `:aud`。这是最容易写错的地方。

然后给 ServiceAccount 打注解(命令行等价写法:`kubectl annotate serviceaccount -n default my-service-account eks.amazonaws.com/role-arn=<role-arn>`):

```shell
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-service-account
  namespace: default
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/my-role
```

**IRSA 的 OIDC 签名私钥每 7 天轮换一次**,EKS 会保留公钥直到过期,外部系统若自行缓存公钥需要自行刷新。

允许整个命名空间的所有 SA 使用时,把 `StringEquals` 换成 `StringLike`,`sub` 写成 `system:serviceaccount:default:*`。

### AWS EKS Pod Identity

EKS Pod Identity 是较新的方案,**不依赖 OIDC provider**,配置全部收敛在 EKS 与 IAM 两侧:

```shell
# 安装 agent add-on(每个集群一次;EKS Auto Mode 已内置)
aws eks create-addon --cluster-name my-cluster \
  --addon-name eks-pod-identity-agent

# 建立关联:集群 + 命名空间 + SA → IAM 角色
aws eks create-pod-identity-association \
  --cluster-name my-cluster \
  --namespace default \
  --service-account my-service-account \
  --role-arn arn:aws:iam::123456789012:role/my-role
```

角色的信任策略里只需一个服务主体,不需要为每个集群单独配置:

```shell
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "pods.eks.amazonaws.com" },
      "Action": ["sts:AssumeRole", "sts:TagSession"]
    }
  ]
}
```

选型建议:

```shell
IRSA             需要跨账号、需要精细的 sub 条件控制时更灵活
EKS Pod Identity 多集群复用同一角色、不想管理 OIDC provider 时更省事
                 两者可以在同一个集群里共存
```

### GCP:Workload Identity Federation for GKE

GKE 的方案是**建立自己的工作负载身份池**,池名固定为 `PROJECT_ID.svc.id.goog`:

```shell
# 建集群或更新集群时启用
gcloud container clusters update my-cluster \
  --workload-pool=PROJECT_ID.svc.id.goog

# 节点池启用元数据服务器
gcloud container node-pools update my-node-pool \
  --cluster=my-cluster --workload-metadata=GKE_METADATA
```

Kubernetes ServiceAccount 与 IAM Service Account 通过注解绑定:

```shell
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-ksa
  namespace: my-ns
  annotations:
    iam.gke.io/gcp-service-account: my-gsa@PROJECT_ID.iam.gserviceaccount.com
```

再授权 KSA 冒充 GSA:

```shell
gcloud iam service-accounts add-iam-policy-binding \
  my-gsa@PROJECT_ID.iam.gserviceaccount.com \
  --role=roles/iam.workloadIdentityUser \
  --member="serviceAccount:PROJECT_ID.svc.id.goog[my-ns/my-ksa]"
```

**成员格式必须精确**:

```shell
serviceAccount:PROJECT_ID.svc.id.goog[NAMESPACE/KSA_NAME]    授予冒充 IAM SA 的权限
serviceAccount:IAM_SA_NAME@IAM_SA_PROJECT.iam.gserviceaccount.com   给 IAM SA 本身绑角色

# 直接给 KSA 授予资源权限时用 principal:// 形式(用于 IAM allow policy)
principal://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/PROJECT_ID.svc.id.goog/subject/ns/NAMESPACE/sa/KSA_NAME
```

注意这里的两处坑:`serviceAccount:` 形式里方括号内是 `命名空间/SA名` 而不是反过来的;`principal://` 形式里第一个占位是**项目编号(数字)**而不是项目 ID。

### Azure:Microsoft Entra Workload ID

Azure 的方案自 2023 年起从「Pod 托管标识」(aad-pod-identity)迁移到 **Microsoft Entra Workload ID**。它通过 mutating webhook 注入投影 token 与环境变量:

```shell
apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-sa
  namespace: my-ns
  annotations:
    azure.workload.identity/client-id: <managed-identity-client-id>
    # 可选
    azure.workload.identity/tenant-id: <tenant-id>
    azure.workload.identity/service-account-token-expiration: "3600"

---
apiVersion: v1
kind: Pod
metadata:
  name: my-pod
  labels:
    azure.workload.identity/use: "true"     # 必需,否则 webhook 不会注入
spec:
  serviceAccountName: my-sa
  containers:
    - name: app
      image: my-app:1.0
```

三条关键约束:

```shell
1. Pod 必须带 azure.workload.identity/use: "true" 标签
   只有带这个标签的 Pod 才会被 webhook 注入

2. token 的受众是 api://AzureADTokenExchange
   联邦身份凭据(FIC)的 issuer 是集群 OIDC,subject 是
   system:serviceaccount:<namespace>:<serviceaccount-name>

3. 不要在代码里硬编码 token 路径
   从 AZURE_FEDERATED_TOKEN_FILE 环境变量读取
   挂载路径属于 webhook 的实现细节,可能变化
```

Azure Identity 客户端库(`DefaultAzureCredential` / `WorkloadIdentityCredential`)会自动读这个环境变量。**每次换取 Entra token 时都要重新读文件**,不要缓存内容 —— kubelet 会原地刷新它。

单机上限:`20` 个联邦身份凭据 / 托管标识;AKS Automatic 集群默认已预配好工作负载身份与 OIDC issuer,Standard 集群需要单独启用。

### 对比

```shell
              AWS IRSA        AWS Pod Identity    GCP WIF            Azure Workload ID
依赖 OIDC     是               否                  是                 是
换 token 的   STS             EKS Auth 服务       STS(联邦)         Entra ID
受众          sts.amazonaws.com  (由 agent 处理)   (按需指定)        api://AzureADTokenExchange
身份载体      SA 注解          API 关联            SA 注解            SA 注解 + Pod 标签
多集群复用    需改信任策略      直接复用角色        需改 IAM 绑定      需为每个集群建 FIC
```

### 注意

1. **改完集群后必须更新信任策略**。IRSA 与 GCP/Azure 的信任都绑定在**集群的 OIDC issuer URL** 上。**重建集群会生成新的 issuer**,旧的信任策略立即失效,Pod 换凭据时报 `InvalidIdentityToken` / `AADSTS70021` 一类错误。删集群重建前务必先导出并准备新的信任配置。
2. **`sub` 条件写错是最常见的坑**。IRSA 的条件键是完整的 `<issuer-host><path>:sub`,不是简单的 `sub`;写成 `sub` 或漏掉 `/id/xxx` 部分,角色会一直拒绝。GCP 是 `PROJECT_ID.svc.id.goog[命名空间/SA名]`,顺序反了就直接不生效。
3. **SA 的注解改完必须重启 Pod**。注解是在 Pod 准入时被 webhook(或 IRSA 的注入逻辑)读取的,已经运行的 Pod 不会重新读取。改完注解不滚动重启,新权限不会生效 —— 这一点三家的文档都明确写了。
4. **不要用节点实例角色兜底**。节点 IAM role 对节点上**所有** Pod 可见,一旦 Pod 能访问 IMDS,就等于拿到了节点角色,可能进一步访问同节点其他 Pod 的凭据。生产应**限制 IMDS 访问**(IMDSv2 + hop limit 设为 1),让 Pod 只能走工作负载身份。
5. **`hostNetwork: true` 的 Pod 始终能访问 IMDS**。这是官方明确记录的例外:即使启用了 IRSA/Azure Workload ID,hostNetwork 的 Pod 仍能访问实例元数据。对这类 Pod 需要额外的网络策略管控。
6. **EKS Pod Identity 与 IRSA 不是「谁替代谁」**。两者可以在同一集群共存,但一个 ServiceAccount 只能被一种方式关联。迁移期间混用容易排查困难。
7. **Azure 上改注解必须重启,且 Pod 标签不能漏**。漏掉 `azure.workload.identity/use: "true"` 的 Pod 不会被注入,应用会静默回退到 `DefaultAzureCredential` 的其他凭据链(可能命中节点托管标识),表现为「权限不对但也不报错」。
8. **EKS Pod Identity 的关联是最终一致的**。官方提示 API 调用后可能有数秒延迟,不要在关键高可用路径上动态创建关联 —— 应放在初始化流程里提前完成。
9. **代理环境要把 Pod Identity 地址加进 `no_proxy`**。EKS Pod Identity Agent 监听链路本地地址 `169.254.170.23`(IPv6 为 `[fd00:ec2::23]`),走代理会导致取凭据失败。
10. **`20` 个联邦身份凭据是 Azure 的硬上限**(每个托管标识)。大规模多集群场景要么复用,要么改用 identity bindings 之类的新机制;规划时不要按「每集群一个 FIC」无脑铺开。
11. **GCP 的 `principal://` 里第一个占位是项目编号**。写项目 ID 会静默匹配不上,而 IAM 绑定失败往往只体现在运行时 403,不体现在绑定命令本身。
12. **工作负载身份不能替代最小权限**。它把「怎么拿到凭据」变安全了,但角色/策略授予的权限范围仍然要靠人收敛。给一个 SA 绑 `AdministratorAccess` 的做法不会因为用了 IRSA 就变得安全。

### 相关命令

- `serviceaccount` — 身份的载体,注解挂在它上面
- `spiffe` — 跨云、跨运行时的身份规范,与云厂商方案互补
- `spire` — SPIFFE 的参考实现
- `secret` — 工作负载身份要取代的正是 Secret 里的静态密钥

### 参考链接

- [EKS:IAM roles for service accounts](https://docs.aws.amazon.com/eks/latest/userguide/iam-roles-for-service-accounts.html)
- [EKS:Pod Identities](https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html)
- [GKE:Workload Identity Federation](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/workload-identity)
- [AKS:Microsoft Entra Workload ID](https://learn.microsoft.com/en-us/azure/aks/workload-identity-overview)
- [Kubernetes:ServiceAccount Token Volume Projection](https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/)
