capsule
===

命名空间级的多租户框架,用 Tenant 把一组命名空间与配额、权限、策略绑定在一起

## 补充说明

**Capsule**(Project Capsule)是 CNCF Sandbox 项目,由 Clastix 创建并捐赠给 CNCF,采用 Apache-2.0 许可。它解决的是这样一个问题:多个团队或客户共用一个 Kubernetes 集群时,**如何在只给命名空间的前提下,让租户能自助创建命名空间、还能被配额与策略约束住**。

> **重要变更**:项目仓库已从 `clastix/capsule` 迁移到 **`projectcapsule/capsule`**,文档站点也迁到 `projectcapsule.dev`,Helm chart 仓库是 `projectcapsule.github.io/charts`。旧文章里指向 `clastix/capsule` 的安装命令会失效。相关组件(如 capsule-proxy)也一并搬到 `projectcapsule` 组织下。
>
> 当前最新版本为 **v0.14.6(2026-09-15)**。官方明确表示**只支持最新一个 minor 版本的 Kubernetes**(该版本 release notes 中给出的下限是 v1.36),旧版本 Kubernetes 的兼容性由厂商提供支持,升级前务必核对。

Capsule 的核心抽象只有一个:**Tenant**。一个 Tenant 对应若干命名空间,并携带这组命名空间的配额、限制、网络策略、节点选择器与所有者信息。

### 核心概念

```shell
Tenant          集群级 CRD,代表一个租户;短名 tnt
Tenant owner    租户管理员,可以是 User / Group / ServiceAccount
Namespace       归属某个 Tenant 的命名空间(通过标签关联)
capsule-proxy   可选组件,解决租户无法列取集群级资源的问题
```

### 安装

```shell
helm repo add projectcapsule https://projectcapsule.github.io/charts
helm repo update
helm install capsule projectcapsule/capsule \
  --namespace capsule-system --create-namespace

# 或用 OCI chart
helm install capsule oci://ghcr.io/projectcapsule/charts/capsule \
  --namespace capsule-system --create-namespace

# 查看
kubectl get pods -n capsule-system
kubectl get capsuleconfigurations
```

如果希望租户能执行 `kubectl get namespaces`、`kubectl get ingressclasses` 这类**集群级列表操作**,还需要额外部署 capsule-proxy —— 这是 Kubernetes API Server 本身的限制,Capsule 控制器无法绕过。

### Tenant 清单

```shell
apiVersion: capsule.clastix.io/v1beta2
kind: Tenant
metadata:
  name: solar
spec:
  owners:
    - name: alice
      kind: User
    - name: solar-users
      kind: Group
    - name: system:serviceaccount:tenant-system:robot
      kind: ServiceAccount
  namespaceOptions:
    quota: 3
  resourceQuotas:
    scope: Tenant
    items:
      - hard:
          requests.cpu: "20"
          requests.memory: 40Gi
          limits.cpu: "40"
          limits.memory: 80Gi
          pods: "50"
  limitRanges:
    items:
      - limits:
          - type: Container
            default:
              cpu: "500m"
              memory: 512Mi
            defaultRequest:
              cpu: "100m"
              memory: 128Mi
  nodeSelector:
    kubernetes.io/os: linux
  storageClasses:
    allowed:
      - standard
  ingressOptions:
    allowedHostnames:
      - "*.solar.example.com"
  imagePullPolicies:
    - IfNotPresent
```

`spec.owners` 是**唯一必填字段**。Tenant 是集群级资源(`scope: Cluster`),短名 `tnt`:

```shell
kubectl get tenants
kubectl get tnt
kubectl get tenant solar -o yaml
```

### Tenant 的 spec 字段

```shell
owners                 必填;租户所有者列表
namespaceOptions       命名空间数量上限(quota)与元数据规则
resourceQuotas         为该租户命名空间创建 ResourceQuota
limitRanges            为该租户命名空间创建 LimitRange
networkPolicies        网络策略(已弃用,官方建议改用 Tenant Replications)
nodeSelector           限定租户工作负载可调度的节点
storageClasses         允许/禁止使用的 StorageClass
ingressOptions         允许的域名、Ingress Class 等
imagePullPolicies      允许的 imagePullPolicy
priorityClasses        允许使用的 PriorityClass
containerRegistries    允许的镜像仓库前缀
additionalRoleBindings 注入到所有租户命名空间的额外 RoleBinding
serviceOptions         对 Service 的约束(如 externalIPs)
```

**注意这里没有 `podSecurity` 字段**。命名空间的安全级别要靠 Metadata Rules 给命名空间打上 `pod-security.kubernetes.io/enforce` 之类的标签来实现,不要以为可以像写 `resourceQuotas` 那样直接声明。

### 命名空间归属与权限

命名空间通过标签归属到租户:

```shell
apiVersion: v1
kind: Namespace
metadata:
  name: solar-dev
  labels:
    capsule.clastix.io/tenant: solar
```

标签的迁移值得留意:

```shell
capsule.clastix.io/tenant      现有标签,仍被识别
capsule.clastix.io/owner       所有者标签
projectcapsule.dev/tenant      长期替代标签(官方正在迁移)
```

租户所有者默认会在自己的命名空间里拿到两个 ClusterRole 的绑定:`admin` 与 Capsule 自建的 `capsule-namespace-deleter`。也就是说,**租户在自己的命名空间里近似于命名空间管理员**,这一点决定了后面「注意」里的多条风险。

### 配额与资源池

命名空间级的 `ResourceQuota` 只能约束单个命名空间,Capsule 额外提供了跨命名空间的机制:

```shell
GlobalResourceQuota     集群级配额,可被多个租户/命名空间共享
ResourcePool            资源池,按需分配给租户
ResourcePoolClaim       租户对资源池的申请
CustomQuota             自定义配额机制
QuantityLedger          配额账本,记录用量
```

Replications 相关的两个 CRD 用于跨租户/跨命名空间复制资源:

```shell
GlobalTenantResource    全局的租户资源复制
TenantResource          租户内的资源复制
```

### 注意

1. **Capsule 是命名空间级方案,命名空间不是安全边界**。租户的 Pod 仍然共享宿主集群的 kubelet、内核、conntrack 与节点资源。Capsule 约束的是 API 准入、配额与 RBAC,**不提供内核级隔离**;要更强的边界请考虑 vcluster 或独立集群。
2. **租户所有者拿到的是命名空间内的 `admin`**。这意味着租户可以在自己的命名空间里创建 RoleBinding 把权限转授他人,也可以创建任意 Pod —— 如果集群没有启用 Pod Security Admission,提权路径(privileged、hostPath、hostNetwork)是敞开的。**多租户下 PSA 必须开**,而 PSA 的 `enforce` 又不作用于 Deployment 等工作负载对象(只有 audit/warn 会),这一点尤其容易踩空。
3. **NodePort 是横向风险**。命名空间配额里不写 `services.nodeports` 的话,租户可以创建 NodePort Service 占用宿主节点的端口,既可能冲突也可能对外暴露服务。要在配额里限制,或配合准入策略禁用。
4. **hostPath 同样是横向风险**。租户 Pod 挂载宿主目录即可读写节点文件系统,跨租户逃逸的经典路径。必须用 PSA 的 `baseline`/`restricted` 级别或准入策略禁止。
5. **`networkPolicies` 字段已弃用**,官方指向 Tenant Replications。继续用它虽然可能仍生效,但属于过时写法,新部署应按当前文档实现,并在升级时确认行为是否变化。
6. **Tenant 里没有 `podSecurity` 字段**。想给租户的所有命名空间统一设置安全级别,要用 Metadata Rules 注入命名空间标签,而不是找一个不存在的 spec 字段。
7. **标签正在从 `capsule.clastix.io/tenant` 迁往 `projectcapsule.dev/tenant`**。混用两套标签最容易出现「命名空间建了但没归属到租户」,结果既没有配额也没有权限,或者反过来漏掉约束。
8. **配额生效后会强制显式声明 requests/limits**。Capsule 给租户创建的 ResourceQuota 一旦生效,未声明资源的 Pod 会被拒绝,必须同时提供 LimitRange 默认值,否则租户侧会大面积创建失败。
9. **命名空间级配额管不住租户总量**。`resourceQuotas` 是逐命名空间的,租户建了 3 个命名空间就可能用掉 3 倍资源;要控制租户整体用量必须用 ResourcePool / GlobalResourceQuota 这一层。
10. **租户默认无法列取集群级资源**,`kubectl get namespaces` 会返回权限错误 —— 这是 API Server 的限制而不是 bug,需要通过 capsule-proxy 解决。评估时要把它算进部署成本。
11. **Capsule 只支持最新的 Kubernetes minor 版本**。跳版本升级集群前先确认 Capsule 是否已发布对应版本,否则可能直接失去准入控制保护。
12. **Capsule 管不住 CRD 里的自定义资源**。租户在自己的命名空间里创建自定义资源是允许的,如果某个 CRD 的控制器会创建集群级资源或访问宿主路径,风险由该控制器承担,不在 Capsule 的模型内。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `namespace` — Capsule 的隔离单元,理解它的边界是前提
- `resource-quota` — 命名空间级配额,Capsule 会代租户创建
- `limitrange` — 容器默认与上下限,通常与配额成对出现
- `pod-security-admission` — 多租户下必须叠加的运行时约束
- `rbac` — 租户权限的实际落地方式
- `vcluster` — 虚拟集群方案,隔离更强但成本更高
- `multi-tenancy` — 多租户隔离的整体取舍

### 参考链接

- [Capsule 官方文档](https://projectcapsule.dev/docs/)
- [Tenant 概念与教程](https://projectcapsule.dev/docs/tenants/)
- [已知元数据标签与注解](https://projectcapsule.dev/docs/operating/concepts/known-metadata/)
- [Capsule GitHub 仓库(projectcapsule/capsule)](https://github.com/projectcapsule/capsule)
- [Capsule Helm Chart(Artifact Hub)](https://artifacthub.io/packages/helm/projectcapsule/capsule)
