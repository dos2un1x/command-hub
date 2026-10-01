istio
===

Kubernetes服务网格,提供流量管理、可观测性与安全能力

## 补充说明

**Istio** 是当前最主流的服务网格(Service Mesh)实现。它把「服务间通信」从业务代码里抽出来下沉到基础设施层:每个 Pod 旁挂一个 Envoy 代理,进出流量全部被接管,于是熔断、重试、超时、灰度、mTLS、链路追踪这些能力都能用声明式 CRD 配置,不用改一行业务代码。

先分清三个容易混淆的定位:

- **Service Mesh**:解决集群**内部服务之间**的通信,即东西向流量。代表是 Istio 与 Linkerd。
- **Ingress Controller**:解决**集群外部流量如何进来**,即南北向流量,只管入口这一跳。代表是 ingress-nginx、Traefik、Contour。
- **API 网关**:在入口这一跳之上再加认证、限流、计费、协议转换等业务能力。代表是 Kong、APISIX、Higress。

Istio 三者都沾:本质是 Mesh,但自带 `istio-ingressgateway` 可以做入口,也支持用 Gateway API 暴露服务。所以决定引入前先想清楚需求 —— 如果只是要一个入口路由,装 Ingress Controller 就够了,引入 Istio 会带来相当可观的资源与运维成本。

架构上分两层:

- **控制平面 `istiod`**:服务发现、配置分发(xDS)、证书签发三合一。Istio 1.5 之后由原来的多个组件合并为单体的 istiod。
- **数据平面**:默认 sidecar 模式的 `istio-proxy`(基于 Envoy);1.18 起引入 **ambient 模式**,用节点级的 `ztunnel` 处理四层,需要七层能力时再挂 `waypoint` 代理,免去每个 Pod 一个 sidecar。

### 安装

Istio 官方推荐用 CLI `istioctl` 安装,便于后续升级与排障:

```shell
# 下载官方 CLI
curl -L https://istio.io/downloadIstio | sh -
cd istio-1.24.0            # 目录名即下载到的版本号
export PATH=$PWD/bin:$PATH

# 查看可用配置档
istioctl profile list

# 测试环境用 demo 档(组件最全,资源占用也最大)
istioctl install --set profile=demo -y

# 生产环境建议先把配置落成 IstioOperator 文件再安装
istioctl install -f my-config.yaml -y

# 确认控制平面
kubectl get pods -n istio-system
kubectl get svc -n istio-system
```

各配置档的含义:`default` 是生产默认档,含 istiod 与 istio-ingressgateway;`demo` 额外打开遥测组件,功能最全但资源占用最大;`minimal` 只装 istiod 不要网关;`ambient` 含 ambient 模式所需的 ztunnel 与 CNI;此外还有 `empty`、`preview`、`remote` 三个特殊用途的档位。

用 Helm 安装需要分别装 base、istiod、gateway 三个 chart:

```shell
helm repo add istio https://istio-release.storage.googleapis.com/charts
helm repo update

kubectl create namespace istio-system
helm install istio-base istio/base -n istio-system --set defaultRevision=default
helm install istiod istio/istiod -n istio-system --wait
helm install istio-ingressgateway istio/gateway -n istio-system
```

### 启用 sidecar 注入

Istio 的注入依赖命名空间标签,且**只对新建 Pod 生效**:

```shell
# 给命名空间打标签,该空间内新建的 Pod 自动注入 sidecar
kubectl label namespace default istio-injection=enabled --overwrite
kubectl get namespace -L istio-injection

# 已经在跑的 Pod 不会自动补注入,必须重建
kubectl rollout restart deployment -n default

# 验证:READY 应该从 1/1 变成 2/2
kubectl get pods -n default
```

单个 Pod 级别的开关优先级高于命名空间标签,摘掉标签则关闭整个命名空间的注入:

```shell
kubectl label pod <pod-name> sidecar.istio.io/inject=false
kubectl label namespace default istio-injection-
```

### ambient 模式

不需要 sidecar,按命名空间把 Pod 纳入网格:

```shell
istioctl install --set profile=ambient -y

# 把命名空间加入 ambient 网格,并查看 ztunnel 状态
kubectl label namespace default istio.io/dataplane-mode=ambient
kubectl get pods -n istio-system -l app=ztunnel
istioctl ztunnel-config all
```

需要七层策略(HTTP 路由、JWT 等)时,再为该命名空间部署一个 waypoint:

```shell
istioctl waypoint apply --enroll-namespace --namespace default
kubectl get gateway -n default
```

### 核心 CRD

```shell
Gateway               入口网关,声明监听端口、协议与证书
VirtualService        路由规则,按域名、路径、Header 分流
DestinationRule       后端策略,定义子集、负载均衡与熔断
ServiceEntry          把集群外的服务纳入网格
PeerAuthentication    服务间 mTLS 策略
RequestAuthentication 终端用户 JWT 校验
AuthorizationPolicy   访问控制
Sidecar               收窄 sidecar 的可见服务范围,减小配置体积
Telemetry             遥测与访问日志配置
```

虚拟服务与目标规则配合做灰度,是最常用的一组:

```shell
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: reviews
  namespace: default
spec:
  hosts:
    - reviews
  http:
    - match:
        - headers:
            end-user:
              exact: tester
      route:
        - destination:
            host: reviews
            subset: v2
    - route:
        - destination:
            host: reviews
            subset: v1
          weight: 90
        - destination:
            host: reviews
            subset: v2
          weight: 10
---
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: reviews
  namespace: default
spec:
  host: reviews
  trafficPolicy:
    outlierDetection:
      consecutive5xxErrors: 5
      interval: 30s
      baseEjectionTime: 30s
  subsets:
    - name: v1
      labels:
        version: v1
    - name: v2
      labels:
        version: v2
```

入口网关。注意 Istio 的 `Gateway` 与 Gateway API 的 `Gateway` 是两个不同的资源:

```shell
apiVersion: networking.istio.io/v1
kind: Gateway
metadata:
  name: bookinfo-gateway
  namespace: default
spec:
  selector:
    istio: ingressgateway      # 选中 istio-ingressgateway 的 Pod
  servers:
    - port:
        number: 80
        name: http
        protocol: HTTP
      hosts:
        - "*"
```

网关只是入口。还要再写一条 `VirtualService`,用 `spec.gateways` 引用它,路由才会真正生成,且 `spec.hosts` 与网关的 `hosts` 要能匹配上。

### 开启严格 mTLS

放在 `istio-system` 命名空间表示对整个网格生效:

```shell
apiVersion: security.istio.io/v1
kind: PeerAuthentication
metadata:
  name: default
  namespace: istio-system
spec:
  mtls:
    mode: STRICT
```

### 可观测性

```shell
# 安装官方示例自带的 Kiali、Prometheus、Grafana、Jaeger
kubectl apply -f samples/addons/

# 打开面板
istioctl dashboard kiali
```

### 升级

```shell
# 1. 升级 istioctl 本体
curl -L https://istio.io/downloadIstio | ISTIO_VERSION=1.24.0 sh -

# 2. 预演并执行原地升级
istioctl upgrade --dry-run
istioctl upgrade -y

# 3. 滚动重启业务 Pod,把旧版 sidecar 换掉
kubectl rollout restart deployment -n default
```

更稳妥的做法是用 revision 做金丝雀升级,让新旧两个控制平面并存一段时间:

```shell
istioctl install --set revision=1-24-0 -y
kubectl label namespace default istio.io/rev=1-24-0 istio-injection-
kubectl rollout restart deployment -n default

# 业务全部迁移完成后,再删掉旧 revision
istioctl uninstall --revision=default -y
```

### 卸载

```shell
istioctl uninstall --purge -y
kubectl delete namespace istio-system
```

### 注意

1. **sidecar 注入依赖命名空间标签,且只对新建 Pod 生效**。给命名空间打完 `istio-injection=enabled` 之后,已经在跑的 Pod 不会自动补上 sidecar,必须 `kubectl rollout restart` 重建。判断是否注入成功看 `READY` 是不是 `2/2`。
2. **同时打 `istio-injection` 与 `istio.io/rev` 两个标签时,`istio-injection` 优先**。做 revision 金丝雀升级时务必先把旧的 `istio-injection` 标签摘掉,否则命名空间仍会被旧控制平面接管,升级看起来「没生效」。
3. **Istio 的 CRD 体积很大,`kubectl apply` 会报 `metadata.annotations: Too long: must have at most 262144 bytes`**。原因是客户端 apply 会把整个清单塞进 `kubectl.kubernetes.io/last-applied-configuration` 注解,而注解上限是 256 KiB。解决办法是改用服务端 apply(`kubectl apply --server-side -f ...`)或 `kubectl create`。
4. **Istio 的 `Gateway` 不是 Gateway API 的 `Gateway`**。前者属于 `networking.istio.io` 组,只能被 Istio 自身识别;后者属于 `gateway.networking.k8s.io` 组,是跨实现的行业标准。两者同名不同物,`kubectl get gateway` 会提示需要指定资源组,排障时先确认在说哪一个。
5. **必须先升级 istiod,再换数据平面**。控制平面允许比数据平面领先一个小版本,反过来不保证兼容。业务 Pod 里的旧 sidecar 不会随控制平面自动更新,必须重启 Pod 才会换成新镜像。
6. **`istioctl` 与被管理的集群版本必须匹配**。用 1.22 的 CLI 去操作 1.24 的集群会直接报错,升级前先同步 CLI。
7. **每个 sidecar 都有实打实的资源开销**。Envoy 单实例通常占用几十 MB 内存,几百个 Pod 的集群光 sidecar 就可能吃掉数十 GB。资源紧张时优先考虑 ambient 模式,或用 `Sidecar` 资源把 sidecar 的可见服务范围收窄。
8. **默认配置下 Istio 不做 mTLS 强制**。要显式配置 `PeerAuthentication` 的 `STRICT` 模式,否则服务间仍是明文通信。
9. **`istioctl uninstall` 不加 `--purge` 不会删除命名空间**,残留的 `istio-system` 与 CRD 会让重装出现版本冲突。
10. **Istio 会接管 Pod 的网络流量,可能与网络插件和安全策略冲突**。集群开启严格网络策略、或禁止容器提权时,可能出现 sidecar 起不来或流量不通,正式上线前先在测试集群验证。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `istioctl` — Istio服务网格的官方命令行工具
- `kiali` — Istio服务网格的可视化控制台
- `helm` — Kubernetes包管理器
- `linkerd` — 轻量级服务网格实现
- `gateway-api` — Kubernetes七层路由API标准

### 参考链接

- [Istio 官方文档](https://istio.io/latest/docs/)
- [使用 istioctl 安装](https://istio.io/latest/docs/setup/install/istioctl/)
- [Istio 流量管理](https://istio.io/latest/docs/concepts/traffic-management/)
- [Ambient 模式](https://istio.io/latest/docs/ambient/)
