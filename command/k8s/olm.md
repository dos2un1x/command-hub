olm
===

Operator Lifecycle Manager,在集群内安装、升级与治理Operator

## 补充说明

**OLM(Operator Lifecycle Manager)** 是 Operator Framework 的集群内组件,用一组自定义资源把「安装、升级、依赖解析、权限治理」这套 Operator 生命周期变成声明式的集群行为。用户不再需要手工 `kubectl apply` 一堆清单,而是声明「我要装某个包的某个通道」,由 OLM 去解析版本、创建资源、维护升级链。

**使用 OLM 前必须搞清楚现状:它现在分成两条线。**

```shell
OLM v0(仓库 operator-lifecycle-manager)
    经典形态,即通常所说的 OLM
    README 明确标注处于「维护模式」:不再新增功能、只处理导致集群级故障
    且无绕过方案的问题、其余积压 issue 会关闭、仅做紧急漏洞修复
    没有归档,也仍在打补丁版本(2026 年仍有 v0.46.x 发布)

OLM v1(仓库 operator-controller,含 catalogd)
    重写后的新一代,对外只暴露一个 cluster 级 API:ClusterExtension
    组件:Operator Controller(安装扩展)+ catalogd(解包并索引目录内容)
    在 OpenShift 4.17 为技术预览、4.18 起 GA;上游未见同等口径的 GA 公告
```

**两条线之间没有具体的迁移方案**(官方明确说明二者概念差异较大),而且 **v1 目前只覆盖 v0 的一部分内容**。在 OpenShift 上两者长期共存,各自管理自己的资源。

**最重要的一条实务结论:OLM 不是运行 Operator 的必要条件。** 用 kubebuilder 或 operator-sdk 生成的 Operator,本质就是「一组 CRD + 一个 Deployment」,用 `kubectl apply`、kustomize 或 Helm 装上去就能跑 —— 脚手架与 controller-runtime 的文档里都不涉及 OLM。OLM 解决的是**分发与治理**问题:目录化发现、订阅式安装、统一的升级审批、API 所有权仲裁。**只有在需要这些能力时才引入它**,否则你只是给自己的集群多装了一个需要维护的组件。

### 核心对象(v0)

| 对象 | API 版本 | 作用 |
| --- | --- | --- |
| ClusterServiceVersion | `operators.coreos.com/v1alpha1` | 某个 Operator **某个版本**的完整描述:部署方式、RBAC、拥有与依赖的 API、升级关系 |
| Subscription | `operators.coreos.com/v1alpha1` | 用户意图:「从某目录的某个包、某个通道安装」,并决定升级审批方式 |
| InstallPlan | `operators.coreos.com/v1alpha1` | 为完成安装/升级而计算出的资源清单,审批的载体 |
| CatalogSource | `operators.coreos.com/v1alpha1` | 目录来源,指向一个 index 镜像 |
| OperatorGroup | `operators.coreos.com/v1` | 命名空间内的多租户单元,决定 Operator 能 watch 哪些命名空间 |
| PackageManifest | `packages.operators.coreos.com/v1` | 目录内容的只读视图,**由聚合 API Server 提供,不是 CRD** |

OLM 自身由两个控制器组成:**OLM Operator** 负责按 CSV 的安装策略创建 Deployment、ServiceAccount、RBAC;**Catalog Operator** 负责解析 Subscription 与目录、生成 InstallPlan,并创建 CRD 与 CSV。

### 安装 OLM

```shell
# 方式一:用 operator-sdk(会创建 olm 与 operators 两个命名空间)
operator-sdk olm install --version <OLM版本>
operator-sdk olm status
operator-sdk olm uninstall

# 方式二:直接从发布页应用清单(版本号以发布页为准)
kubectl apply -f https://github.com/operator-framework/operator-lifecycle-manager/releases/download/<OLM版本>/crds.yaml
kubectl apply -f https://github.com/operator-framework/operator-lifecycle-manager/releases/download/<OLM版本>/olm.yaml

# 确认组件就绪
kubectl get pods -n olm
kubectl get csv -A
```

注意 **OpenShift 自 4.0 起默认自带 OLM**,不需要也不能再重复安装。

### 安装一个 Operator

```shell
apiVersion: v1
kind: Namespace
metadata:
  name: operators
---
apiVersion: operators.coreos.com/v1
kind: OperatorGroup
metadata:
  name: memcached-operator-group
  namespace: operators
spec:
  targetNamespaces:
  - operators                # Operator 只 watch 这个命名空间
---
apiVersion: operators.coreos.com/v1alpha1
kind: Subscription
metadata:
  name: memcached-operator
  namespace: operators
spec:
  name: memcached-operator   # 包名
  channel: alpha
  source: my-catalog         # CatalogSource 名称
  sourceNamespace: olm       # CatalogSource 所在命名空间
  installPlanApproval: Manual   # Manual 或 Automatic
```

```shell
kubectl apply -f operator.yaml

# 观察安装过程
kubectl get subscriptions -n operators
kubectl get installplans -n operators
kubectl get csv -n operators
kubectl get pods -n operators
```

`Manual` 审批时需要人工放行 InstallPlan:

```shell
kubectl get installplan -n operators
kubectl patch installplan <名称> -n operators \
  --type=merge -p '{"spec":{"approved":true}}'
```

### 目录与 bundle

OLM 从 **CatalogSource** 指向的 index 镜像里读取可安装内容。目录 → 包 → 通道 → CSV 的层级如下:

```shell
CatalogSource(索引镜像)
└── Package(包,如 memcached-operator)
    ├── Channel(通道,如 stable / alpha)   ← 通道的 head 指向最新 CSV
    └── CSV(某个具体版本)
```

`CatalogSource` 的刷新频率由 `updateStrategy` 控制:

```shell
spec:
  sourceType: grpc
  image: quay.io/example/my-index:v1.0.0
  updateStrategy:
    registryPoll:
      interval: 10m           # 多久去拉一次新目录
```

```shell
# 查看目录里的包与通道
kubectl get packagemanifests -n olm
kubectl get packagemanifest memcached-operator -n olm -o yaml
```

### 升级链

OLM **不比较版本号大小**,而是沿着 CSV 声明的后继关系走:

```shell
spec:
  version: 0.0.2
  replaces: memcached-operator.v0.0.1     # 我替换谁
  skips:                                    # 可以跳过的中间版本
  - memcached-operator.v0.0.1-beta
```

通道的「最新」指的是链条的头部(head),就像一个 Git 引用。因此**新版本漏写 `replaces` 会导致订阅永远停在旧版本**,而且不会报错 —— 这是自建目录时最常见的升级故障。

### API 所有权与依赖

CSV 里的 `customresourcedefinitions` 是 OLM 做冲突仲裁的依据:

```shell
customresourcedefinitions:
  owned:                                    # 我拥有并负责管理这些 API
  - name: memcacheds.cache.example.com
    version: v1alpha1
    kind: Memcached
  required:                                 # 我依赖别人提供的 API
  - name: certificates.cert-manager.io
    version: v1
    kind: Certificate
```

**一个 CRD 同一时刻只能被一个 Operator 拥有**,冲突时报 `cannot be managed by ... already exists` 一类的错误。这也是「卸载不干净导致重装失败」的常见原因。

### OLM v1 的不同之处

v1 把用户可见的 API 收敛成一个 **`ClusterExtension`**(集群级),安装位置、服务账号、来源都在一个对象里:

```shell
apiVersion: olm.operatorframework.io/v1
kind: ClusterExtension
metadata:
  name: argocd
spec:
  namespace: argocd                    # 装到哪个命名空间
  serviceAccount:
    name: argocd-installer
  source:
    sourceType: Catalog
    catalog:
      packageName: argocd-operator
      channels: ["stable"]
      version: ">=1.0.0"               # 也可写精确版本,或省略以跟随通道
```

与 v0 的关键差异:

```shell
作用域       v0 可命名空间级或集群级(取决于 OperatorGroup/Subscription)
             v1 的 ClusterExtension 是集群级

目录         v0 用 CatalogSource(grpc/index 镜像)
             v1 用 Catalog / ClusterCatalog,由 catalogd 组件解包与索引

升级         v0 靠 CSV 的 replaces 链
             v1 按 通道 / 版本号 / 版本范围 解析目标版本,支持自动更新
```

v1 早期的 `v1alpha1` 写法里字段名不同(`spec.packageName`、`spec.installNamespace`、`spec.channel`、`spec.version`),升级到 `v1` 时需要一并改写,照抄旧教程会直接报字段不存在。

### 注意

1. **命名空间里没有 OperatorGroup,CSV 的安装策略不会执行。** OLM 要求 CSV 必须是某个 OperatorGroup 的成员才会真正安装;加了一个 OperatorGroup 但没加另一个,或压根没建,表现都是「Subscription 建好了,但没有任何 Pod 起来」。这是 OLM 排障的第一顺位检查项。
2. **一个命名空间只能有一个 OperatorGroup。** 出现多个时,OLM 会在相关对象上报告 `TooManyOperatorGroups`,该命名空间内的订阅全部无法正常解析。
3. **OperatorGroup 的范围必须被 CSV 的 `installModes` 支持。** 例如 OperatorGroup 要求 watch 全部命名空间(`AllNamespaces`),而 CSV 只声明支持 `OwnNamespace`/`SingleNamespace`,安装会被拒绝,条件里给出 `UnsupportedOperatorGroup` 一类的理由。改 `installModes` 要同时确认 Operator 真的具备相应权限。
4. **升级链条靠 CSV 的 `replaces` 维系,漏写就永远升不上去。** 这不是警告而是静默失败:目录刷新正常、订阅状态看起来也正常,只是版本停在原处。发布新版本后务必核对目录里那条升级边是否存在。
5. **`installPlanApproval: Automatic` 会在你不知情时升级生产 Operator。** 新版本可能带来 CRD 变更与不可逆迁移,生产环境建议用 `Manual`,把 InstallPlan 的审批当作一次发布窗口。
6. **OLM 管理的资源不要手工改。** CSV 的安装策略会被 OLM 持续调和,手工改动它创建的 Deployment、ServiceAccount、RBAC 会被还原;要改就改 CSV 或换新版本。
7. **CRD 的 API 所有权是排他的。** 卸载不彻底、或在两个目录里发布了同 CRD 的两个 Operator,都会让后续安装因所有权冲突失败。安装前用 `kubectl get crd` 确认目标 CRD 的归属。
8. **卸载前先处理数据。** 删掉 Subscription、CSV 乃至命名空间后,CRD 与 CR 未必随之消失(避免误删数据),残留的 CRD 又会阻塞后续安装。**先确认 CR 是否需要保留并导出,再决定 CRD 的去留。**
9. **OLM v0 处于维护模式。** 不要期待新功能或非紧急缺陷的修复;新项目评估时应当考虑 v1,并接受它目前只覆盖 v0 部分能力的现实。
10. **v0 与 v1 不是替代关系,而是并存关系,且互不感知。** 同一个集群里两套都装着时,排查问题必须先确认对象属于哪一套 —— `Subscription`/`CatalogSource` 是 v0,`ClusterExtension`/`Catalog` 是 v1。
11. **OLM 自带一个聚合 API Server。** `packageserver` 组件通过 `APIService` 提供 `packages.operators.coreos.com`(PackageManifest),因此它**不是 CRD**,不能用管理 CRD 的方式去操它。它的证书或可用性出问题时,目录查询与 OperatorHub 界面会一起失效,排查方法与 `aggregated-apiserver` 页所述完全一致:

    ```shell
    kubectl get apiservices | grep packages
    kubectl get apiservice v1.packages.operators.coreos.com -o yaml
    ```

12. **目录刷新有延迟。** 推送新 bundle 到 index 后,OLM 要等 `registryPoll` 的间隔才会看到;刚发布的版本「查不到」往往只是还没轮询到。
13. **离线环境要提前规划。** index 镜像、bundle 镜像与 Operator 自身镜像都必须能被集群拉取,私有仓库还需要配置拉取凭据,否则安装会停在镜像拉取失败。
14. **删除命名空间会连带卸载其中的 Operator。** 由该命名空间内的 Subscription 安装的 Operator 会随命名空间一起消失,但 CRD 与 CR 的残留问题同样存在,清理顺序要预先想好。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `operator-sdk` — Operator 开发与打包工具
- `operator` — Operator 模式与控制器
- `crd` — 自定义资源定义
- `aggregated-apiserver` — 聚合 API Server
- `kubebuilder` — Operator 脚手架

### 参考链接

- [Operator Lifecycle Manager 官方文档](https://olm.operatorframework.io/)
- [OLM v0 仓库](https://github.com/operator-framework/operator-lifecycle-manager)
- [OLM v1(operator-controller)文档](https://operator-framework.github.io/operator-controller/)
- [Operator Framework 官网](https://operatorframework.io/)
- [OperatorHub.io](https://operatorhub.io/)
