contour
===

基于Envoy的Kubernetes Ingress Controller,提供HTTPProxy与Gateway API能力

## 补充说明

**Contour** 是 VMware 主导、CNCF 孵化的 Ingress Controller,数据平面用的是 Envoy。它在众多 Ingress Controller 里最鲜明的特点是**不用注解**。

Ingress 标准只覆盖了最基础的 host/path 路由,想让 nginx 做一次重写、加一个超时,就得靠 `nginx.ingress.kubernetes.io/*` 这类注解。Contour 的做法是另起一套 CRD —— **HTTPProxy** —— 把这些能力变成**有 schema、有校验、有状态反馈**的字段:

- 灰度权重是 `services[].weight` 这样的正式字段,不是注解。
- 超时、重试、健康检查写在 `timeoutPolicy`、`retryPolicy` 里。
- 写错了 `kubectl apply` 当场报错,而不是静默忽略。
- 创建后 Contour 会把校验结果写回 `status`,`kubectl describe` 就能看到。

代价是**绑定**。HTTPProxy 是 Contour 独有的资源,用它就意味着放弃可移植性。所以 Contour 的定位是:你认同这套 CRD 的设计,**并且**愿意接受被它锁定。

Contour 在集群里跑两个组件:

```shell
contour     控制平面,监听 Ingress / HTTPProxy / Gateway API 资源,翻译成 xDS
envoy       数据平面,实际监听 80/443 并转发流量
```

两者通过 xDS 通信,也就是说 **Envoy 的配置是 Contour 动态下发的,不要手改**。

它同时支持三种配置入口:

```shell
Ingress       标准 API,兼容但不推荐(能力受限)
HTTPProxy     Contour 自有 CRD,能力最全
Gateway API   通过 Gateway Provisioner 提供,是官方的推荐演进方向
```

### 安装

三种安装方式,按场景选择:

```shell
# 方式一:快速开始清单,自带 Ingress 支持(仅适合测试)
kubectl apply -f https://projectcontour.io/quickstart/contour.yaml

# 方式二:Helm,便于做配置管理
helm repo add contour https://projectcontour.github.io/helm-charts/
helm repo update
helm install my-release contour/contour \
  --namespace projectcontour --create-namespace

# 方式三:Gateway Provisioner,用 Gateway API 驱动
kubectl apply -f https://projectcontour.io/quickstart/contour-gateway-provisioner.yaml
```

验证部署:

```shell
kubectl get pods -n projectcontour -o wide
kubectl get ingressclass
```

### 试用示例

```shell
# 部署官方示例应用
kubectl apply -f https://projectcontour.io/examples/httpbin.yaml

# 用 Helm 安装时,示例 Ingress 的 ingressClassName 需要改一下
kubectl patch ingress httpbin -p '{"spec":{"ingressClassName": "contour"}}'

# 端口转发到 Envoy 验证(Service 名随安装方式不同)
kubectl -n projectcontour port-forward service/envoy 8888:80
# Helm 安装的 Service 名带 release 前缀,Gateway Provisioner 方式则是 envoy-contour

curl -H "Host: local.projectcontour.io" http://localhost:8888/get
```

### HTTPProxy

最小的 HTTPProxy,一个虚拟主机加一条路由:

```shell
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: basic
  namespace: default
spec:
  virtualhost:
    fqdn: www.example.com
  routes:
    - conditions:
        - prefix: /
      services:
        - name: frontend-svc
          port: 80
```

带 TLS 的虚拟主机。证书放 Secret,再由 `tls.secretName` 引用:

```shell
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: tls-proxy
  namespace: default
spec:
  virtualhost:
    fqdn: secure.example.com
    tls:
      secretName: example-tls        # 必须与 HTTPProxy 在同一命名空间
  routes:
    - conditions:
        - prefix: /
      services:
        - name: frontend-svc
          port: 80
```

灰度、超时、重试与负载均衡策略都是正式字段:

```shell
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: weighted
  namespace: default
spec:
  virtualhost:
    fqdn: app.example.com
  routes:
    - conditions:
        - prefix: /
      timeoutPolicy:
        response: 30s
        idle: 60s
      retryPolicy:
        count: 3
        perTryTimeout: 5s
        retryOn: "5xx,gateway-error,connect-failure"
      services:
        - name: app-v1
          port: 80
          weight: 90
        - name: app-v2
          port: 80
          weight: 10
          requestHeadersPolicy:
            set:
              - name: X-Canary
                value: "true"
          strategy: RoundRobin      # 也可用 WeightedLeastRequest、Random、Cookie
          healthCheckPolicy:
            path: /healthz
            intervalSeconds: 5
            unhealthyThresholdCount: 3
```

### 委托与多团队协作

HTTPProxy 支持把一个虚拟主机的一部分路径**委托**给别的 HTTPProxy,甚至跨命名空间,这是它相比 Ingress 的重要优势:

```shell
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: root
  namespace: default
spec:
  virtualhost:
    fqdn: www.example.com
  includes:
    - name: app-team-proxy
      namespace: team-a          # 跨命名空间委托
      conditions:
        - prefix: /team-a
---
apiVersion: projectcontour.io/v1
kind: HTTPProxy
metadata:
  name: app-team-proxy
  namespace: team-a
spec:
  routes:
    - conditions:
        - prefix: /team-a
      services:
        - name: team-a-svc
          port: 80
```

委托有三条硬约束:子代理的 conditions 前缀必须落在父代理 include 的前缀范围内;不能形成环(A 委托 B、B 又委托 A 会被判为非法);一个 route 要么委托给别的 HTTPProxy,要么直接列 services,不能两者兼有。

### 查看状态

HTTPProxy 会把校验结果写进 `status`,这是它比 Ingress 好用的地方:

```shell
kubectl get httpproxy -A
kubectl describe httpproxy basic

# 直接取校验状态,valid 表示合法,invalid 会附带 description
kubectl get httpproxy basic -o jsonpath='{.status.currentStatus}'
```

### Gateway API

用 Gateway Provisioner 方式安装时,需要再创建 GatewayClass 与 Gateway:

```shell
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: contour
spec:
  controllerName: projectcontour.io/gateway-controller
---
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: contour
  namespace: projectcontour
spec:
  gatewayClassName: contour
  listeners:
    - name: http
      protocol: HTTP
      port: 80
      allowedRoutes:
        namespaces:
          from: All
```

之后就可以用标准的 `HTTPRoute` 声明路由,Provisioner 会自动拉起对应的 Envoy 实例。

### 排障

```shell
# 控制平面日志:配置为什么没下发
kubectl -n projectcontour logs deploy/contour --tail=100 -f

# Envoy 日志:请求为什么不通
kubectl -n projectcontour logs deploy/envoy --tail=100 -f

# Envoy 管理接口
kubectl -n projectcontour port-forward deploy/envoy 9001:9001
curl -s localhost:9001/config_dump | jq '.configs | length'
curl -s localhost:9001/clusters
```

### 注意

1. **`fqdn` 在同一个 Contour 实例内必须唯一**。两个不同命名空间的 root HTTPProxy 声明了同一个域名,后创建的那个会被判为 invalid,`status` 里会写明「fqdn already in use」。多团队共用集群时要提前约定域名归属。
2. **HTTPProxy 的校验错误不会阻止资源创建**。`kubectl apply` 会成功,错误信息只写在 `status.currentStatus` 与 `description` 里,必须主动去看。养成 `kubectl describe httpproxy` 的习惯,否则配置错了也毫无察觉。
3. **配置错误在请求时才变成 502/503**。include 指向了不存在的 HTTPProxy 会返回 `502 Bad Gateway`,引用了不存在的 Service 会返回 `503 Service Unavailable`。Contour 会尽量处理部分合法的配置,所以「一部分能通、一部分不通」是常见现象,要逐条路由排查。
4. **HTTPProxy 的委托有严格约束**。子代理的前缀必须落在父代理 include 的范围内,不能成环,一个 route 也不能同时既委托又列 services。违反任意一条都会让整个 HTTPProxy 变成 invalid。
5. **跨命名空间委托与证书引用有额外的安全边界**。Contour 默认只允许在同一个命名空间内引用 TLS 证书,跨命名空间用证书需要显式授权。设计多租户集群前先读一遍官方的 TLS 委托文档,不要等到上线才发现证书引不过去。
6. **Helm 安装方式下 Service 名带 release 前缀**。`envoy` 会变成 `my-release-contour-envoy`,照抄快速开始的 `port-forward service/envoy` 会报找不到 Service。
7. **Envoy 的配置是 Contour 通过 xDS 下发的,不要手改**。进 Pod 改配置文件会在下一次推送时被覆盖,而且不会报错。要改行为只能改 HTTPProxy、Ingress 或 Gateway API 资源。
8. **快速开始清单仅适合测试**。它用 DaemonSet 加 hostNetwork 的方式暴露 Envoy,没有高可用保证。生产环境应当用 Helm 或 Gateway Provisioner,并按官方指导配置副本数与反亲和。
9. **Ingress 与 HTTPProxy 可以共存但不推荐混用**。同一个域名同时被 Ingress 与 HTTPProxy 声明会造成难以预期的结果,迁移时应当整块切换而不是逐条替换。
10. **Contour 与 Envoy 的版本是绑定的**。Contour 只保证与特定 Envoy 版本兼容,不要单独升级 Envoy 镜像,升级应当整体走 Contour 的 Release。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `ingress` — Contour同时支持的标准路由对象
- `envoy` — Contour的数据平面
- `gateway-api` — Contour通过Gateway Provisioner支持的标准API
- `helm` — Kubernetes包管理器

### 参考链接

- [Contour 官方文档](https://projectcontour.io/docs/)
- [Contour 快速开始](https://projectcontour.io/getting-started/)
- [HTTPProxy 参考](https://projectcontour.io/docs/main/config/fundamentals/)
- [Contour Gateway Provisioner](https://projectcontour.io/docs/main/guides/gateway-api/)
