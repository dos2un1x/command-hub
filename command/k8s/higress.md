higress
===

基于Envoy与Istio的云原生API网关,兼容Ingress、Gateway API与Istio生态

## 补充说明

**Higress** 是由阿里巴巴开源、捐赠给 CNCF 的云原生 API 网关。它和前面几个组件的最大区别是:**控制平面直接复用了 Istio**。

具体来说:

```shell
higress-controller   控制平面,基于 Istio 的 xDS 能力改造而来
higress-gateway      数据平面,就是 Envoy
higress-console      Web 控制台,提供图形化的路由与插件管理
```

因为控制平面就是 Istio,所以 Higress 天然同时支持三套 API:

```shell
Ingress       标准的 Kubernetes Ingress,通过 ingressClassName: higress 使用
Gateway API   标准的 Gateway / HTTPRoute,需要额外开启
Istio API     VirtualService / DestinationRule 等 Istio 自有资源
```

这意味着**已有的 Istio 配置可以平移到 Higress**,反之亦然,这是它与其他网关相比最独特的地方。

它在 API 网关层面的能力也明显强于纯 Ingress Controller:

- **插件体系基于 Wasm**,插件在沙箱中运行,可在不重启网关的情况下动态加载,官方提供插件市场。
- **多服务注册中心支持**:通过 `McpBridge` 资源把 Nacos、Consul、Eureka、ZooKeeper、DNS 里的服务直接接入,不要求服务必须跑在 Kubernetes 里。
- **控制台开箱可用**,认证、限流、IP 黑白名单这类常见需求点点就能开,不必写 CRD。
- **支持 HTTP 到 Dubbo 的协议转换**,这是阿里内部场景沉淀下来的能力。

选型时记住这个差异:**如果你已经在用 Istio 且需要一个更完整的入口网关能力,Higress 是平移成本最低的选择;如果完全是 Kubernetes 原生技术栈,Envoy Gateway 或 Contour 更简单。**

### 安装

要求 Helm 3.10 及以上:

```shell
helm repo add higress.io https://higress.io/helm-charts
helm repo update

helm install higress -n higress-system higress.io/higress \
  --create-namespace --render-subchart-notes
```

国内环境可以用加速仓库(镜像本身也有独立镜像源,不受 Docker Hub 限制影响):

```shell
helm repo add higress.cn https://higress.cn/helm-charts
helm upgrade --install higress -n higress-system higress.cn/higress \
  --create-namespace --render-subchart-notes
```

本地集群(Kind、Rancher Desktop 等)需要加上本地模式参数:

```shell
helm install higress -n higress-system higress.io/higress \
  --create-namespace --render-subchart-notes \
  --set global.local=true \
  --set global.o11y.enabled=false
```

验证部署:

```shell
kubectl get pods -n higress-system
kubectl get svc -n higress-system
```

主要组件:`higress-gateway` 是数据平面,默认 2 副本并监听 80 与 443;`higress-controller` 是控制平面;`higress-console` 是控制台,后两者默认各 1 副本。

### 获取入口地址

```shell
kubectl get svc -n higress-system higress-gateway \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
```

如果拿不到 LoadBalancer IP(裸机或本地集群),可以用本地模式加端口转发,或开启 hostNetwork 交由外部负载均衡转发:

```shell
kubectl port-forward service/higress-gateway -n higress-system 80:80 443:443
# 或者安装时加 --set higress-core.gateway.hostNetwork=true
```

### 访问控制台

```shell
kubectl port-forward service/higress-console -n higress-system 8080:8080
```

浏览器打开后首次访问会要求初始化管理员账号。控制台里可以完成路由配置、插件开关、证书管理、服务来源管理等操作,也可以直接看到下发的配置。

如果装了 `hgctl` 命令行工具,可以直接拉起控制台:

```shell
hgctl dashboard console
```

### 用 Ingress 配置路由

最简单的方式,和普通 Ingress Controller 用法一致,只需指定 `ingressClassName: higress`:

```shell
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: foo
  namespace: default
spec:
  ingressClassName: higress
  rules:
    - host: foo.bar.com
      http:
        paths:
          - path: /foo
            pathType: Prefix
            backend:
              service:
                name: foo-svc
                port:
                  number: 8080
```

验证:

```shell
curl http://<GatewayIP>/foo -H 'host: foo.bar.com'
```

### 用 Istio API 配置路由

因为控制平面就是 Istio,可以直接写 VirtualService:

```shell
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: reviews
  namespace: default
spec:
  hosts:
    - reviews.example.com
  gateways:
    - higress-system/higress-gateway
  http:
    - route:
        - destination:
            host: reviews-v1
            port:
              number: 8080
          weight: 90
        - destination:
            host: reviews-v2
            port:
              number: 8080
          weight: 10
```

### 开启 Gateway API

```shell
# 1. 先装 Gateway API 的 CRD
kubectl apply -f \
  https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.6.0/experimental-install.yaml

# 2. 升级 Higress 打开 Gateway API 支持
helm upgrade higress -n higress-system \
  --set global.enableGatewayAPI=true \
  higress.io/higress --reuse-values
```

版本兼容关系需要留意:Higress 2.2.4 及以上对应 Gateway API 1.6.0,2.2.0 至 2.2.4 之间对应 1.4.0,2.1.x 及以下对应 1.0.0。

### 接入外部服务注册中心

这是 Higress 相比其他网关的独有优势。用 `McpBridge` 把 Nacos、Consul、Eureka、DNS 里的服务接进来:

```shell
apiVersion: networking.higress.io/v1
kind: McpBridge
metadata:
  name: default
  namespace: higress-system
spec:
  registries:
    - name: my-nacos
      type: nacos2
      domain: nacos-server.default.svc.cluster.local
      port: 8848
      nacosGroups:
        - DEFAULT_GROUP
    - name: my-dns
      type: dns
      domain: api.example.com
      port: 80
```

之后就可以像引用普通 Service 一样引用这些外部服务,网关会自动感知实例变化。

### 插件

插件通过 `WasmPlugin` 资源挂载,也可以在控制台里直接开启:

```shell
apiVersion: extensions.higress.io/v1alpha1
kind: WasmPlugin
metadata:
  name: key-rate-limit
  namespace: higress-system
spec:
  url: oci://higress-registry.cn-hangzhou.cr.aliyuncs.com/plugins/key-rate-limit:1.0.0
  defaultConfig:
    rate_limit_by_header: X-Real-IP
```

常用插件类别:认证类(key-auth、basic-auth、jwt-auth、oidc)、限流类(key-rate-limit、cluster-key-rate-limit)、安全类(ip-restriction、waf、bot-detect)、流量类(canary、redirect、cors)、可观测类(prometheus、zipkin、skywalking)。

### 排障

```shell
# 控制器日志:配置为什么没下发
kubectl -n higress-system logs deploy/higress-controller --tail=100 -f

# 数据平面日志:请求为什么不通
kubectl -n higress-system logs deploy/higress-gateway --tail=100 -f

# 查看网关容器内的 Envoy 实际配置
kubectl -n higress-system exec deploy/higress-gateway -- \
  curl -s localhost:15000/config_dump | head

# 查看控制器版本
kubectl -n higress-system get deploy higress-controller \
  -o jsonpath='{.spec.template.spec.containers[0].image}'
```

### 卸载

```shell
helm delete higress -n higress-system
```

### 注意

1. **Higress 的控制平面基于 Istio,不要在同一集群里再装一套完整的 Istio**。两者的控制平面都基于 Istio 的 xDS 体系,同时安装可能造成 CRD 版本冲突或配置互相干扰。确实需要时,按官方文档的说明只安装 `istio/base` chart 提供 CRD,不要装 istiod。
2. **`global.local=true` 只适合本地集群**。它会把网关的 Service 类型改成 NodePort 之类便于本地访问的形态,生产环境使用会失去负载均衡能力。本地调试完记得改回。
3. **Gateway API 需要手动开,而且要按版本配对**。Higress 2.2.4 以上才对应 Gateway API 1.6.0,装错版本的 CRD 会出现资源无法识别或字段校验失败。开之前先查一遍官方的兼容矩阵。
4. **控制台默认没有认证,必须初始化管理员账号**。首次访问会让你创建管理员,这一步不能跳过。控制台拥有改路由、改证书、装插件的全部权限,不要直接暴露到公网。
5. **`McpBridge` 是命名空间级的单例**。官方约定在 `higress-system` 下创建一个名为 `default` 的 `McpBridge`,重复创建同名或同命名空间多个实例会造成服务来源混乱。
6. **Wasm 插件来自 OCI 镜像,拉取失败不会阻塞网关启动**。插件拉不下来时路由仍然可用,只是插件不生效,表现是「配了限流但没限住」。排查时先看控制台里插件的状态,再看网络能否访问镜像仓库。
7. **国内环境要用加速仓库**。`higress.cn` 提供 chart 与镜像的加速,用 `higress.io` 在受限网络下可能拉取超时。两者可以混合使用,但要以其中一个为准,避免版本不一致。
8. **控制台改的配置会写回 Kubernetes 资源**。控制台不是独立的配置存储,它的操作最终会变成 Ingress、VirtualService、WasmPlugin 等资源。用 GitOps 管理时要注意人工在控制台改的东西会被下一次同步覆盖。
9. **网关副本数默认是 2**。这个默认值可以抵御单副本故障,但压测或大流量场景需要按 CPU 与连接数调大 `higress-core.gateway.replicas`,数据平面是无状态的水平扩展。
10. **Istio 与 Higress 资源的 `gateways` 字段要写对引用**。用 VirtualService 时,`spec.gateways` 需要写成 `<命名空间>/<网关名>`,漏掉命名空间前缀会导致路由绑不上网关,且不会有明显报错。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `istio` — Higress控制平面所基于的服务网格
- `envoy` — Higress的数据平面
- `gateway-api` — Higress可选支持的标准路由API
- `ingress` — Higress同时兼容的标准路由对象
- `helm` — Kubernetes包管理器

### 参考链接

- [Higress 官方文档](https://higress.io/docs/latest/overview/)
- [Higress 快速开始](https://higress.io/en/docs/latest/user/quickstart)
- [使用 Helm 部署 Higress](https://higress.io/en/docs/latest/ops/deploy-by-helm)
- [Higress 插件市场](https://higress.io/plugin/)
