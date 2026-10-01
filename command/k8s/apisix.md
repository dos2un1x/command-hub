apisix
===

Apache APISIX 云原生API网关,以插件体系提供认证、限流与协议转换能力

## 补充说明

**Apache APISIX** 是 Apache 基金会的顶级项目,定位是**API 网关**而不是 Ingress Controller。这个区别很关键:

```shell
Ingress Controller   只解决「外部流量怎么进集群」,路由能力为主
API 网关             在入口之上叠加认证、限流、熔断、协议转换、可观测等业务能力
```

APISIX 的数据平面基于 OpenResty(Nginx + Lua),配置存储在 **etcd** 中,变更通过 etcd 的 watch 机制实时推送到数据平面,**不需要 reload Nginx**。这是它和传统 Nginx 网关最本质的差别。

在 Kubernetes 上使用 APISIX 有三种姿态,先想清楚要哪一种:

```shell
1. 纯 API 网关            只装 APISIX + etcd + Dashboard,路由通过 Admin API 或 Dashboard 配置,与 Kubernetes 资源无关
2. 网关 + Ingress Controller  额外装 apisix-ingress-controller,由 Ingress / Gateway API / ApisixRoute 资源驱动
3. 网关 + Ingress Controller(standalone)  不装 etcd,控制器以 YAML 配置驱动 APISIX,部署最简单
```

第三种(standalone 模式)是近几年官方主推的形态,因为没有 etcd 就少了一大块运维负担。

### 安装

```shell
helm repo add apisix https://apache.github.io/apisix-helm-chart
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update
```

**方式一:APISIX 加 Ingress Controller(默认 etcd 模式)**

```shell
helm install apisix \
  --namespace ingress-apisix \
  --create-namespace \
  --set ingress-controller.enabled=true \
  --set ingress-controller.apisix.adminService.namespace=ingress-apisix \
  --set ingress-controller.gatewayProxy.createDefault=true \
  apisix/apisix
```

**方式二:standalone 模式,不需要 etcd**

```shell
helm install apisix \
  --namespace ingress-apisix \
  --create-namespace \
  --set apisix.deployment.role=traditional \
  --set apisix.deployment.role_traditional.config_provider=yaml \
  --set etcd.enabled=false \
  --set ingress-controller.enabled=true \
  --set ingress-controller.config.provider.type=apisix-standalone \
  --set ingress-controller.apisix.adminService.namespace=ingress-apisix \
  --set ingress-controller.gatewayProxy.createDefault=true \
  apisix/apisix
```

**方式三:只装 Ingress Controller**,用 `apisix/apisix-ingress-controller` chart 连接已有的 APISIX 实例,通过 `--set apisix.adminService.*` 指定 Admin API 所在的命名空间、服务名与端口。

验证:

```shell
kubectl get pods -n ingress-apisix
```

### 默认端口

```shell
9080    HTTP 入口
9443    HTTPS 入口
9180    Admin API,配置网关的核心接口
9000    Dashboard
```

### 用 Ingress 配置路由

```shell
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: httpserver-route
  namespace: default
spec:
  ingressClassName: apisix
  rules:
    - host: httpbin.org
      http:
        paths:
          - path: /get
            pathType: Exact
            backend:
              service:
                name: httpbin
                port:
                  number: 80
```

In 规则不支持的场景下,用 `k8s.apisix.apache.org/` 前缀的注解补齐,例如开启 HTTPS 跳转、指定上游协议等。

### 用 ApisixRoute 配置路由

APISIX 自己的 CRD 能力比 Ingress 强得多,是生产环境推荐的方式:

```shell
apiVersion: apisix.apache.org/v2
kind: ApisixRoute
metadata:
  name: httpbin-route
  namespace: default
spec:
  http:
    - name: rule1
      match:
        hosts:
          - httpbin.org
        paths:
          - /get
        methods:
          - GET
      backends:
        - serviceName: httpbin
          servicePort: 80
          weight: 100
      plugins:
        - name: limit-count
          enable: true
          config:
            count: 100
            time_window: 60
            key_type: var
            key: remote_addr
            rejected_code: 429
```

灰度发布,两个 backend 加权重:

```shell
apiVersion: apisix.apache.org/v2
kind: ApisixRoute
metadata:
  name: canary-route
  namespace: default
spec:
  http:
    - name: canary
      match:
        hosts:
          - app.example.com
        paths:
          - /*
      backends:
        - serviceName: app-v1
          servicePort: 80
          weight: 90
        - serviceName: app-v2
          servicePort: 80
          weight: 10
```

一条路由也可以通过 `plugin_config_name` 引用共享的 `ApisixPluginConfig`,把 CORS、Prometheus 这类通用插件抽出来复用:

```shell
apiVersion: apisix.apache.org/v2
kind: ApisixPluginConfig
metadata:
  name: common-plugins
  namespace: default
spec:
  plugins:
    - name: cors
      enable: true
      config:
        allow_origins: "*"
    - name: prometheus
      enable: true
```

### 常用 CRD

```shell
ApisixRoute           路由规则,APISIX 最核心的资源
ApisixUpstream        上游配置:负载均衡、健康检查、超时
ApisixPluginConfig    插件配置集,可被多条路由复用
ApisixConsumer        消费者,配合认证插件使用
ApisixGlobalRule      全局插件,对所有路由生效
```

### 插件体系

APISIX 的插件通过路由或全局规则启用,配置直接写在路由资源里。常用插件:

```shell
认证      key-auth、basic-auth、jwt-auth、hmac-auth、openid-connect
限流      limit-count、limit-req、limit-conn
安全      ip-restriction、cors、csrf、waf
流量      redirect、rewrite、traffic-split、proxy-rewrite
转换      grpc-transcode、response-rewrite、fault-injection
可观测    prometheus、zipkin、skywalking、opentelemetry
```

插件也支持通过 Wasm 自行扩展,或者用 `serverless-pre-function` 这类函数式插件做临时逻辑。

### 通过 Admin API 直接操作

不装 Ingress Controller 时,直接操作 Admin API:

```shell
kubectl -n ingress-apisix port-forward svc/apisix-admin 9180:9180

# 查看路由列表
curl http://127.0.0.1:9180/apisix/admin/routes -H 'X-API-KEY: <admin-key>'

# 创建一条路由
curl http://127.0.0.1:9180/apisix/admin/routes/1 -X PUT \
  -H 'X-API-KEY: <admin-key>' \
  -d '{
    "uri": "/get",
    "upstream": {
      "type": "roundrobin",
      "nodes": { "httpbin.org:80": 1 }
    }
  }'

# 查看 etcd 中的配置
kubectl -n ingress-apisix exec deploy/apisix-etcd -- \
  etcdctl get /apisix --prefix --keys-only
```

### 排障

```shell
# 数据平面日志
kubectl -n ingress-apisix logs deploy/apisix --tail=100 -f

# Ingress Controller 日志
kubectl -n ingress-apisix logs deploy/apisix-ingress-controller --tail=100 -f

# 错误日志单独看,配置类错误多半在这里
kubectl -n ingress-apisix exec deploy/apisix -- tail -100 /usr/local/apisix/logs/error.log

# 查看某条路由在 APISIX 里的实际形态
curl http://127.0.0.1:9180/apisix/admin/routes -H 'X-API-KEY: <admin-key>' | jq

kubectl -n ingress-apisix get pods
```

### 注意

1. **Admin API 的默认密钥必须改**。APISIX 的默认 admin key 是公开的固定值,不改等于把网关的全部配置权限开放出去。安装后第一件事就是通过 `--set apisix.admin.credentials.admin` 之类的参数换成随机值,并确保 Admin API 只监听集群内。
2. **etcd 是默认配置的唯一存储,它的可用性就是网关配置的可用性**。etcd 挂掉期间,已有配置仍能继续工作,但任何配置变更都无法下发。生产环境要用三节点以上的 etcd 集群,并把数据盘配好。
3. **standalone 模式不需要 etcd,但配置来自 YAML 文件**。控制器会把 Kubernetes 资源渲染成一份声明式配置写入 APISIX 容器。这条路径大幅简化了运维,但要注意它和 etcd 模式在功能上有细微差别,部分依赖 etcd 的能力不可用。
4. **Ingress 注解与 ApisixRoute 是两套体系,不要混用同一个域名**。同一个 host 同时被 Ingress 与 ApisixRoute 声明,会产生难以预期的优先级结果。迁移时应当整块切换。
5. **APISIX 版本与 Ingress Controller 版本存在兼容矩阵**。控制器通过 Admin API 与数据平面通信,两者版本跨度过大会出现字段不识别的问题。升级时对照官方兼容表逐项确认。
6. **插件写在路由级别,不写就不生效**。APISIX 不会自动给所有路由开启可观测或限流,必须在 `plugins` 里显式声明,或用 `ApisixGlobalRule` 全局启用。排查「限流没生效」时先确认插件挂在哪一级。
7. **Dashboard 默认没有强认证且端口是 9000**。不要把 Dashboard 暴露到公网,它等价于 Admin API 的图形界面,能改全部路由与插件配置。
8. **Gateway API 支持需要较新的 Kubernetes 版本**。apisix-ingress-controller 的 Gateway API 支持依赖较高版本的 CRD 与 CEL 校验规则,Kubernetes 版本过低时相关资源无法创建。
9. **`limit-count` 这类计数插件在多副本下需要考虑共享存储**。默认的本地计数在网关多副本时每个 Pod 各算一份,总限额会被放大。需要全局精确限流时要配置 Redis 等外部存储。
10. **不要直接改 Nginx 配置文件**。APISIX 的配置由 etcd 或 YAML 声明式管理,手改 `/usr/local/apisix/conf/nginx.conf` 会在下次重载时被覆盖,一切改动都应通过路由资源或 Admin API 完成。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `ingress` — APISIX支持的上一代路由对象
- `gateway-api` — APISIX支持的新一代路由API
- `kong` — 同为API网关的另一个主流选择
- `higress` — 基于Envoy与Istio的云原生网关
- `helm` — Kubernetes包管理器

### 参考链接

- [Apache APISIX 官方文档](https://apisix.apache.org/docs/apisix/getting-started/)
- [APISIX Ingress Controller](https://apisix.apache.org/docs/ingress-controller/getting-started/)
- [使用 Helm 部署 APISIX Ingress](https://apisix.apache.org/docs/ingress-controller/deployments/helm/)
- [APISIX 插件列表](https://apisix.apache.org/docs/apisix/plugins/)
