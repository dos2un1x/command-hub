crd
===

Kubernetes自定义资源定义,扩展API而不改动控制平面代码

## 补充说明

**CustomResourceDefinition(CRD)** 让用户在不编写任何 API Server 代码的前提下,向集群注册一种全新的资源类型。注册完成后,`kubectl get` / `kubectl apply` / RBAC / 准入控制 / `kubectl explain` 全部对它是原生支持的,用起来和内置的 Pod、Deployment 没有区别。

如果每扩展一种 API 都要重新编译并重启 `kube-apiserver`,「加一个数据库类型」的成本会高到无法接受。CRD 把「定义类型」这件事本身变成了一个普通的 API 对象:**CRD 的实例是 CR(Custom Resource),而 CRD 自己是描述 CR 的元数据对象** —— 例如定义类型的 `crontabs.stable.example.com` 是集群级对象,而它描述的 `my-cron` 是命名空间级的实例。

当前稳定版本为 `apiextensions.k8s.io/v1`。**v1beta1 自 Kubernetes 1.22 起被彻底移除**,网上大量老教程里的 `apiextensions.k8s.io/v1beta1` 清单直接 apply 会报 `no matches for kind`,必须迁移到 v1 写法(最明显的变化是:必须为每个版本提供 schema,`preserveUnknownFields` 只允许为 `false`)。

一个重要提醒:**CRD 本身不会带来任何行为**。它只告诉 API Server「有这么一种类型、长这个样子、怎么校验」。要让集群对它的创建做出反应,必须另外部署一个**控制器**,两者合起来才是 Operator。只 apply CRD 而不部署控制器,是自建扩展时最常见的「装好了却毫无反应」的原因。

### 语法

```shell
kubectl apply -f <crd>.yaml                 # 创建/更新 CRD
kubectl get crd                             # 列出所有 CRD
kubectl get crd <plural>.<group> -o yaml    # 查看某个 CRD 定义
kubectl describe crd <plural>.<group>       # 查看详情(含版本、子资源、条件)
kubectl delete crd <plural>.<group>         # 删除 CRD(会连带删除所有 CR)
kubectl get <资源名> [-n <命名空间>]          # 像内置资源一样操作 CR
kubectl explain <资源名>                     # 查看 CR 的字段文档
kubectl api-resources | grep <group>        # 确认资源是否已注册
```

### 最小清单

```shell
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: crontabs.stable.example.com     # 必须写成 <plural>.<group>
spec:
  group: stable.example.com             # API 组名,建议用域名反写
  scope: Namespaced                     # Namespaced 或 Cluster,创建后不可改
  names:
    plural: crontabs                    # 资源名,必须与 metadata.name 的前缀一致
    singular: crontab
    kind: CronTab                       # 首字母大写,CR 里的 kind
    shortNames: ["ct"]                  # kubectl get ct 也可用
    categories: ["all"]                 # kubectl get all 时一并列出
  versions:
  - name: v1
    served: true                        # 是否通过该版本对外提供
    storage: true                       # 是否为存储版本,有且只能有一个为 true
    subresources:
      status: {}                        # 开启 /status 子资源
    additionalPrinterColumns:           # 自定义 kubectl get 的输出列
    - name: Schedule
      type: string
      jsonPath: .spec.schedule
    schema:
      openAPIV3Schema:
        type: object
        properties:
          spec:
            type: object
            properties:
              cronSpec:
                type: string
              image:
                type: string
              replicas:
                type: integer
            required: ["cronSpec", "image"]
```

### 关键字段说明

| 字段 | 说明 |
| --- | --- |
| `metadata.name` | 必须是 `<plural>.<group>`,写错会报 `metadata.name: Invalid value` |
| `spec.scope` | `Namespaced` / `Cluster`,**创建后不可修改** |
| `spec.group` | API 组,决定 CR 的 `apiVersion` 前段 |
| `spec.names.kind` | CR 里的 `kind`,**大小写敏感**,改名等于换类型 |
| `spec.versions[].served` | 该版本是否对外提供(能否被 `kubectl` 访问) |
| `spec.versions[].storage` | 该版本是否为写入 etcd 的存储版本,全局唯一 |
| `spec.versions[].subresources` | 声明 `status` / `scale` 子资源 |
| `spec.preserveUnknownFields` | **v1 中只允许 `false`**,未知字段会被剪掉 |

### 校验:OpenAPI Schema 与结构化解构

v1 要求每个版本都提供 `openAPIV3Schema`,并且必须是**结构化 schema(structural schema)**。官方给出的判定条件是:

- 根节点、每个 object 节点的每个字段、每个数组元素都必须显式声明非空的 `type` —— 例外是带 `x-kubernetes-int-or-string: true` 或 `x-kubernetes-preserve-unknown-fields: true` 的节点;
- 出现在 `allOf` / `anyOf` / `oneOf` / `not` 里的字段,必须在这些关键字**之外**也声明一遍;
- 不得在 `allOf` / `anyOf` / `oneOf` / `not` 内部设置 `description`、`type`、`default`、`additionalProperties`、`nullable`;
- 如果声明了 `metadata`,只允许对 `metadata.name` 与 `metadata.generateName` 做限制。

不满足时,CRD 会带上 **`NonStructural`** 条件,该 API 组不会对外服务。满足之后,API Server 能在写入前直接校验,报错清晰,并且能安全地做字段合并(server-side apply 与 strategic merge 都依赖它)。

```shell
# 整数或字符串都接受的「多态」字段
port:
  x-kubernetes-int-or-string: true

# 列表按 name 字段合并,而不是整体替换
containers:
  type: array
  x-kubernetes-list-type: map
  x-kubernetes-list-map-keys: ["name"]
```

`x-kubernetes-preserve-unknown-fields: true` 用于对某棵子树**关闭剪裁(pruning)**:没有在 schema 里声明的字段会被原样保留。注意它是逐层生效的 —— 这棵子树里**已经被显式声明出来的属性,剪裁会重新启用**。用它换灵活性,代价是这部分数据不再受 schema 约束,也不会被 server-side apply 跟踪字段归属。

### 多版本与转换

一个 CRD 可以同时提供多个版本,常见做法是「老的稳定版 + 新的 beta 版」并行:

```shell
versions:
- {name: v1alpha1, served: true, storage: false}
- {name: v1, served: true, storage: true}       # 只有一个能是存储版本
```

对外提供多个版本时,**必须告诉 API Server 如何在版本之间转换**,有两种策略:

```shell
conversion:
  strategy: None         # 各版本字段结构相同,仅原样搬字段
  # strategy: Webhook    # 结构不同,调用你的转换服务
  webhook:
    conversionReviewVersions: ["v1"]     # v1 中必填
    clientConfig:
      # url 与 service 二选一,且只能有一个
      service:
        namespace: default
        name: my-conversion-webhook
        path: /convert        # 可省略,默认 "/"
        port: 443             # 可省略,默认 443
      caBundle: <base64 编码的 CA 证书>
```

几条硬性约束:

- `strategy: None` 只适用于**各版本字段结构相同**的情况(它只是把 `apiVersion` 改写一下)。官方明确警告:如果同一份数据在不同版本里落在不同字段上,用 `None` 不会有好结果。
- `clientConfig` 里 `url` 与 `service` **必须二选一**;`url` 必须是 https,且不允许带用户名密码、查询参数与片段。**用 Service 时必须暴露 443 端口**(服务器本身可以监听任意端口,但 Service 要把它映射到 443),官方特别提示:Service 用了别的端口,通信可能失败。
- `conversionReviewVersions` 在 v1 中是必填。API Server 只发送它自己支持、且出现在该列表里的版本;**如果列表里没有一个版本是 API Server 认识的,CRD 直接创建不了**;如果是已存在的 webhook 配置后来不再兼容,则调用直接失败。
- webhook **只能改 `labels` 与 `annotations`**,改动 `name`、`uid`、`namespace` 会被拒绝并让整个请求失败。

转换 webhook 有一个**必须提前知道的严重风险**:当某个 CRD 提供多个版本且使用 `Webhook` 转换时,API Server 处理**任何**该类型的请求都要先调用 webhook。官方原话是「转换失败会中断对自定义资源的读写访问,包括更新与删除的能力」。webhook 挂了,这个资源类型就整体不可用 —— 包括 `kubectl get` 和控制器自己的 watch。

因此官方要求:**在把新版本加进 CRD 之前,先确保转换服务已经部署并处于运行状态**。社区里常用的稳妥顺序是先以单版本上线,再补第二版本(这是实践建议,不是文档原文):

```shell
1. 先创建只含一个版本(且为 storage 版本)的 CRD → 此阶段不需要 webhook
2. 部署 webhook 服务并确认就绪
3. 再更新 CRD,加入第二个版本与 conversion.webhook 配置
```

**移除一个版本时要注意:旧版本不能直接从 `spec.versions` 里删掉**,只要它还在 `status.storedVersions` 里,删除就会被拒绝。必须先确认所有数据都已用新版本重写,再把 `storedVersions` 更新掉:

```shell
kubectl get crd crontabs.stable.example.com -o jsonpath='{.status.storedVersions}'

# 数据迁移完成后,把 storedVersions 改为只剩存储版本
kubectl patch customresourcedefinitions crontabs.stable.example.com \
  --subresource='status' --type='merge' -p '{"status":{"storedVersions":["v1"]}}'
```

更规范的做法是使用 `StorageVersionMigration`(`storagemigration.k8s.io/v1`)来驱动迁移,而不是手工改 `storedVersions`。

### 子资源:status 与 scale

**status 子资源**开启后:

- 主端点 `/apis/<group>/<version>/namespaces/<ns>/<plural>` 的写入**会忽略 `status` 字段**;
- 更新状态必须走 `/apis/.../<plural>/<name>/status`;
- 好处是「用户改 spec」与「控制器写 status」互不覆盖,不会互相触发 `the object has been modified` 冲突。

控制器必须显式使用 status 子资源写回,否则状态更新会被静默丢弃 —— 这是「CR 的 status 永远不更新」的头号原因。

**scale 子资源**开启后,该 CR 可以像 Deployment 一样被 `kubectl scale` 和 HPA 操作:

```shell
subresources:
  status: {}
  scale:
    specReplicasPath: .spec.replicas              # 从 CR 的哪个路径读期望副本数
    statusReplicasPath: .status.replicas          # 从哪个路径读实际副本数
    labelSelectorPath: .status.selector           # 指向一个字符串字段,内容为序列化后的标签选择器
```

三条路径的具体语义(官方定义):

| 路径 | 是否必填 | 必须位于 | 缺失时的行为 |
| --- | --- | --- | --- |
| `specReplicasPath` | 必填 | `.spec` 下,点号记法 | `/scale` 的 GET 直接返回错误 |
| `statusReplicasPath` | 必填 | `.status` 下 | `status.replicas` 默认为 0 |
| `labelSelectorPath` | 可选 | `.status` 或 `.spec` 下 | 默认为空字符串 |

**`labelSelectorPath` 虽是可选项,但官方明确说明:必须设置它才能与 HPA、VPA 配合工作。** 它指向的字段要存放序列化后的标签选择器字符串,少了它,自动扩缩容无法判断该 CR 管理着哪些 Pod。

开启 `scale` 后相关端点会自动出现,`kubectl scale --replicas=5 crontabs/xxx` 与 HPA 都能直接作用于该 CR;官方还提到可以用 PodDisruptionBudget 保护启用了 scale 子资源的自定义资源。

### 常用操作

```shell
# 创建并确认
kubectl apply -f crontab-crd.yaml
kubectl get crd crontabs.stable.example.com
kubectl wait --for condition=established --timeout=60s \
  crd/crontabs.stable.example.com

# 操作自定义资源
kubectl apply -f my-crontab.yaml
kubectl get crontabs
kubectl get ct                                  # 用 shortNames
kubectl get crontabs -o wide
kubectl describe crontab my-new-cron-object
kubectl delete crontab my-new-cron-object

# 观察 status(需开启 status 子资源)
kubectl get crontab my-new-cron-object \
  -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}'

# 排查:资源是否存在、API 组是否注册、字段是否合法
kubectl api-resources --api-group=stable.example.com
kubectl api-versions | grep stable.example.com

# 见「注意」第 2 条:清单过大时改用服务端应用
kubectl apply --server-side --force-conflicts -f crontab-crd.yaml
```

### CRD 还是聚合 API Server

| 维度 | CRD | 聚合 API Server |
| --- | --- | --- |
| 是否需要写代码 | 不需要 | 需要(Go,实现 REST storage) |
| 部署形态 | 只是一个对象 | 额外的 Pod + Service + APIService |
| 存储 | 存在集群 etcd | 自选(etcd / 外部库) |
| 自定义子资源、长连接 | 不支持 | 完全自由 |
| 默认转换能力 | None / Webhook | 自己实现 |
| 可用性影响 | 几乎无 | 自身挂了会拖累整组 API 发现 |
| 适用 | 99% 的场景 | 需要特殊存储、特殊语义时 |

**结论很明确:能用 CRD 就用 CRD。** 只有当你需要把数据存到集群之外、需要自定义 REST 子资源或长连接协议(如 exec 风格的接口)时,才值得考虑聚合 API Server。

### 注意

1. **只有少数几个字段永久不可变,但踩中就得重建。** 不可改的是 `spec.group`、`spec.names.plural`(资源名与它绑定)、`spec.scope` 与 `spec.names.kind`(影响存储与 API 路径)。**可以改的是 `spec.versions`(含各版本的 schema)、`spec.conversion`、`spec.names.shortNames`、`spec.names.categories`** —— 所以「加个字段」并不需要重建。真正逼你重建的只有组名、kind、作用域这类命名问题,而重建意味着 `kubectl delete crd` 后重来,且删除会带走该类型的所有 CR。设计阶段务必想清楚命名。
2. **`kubectl apply` 可能失败在 262144 字节的注解上限上。** 客户端 apply 会把整份清单写进 `kubectl.kubernetes.io/last-applied-configuration` 注解,而 API Server 对**单个对象注解总量**的校验上限是 262144 字节(256 KiB,对应 apimachinery 中的 `TotalAnnotationSizeLimitB`),超限报 `metadata.annotations: Too long: must have at most 262144 bytes`。CRD 的 schema 动辄几百 KB,很容易撞上。解法是改用**服务端应用**(Server-Side Apply,自 1.22 稳定):它不再依赖那个注解,而是按字段归属来跟踪变更。

   ```shell
   kubectl apply --server-side -f crontab-crd.yaml
   ```

   从客户端 apply 切到服务端 apply 时,已有对象的字段归属会冲突,通常还需补一个 `--force-conflicts`。
3. **删除 CRD = 删除它的全部 CR,且不可撤销。** 删除 CRD 时 API Server 会清理该类型的所有自定义资源,数据没有回收站。生产环境删除前应先导出:`kubectl get crontabs -A -o yaml > backup.yaml`。
4. **CRD 上的 finalizer 会让它卡在删除中。** 删除 CRD 时会给它加上 `customresourcecleanup.apiextensions.k8s.io` finalizer 用于清理 CR;若清理过程异常,CRD 会一直处于 `Terminating`。同理,CR 自身若有 finalizer 且控制器不摘除,也会永远删不掉。
5. **`preserveUnknownFields` 在 v1 中只能是 `false`。** 老清单里的 `spec.preserveUnknownFields: true` 或版本级的 `preserveUnknownFields: true` 都会导致创建失败,需要改用 `x-kubernetes-preserve-unknown-fields`。
6. **schema 不合法时整个 CRD 不生效。** `kubectl apply` 返回成功后,CRD 仍需通过校验才会进入 `Established` 状态。当 `NonStructural`、`NamesAccepted: False` 这类条件出现时,该 API 组不会对外服务,而客户端拿到的往往只是含糊的 `could not find the requested resource`。
7. **开启 status 子资源后,主端点写 status 会被静默忽略。** 控制器若用普通 `Update` 写整个对象,status 改动直接消失,且不会有任何报错,排查时极易误判为「控制器没跑」。官方对此的规定很明确:对主端点的 PUT/POST/PATCH **一律忽略 status 段落**,而 `/status` 端点则只校验、只接受 status 段落。
8. **`scale` 子资源的路径要求严格,而漏配的那一项不会报错。** `specReplicasPath` 必须在 `.spec` 下、`statusReplicasPath` 必须在 `.status` 下,只支持点号记法,写错会让 CRD 创建失败;但**可选的 `labelSelectorPath` 漏配不报错,只会让 HPA/VPA 悄悄失效** —— 这类「不报错的错」最难查。
9. **转换 webhook 不可用会让整个资源类型瘫痪。** 它影响读、写、watch 全部请求,而不只是升级路径。上线多版本 CRD 时,务必**先让转换服务就绪,再把它接进 CRD**,并给 webhook 配置足够的副本与 PDB。
10. **CRD 不是海量数据的存储。** 官方的说法是:自定义资源「和 ConfigMap 一样消耗存储空间,创建过多自定义资源可能压垮 API Server 的存储」;并把「每个对象超过几 kB、对象数量上千」以及「需要每秒几十次的持续高带宽访问」明确列为**你的 API 可能不该是声明式**的信号。`kubectl get` 会读出整个对象,把日志、大 JSON、二进制内容塞进 CR 会迅速拖垮集群,CR 里只应保留引用。
11. **CRD 的变更不会触发控制器重建。** 更新 CRD(比如新增字段)后,已经在运行的 Operator 不会自动感知,需要它自己重新 list/watch 或滚动重启。
12. **`categories: ["all"]` 会让 `kubectl get all` 输出暴涨。** 它把该 CR 混进最常用的总览命令里,给监控或脚本的解析带来噪音,非必要不要加。
13. **RBAC 需要同时授权 CRD 与 CR。** 只授予 CR 的权限时,`kubectl apply` 一个 CRD 仍然会被拒绝;而授予了 CRD 的写权限,等于可以把任意类型注册进集群,应严格限制。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `operator` — Operator 模式与控制器
- `controller-runtime` — 控制器核心库
- `kubebuilder` — Operator 脚手架
- `aggregated-apiserver` — 聚合 API Server
- `rbac` — 集群授权配置

### 参考链接

- [自定义资源官方文档](https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/custom-resources/)
- [使用 CustomResourceDefinition 扩展 API](https://kubernetes.io/docs/tasks/extend-kubernetes/custom-resources/custom-resource-definitions/)
- [API 扩展方式对比](https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/apiserver-aggregation/)
- [CustomResourceDefinition API 参考](https://kubernetes.io/docs/reference/kubernetes-api/extend-resources/custom-resource-definition-v1/)
- [CRD 的版本与转换](https://kubernetes.io/docs/tasks/extend-kubernetes/custom-resources/custom-resource-definition-versioning/)
- [服务端应用(Server-Side Apply)参考](https://kubernetes.io/docs/reference/using-api/server-side-apply/)
