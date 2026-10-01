argo-events
===

Kubernetes事件驱动自动化框架

## 补充说明

**Argo Events** 把「外部事件」变成「集群内的动作」:接收 Webhook、消息队列、云存储、日历等来源的事件,经过过滤与转换后触发 Kubernetes 资源 —— 最典型的用法是**事件一到就创建一个 Argo Workflow**。

数据流由三个 CRD(全部是 `argoproj.io/v1alpha1`)组成,缺一不可:

- **EventSource** —— 事件入口。定义从哪种系统接收事件(webhook、Kafka、S3、GitHub、Calendar 等),控制器会为它运行一个接收 Pod。
- **EventBus** —— 事件传输层。EventSource 收到的事件先进 EventBus,再由 Sensor 消费。它是**命名空间级**对象,每个要用 Argo Events 的命名空间都得有一个。
- **Sensor** —— 事件消费与动作触发。订阅 EventBus 上的事件,按依赖与过滤条件判断,然后触发动作(创建 Workflow、创建 K8s 对象、发 HTTP 请求等)。

因此典型的处理链路是:**EventSource 收到事件 → 投递到 EventBus → Sensor 消费并过滤 → 创建 Workflow / 其他资源**。

### 安装

```shell
# 1. 创建命名空间
kubectl create namespace argo-events

# 2. 集群级安装(EventSource/Sensor 可作用于任意命名空间)
kubectl apply -f \
  https://raw.githubusercontent.com/argoproj/argo-events/stable/manifests/install.yaml

# 带准入校验 Webhook 的版本(推荐用于生产)
kubectl apply -f \
  https://raw.githubusercontent.com/argoproj/argo-events/stable/manifests/install-validating-webhook.yaml

# 命名空间级安装(控制器只处理本命名空间)
kubectl apply -f \
  https://raw.githubusercontent.com/argoproj/argo-events/stable/manifests/namespace-install.yaml

# 3. 安装事件总线(每个命名空间一份)
kubectl apply -n argo-events -f \
  https://raw.githubusercontent.com/argoproj/argo-events/stable/examples/eventbus/native.yaml

# 也可以用社区维护的 Helm Chart
helm repo add argo https://argoproj.github.io/argo-helm
helm install argo-events argo/argo-events -n argo-events --create-namespace

# 4. 验证
kubectl get pods -n argo-events
kubectl get eventbus -n argo-events
```

集群级安装会创建 `argo-events-sa` 等 ServiceAccount 以及 `argo-events-webhook` 等 ClusterRole,控制器以它们作为运行身份。

### EventBus

三种可选后端,`native` 是官方示例默认使用的 NATS 内置部署:

```shell
# 方式一:native(内置 NATS,最少 3 副本)
apiVersion: argoproj.io/v1alpha1
kind: EventBus
metadata:
  name: default
  namespace: argo-events
spec:
  nats:
    native:
      replicas: 3          # 最小要求是 3
      auth: token          # none 或 token
```

```shell
# 方式二:JetStream(推荐用于生产)
apiVersion: argoproj.io/v1alpha1
kind: EventBus
metadata:
  name: default
  namespace: argo-events
spec:
  jetstream:
    version: 2.10.11       # 不要写 latest,生产环境请锁定具体版本
```

```shell
# 方式三:对接已有的 Kafka
apiVersion: argoproj.io/v1alpha1
kind: EventBus
metadata:
  name: default
  namespace: argo-events
spec:
  kafka:
    url: kafka.default.svc.cluster.local:9092
    topic: argo-events
```

JetStream 可用的 NATS 版本列表可以从控制器配置里查:

```shell
kubectl get configmap argo-events-controller-config -n argo-events -o yaml
```

EventBus 的名字默认是 `default`;若用别的名字,EventSource 与 Sensor 都必须显式指定 `eventBusName`。

### EventSource:Webhook 示例

```shell
apiVersion: argoproj.io/v1alpha1
kind: EventSource
metadata:
  name: webhook
  namespace: argo-events
spec:
  # 控制器会为 EventSource 创建 Service,端口必须在这里声明
  service:
    ports:
    - port: 12000
      targetPort: 12000
  webhook:
    example:
      port: "12000"
      endpoint: /example
      method: POST
```

```shell
# 查看接收 Pod(按标签选择,不要猜 Pod 名字)
kubectl -n argo-events get pods --selector eventsource-name=webhook

# Service 名称规则:<eventsource 名>-eventsource-svc
kubectl -n argo-events get svc

# 本地验证:把接收端口转发出来
kubectl -n argo-events port-forward svc/webhook-eventsource-svc 12000:12000

# 发送一条测试事件
curl -d '{"message":"this is my first webhook"}' \
  -H "Content-Type: application/json" \
  -X POST http://localhost:12000/example
```

### Sensor:收到事件后创建 Workflow

```shell
apiVersion: argoproj.io/v1alpha1
kind: Sensor
metadata:
  name: webhook
  namespace: argo-events
spec:
  template:
    # Sensor 用这个身份去创建 Workflow,权限不足时会静默失败
    serviceAccountName: operate-workflow-sa
  dependencies:
  - name: test-dep
    eventSourceName: webhook
    eventName: example
  triggers:
  - template:
      name: webhook-workflow-trigger
      k8s:
        operation: create
        source:
          resource:
            apiVersion: argoproj.io/v1alpha1
            kind: Workflow
            metadata:
              generateName: webhook-
            spec:
              entrypoint: print-message
              arguments:
                parameters:
                - name: message
                  value: hello world
              templates:
              - name: print-message
                inputs:
                  parameters:
                  - name: message
                container:
                  image: busybox
                  command: [echo]
                  args: ["{{inputs.parameters.message}}"]
        # 把事件体里的字段映射到 Workflow 的参数上
        parameters:
        - src:
            dependencyName: test-dep
            dataKey: body
          dest: spec.arguments.parameters.0.value
```

`dependencies[].name` 是这条依赖在 Sensor 内部的代号,`parameters[].src.dependencyName` 必须与之对应;`dataKey` 取事件体中的字段(如 `body`、`header`),`dest` 是要写入的字段路径。

### Sensor 的权限

Sensor 创建 Workflow 用的是它自己 `template.serviceAccountName` 指定的身份,必须提前授予权限:

```shell
apiVersion: v1
kind: ServiceAccount
metadata:
  name: operate-workflow-sa
  namespace: argo-events
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: operate-workflow-role
  namespace: argo-events
rules:
- apiGroups: ["argoproj.io"]
  resources: ["workflows", "workflowtemplates", "cronworkflows"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
```

再用 RoleBinding 绑定。跨命名空间创建 Workflow 时需要 ClusterRole 与 ClusterRoleBinding。

### 常用排查命令

```shell
# 三类对象的状态
kubectl get eventsources -n argo-events
kubectl get sensors -n argo-events
kubectl get eventbus -n argo-events
kubectl describe eventsource webhook -n argo-events
kubectl describe sensor webhook -n argo-events

# 组件日志
kubectl logs -n argo-events deploy/argo-events-controller --tail=200
kubectl logs -n argo-events -l eventsource-name=webhook --tail=200
kubectl logs -n argo-events -l sensor-name=webhook --tail=200

# 事件是否真的到达:确认 EventBus 与 Sensor 的 Pod 都在运行
kubectl get pods -n argo-events -l app.kubernetes.io/part-of=argo-events
```

Argo Events 没有独立的 CLI,`argo` 命令属于 Argo Workflows —— 排查一律用 `kubectl`。

### 注意

1. **每个命名空间都必须先有 EventBus**。EventBus 是命名空间级的,EventSource 与 Sensor 都依赖它;某个命名空间里没有 EventBus,该命名空间的 EventSource/Sensor 就无法工作 —— 这是最常见的「配好了却没反应」的原因。
2. **EventBus 名字不是 `default` 时必须显式声明**。在 EventSource 与 Sensor 里都要写 `eventBusName`,漏写会去连默认的 `default` 而找不到对象。
3. **Sensor 权限不足会表现为「事件来了但什么都没发生」**。Sensor 用 `template.serviceAccountName` 的身份创建资源,ServiceAccount 不存在或没有 `create workflows` 权限时,触发动作失败,而事件本身早已被正常消费掉。
4. **Webhook 的端口与路径要和 Service 声明一致**。`spec.service.ports` 决定控制器创建的 Service 端口,`webhook.<name>.port` / `endpoint` 决定 Pod 真正监听的端口与路径,三者不一致时请求会 404 或连接被拒。
5. **不要用 `latest` 作为 JetStream 版本**。官方在示例旁明确提醒生产环境要锁定具体版本,否则控制器或 NATS 升级后事件总线的行为会变。
6. **STAN(NATS Streaming)已被官方标注为「最终会被废弃」**。新部署建议直接用 `jetstream`,老环境应尽早迁移。
7. **`native` 模式的 EventBus 至少需要 3 个副本**。文档说明副本数最小为 3,填小于 3 的值会被拉齐到 3。
8. **事件投递是「至少一次」语义**。同一条事件可能被投递多次,依赖事件去重的场景要在 Workflow 侧做幂等,不能假设一条事件只对应一次执行。
9. **Pod 名字是随机的,按标签选**。EventSource/Sensor 的 Pod 名带哈希后缀,`kubectl logs <pod>` 前请用 `--selector eventsource-name=<名称>` / `sensor-name=<名称>` 定位。
10. **集群级与命名空间级安装的权限模型不同**。`install.yaml` 装的是 ClusterRole,能跨命名空间工作;`namespace-install.yaml` 只在本命名空间内有效,选错了会出现「权限不足」或「看不到别的命名空间对象」。
11. **EventSource 会长期占用一个 Pod 与一个 Service**。数量多了会显著增加集群对象与端口占用,不再使用时记得删除对应 CR。
12. **修改 EventSource 需要重建接收 Pod**。改完清单后控制器会滚动更新接收 Pod,期间事件可能丢失,生产环境的变更要避开事件高峰。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `argo-workflows` — Kubernetes原生工作流引擎
- `argo-rollouts` — Kubernetes渐进式交付控制器
- `argocd` — Kubernetes声明式GitOps持续交付工具

### 参考链接

- [Argo Events 官方文档](https://argoproj.github.io/argo-events/)
- [安装指南](https://argoproj.github.io/argo-events/installation/)
- [EventBus 说明](https://argoproj.github.io/argo-events/eventbus/)
- [EventSource:Webhook](https://argoproj.github.io/argo-events/eventsources/setup/webhook/)
- [快速开始](https://argoproj.github.io/argo-events/quick_start/)
