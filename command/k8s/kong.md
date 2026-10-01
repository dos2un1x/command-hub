kong
===

Kong Gateway 与 Kong Ingress Controller,以插件体系提供API网关能力

## 补充说明

**Kong** 的定位是 **API 网关**,在 Kubernetes 上由两个部分组成:

```shell
Kong Gateway              数据平面,基于 Nginx 与 OpenResty
Kong Ingress Controller   控制平面,把 Kubernetes 资源翻译成 Kong 的声明式配置
```

它与 APISIX 属于同一类产品(都基于 OpenResty 技术栈、都有庞大的插件体系),与 Contour、Emissary 这类「Envoy 系的入口组件」定位不同:

```shell
Ingress Controller   只管路由,把外部流量送进集群
API 网关             路由之上还有认证、限流、计费、协议转换、请求改写、可观测
```

Kong 最核心的资产是**插件体系**。认证(JWT、OAuth2、Key Auth、LDAP)、限流(Rate Limiting、Rate Limiting Advanced)、安全(IP Restriction、Bot Detection)、流量控制(Canary、Request Transformer)、可观测(Zipkin、OpenTelemetry、Prometheus)都有成熟的官方插件,企业版还提供更高级的限流与安全能力。插件用 Lua 编写,也可以自己扩展。

Kong 有两种运行模式,选型时必须先确定:

```shell
DB-less(无数据库)   配置全量保存在内存中,由控制器通过声明式配置推送
DB 模式             使用 PostgreSQL 存储配置,支持 Admin API 动态增删改
```

**在 Kubernetes 上官方推荐 DB-less 模式**,因为所有配置都来自 Kubernetes 资源,本身就已经是声明式的,再引入一个数据库只会增加运维负担。

### 安装

官方 Helm chart 名为 `kong/ingress`,一次性装好控制器与网关:

```shell
helm repo add kong https://charts.konghq.com
helm repo update

helm install kong kong/ingress -n kong --create-namespace
```

默认值部署的是「Gateway Discovery 模式」的控制器加一个 DB-less 的 Kong Gateway,这是官方推荐的拓扑。

如果要接入 Kong Konnect(云控制面),改用 `upgrade --install` 并传入包含控制平面 ID、mTLS Secret 名等信息的 values 文件:

```shell
helm upgrade --install kong kong/ingress -n kong --values ./values.yaml
```

验证:

```shell
kubectl get pods -n kong
kubectl get svc -n kong
kubectl get ingressclass
```

### 默认端口

```shell
8000    HTTP 代理入口
8443    HTTPS 代理入口
8001    Admin API(DB-less 模式下为只读)
8100    控制器的健康检查与指标
```

### 获取入口地址

```shell
kubectl get svc -n kong kong-gateway-proxy
kubectl get svc -n kong kong-gateway-proxy \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
```

### 用 Ingress 配置路由

```shell
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web-ingress
  namespace: default
spec:
  ingressClassName: kong
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: frontend-svc
                port:
                  number: 80
```

Kong 的行为通过 `konghq.com/` 前缀的注解表达:

```shell
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: annotated-ingress
  namespace: default
  annotations:
    konghq.com/strip-path: "true"
    konghq.com/methods: "GET,POST"
    konghq.com/protocols: "https"
    konghq.com/https-redirect-status-code: "301"
    konghq.com/plugins: rate-limiting,key-auth
spec:
  ingressClassName: kong
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /v1
            pathType: Prefix
            backend:
              service:
                name: api-svc
                port:
                  number: 8080
```

常用注解分两类,分别作用在 Ingress 与 Service 上:

```shell
Ingress 级
  konghq.com/plugins                   引用 KongPlugin
  konghq.com/strip-path                转发前剥掉匹配到的路径
  konghq.com/methods                   限定 HTTP 方法
  konghq.com/protocols                 允许的协议
  konghq.com/preserve-host             是否保留 Host 头

Service 级
  konghq.com/protocol                  转发到上游用的协议
  konghq.com/path                      上游路径前缀
  konghq.com/connect-timeout           连接超时
  konghq.com/retries                   重试次数
```

### 插件

插件是 Kong 的核心。定义一个 `KongPlugin`,再通过注解引用:

```shell
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: rate-limiting
  namespace: default
config:
  minute: 100
  policy: local
  limit_by: ip
plugin: rate-limiting
```

引用方式:在 Ingress 上加 `konghq.com/plugins: rate-limiting`,或者在 Service、HTTPRoute、KongConsumer 上加同样的注解。

认证插件的典型组合 —— 先挂一个认证插件,再配 `KongConsumer` 保存凭证:

```shell
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata:
  name: key-auth
  namespace: default
plugin: key-auth
config:
  key_names:
    - apikey
---
apiVersion: configuration.konghq.com/v1
kind: KongConsumer
metadata:
  name: consumer-a
  namespace: default
  annotations:
    kubernetes.io/ingress.class: kong
username: consumer-a
credentials:
  - consumer-a-apikey
```

凭据本身放在一个 Secret 里,关键是必须带 `konghq.com/credential: key-auth` 标签,否则控制器不会把它识别为凭证;`KongConsumer` 的 `credentials` 字段填的就是这个 Secret 的名字。

### 常用 CRD

```shell
KongPlugin          命名空间级的插件配置
KongClusterPlugin   集群级的插件配置,所有命名空间可用
KongConsumer        消费者,配合认证插件使用
KongConsumerGroup   消费者组
TCPIngress          四层 TCP 入口,Ingress 不支持的能力
UDPIngress          四层 UDP 入口
KongUpstreamPolicy  上游的负载均衡与健康检查策略
KongIngress         早期用于配置上游行为,现多由注解取代
```

### Gateway API

Kong 也支持标准的 Gateway API。需要用 chart 的 values 开启相应支持,具体开关名随版本变化,以官方文档为准:

```shell
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: web-route
  namespace: default
  annotations:
    konghq.com/plugins: rate-limiting
spec:
  parentRefs:
    - name: kong
  hostnames:
    - app.example.com
  rules:
    - backendRefs:
        - name: frontend-svc
          port: 80
```

注意 `konghq.com/plugins` 这类注解在 HTTPRoute 上依然有效,这是 Kong 的过渡策略。

### 排障

```shell
# 控制器日志
kubectl -n kong logs deploy/kong-controller --tail=100 -f

# 网关日志
kubectl -n kong logs deploy/kong-gateway --tail=100 -f

# 查看控制器翻译出的声明式配置
kubectl -n kong exec deploy/kong-gateway -- cat /kong_dbless/kong.yml

# Admin API(DB-less 模式下只读)
kubectl -n kong port-forward svc/kong-gateway-admin 8001:8001
curl -s localhost:8001/routes | jq

# 指标
kubectl -n kong port-forward deploy/kong-controller 8100:8100
curl -s localhost:8100/metrics | head
```

### 注意

1. **官方有两个容易混淆的 chart**。`kong/ingress` 是新一代 chart,同时装控制器与网关,是现在的推荐;**`kong/kong` 是旧版 chart**,只装网关本身。网上大量教程还在用后者,照抄会把控制器漏掉,结果是网关起来了但任何 Ingress 都不生效。
2. **DB-less 模式下部分插件不可用**。依赖数据库存储运行时状态的插件(如某些高级限流、开发者门户类功能)在 DB-less 模式下无法工作,选型时要先确认需要的插件是否支持。
3. **`KongPlugin` 与 `KongClusterPlugin` 的作用域不同**。`KongPlugin` 只能在创建它的命名空间内被引用,跨命名空间引用会静默不生效;需要全局复用时应当用 `KongClusterPlugin`。
4. **插件「配了不生效」几乎都是引用方式错了**。插件必须通过 `konghq.com/plugins` 注解显式挂载到 Ingress、Service、HTTPRoute 或 KongConsumer 上,创建了 `KongPlugin` 资源本身不等于启用了插件。多个插件用逗号分隔,名称写错会被静默忽略。
5. **注解前缀是 `konghq.com/`,不是历史教程里的 `kong.ingress.kubernetes.io/`**。旧前缀在早期版本中使用,现已不再生效,照抄旧文档会得到「注解完全没起作用」的结果。
6. **`kubernetes.io/ingress.class` 注解在新版本中已由 `ingressClassName` 取代**。Ingress 资源应当用 `spec.ingressClassName: kong`,旧的注解方式只对 Kong 自身的 CRD 还有意义。
7. **默认 IngressClass 名称是 `kong`**。集群里同时装了其他控制器时,Ingress 必须显式声明 `ingressClassName`,否则可能被别的控制器抢走或无人处理。
8. **DB 模式下必须自己运维 PostgreSQL**。数据库出问题会直接影响配置下发,且 Kong 的 schema 迁移有版本约束。没有特别理由时在 Kubernetes 上就用 DB-less。
9. **企业版插件需要 License**。`KongPlugin` 里写了企业版插件名但集群没有有效 License 时,插件不会启用,日志里会有相关提示,排查时要先确认 License 状态。
10. **网关配置由控制器通过声明式配置整体推送**。不要直接调 Admin API 修改配置 —— DB-less 模式下 Admin API 是只读的,而且下一次控制器同步会把所有内容覆盖回 Kubernetes 里声明的状态。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `ingress` — Kong支持的上一代路由对象
- `gateway-api` — Kong支持的新一代路由API
- `apisix` — 同为OpenResty系API网关的另一选择
- `higress` — 基于Envoy与Istio的云原生网关
- `helm` — Kubernetes包管理器

### 参考链接

- [Kong Ingress Controller 文档](https://developer.konghq.com/kubernetes-ingress-controller/)
- [Kong Ingress Controller 安装](https://developer.konghq.com/kubernetes-ingress-controller/install/)
- [Kong 注解参考](https://developer.konghq.com/kubernetes-ingress-controller/reference/annotations/)
- [Kong 插件中心](https://developer.konghq.com/plugins/)
