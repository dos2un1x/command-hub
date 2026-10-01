gateway-api
===

Kubernetes新一代七层路由API标准,Ingress的官方继任者

## 补充说明

**Gateway API** 是 Kubernetes SIG-Network 主导的七层路由标准,目标是取代 Ingress。它是 Ingress 的**继任者**,但两者不是同一层面的东西 —— 这一点必须先说清楚:

- **Ingress 是一套 API 加一个「约定俗成」的注解体系**。标准本身只覆盖最基础的 host/path 路由,稍微复杂一点的需求(重写、超时、灰度、鉴权)全靠各家 Controller 自己发明的注解。注解不属于 API,换个 Controller 就全部失效。
- **Gateway API 是一套完整的、可扩展的 API 标准**。资源有明确的角色划分,高级能力通过标准字段表达,不同实现之间行为一致。

Gateway API 由四个核心角色构成,这是它和 Ingress 最大的设计差别:

```shell
GatewayClass    集群级,声明由哪个实现(控制器)来接管,类比 StorageClass
Gateway         声明一个入口:监听哪些端口、什么协议、用哪张证书
HTTPRoute       路由规则:按域名、路径、Header 把请求分发到 Service
ReferenceGrant  跨命名空间引用的授权凭证
```

角色分工是刻意设计的:`GatewayClass` 由集群管理员维护,`Gateway` 由负责入口的运维团队维护,`HTTPRoute` 由业务团队在自己的命名空间里维护。Ingress 时代「所有人改同一个 Ingress + 一堆注解」的混乱因此得到缓解。

**Gateway API 本身只是一组 CRD,不含任何实现**。装上 CRD 之后集群里只是多了几个「空壳」资源类型,创建了 `Gateway` 也没人会去执行。必须再装一个实现了这些 API 的控制器:

```shell
Envoy Gateway     envoyproxy.io,官方参考实现,GatewayClass 名 eg
Istio             istio.io,自身就有 Gateway API 支持
Contour           projectcontour.io,提供 Gateway Provisioner
Traefik           traefik.io
NGINX Gateway Fabric   nginx.org
Kong              konghq.com
APISIX            apisix.apache.org
Higress           higress.io,基于 Envoy 与 Istio
Cilium            cilium.io,基于 eBPF
```

### 安装 CRD

CRD 有 standard 与 experimental 两个通道,按需选择:

```shell
# 标准通道:只含已 GA 或 Beta 的资源
kubectl apply --server-side -f \
  https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.6.1/standard-install.yaml

# 实验通道:额外包含 TCPRoute、TLSRoute、UDPRoute
kubectl apply --server-side -f \
  https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.6.1/experimental-install.yaml

# 验证
kubectl get crd | grep gateway.networking.k8s.io
```

**注意 `--server-side` 不是可选项,而是强烈建议的做法**。Gateway API 的 CRD 描述体积很大,客户端 apply 会把它塞进 `kubectl.kubernetes.io/last-applied-configuration` 注解,而注解上限是 256 KiB,直接报 `metadata.annotations: Too long`。服务端 apply 把状态记录在 `managedFields` 里,绕开了这个限制。

删除 CRD:

```shell
kubectl delete -f \
  https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.6.1/standard-install.yaml
```

这会删掉集群里所有 Gateway API 资源,控制器也随之失去依赖,不要在有业务运行时执行。

### GatewayClass

安装好实现之后,通常会由控制器自动创建一个 GatewayClass:

```shell
kubectl get gatewayclass

NAME       CONTROLLER                      ACCEPTED   AGE
eg         gateway.envoyproxy.io/gatewayclass-controller   True   5m
istio      istio.io/gateway-controller     True       5m
contour    projectcontour.io/gateway-controller   True   5m
```

`CONTROLLER` 字段必须与实现声明的 `controllerName` 完全一致,控制器才会认领这个 GatewayClass。自己手写 GatewayClass 时最容易错的就是这一项。

### Gateway

`Gateway` 声明入口本身:监听哪些端口、什么协议、用哪张证书。

```shell
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: eg
  namespace: default
spec:
  gatewayClassName: eg
  listeners:
    - name: http
      protocol: HTTP
      port: 80
      allowedRoutes:
        namespaces:
          from: Same          # 只允许本命名空间的 HTTPRoute 挂上来
    - name: https
      protocol: HTTPS
      port: 443
      tls:
        mode: Terminate
        certificateRefs:
          - kind: Secret
            name: example-tls
      allowedRoutes:
        namespaces:
          from: All           # 允许所有命名空间的 HTTPRoute 挂上来
```

`allowedRoutes` 体现了 Gateway API 的跨命名空间设计:一个共享的入口可以只对特定命名空间开放,不需要像 Ingress 那样把规则和证书都塞在同一个空间里。

### HTTPRoute

最常见的路由资源。按域名与路径分发:

```shell
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: web-route
  namespace: default
spec:
  parentRefs:
    - name: eg
      namespace: default
  hostnames:
    - "www.example.com"
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api
      backendRefs:
        - name: api-svc
          port: 8080
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: frontend-svc
          port: 80
```

按权重做灰度,这是 Ingress 完全做不到、必须靠注解或额外 CRD 才能实现的能力:

```shell
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: canary-route
  namespace: default
spec:
  parentRefs:
    - name: eg
  hostnames:
    - "app.example.com"
  rules:
    - backendRefs:
        - name: app-v1
          port: 80
          weight: 90
        - name: app-v2
          port: 80
          weight: 10
```

按 Header 匹配,常用于内部测试:

```shell
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: header-route
  namespace: default
spec:
  parentRefs:
    - name: eg
  rules:
    - matches:
        - headers:
            - name: X-Canary
              value: "true"
      backendRefs:
        - name: app-v2
          port: 80
    - backendRefs:
        - name: app-v1
          port: 80
```

### ReferenceGrant

跨命名空间引用后端或证书时,必须由**被引用资源的所在命名空间**显式授权:

```shell
apiVersion: gateway.networking.k8s.io/v1beta1
kind: ReferenceGrant
metadata:
  name: allow-web-to-api
  namespace: api-namespace        # 被引用方所在的命名空间
spec:
  from:
    - group: gateway.networking.k8s.io
      kind: HTTPRoute
      namespace: default          # 谁可以来引用
  to:
    - group: ""
      kind: Service               # 允许引用的资源类型
```

没有这个授权,跨命名空间的路由会被控制器拒绝,并且通常只在 `HTTPRoute` 的 `status.parents[].conditions` 里给出一条 `ResolvedRefs=False`。

### 排障

```shell
# GatewayClass 是否被实现接受
kubectl get gatewayclass
kubectl describe gatewayclass eg

# Gateway 是否拿到了地址、监听器是否全部 Programmed
kubectl get gateway -A
kubectl describe gateway eg

# HTTPRoute 是否被 Gateway 接受
kubectl get httproute -A
kubectl describe httproute web-route

# 精确查看挂载状态与条件
kubectl get httproute web-route -o jsonpath='{.status.parents}' | jq

# 用标准字段而非注解来诊断
kubectl get gateway eg -o jsonpath='{.status.listeners[*].conditions}'
```

`status.parents[].conditions` 里的 `Accepted` 与 `ResolvedRefs` 是最关键的两个条件:`Accepted=False` 说明路由没被入口接受,`ResolvedRefs=False` 说明引用解析失败(多半是 ReferenceGrant 或 Service 不存在)。

### 从 Ingress 迁移

```shell
# 官方提供的转换工具,把 Ingress 转成 Gateway API 资源
ingress2gateway print --input-file ingress.yaml > gateway.yaml

# 直接读取集群里的 Ingress 并转换
ingress2gateway print > gateway.yaml
```

转换工具只处理标准字段,**各家 Controller 的私有注解不会被翻译**,需要人工补齐。迁移前先把自定义注解列一份清单,逐个找对应的标准字段。

### 注意

1. **装 CRD 不等于能用**。Gateway API 只是一组资源定义,没有实现它的控制器,创建出来的 `Gateway` 永远停在 `Accepted=False`、`status.addresses` 为空,而且不会有任何报错提示。必须同时部署 Envoy Gateway、Istio、Contour 之类的实现。
2. **`kubectl apply` 会因 CRD 体积过大而失败**。报错信息是 `metadata.annotations: Too long: must have at most 262144 bytes`。客户端 apply 会把整份清单写进 `last-applied-configuration` 注解,而注解上限是 256 KiB。解决办法是 `--server-side`,这也是官方安装命令里带这个参数的原因。
3. **standard 与 experimental 通道不能随意混用**。实验通道包含 `TCPRoute`、`TLSRoute`、`UDPRoute`,未来版本可能有破坏性变更。生产环境优先用 standard,确实需要 L4 路由时再评估实验通道的风险。
4. **`controllerName` 必须与实现声明的一字不差**。`eg`、`istio.io/gateway-controller`、`projectcontour.io/gateway-controller` 各不相同,手写 GatewayClass 时写错,控制器就不会认领,表现是 Gateway 一直不 Ready 且没有任何显式报错。
5. **跨命名空间引用需要 ReferenceGrant**。`HTTPRoute` 想引用别的命名空间的 Service,或者 `Gateway` 想引用别的命名空间的 TLS Secret,必须由对端命名空间创建 `ReferenceGrant` 授权。缺了它只会得到 `ResolvedRefs=False`,不会给出「缺少 ReferenceGrant」这类直白提示。
6. **各实现的成熟度差异很大**。同样是 Gateway API,不同实现支持的功能集不同,有的只覆盖核心的 HTTPRoute,有的支持 TCPRoute、GRPCRoute 或 BackendTLSPolicy。选型时要对照官方的一致性报告确认需要的资源在支持列表内。
7. **Gateway API 与 Istio 的 `Gateway` 同名但不同物**。Istio 自有的 `networking.istio.io/v1` 的 `Gateway` 只能在 Istio 内使用,Gateway API 的 `gateway.networking.k8s.io/v1` 的 `Gateway` 是跨实现标准。执行 `kubectl get gateway` 时集群会提示需要指定资源组,先确认在说哪一个。
8. **`v1alpha2` 的资源需要升级**。早期实现大量使用 `v1alpha2` 版本的 `GRPCRoute`、`ReferenceGrant` 等,升级 CRD 前要检查 `storedVersions`,并先把已存资源迁到新版本,否则升级后旧资源读不出来。
9. **Gateway 的地址可能不是立刻就有**。云厂商的 LoadBalancer 分配 IP 需要时间,`status.addresses` 从空到有通常要几十秒,写自动化脚本时要轮询等待而不是一次判断。
10. **Ingress 不会自动迁移**。装好 Gateway API 之后原有的 Ingress 依然由原控制器处理,两者并存。迁移是逐条改写规则的过程,官方工具 `ingress2gateway` 只能覆盖标准字段的部分。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `ingress` — 被Gateway API取代的上一代路由对象
- `envoy` — Envoy Gateway是Gateway API的参考实现
- `istio` — 同时支持Istio自有Gateway与Gateway API
- `contour` — 提供Gateway Provisioner的Ingress Controller
- `traefik` — 支持Gateway API的云原生网关

### 参考链接

- [Gateway API 官方文档](https://gateway-api.sigs.k8s.io/)
- [Gateway API 安装指南](https://gateway-api.sigs.k8s.io/guides/)
- [Gateway API 实现列表](https://gateway-api.sigs.k8s.io/implementations/)
- [从 Ingress 迁移到 Gateway API](https://gateway-api.sigs.k8s.io/guides/migrating-from-ingress/)
