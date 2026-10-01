emissary
===

基于Envoy的Kubernetes API网关与Ingress Controller

## 补充说明

**Emissary-ingress** 的前身是 Ambassador,是 CNCF 孵化的 API 网关项目,数据平面同样基于 Envoy。

它和 Contour 都属于「Envoy 系」的入口组件,但定位不同:

```shell
Contour      侧重「Ingress Controller」,把入口路由做好做全
Emissary     侧重「API 网关」,在入口之上叠加认证、限流、流量切分等能力
```

具体到能力清单上,Emissary 更强调这些:

- **API 网关语义**:`Mapping` 资源直接描述「把哪个 URL 前缀映射到哪个服务」,概念上更接近 API 网关而不是 Ingress。
- **认证与鉴权**:内置 JWT、OAuth、API Key、外部鉴权服务(ExtAuth)等过滤器。
- **流量切分与灰度**:基于权重和 Header 的金丝雀发布是原生能力。
- **协议支持**:除 HTTP/HTTPS 外,还处理 gRPC、gRPC-Web、WebSocket、TCP。
- **开发者门户**:配套的 Ambassador Edge Stack 提供 API 目录与自助式开发者门户(商业版)。

Emissary 由两个部分组成:

```shell
emissary            数据平面 + 控制平面,基于 Envoy,部署在 emissary 命名空间
emissary-apiext     CRD 的转换 Webhook,部署在 emissary-system 命名空间
```

**`emissary-apiext` 是必须保持运行的组件**。它负责在 `getambassador.io/v2` 与 `getambassador.io/v3alpha1` 之间做 CRD 版本转换,一旦它挂掉,所有 v3alpha1 的自定义资源都会失效。

### 安装

Emissary 的 CRD 与主程序是**分开发布**的,必须分两步走:**先装 CRD,再装主程序**。

```shell
# 方式一:经典 Helm 仓库
helm repo add datawire https://app.getambassador.io
helm repo update

# 1. 先创建命名空间并安装 CRD
kubectl create namespace emissary
kubectl apply -f https://app.getambassador.io/yaml/emissary/3.9.1/emissary-crds.yaml

# 2. 等待 CRD 转换 Webhook 就绪
kubectl wait --timeout=90s --for=condition=available \
  deployment emissary-apiext -n emissary-system

# 3. 安装主程序
helm install emissary-ingress --namespace emissary datawire/emissary-ingress

# 4. 等待数据平面就绪
kubectl -n emissary wait --for condition=available --timeout=90s \
  deploy -lapp.kubernetes.io/instance=emissary-ingress
```

4.x 起官方改用 OCI 仓库,CRD 也做成了独立的 chart:

```shell
helm install emissary-crds \
  oci://ghcr.io/emissary-ingress/emissary-crds-chart --version=4.0.1 --wait

helm install emissary --namespace emissary --create-namespace \
  oci://ghcr.io/emissary-ingress/emissary-ingress --version=4.0.1
```

注意 CRD chart 与主程序**会落在不同的命名空间**,`helm list -A` 才能看全。

验证并获取入口地址:

```shell
kubectl get all -n emissary
kubectl get all -n emissary-system
kubectl get crd | grep getambassador.io

# 如果 EXTERNAL-IP 一直是 pending,用端口转发代替
kubectl port-forward deployment/emissary-ingress 8080:8080 -n emissary
```

### 核心 CRD

```shell
Mapping       把 URL 前缀映射到 Kubernetes Service,最核心的资源
Listener      声明监听端口、协议与安全模型
Host          虚拟主机,绑定域名与 TLS 证书
TLSContext    TLS 配置,可被 Host 或 Listener 引用
Filter        请求/响应过滤器,做认证、限流、改写
FilterPolicy  把 Filter 绑定到具体的 Mapping 上
```

最小的 Mapping,把 `/backend/` 映射到一个 Service:

```shell
apiVersion: getambassador.io/v3alpha1
kind: Mapping
metadata:
  name: backend-mapping
  namespace: default
spec:
  hostname: "*"
  prefix: /backend/
  service: backend-svc.default:8080
```

带重写、超时与重试的 Mapping:

```shell
apiVersion: getambassador.io/v3alpha1
kind: Mapping
metadata:
  name: api-mapping
  namespace: default
spec:
  hostname: "api.example.com"
  prefix: /v1/
  service: api-svc.default:8080
  rewrite: /
  timeout_ms: 30000
  idle_timeout_ms: 60000
  connect_timeout_ms: 5000
  retry_policy:
    retry_on: "5xx"
    num_retries: 3
    per_try_timeout: 5s
```

按权重做灰度。Emissary 用**两个 Mapping 加 `weight`** 实现,权重是相对值:

```shell
apiVersion: getambassador.io/v3alpha1
kind: Mapping
metadata:
  name: app-v1
  namespace: default
spec:
  hostname: "app.example.com"
  prefix: /
  service: app-v1.default:80
  weight: 90
---
apiVersion: getambassador.io/v3alpha1
kind: Mapping
metadata:
  name: app-v2
  namespace: default
spec:
  hostname: "app.example.com"
  prefix: /
  service: app-v2.default:80
  weight: 10
```

按 Header 精确切流给测试用户时,用 `precedence` 控制优先级(数字小的先匹配):

```shell
apiVersion: getambassador.io/v3alpha1
kind: Mapping
metadata:
  name: app-canary
  namespace: default
spec:
  hostname: "app.example.com"
  prefix: /
  service: app-v2.default:80
  precedence: 1
  headers:
    X-Canary: "true"
```

### Host 与 TLS

`Host` 资源用来声明域名与证书:

```shell
apiVersion: getambassador.io/v3alpha1
kind: Host
metadata:
  name: example-host
  namespace: default
spec:
  hostname: app.example.com
  acmeProvider:
    authority: none           # 用自备证书时设为 none
  tlsSecret:
    name: example-tls         # 必须是 kubernetes.io/tls 类型
```

要让 Emissary 自己通过 ACME 申请证书,把 `acmeProvider.authority` 改成 Let's Encrypt 的目录地址并配置 `acmeProvider.email`。

```shell
kubectl create secret tls example-tls --cert=tls.crt --key=tls.key -n default
```

Emissary 也支持标准的 Ingress,但能力受限于标准 API 的字段:

```shell
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web-ingress
  annotations:
    kubernetes.io/ingress.class: emissary
spec:
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

### 排障

```shell
# 数据平面日志
kubectl -n emissary logs deploy/emissary-ingress --tail=100 -f

# CRD 转换 Webhook 日志,CRD 相关问题的第一站
kubectl -n emissary-system logs deploy/emissary-apiext --tail=100

# 查看所有 Mapping 及其状态
kubectl get mappings -A
kubectl describe mapping backend-mapping

# Envoy 管理接口
kubectl -n emissary port-forward deploy/emissary-ingress 8001:8001
curl -s localhost:8001/clusters
```

### 升级

升级必须严格两步走,**顺序不能反**:

```shell
# 1. 先更新 CRD
kubectl apply -f https://app.getambassador.io/yaml/emissary/3.10.0/emissary-crds.yaml

# 2. 再升级主程序
helm upgrade emissary-ingress --namespace emissary datawire/emissary-ingress

# 3. 观察是否全部就绪
kubectl -n emissary rollout status deploy/emissary-ingress
```

### 注意

1. **CRD 必须先于主程序安装**。Emissary 的 CRD 不随 Helm chart 一起管理,`helm install` 不会替你创建它们。少了这一步,主程序起来后所有 Mapping、Host 都会创建失败。
2. **`emissary-apiext` 转换 Webhook 必须保持运行**。它负责 CRD 的版本转换,Pod 挂掉期间所有 `v3alpha1` 资源都无法读取或写入。这个组件在 `emissary-system` 命名空间,不在 `emissary`,排查时容易漏掉。
3. **`emissary-apiext` 的证书一年后过期且不会自动续期**。这是 2.x 与 3.x 上的已知问题,到期后 CRD 操作会开始报 x509 错误。处理办法是删除旧 Secret 并重启:先 `kubectl delete --all secrets --namespace=emissary-system`,再 `kubectl rollout restart deploy/emissary-apiext -n emissary-system`。
4. **升级必须「先 CRD、后主程序」**。反过来会出现主程序已经用上新 schema、CRD 还是旧版的情况,资源写入被拒。跨大版本升级前务必读一遍官方的升级路径文档,有些版本必须逐级升。
5. **灰度是靠多个 Mapping 加 `weight` 实现的**。权重是**相对值**而不是百分比,两个 Mapping 的权重比就是流量比。写 `weight: 90` 与 `weight: 10` 表示九比一,单独一个 Mapping 写 `weight: 5` 没有意义。
6. **`precedence` 数字越小优先级越高**。不指定时 Emissary 会按映射的匹配长度自动排序,一旦手工设置了 `precedence` 就必须自己保证整组 Mapping 的优先级顺序合理,否则会出现难以理解的匹配结果。
7. **Host 资源的 `tlsSecret` 必须与 Host 在同一命名空间**,且 Secret 类型必须是 `kubernetes.io/tls`。用 `kubectl create secret generic` 建的 Opaque 类型不会被识别,证书静默失效。
8. **Helm 安装的 chart 名是 `emissary-ingress`,不是 `ambassador`**。Emissary 2.x/3.x 要使用 `emissary-ingress` 这个 chart,用错 chart 会装出另一套东西。
9. **`app.getambassador.io` 仓库里没有独立的 `emissary-crds` chart**。经典仓库路径下 CRD 只能通过 `kubectl apply` 那份 `emissary-crds.yaml` 安装,要做 GitOps 时应当把它作为普通清单纳入,而不是当成 HelmRelease。
10. **Envoy 配置由 Emissary 通过 xDS 下发,不要手改**。进 Pod 直接编辑配置文件会在下一次推送时被覆盖,一切改动都应通过 CRD 或注解完成。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `envoy` — Emissary的数据平面
- `ingress` — Emissary同时支持的标准路由对象
- `contour` — 同样基于Envoy的Ingress Controller
- `gateway-api` — Emissary逐步支持的标准API
- `helm` — Kubernetes包管理器

### 参考链接

- [Emissary-ingress 官方文档](https://emissary-ingress.dev/docs/)
- [Emissary-ingress 快速开始](https://emissary-ingress.dev/docs/4.0/quick-start/)
- [Mapping 资源参考](https://emissary-ingress.dev/docs/4.0/topics/using/intro-mappings/)
- [Emissary-ingress GitHub](https://github.com/emissary-ingress/emissary)
