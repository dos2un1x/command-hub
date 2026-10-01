traefik
===

Go编写的云原生Ingress Controller与API网关,以CRD表达路由与中间件

## 补充说明

**Traefik** 是一个用 Go 编写的反向代理与入口组件,在 Kubernetes 生态里的定位介于 Ingress Controller 与 API 网关之间。

它的最大特点是**配置自动发现**。Traefik 会监听 Kubernetes API,一旦发现符合条件的新 Service 或 Ingress 资源就自动生成路由并热加载,**不需要重启进程也不需要额外的控制平面**。这一点和 Contour、Emissary 那种「控制器翻译成配置再推给 Envoy」的两段式架构很不一样 —— Traefik 自己既是控制平面也是数据平面。

它的配置入口有三套,彼此独立:

```shell
kubernetesIngress  标准 Ingress 资源,用注解补充能力
kubernetesCRD      自有 CRD(IngressRoute、Middleware 等),能力最全
kubernetesGateway  标准的 Gateway API,可单独开关
```

Traefik 的 CRD 体系围绕「路由」和「中间件」两个概念展开:

```shell
IngressRoute        HTTP 路由
IngressRouteTCP     TCP 路由
IngressRouteUDP     UDP 路由
Middleware          HTTP 中间件:重写、鉴权、限流、重试
MiddlewareTCP       TCP 中间件
TraefikService      加权轮询、镜像等高级负载均衡
TLSOption          TLS 参数
TLSStore           默认证书存储
ServersTransport   到上游的连接参数
```

**Middleware 单独定义、按名引用**是 Traefik 设计上最舒服的一点:限流、重写、鉴权这些配置可以跨路由复用,而不是像 Ingress 注解那样每条路由抄一遍。

### 安装

Helm 是推荐方式,chart 默认会启用 `kubernetesCRD` provider:

```shell
helm repo add traefik https://traefik.github.io/charts
helm repo update

helm install traefik traefik/traefik -n traefik --create-namespace
```

**不用 Helm 时需要手动装 CRD 与 RBAC**:

```shell
# CRD 定义
kubectl apply -f https://raw.githubusercontent.com/traefik/traefik/v3.2/docs/content/reference/dynamic-configuration/kubernetes-crd-definition-v1.yml

# 控制器所需的 RBAC
kubectl apply -f https://raw.githubusercontent.com/traefik/traefik/v3.2/docs/content/reference/dynamic-configuration/kubernetes-crd-rbac.yml
```

因为 Helm 不会升级 CRD,chart v34 起提供了独立的 CRD chart:

```shell
# 单独管 CRD,主 chart 跳过 CRD 安装
helm install traefik-crds traefik/traefik-crds
helm install traefik traefik/traefik --skip-crds
```

这样升级时可以先用 CRD chart 升级定义,再升主程序。

验证:

```shell
kubectl get crd | grep traefik.io
kubectl get pods -n traefik -l app.kubernetes.io/name=traefik
```

### 访问面板

```shell
kubectl port-forward $(kubectl get pods --selector "app.kubernetes.io/name=traefik" \
  --output=name -n traefik) 9000:9000
```

浏览器打开 `http://localhost:9000/dashboard/` 即可看到路由器、中间件、服务的实时状态,这是排障时最直观的工具。

**面板不要暴露到公网**。默认的 `--api.insecure=true` 会让面板不经过任何认证直接可访问,只适合本地调试。

### IngressRoute

基本路由:

```shell
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: web-route
  namespace: default
spec:
  entryPoints:
    - web
  routes:
    - match: Host(`app.example.com`) && PathPrefix(`/`)
      kind: Rule
      services:
        - name: frontend-svc
          port: 80
```

带 TLS,并引用中间件做重写与限流:

```shell
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: secure-route
  namespace: default
spec:
  entryPoints:
    - websecure
  routes:
    - match: Host(`app.example.com`) && PathPrefix(`/v1`)
      kind: Rule
      middlewares:
        - name: strip-v1
        - name: rate-limit
      services:
        - name: api-svc
          port: 8080
  tls:
    secretName: example-tls
```

匹配规则用的是 Traefik 自己的表达式语法,和 Ingress 的 host/path 字段完全不同:

```shell
Host(`app.example.com`)                       按域名
PathPrefix(`/api`) / Path(`/exact`)           按路径前缀或精确路径
Method(`GET`)                                 按 HTTP 方法
Headers(`X-Canary`, `true`)                   按请求头
Query(`foo`, `bar`)                           按查询参数
Host(`a.com`) && PathPrefix(`/api`)           逻辑与,|| 为逻辑或
```

### Middleware

中间件单独定义,按名引用:

```shell
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: strip-v1
  namespace: default
spec:
  stripPrefix:
    prefixes:
      - /v1
---
apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: rate-limit
  namespace: default
spec:
  rateLimit:
    average: 100
    burst: 50
```

常用的中间件类型:

```shell
redirectRegex / redirectScheme    重定向
stripPrefix / replacePathRegex    路径改写
headers                           改请求/响应头,配置 CORS
basicAuth / forwardAuth           认证
rateLimit / inFlightReq           限流与并发限制
retry / circuitBreaker            重试与熔断
compress / ipAllowList            压缩与 IP 访问控制
errors                            自定义错误页
```

### 加权与灰度

用 `TraefikService` 做加权轮询:

```shell
apiVersion: traefik.io/v1alpha1
kind: TraefikService
metadata:
  name: app-weighted
  namespace: default
spec:
  weighted:
    services:
      - name: app-v1
        port: 80
        weight: 90
      - name: app-v2
        port: 80
        weight: 10
---
apiVersion: traefik.io/v1alpha1
kind: IngressRoute
metadata:
  name: app-route
  namespace: default
spec:
  entryPoints:
    - web
  routes:
    - match: Host(`app.example.com`)
      kind: Rule
      services:
        - name: app-weighted
          kind: TraefikService
```

### 开启 Gateway API

在 values 中打开对应 provider:

```shell
providers:
  kubernetesGateway:
    enabled: true
```

之后就可以使用标准的 `Gateway` 与 `HTTPRoute`:

```shell
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: traefik-gateway
  namespace: default
spec:
  gatewayClassName: traefik
  listeners:
    - name: web
      protocol: HTTP
      port: 8000
```

### 排障

```shell
kubectl -n traefik logs deploy/traefik --tail=100 -f

# 通过 API 查看已发现的配置
kubectl port-forward -n traefik deploy/traefik 9000:9000
curl -s localhost:9000/api/http/routers | jq '.[] | {name, status, rule}'
curl -s localhost:9000/metrics | head
```

### 注意

1. **Helm 不会升级 CRD**。`helm upgrade` 只更新工作负载,CRD 定义始终停留在首次安装时的版本。升级 Traefik 前必须先单独更新 CRD,否则新版本用到的字段会被 API Server 拒绝。chart v34 之后用独立的 `traefik-crds` chart 管理,顺带加 `--skip-crds` 避免冲突。
2. **`IngressRoute` 的优先级高于 `Ingress`**。同一个域名同时被 IngressRoute 与 Ingress 声明时,IngressRoute 会赢。迁移期间两种资源并存容易造成「改了 Ingress 但没生效」的困惑,应当整块切换。
3. **Middleware 必须与引用它的 IngressRoute 在同一命名空间**。跨命名空间引用中间件不被支持,会直接报错。需要复用时只能在每个命名空间各建一份。
4. **`apiVersion` 在 v2 到 v3 之间发生过变更**。旧版使用 `traefik.containo.us/v1alpha1`,v3 起统一为 `traefik.io/v1alpha1`,chart v28 之后只安装 `traefik.io` 这一组 CRD。照抄旧教程会得到「资源创建成功但路由不生效」的结果。
5. **面板默认不认证**。`--api.insecure=true` 打开的面板可以被任何人读取全部路由、中间件与后端信息。生产环境应通过 `api.dashboard` 配合 IngressRoute 加认证中间件暴露,或干脆只做端口转发。
6. **匹配表达式写错往往没有明显报错**。`Host` 与 `PathPrefix` 之间的 `&&` 漏写、反引号写成单引号,都会导致规则无法解析,面板里对应路由器会显示为错误状态。写复杂规则时务必到面板确认路由器状态。
7. **Ingress 资源的注解前缀是 `traefik.ingress.kubernetes.io/`**。这类注解只对 `kubernetesIngress` provider 有效,写在 IngressRoute 上会被忽略;反过来 IngressRoute 的字段也无法用注解表达。两套体系不要混着理解。
8. **`entryPoints` 名称必须与静态配置一致**。默认是 `web`(80)与 `websecure`(443),写在 IngressRoute 里的名字对不上时路由会被挂到不存在的入口上,表现为资源创建成功但没有任何监听。
9. **默认证书要通过 `TLSStore` 设置**。没有为某个域名配置 TLS 时,Traefik 会回退到默认自签证书,浏览器会报证书错误。自定义默认证书需要创建 `TLSStore` 资源并引用对应的 Secret。
10. **Traefik 自己就是数据平面,没有单独的控制器进程**。所以「重启 Traefik」会中断流量,滚动更新时要配好 `PodDisruptionBudget` 与 `terminationGracePeriodSeconds`,不要像对待无状态的 Ingress Controller 那样随意重启。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `ingress` — Traefik支持的上一代路由对象
- `gateway-api` — Traefik支持的新一代路由API
- `contour` — 另一款主流Ingress Controller
- `nginx-ingress` — 基于Nginx的Ingress Controller
- `helm` — Kubernetes包管理器

### 参考链接

- [Traefik 官方文档](https://doc.traefik.io/traefik/)
- [Traefik Kubernetes CRD 提供者](https://doc.traefik.io/traefik/reference/install-configuration/providers/kubernetes/kubernetes-crd/)
- [Traefik Kubernetes Gateway API](https://doc.traefik.io/traefik/reference/install-configuration/providers/kubernetes/kubernetes-gateway/)
- [Traefik Helm Chart](https://github.com/traefik/traefik-helm-chart)
