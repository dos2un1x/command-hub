envoy
===

高性能L4/L7代理,是众多网关与服务网格共用的数据平面

## 补充说明

**Envoy** 是一个用 C++ 编写的高性能代理,在 Kubernetes 生态里的位置非常特殊:**它通常不是给人直接用的产品,而是别人产品里的数据平面**。

把这一点想清楚,很多困惑就消失了:

- 用 Istio,每个 Pod 里的 `istio-proxy` 就是 Envoy。
- 用 Contour,`projectcontour` 命名空间里跑的那个 `envoy` Deployment 就是 Envoy。
- 用 Emissary、Higress、Gloo,数据平面也全都是 Envoy。
- 用 **Envoy Gateway**,则是把 Envoy 本身当作一个 Gateway API 实现来用,提供 `GatewayClass` 与控制器。

所以「在 k8s 上运维 Envoy」有两种截然不同的场景:

1. **作为某个上层组件的内部实现**:你不直接碰 Envoy 配置,而是操作上层的 CRD(HTTPRoute、HTTPProxy、VirtualService),由那个组件通过 xDS 把配置翻译给 Envoy。
2. **独立部署 Envoy 做边缘代理或东西向代理**:自己写一份 bootstrap 配置,用 Deployment 或 DaemonSet 跑起来,适合做简单的固定转发、协议透传,或者当作学习 xDS 的实验环境。

### 核心概念

理解这四个概念,就能看懂 Envoy 的配置结构:

```shell
Listener       监听器,绑定 IP 与端口,负责接收连接
Filter Chain   过滤器链,在连接上挂载编解码、鉴权、限流等能力
Cluster        上游集群,一组逻辑相同的后端实例,定义负载均衡与连接池
Endpoint       集群里的具体实例地址
```

以及它的两套配置来源:

```shell
静态配置   写在 bootstrap 文件里,启动时加载,改动需重启
xDS 动态配置 由控制平面通过 gRPC 下发(LDS/RDS/CDS/EDS/SDS),热更新
```

**xDS 是 Envoy 最关键的设计**。控制平面可以不停机地推送新的监听器、路由、集群和证书,这正是 Istio 能做到「改一条 CRD 立刻生效」的原因。

### 用 Envoy Gateway 部署

如果目的是**把 Envoy 当成 Kubernetes 的网关来用**,现在的标准做法是 Envoy Gateway —— 它把 Envoy 包装成一个符合 Gateway API 的实现:

```shell
# 一条命令同时装 Gateway API CRD 与 Envoy Gateway 控制器
helm install eg oci://docker.io/envoyproxy/gateway-helm \
  --version v1.9.1 -n envoy-gateway-system --create-namespace

# 等待控制器就绪
kubectl wait --timeout=5m -n envoy-gateway-system \
  deployment/envoy-gateway --for=condition=Available

# 应用官方示例:GatewayClass、Gateway、HTTPRoute 与示例应用
kubectl apply -f https://github.com/envoyproxy/gateway/releases/download/v1.9.1/quickstart.yaml -n default

# 查看控制器自动创建的 Envoy 代理与地址
kubectl get gatewayclass
kubectl get pods -n envoy-gateway-system
kubectl get gateway/eg -o jsonpath='{.status.addresses[0].value}'
```

Envoy Gateway 会自动根据 `Gateway` 资源拉起一批 Envoy 代理 Pod,你只操作 Gateway API 资源,不直接写 Envoy 配置。

### 独立部署 Envoy

自己跑一个 Envoy,用 ConfigMap 挂载 bootstrap 配置:

```shell
apiVersion: v1
kind: ConfigMap
metadata:
  name: envoy-bootstrap
  namespace: default
data:
  envoy.yaml: |
    static_resources:
      listeners:
        - name: listener_0
          address:
            socket_address:
              address: 0.0.0.0
              port_value: 10000
          filter_chains:
            - filters:
                - name: envoy.filters.network.http_connection_manager
                  typed_config:
                    "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                    stat_prefix: ingress_http
                    route_config:
                      name: local_route
                      virtual_hosts:
                        - name: backend
                          domains: ["*"]
                          routes:
                            - match:
                                prefix: "/"
                              route:
                                cluster: web
                    http_filters:
                      - name: envoy.filters.http.router
                        typed_config:
                          "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
      clusters:
        - name: web
          type: STRICT_DNS
          load_assignment:
            cluster_name: web
            endpoints:
              - lb_endpoints:
                  - endpoint:
                      address:
                        socket_address:
                          address: web-svc
                          port_value: 80
    admin:
      address:
        socket_address:
          address: 127.0.0.1
          port_value: 9901
```

注意 `admin` 绑定在 `127.0.0.1`,这是有意的:管理接口能读取全部配置、还能改日志级别,绝不能暴露到集群外。

配套的 Deployment:

```shell
apiVersion: apps/v1
kind: Deployment
metadata:
  name: envoy
  namespace: default
spec:
  replicas: 2
  selector:
    matchLabels:
      app: envoy
  template:
    metadata:
      labels:
        app: envoy
    spec:
      containers:
        - name: envoy
          image: envoyproxy/envoy:v1.31-latest
          args: ["-c", "/etc/envoy/envoy.yaml", "--log-level", "info"]
          ports:
            - containerPort: 10000
              name: http
          readinessProbe:
            httpGet:
              path: /ready
              port: 9901
          volumeMounts:
            - name: bootstrap
              mountPath: /etc/envoy
      volumes:
        - name: bootstrap
          configMap:
            name: envoy-bootstrap
```

### 验证配置

Envoy 自带 `--mode validate`,可以在不启动的情况下检查配置是否合法:

```shell
# 本地校验配置文件
envoy --mode validate -c envoy.yaml

# 容器里校验
kubectl exec -it deploy/envoy -- envoy --mode validate -c /etc/envoy/envoy.yaml
```

### 通过管理接口排障

管理接口(admin)是 Envoy 排障的核心工具:

```shell
# 转发管理端口到本地
kubectl port-forward deploy/envoy 9901:9901

# 查看完整配置(静态与动态合并后的最终结果)
curl -s localhost:9901/config_dump | jq '.configs | length'

# 查看所有集群
curl -s localhost:9901/clusters

# 查看所有监听器
curl -s localhost:9901/listeners

# 查看统计指标
curl -s localhost:9901/stats | grep upstream_rq

# 只看关键指标
curl -s localhost:9901/stats?filter=upstream_rq_5xx

# 就绪状态
curl -s localhost:9901/ready

# 版本与运行信息
curl -s localhost:9901/server_info

# 临时改日志级别
curl -X POST "localhost:9901/logging?level=debug"

# 优雅排空连接,摘流量时用
curl -X POST localhost:9901/healthcheck/fail
```

Envoy Gateway 托管的代理,管理端口是 19000:

```shell
kubectl port-forward -n envoy-gateway-system pod/<envoy-pod> 19000:19000
curl -s localhost:19000/config_dump | head
```

### 接口与可观测

```shell
# Prometheus 指标(需要配置 stats listener)
curl -s localhost:9901/stats/prometheus | head

# 打开访问日志需要显式配置
access_log:
  - name: envoy.access_loggers.stdout
    typed_config:
      "@type": type.googleapis.com/envoy.extensions.access_loggers.stream.v3.StdoutAccessLog
```

### 注意

1. **Envoy 的配置是 xDS 动态下发的,不要手改单个 Pod 的配置文件**。在 Istio、Contour、Higress 里,Envoy 配置由控制平面根据 CRD 实时生成并推送,手工改文件会被下一次推送覆盖,而且不会报任何错。要改行为必须改上层 CRD。
2. **`admin` 端口绝不能暴露到集群外**。管理接口可以读取全部配置(含证书)、修改日志级别、主动让实例退出健康检查,等于把整个服务交给任何能访问它的人。默认绑定 `127.0.0.1` 是刻意为之,不要为了「方便调试」改成 `0.0.0.0` 或加公网 Service。
3. **Envoy 本身不含控制平面**。自己部署的 Envoy 只能读静态配置,没有服务发现、没有证书轮换、没有配置热更新。要动态能力就必须配一个 xDS 服务器,或者直接改用 Envoy Gateway。
4. **Envoy 实例数量随 Gateway 变化,不要手动干预**。Envoy Gateway、Contour 这类组件会自行管理 Envoy 的 Deployment 与副本数,手工扩缩容或改标签会破坏控制器的管理逻辑,应改上层资源。
5. **`--mode validate` 只能检查语法与结构,不做连通性验证**。它能发现字段拼写错误、类型不匹配,但后端地址写错、证书路径不存在这类问题只有真正启动才会暴露,所以 Deployment 里要配 `readinessProbe` 打到 `/ready`。
6. **`/healthcheck/fail` 是排空流量的开关,不是关机**。调用后实例会主动让负载均衡把流量摘走,但进程仍在运行。节点维护前先调它、等待连接数归零,比直接 `kubectl delete pod` 平滑得多。
7. **Envoy 版本升级要跟着上层组件走**。Istio、Contour 各自绑定经过验证的 Envoy 版本,单独升级某个 Pod 的 Envoy 镜像可能引入协议不兼容,数据平面会与控制平面失联。
8. **`config_dump` 的输出可能非常大**。集群里服务多时动辄几十万行,务必配合 `jq` 或 `--filter` 使用,直接输出到终端容易把会话卡死。
9. **Envoy 的统计指标数量按集群与路由数量倍增**。开启全量 Prometheus 抓取会在几千个实例时产生巨大的指标基数,建议按需过滤或使用 stats listener 做聚合。
10. **不要把它和上层产品混为一谈**。「装 Envoy」在不同语境下可能指装 Envoy Gateway、装 Contour、装 Istio —— 先确认对方说的是哪一层,再决定操作哪个资源。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `istio` — 用Envoy作为数据平面的服务网格
- `contour` — 基于Envoy的Ingress Controller
- `emissary` — 基于Envoy的API网关
- `higress` — 基于Envoy与Istio的云原生网关
- `gateway-api` — Envoy Gateway实现的路由API标准

### 参考链接

- [Envoy 官方文档](https://www.envoyproxy.io/docs/envoy/latest/)
- [Envoy Gateway 快速上手](https://gateway.envoyproxy.io/docs/tasks/quickstart/)
- [Envoy 管理接口](https://www.envoyproxy.io/docs/envoy/latest/operations/admin)
- [xDS 协议概述](https://www.envoyproxy.io/docs/envoy/latest/api-docs/xds_protocol)
