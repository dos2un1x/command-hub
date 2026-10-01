aggregated-apiserver
===

通过APIService把自建API服务器接入kube-apiserver的聚合层

## 补充说明

**聚合层(API Aggregation)** 是 Kubernetes 提供的第二条 API 扩展路径。它允许你**在集群里再跑一个独立的 API Server**,然后通过一个 `APIService` 对象把它注册到 `kube-apiserver` 上,之后用户访问:

```shell
/apis/<你的组>/<版本>/...
```

时,`kube-apiserver` 会把这个请求**反向代理**给扩展服务器。对用户与客户端而言,这条路径下的资源与内置资源完全等价 —— 同样的认证、同样的 RBAC、同样的 `kubectl get`、同样出现在 API 发现里。

关键点在于:**这个扩展服务器是由你完全掌控的真实服务**,不是 kube-apiserver 里的插件。你可以自己决定数据存哪里(集群 etcd、独立 etcd、关系数据库、外部系统),可以实现 CRD 根本无法表达的子资源与长连接协议(如 WebSocket 控制台)。

这套代理能力**自 Kubernetes 1.7 起就已经合并进 `kube-apiserver` 进程**(其实现来自 `kubernetes/kube-aggregator` 仓库),不再是一个需要单独部署的组件 —— 官方文档现在的表述是「聚合层与 kube-apiserver 进程内运行」,「kube-aggregator」这个名字指的是实现仓库,而不是一个独立的部署单元。也就是说,使用者只需创建 `APIService` 对象,代理能力本身就绪:

```shell
apiregistration.k8s.io/v1   →  APIService 的稳定版本(GA 自 1.10)
apiregistration.k8s.io/v1beta1 → 已于 Kubernetes 1.22 移除
```

关于当前定位需要说清楚:**聚合层仍是完全受支持、且没有退役计划的稳定机制**,官方文档依然把它与 CRD 并列为两种 API 扩展方式。但**官方给出的默认建议是优先用 CRD**:聚合层会引入一个必须自己运维、自己保证高可用、还需要处理证书与委托认证的服务,只有 CRD 表达不了的需求才值得付这个代价。

### 工作原理

```shell
kubectl get pods
    ↓
kube-apiserver 收到请求,查路由表(即集群中的 APIService 对象)
    ↓
命中某个已注册的 API 组 → 反向代理到对应的 Service
    ↓
扩展 API Server 处理请求(自选存储)→ 返回结果
    ↓
kube-apiserver 原样回给客户端
```

`kube-apiserver` 会持续对每个 `APIService` 做健康探测,并把结果写进它的 `status.conditions`:

```shell
kubectl get apiservices
# NAME                     SERVICE                      AVAILABLE   AGE
# v1.                      Local                        True        30d
# v1beta1.metrics.k8s.io   kube-system/metrics-server   True        30d
# v1alpha1.wardle.example.com   wardle/wardle    True        5m
```

`AVAILABLE` 为 `False` 时,**该 API 组的请求会失败**,而且客户端的 API 发现过程会一并受损。

### 与 CRD 的取舍

| 维度 | CRD | 聚合 API Server |
| --- | --- | --- |
| 是否需要写代码 | 不需要 | 需要(通常用 `k8s.io/apiserver` 库) |
| 需要额外运维的组件 | 无 | 有:Deployment、Service、证书、APIService |
| 数据类型 | 只能是 Kubernetes 风格的声明式对象 | 任意,可自定义 |
| 数据存储 | 集群 etcd | 自选(集群 etcd 的另一前缀、独立 etcd、外部库) |
| 自定义子资源 | 仅 `status` 与 `scale` | 任意,如 `console`、`exec`、`portforward` |
| 长连接 / 流式接口 | 不支持 | 支持(WebSocket、SPDY) |
| 自定义 REST 语义 | 不支持 | 完全自由 |
| 版本转换 | `None` 或 Webhook | 自己实现 |
| 故障影响面 | 基本只影响该类型的 CR | **可能拖累整个集群的 API 发现与依赖它的功能** |

**判断标准:先用 CRD 把需求写一遍,只有当能力确实不够时才转向聚合层。** 官方对二者的定位是一句话:**「CRD 更易用,聚合 API 更灵活」**。CRD 的优势在于零编程(控制器可以用任何语言写)、不需要额外运行一个服务、没有额外的故障点、修复随控制面升级一起到来;聚合 API 的灵活性则体现在自定义存储后端、任意校验逻辑、额外子资源、strategic merge patch、Protocol Buffers,以及不受自定义资源名必须是 DNS 子域名的限制。

典型的「确实不够,必须上聚合层」有三类:

1. 数据不在集群 etcd 里(要读写外部系统);
2. 需要 CRD 无法声明的子资源或非 CRUD 接口(HTTP 流、WebSocket、自定义动作);
3. 需要完全自定义的存储与一致性语义(例如跨对象的强事务)。

### APIService 清单

```shell
apiVersion: apiregistration.k8s.io/v1
kind: APIService
metadata:
  name: v1alpha1.wardle.example.com     # 必须是 <版本>.<组>
spec:
  group: wardle.example.com
  version: v1alpha1
  groupPriorityMinimum: 1000            # 组在 API 发现中的排序,数值越大越靠前
  versionPriority: 15                   # 同组内多版本时的排序
  insecureSkipTLSVerify: false          # 生产环境必须为 false
  caBundle: <base64 编码的 CA 证书>      # 用于校验扩展服务器的服务端证书
  service:
    name: wardle-server
    namespace: wardle
    port: 443
```

几条硬性要求:

- `metadata.name` 必须是 `<version>.<group>` 形式,写错会被拒绝。
- `service.namespace` / `name` / `port` 指向集群内的一个 Service,**扩展服务器必须通过 Service 暴露**,不能直接写 IP。
- `caBundle` 必须能校验该服务的服务端证书,证书的 SAN 里要包含服务的 DNS 名(`<service>.<namespace>.svc`)。
- `insecureSkipTLSVerify: true` 只应出现在实验环境,它等价于放弃对后端身份的校验。

### 扩展服务器必须满足的契约

自己写一个聚合 API Server,不是「随便起个 HTTP 服务」就行。它必须:

1. **实现 API 发现**:提供 `/apis`、`/apis/<group>`、`/apis/<group>/<version>` 三个发现端点,返回 `APIGroup` / `APIResourceList`。发现信息不完整会让整个客户端的资源列表受损。
2. **提供 OpenAPI 文档**:`kube-apiserver` 的 OpenAPI 聚合控制器会定期拉取并合并你的 spec,失败会周期性报错(常见现象是 `kubectl explain` 或 `kubectl api-resources` 变慢、报 503)。
3. **信任前置代理的身份头**:请求经过 `kube-apiserver` 转发后,用户身份由 `X-Remote-User`、`X-Remote-Group` 等请求头传递(即 front-proxy 模式)。扩展服务器必须读取 `kube-system/extension-apiserver-authentication` ConfigMap 来获取 `requestheader-client-ca-file` 并据此校验这些头,**绝不能直接信任任何客户端送来的这些头**。
4. **使用集群统一的认证与授权**:把 TokenReview / SubjectAccessReview 委托给 `kube-apiserver` 执行,从而复用集群的认证与 RBAC,而不是自己维护一套用户体系。
5. **保证高可用与低延迟**:每个 `kube-apiserver` 实例都会代理到你的服务,后端挂掉等于该 API 组整体不可用。官方给出的**唯一一条硬性指标**是:扩展 API Server 与 kube-apiserver 之间必须是低延迟网络,**API 发现请求必须在 5 秒内往返**,超时会被判定为不可用。

### 部署要点

```shell
# 1. 扩展服务器以 Deployment + Service 形式部署(通常在独立命名空间)
kubectl create namespace wardle

# 2. 让它能读取委托认证所需的 ConfigMap
kubectl create rolebinding wardle-auth-reader \
  --role=extension-apiserver-authentication-reader \
  --serviceaccount=wardle:wardle-server \
  -n kube-system

# 3. 让它能创建 TokenReview / SubjectAccessReview(委托鉴权)
kubectl create clusterrolebinding wardle-auth-delegator \
  --clusterrole=system:auth-delegator \
  --serviceaccount=wardle:wardle-server

# 4. 注册 API 组
kubectl apply -f apiservice.yaml
kubectl get apiservices v1alpha1.wardle.example.com
kubectl get --raw /apis/wardle.example.com/v1alpha1 | jq .

# 5. 验证发现与资源
kubectl api-versions | grep wardle
kubectl api-resources --api-group=wardle.example.com
kubectl get flunders.wardle.example.com
```

存储通常复用集群 etcd 的另一个键前缀(`/registry/<group>/...`),也可以接入独立的 etcd 或外部数据库 —— 这正是聚合层相对 CRD 最本质的自由度。

### 参考实现与脚手架

自己从头写一个扩展 API Server 的门槛不低,通常从官方参考实现起步:

```shell
k8s.io/apiserver           实现扩展 API Server 的核心库(通用 API Server 框架)
kubernetes/sample-apiserver  官方参考实现(即 wardle 示例)
```

`kubernetes/sample-apiserver` 是 `kubernetes/kubernetes` 的 staging 镜像之一,**随 Kubernetes 的发版流程持续维护**,是目前最可靠的起点。

社区还曾有一个脚手架项目 `apiserver-builder-alpha`,这里必须给出准确现状,因为它正是最容易踩的坑:

```shell
项目状态   仓库**并未正式归档**,但已休眠 —— 最后一次提交停在 2024 年 1 月
官方建议   该项目自己的 README 明确写道:除非你确实需要 API 聚合,
           否则推荐改用 kubebuilder(它用 CRD 构建 API,并解决了
           apiserver-builder 的诸多限制)
文档现状   kubernetes.io 的聚合层文档至今仍把 apiserver-builder
           列为「提供了扩展 API Server 与配套控制器的骨架」
```

也就是说:**官方文档在这里已经落后于项目的实际状态**。照着文档去找 apiserver-builder 的脚手架,拿到的是一个两年多没有维护的工具。需要动手实现时,优先以 `sample-apiserver` 为模板。

### 排查

```shell
# 看所有注册的 API 组及其可用性
kubectl get apiservices
kubectl get apiservices -o wide

# 看某个 APIService 的详细状态与失败原因
kubectl describe apiservice v1beta1.metrics.k8s.io

# 绕过发现缓存,直接看 API 组是否真的可达
kubectl get --raw /apis | jq -r '.groups[].name'
kubectl get --raw /apis/metrics.k8s.io/v1beta1

# 看代理链路里的报错(聚合失败通常在 kube-apiserver 日志中)
kubectl -n kube-system logs -l component=kube-apiserver --tail=100 | grep -i aggregat

# 用错误的 caBundle 复现 TLS 失败
kubectl get apiservice v1alpha1.wardle.example.com \
  -o jsonpath='{.spec.caBundle}' | base64 -d | openssl x509 -noout -subject -dates
```

发现缓存会让问题看起来「时有时无」:`kubectl` 会缓存 API 发现结果(默认约 6 小时,落在 `~/.kube/cache`),修复后仍可能看到旧报错,删掉缓存目录再试可排除干扰。

### 真实用例

- **metrics-server**:注册 `metrics.k8s.io`,数据来自各节点 kubelet 的实时统计,**根本不存在 etcd 里**,这正是 CRD 做不到的事,也是 `kubectl top` 与 HPA 依赖的接口。
- **KubeVirt**:虚拟机对象(`VirtualMachine` 等)本身是 CRD,但 `virt-api` 通过 `APIService` 注册了 `subresource.kubevirt.io` 组,用来提供 `console`、`vnc`、`portforward` 这类需要 WebSocket 长连接的交互式子资源。

这两个例子很好地说明了聚合层的适用边界:**当 API 的对象数据或交互形态超出了「声明式对象存 etcd」的模型时,才需要它。**

### 注意

1. **扩展服务器不可用会拖累整个客户端的 API 发现。** `kubectl` 会打印类似 `couldn't get resource list for metrics.k8s.io/v1beta1: the server is currently unable to handle the request` 的警告;依赖完整发现的工具(Helm、Operator、CI 流水线)可能直接失败。**APIService 的可用性与核心 API 一样重要,必须配置多副本、PDB 与就绪探针。**
2. **`caBundle` 与服务证书必须匹配且及时轮换。** 证书过期或被替换而 `caBundle` 未更新时,代理会报 TLS 校验失败,表现为 `ServiceUnavailable` 或 `x509: certificate signed by unknown authority`。`caBundle` 是**内嵌**在 APIService 里的,不会自动跟随 Secret 变化。
3. **`metadata.name` 必须是 `<version>.<group>`。** 写成 `wardle.example.com/v1alpha1` 或漏掉版本号都会创建失败。
4. **`kube-apiserver` 默认通过 Service 的 ClusterIP 访问扩展服务器。** 某些网络插件或宿主机网络场景下 kube-apiserver 无法访问 ClusterIP,需要开启 `--enable-aggregator-routing`,改为直接拨号到 Service 背后的 Pod IP。修改该参数需要重启所有 kube-apiserver。
5. **委托认证的 RBAC 少一条就起不来。** 漏掉 `extension-apiserver-authentication-reader` 的 RoleBinding,扩展服务器读不到 `extension-apiserver-authentication` ConfigMap,所有请求会以 `Unauthorized` 结束;漏掉 `system:auth-delegator`,则所有鉴权调用失败。
6. **`insecureSkipTLSVerify: true` 是生产事故的常见来源。** 它让 `kube-apiserver` 接受任何证书,等于把「后端是不是真的它」的判断放弃了。仅用于本地实验。
7. **不要手写 `X-Remote-User` 之类的头来伪造身份。** 这些头只有在被可信前置代理(即 kube-apiserver)签名后才有效,扩展服务器必须配置 `requestheader-client-ca-file` 去校验;若为了方便直接信任未校验的头,**任何人都能通过直接访问该服务伪造任意用户**。因此该服务绝不能通过 Ingress/LoadBalancer 暴露到集群外。
8. **删除 `APIService` 不会删除后端的数据。** 它只是把该 API 组从发现中摘掉,数据仍留在扩展服务器的存储里;反过来,后端存储被清空而 APIService 还在,用户会看到「API 存在但资源全空」。
9. **卸载后残留的 APIService 会持续报错。** 例如 KubeVirt 卸载不干净时,残留的 APIService 会让 `virtctl console` 返回 503,并让 OpenAPI 聚合控制器周期性重试。**卸载顺序应是:先删 APIService,再删扩展服务器。**
10. **聚合层不能替代 CRD 的生态能力。** 你自己实现的 API 组不会自动获得 CRD 那些配套能力(如 `kubectl explain` 的字段文档需要你提供 OpenAPI、`scale` 子资源要自己实现、服务端应用要自己处理字段归属)。省下的运维成本往往抵不过这些额外工作量。
11. **集群升级时要一并验证聚合服务器。** `k8s.io/apiserver` 库的接口在不同 Kubernetes 版本间会有调整,扩展服务器通常需要跟随集群版本重新编译与验证,这一步容易被漏掉。
12. **`APIService` 是集群级对象,权限很敏感。** 能创建 `APIService` 的人可以把任意 API 组挂到集群上,并让所有客户端的发现流量经过自己的服务,应视同 `cluster-admin` 级别的权限严格管控。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `crd` — 自定义资源定义(更常用的扩展方式)
- `kube-apiserver` — 集群 API 入口,聚合层宿主
- `metrics-server` — 最典型的聚合 API Server
- `operator` — Operator 模式与控制器
- `rbac` — 集群授权配置

### 参考链接

- [API 聚合层官方文档](https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/apiserver-aggregation/)
- [配置聚合层](https://kubernetes.io/docs/tasks/extend-kubernetes/configure-aggregation-layer/)
- [搭建扩展 API Server](https://kubernetes.io/docs/tasks/extend-kubernetes/setup-extension-api-server/)
- [自定义资源与聚合层对比](https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/custom-resources/)
