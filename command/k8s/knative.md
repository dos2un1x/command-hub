knative
===

Kubernetes无服务器运行时

## 补充说明

**Knative** 在 Kubernetes 之上提供无服务器(Serverless)能力,最核心的特性是**按请求自动伸缩,并且可以缩容到零**。它由两大部分组成:

- **Knative Serving** —— 请求驱动的服务运行时,负责路由、版本管理、自动伸缩。本文主要讲它。
- **Knative Eventing** —— 事件驱动的一部分,提供 Broker、Trigger、Source 等对象。

Serving 的对象模型:

- **Service(`serving.knative.dev/v1`)** —— 面向使用者的入口,一次声明「镜像 + 版本 + 流量」。
- **Configuration** —— Service 背后维护「当前期望的配置」。
- **Revision** —— 每次配置变更生成一个**不可变**的版本快照,流量按 Revision 切分。
- **Route** —— 把域名映射到 Revision,支持按百分比分流。

伸缩由 **KPA(Knative Pod Autoscaler)** 负责,它支持缩容到零,这是与原生 HPA 最大的区别。

### 环境要求

- 一个受支持的 Kubernetes 集群(kubectl 可用)。
- 官方给出的单节点参考规格:**6 核 CPU / 6GB 内存 / 30GB 磁盘**。
- **一个网络层**,三选一:Kourier(最轻量,官方示例默认)、Istio、Contour。

### 安装

```shell
# 1. 安装 CRD
kubectl apply -f \
  https://github.com/knative/serving/releases/download/knative-v1.21.3/serving-crds.yaml

# 2. 安装核心组件
kubectl apply -f \
  https://github.com/knative/serving/releases/download/knative-v1.21.3/serving-core.yaml

# 3. 安装网络层:Kourier(注意仓库已迁到 knative-extensions)
kubectl apply -f \
  https://github.com/knative-extensions/net-kourier/releases/download/knative-v1.21.1/kourier.yaml

# 4. 把 Kourier 设为默认 Ingress 实现
kubectl patch configmap/config-network \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"ingress-class":"kourier.ingress.networking.knative.dev"}}'

# 5. 验证
kubectl get pods --namespace knative-serving
kubectl get pods --namespace kourier-system

# 6. 取得网络层入口地址(用于配置 DNS)
kubectl --namespace kourier-system get service kourier
```

### 配置域名

Knative 需要一个域名才能生成可访问的 URL。两种做法:

```shell
# 方式一:Magic DNS(用 sslip.io 自动解析,仅测试用)
kubectl apply -f \
  https://github.com/knative/serving/releases/download/knative-v1.21.3/serving-default-domain.yaml

# 方式二:用自己的域名(需要把 DNS 指向网络层入口)
kubectl patch configmap/config-domain \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"knative.example.com":""}}'

# 完全不配 DNS 时,可以先用占位域名
kubectl patch configmap/config-domain \
  --namespace knative-serving \
  --type merge \
  --patch '{"data":{"example.com":""}}'
```

### 安装 kn CLI

```shell
# macOS
brew install knative/client/kn

# Linux:从 Releases 下载后改名并放入 PATH
curl -LO https://github.com/knative/client/releases/latest/download/kn-linux-amd64
chmod +x kn-linux-amd64
sudo mv kn-linux-amd64 /usr/local/bin/kn

# 注意二进制名是 kn-linux-amd64 / kn-darwin-amd64,没有 kn-macos-amd64

# 也可以用容器运行
docker run --rm -v "$HOME/.kube/config:/root/.kube/config" \
  gcr.io/knative-releases/knative.dev/client/cmd/kn:latest service list

kn version
```

### 部署第一个服务

```shell
# 创建服务
kn service create hello \
  --image ghcr.io/knative/helloworld-go:latest \
  --env TARGET="Knative" \
  --port 8080 \
  --scale-min 0 \
  --scale-max 10

# 查看
kn service list
kn revision list
kn route list

# 访问
curl http://hello.default.knative.example.com

# 更新:会产生一个新的 Revision
kn service update hello --env TARGET="v2"

# 流量切分:旧版本 90%,新版本 10%
kn service update hello \
  --traffic hello-00001=90 \
  --traffic @latest=10

# 删除
kn service delete hello
```

`kn service create` 的常用参数:`--image`、`--env`(`-e`)、`--port`(`-p`)、`--annotation`(`-a`)、`--revision-name`、`--cluster-local`、`--concurrency-limit`、`--request` / `--limit`、`--volume` / `--mount`、`--timeout`(默认 300 秒)、`--wait`(默认 true)。

**伸缩参数的写法比较特殊**,不是 `--min-scale`:

```shell
kn service create hello --image <image> --scale-min 1 --scale-max 20
kn service create hello --image <image> --scale 1..5     # 同时指定上下限
kn service create hello --image <image> --scale-metric concurrency \
  --scale-target 50 --scale-utilization 70
```

### 自动伸缩配置

按 Revision 打注解可以覆盖自动伸缩行为:

```shell
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: hello
spec:
  template:
    metadata:
      annotations:
        # 缩容到零(默认值即 0)
        autoscaling.knative.dev/min-scale: "0"
        # 0 表示不限制
        autoscaling.knative.dev/max-scale: "20"
        # 伸缩指标:concurrency(默认)/ rps / cpu / memory
        autoscaling.knative.dev/metric: "concurrency"
        # 每个 Pod 的目标并发,默认 "100"
        autoscaling.knative.dev/target: "50"
        # 目标利用率百分比,默认 70
        autoscaling.knative.dev/target-utilization-percentage: "70"
        # 缩容前的稳定窗口,默认 60s
        autoscaling.knative.dev/window: "60s"
    spec:
      # 硬限制:与上面的软限制取较小值生效
      containerConcurrency: 100
      containers:
      - image: ghcr.io/knative/helloworld-go:latest
```

全局默认值在 `knative-serving` 命名空间的 `config-autoscaler` ConfigMap 中,重点关注 `scale-to-zero-grace-period`(默认 30s)与 `enable-scale-to-zero`(默认 true)。

```shell
kubectl edit configmap config-autoscaler -n knative-serving
kubectl edit configmap config-network -n knative-serving
kubectl edit configmap config-domain -n knative-serving
```

### 注意

1. **不装网络层,Service 不会就绪**。官方安装流程把「安装网络层」作为独立步骤,Kourier / Istio / Contour 必须三选一;没有网络层时 Service 缺少入口,路由无法生效。
2. **默认域名必须显式配置**。不配置 `config-domain` 时,生成的 URL 落在示例域名上,既解析不了也访问不到;测试环境用 Magic DNS,生产环境要配真实域名并把 DNS 指向网络层入口。
3. **缩容到零 = 冷启动**。副本数为 0 时第一个请求要等 Pod 拉起(拉镜像 + 启动进程),延迟敏感的服务应设 `min-scale: 1`,或适当调大 `scale-to-zero-grace-period`。
4. **`kn` 的伸缩参数是 `--scale-min` / `--scale-max`**。没有 `--min-scale`、`--max-scale` 这两个参数,照搬注解名的写法会直接报错。
5. **`target` 是软限制,`containerConcurrency` 是硬限制**。两者同时存在时取较小值生效;只想限制上限就设 `containerConcurrency`,想让调度器按目标值决策就调 `target`。
6. **Revision 不可变**。每次改镜像或环境变量都会生成新的 Revision,回滚就是把流量切回旧 Revision,而不是「修改」旧版本。
7. **缩容到零只对 KPA 生效**。切到 HPA class 的 Revision 不会缩到零,而且 `scale-to-zero-grace-period` 只能在全局 ConfigMap 里配置,不能按 Revision 覆盖。
8. **Kourier 需要集群能提供外部入口**。Magic DNS 依赖 `LoadBalancer` 类型的 Service 暴露 IPv4 地址或主机名;裸机或 minikube 环境需要 `minikube tunnel` 之类的方案,否则只能靠端口转发访问。
9. **`metric: cpu` 依赖 metrics-server**。用并发或 RPS 作为指标不需要,但选 CPU 指标时必须有可用的 metrics-server。
10. **三个 ConfigMap 都在 `knative-serving` 命名空间**。`config-network` 管 Ingress 实现、`config-autoscaler` 管伸缩默认值、`config-domain` 管域名,改错命名空间不生效。
11. **单节点 6 核 6GB 是底线**。低于这个规格时控制器与网络层会互相抢占资源,表现为 Revision 长时间处于 `Deploying` 或频繁重启。
12. **Eventing 是独立安装的**。Serving 装完并不包含 Broker、Trigger 等对象,事件驱动场景需要另装 `eventing-crds.yaml` 与 `eventing-core.yaml`,并额外部署一个 Broker 实现。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `keda` — Kubernetes事件驱动自动伸缩组件
- `hpa` — Kubernetes水平自动伸缩
- `ingress` — Kubernetes入口资源
- `argo-events` — Kubernetes事件驱动自动化框架

### 参考链接

- [Knative 官方文档](https://knative.dev/docs/)
- [用 YAML 安装 Serving](https://knative.dev/v1.21-docs/install/yaml-install/serving/install-serving-with-yaml/)
- [自动伸缩:缩容到零](https://knative.dev/v1.21-docs/serving/autoscaling/scale-to-zero/)
- [自动伸缩:并发度](https://knative.dev/v1.21-docs/serving/autoscaling/concurrency/)
- [安装 kn 客户端](https://knative.dev/docs/client/install-kn/)
