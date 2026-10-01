kiali
===

Istio服务网格的可视化控制台,提供服务拓扑、健康检查与配置校验

## 补充说明

**Kiali** 是 Istio 的官方配套控制台。它自己不产生任何数据,而是从 Prometheus 读取指标、从 Istio 控制平面读取配置、再按需查询 Jaeger 或 Tempo 拿链路,最后拼成一张能看懂的图。

它解决的问题很具体:Istio 把一堆 CRD 撒进集群之后,没人能一眼看出「哪些服务在用 mTLS」「哪个版本在报错」「这条路由到底指向谁」。Kiali 的**拓扑图**把这些关系画出来,连线颜色表示成功率、粗细表示流量大小,点进去就能看到具体的请求指标。

Kiali 提供的主要能力:

- **拓扑图**:服务之间的调用关系、流量大小与健康状态。
- **健康检查**:服务、工作负载、应用三个维度的错误率与告警。
- **配置校验**:检查 VirtualService、DestinationRule 等资源是否有问题。
- **流量观测**:调用链、请求量、延迟、gRPC 与 TCP 指标。
- **配置浏览**:在界面上直接查看 Istio 的各种 CRD 与 Envoy 配置。

**Kiali 不是 Istio 的必需组件**。不装它,Istio 照常工作。装它之前先确认集群里已经有 Prometheus —— 没有指标源,Kiali 的图会是空的。

### 安装

推荐用 Operator 方式,由 Operator 根据 Kiali CR 来创建和调谐实际的 Deployment:

```shell
helm repo add kiali https://kiali.org/helm-charts
helm repo update

# 一步到位:装 Operator 并同时创建一个 Kiali CR
helm install kiali-operator kiali/kiali-operator \
  --namespace kiali-operator --create-namespace \
  --set cr.create=true \
  --set cr.namespace=istio-system \
  --set cr.spec.auth.strategy="anonymous"
```

如果打算做大量定制,建议只装 Operator,之后自己写 Kiali CR:

```shell
helm install kiali-operator kiali/kiali-operator \
  --namespace kiali-operator --create-namespace
```

不带 Operator 的独立部署方式,简单但缺少部分 Operator 能力,官方不推荐生产使用:

```shell
helm install kiali-server kiali/kiali-server --namespace istio-system
```

### 访问面板

```shell
# 端口转发
kubectl port-forward service/kiali -n istio-system 20001:20001

# 或者用 istioctl(会自动做端口转发)
istioctl dashboard kiali

# 也可以把 Service 改成 NodePort
kubectl patch svc kiali -n istio-system -p '{"spec":{"type":"NodePort"}}'
kubectl get svc kiali -n istio-system
```

默认端口是 **20001**,与 Istio 其他组件的端口不冲突。

### Kiali CR

用 Operator 安装时,所有配置都写在 `Kiali` 自定义资源里。一个典型的 CR:

```shell
apiVersion: kiali.io/v1alpha1
kind: Kiali
metadata:
  name: kiali
  namespace: istio-system
spec:
  version: default
  auth:
    strategy: anonymous          # 生产环境应换成 openid 或 token
  deployment:
    namespace: istio-system
    image_version: default
  external_services:
    prometheus:
      url: http://prometheus.istio-system:9090
    grafana:
      enabled: true
      in_cluster_url: http://grafana.istio-system:3000
    tracing:
      enabled: true
      in_cluster_url: http://tracing.istio-system:16685/jaeger
      use_grpc: true
```

查看与编辑:

```shell
kubectl get kiali -n istio-system
kubectl describe kiali kiali -n istio-system

# 直接改 CR,Operator 会自动重新调谐
kubectl edit kiali kiali -n istio-system
```

### 认证策略

`spec.auth.strategy` 决定谁能访问控制台:

```shell
anonymous    匿名访问,仅适合本地或内网测试
login        用 Kiali 自己的登录页,账号存在 Secret 里
token        要求用户提供 Kubernetes ServiceAccount Token
openid       接 OIDC 单点登录,生产环境推荐
openshift    OpenShift 专用
```

用 `token` 策略时,用户必须持有具备相应 RBAC 的 ServiceAccount Token,权限映射到 Kubernetes 本身的权限体系,安全性最好。

### 打开追踪与 Grafana

要让 Kiali 里的「链路追踪」和「Grafana 图表」可用,除了 CR 里的配置,还需要补上从浏览器访问的外部地址:

```shell
spec:
  external_services:
    grafana:
      enabled: true
      in_cluster_url: http://grafana.istio-system:3000
      url: https://grafana.example.com     # 浏览器直接访问的地址
    tracing:
      enabled: true
      in_cluster_url: http://tracing.istio-system:16685/jaeger
      use_grpc: true
      external_url: https://jaeger.example.com
```

`in_cluster_url` 是 Kiali 后端在集群内访问用的,`url` / `external_url` 是给浏览器用的,两者不能混用。

### 用 Istio 自带示例快速体验

```shell
# 安装 demo 档及其附加组件(含 Kiali)
istioctl install --set profile=demo -y
kubectl apply -f samples/addons/

# 部署示例应用
kubectl label namespace default istio-injection=enabled
kubectl apply -f samples/bookinfo/platform/kube/bookinfo.yaml

# 产生一些流量
for i in $(seq 1 100); do
  curl -s "http://$GATEWAY_URL/productpage" > /dev/null
done
```

### 卸载

```shell
# 1. 先删掉所有 Kiali CR
kubectl delete kiali --all --all-namespaces

# 2. 再卸载 Operator
helm uninstall kiali-operator -n kiali-operator

# 3. 最后手动删 CRD,Helm 不会替你删
kubectl delete crd kialis.kiali.io
```

### 注意

1. **Kiali 必须先有 Prometheus 才有内容**。Istio 的 demo 配置档会一并安装 Prometheus,但生产环境往往是自己部署的;此时必须在 CR 的 `external_services.prometheus.url` 里指到正确的地址,否则拓扑图会一直空着而 Kiali 不会明确报错。
2. **`auth.strategy` 默认值不安全**。用 `anonymous` 意味着任何能访问该端口的人都能看到全部服务拓扑与配置,生产环境务必换成 `token` 或 `openid`。
3. **CR 里的 `in_cluster_url` 与 `url` 是两个不同的东西**。前者是 Kiali 后端在集群内发请求用的地址,后者是拼给浏览器跳转用的。只配了前者,页面上点 Grafana 图标会跳到一个不存在的地址。
4. **用 Operator 安装时,删 CR 才会删掉实际部署**。只 `helm uninstall` 掉 Operator 而留着 CR,Kiali 的 Deployment 会残留在集群里;反过来只删 CR 不删 Operator,Operator 会一直在日志里报找不到资源。
5. **CRD `kialis.kiali.io` 需要手动删除**。Helm 不管理 CRD 的生命周期,`helm uninstall` 不会清掉它,重装前记得手动删,否则会残留旧版本的结构定义。
6. **多个 Kiali 实例需要设置 `instance_name`**。同一集群里部署多个 Kiali 时,`spec.deployment.instance_name` 用来生成唯一的资源名,取值要符合 DNS 标签规则且**最长 40 个字符**,超长会创建失败。
7. **拓扑图上的「无数据」多半是注入问题**。如果某个服务在图上显示为孤立节点或没有连线,先检查它所在命名空间有没有 `istio-injection=enabled`,以及 Pod 有没有重建过 —— 没有 sidecar 就没有指标。
8. **流量没进网格时 Kiali 看不到任何东西**。只有经过 sidecar 的请求才会上报指标,直接访问 Pod IP、绕过 Service 的调用不会出现在拓扑图上。
9. **Kiali 的权限跟随 Kubernetes RBAC**。用 `token` 策略时,用户看到的内容受限于其 ServiceAccount 的权限,「看不到某个命名空间」通常是 RBAC 没配,而不是 Kiali 的问题。
10. **Operator 的 `--reuse-values` 在升级时要留意**。升级 Operator 不指定 `--reuse-values` 会丢掉此前的 `cr.*` 参数,建议把配置固化在 values 文件里而不是靠命令行 `--set`。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `istio` — Kiali所观测的服务网格
- `istioctl` — Istio服务网格的官方命令行工具
- `helm` — Kubernetes包管理器

### 参考链接

- [Kiali 官方文档](https://kiali.io/docs/)
- [使用 Helm 安装 Kiali](https://kiali.io/docs/installation/installation-guide/install-with-helm/)
- [Kiali CR 参考](https://kiali.io/docs/configuration/kialis.kiali.io/)
- [Kiali 认证策略](https://kiali.io/docs/configuration/authentication/)
