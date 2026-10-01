argo-rollouts
===

Kubernetes渐进式交付控制器

## 补充说明

**Argo Rollouts** 是 Kubernetes 的渐进式交付(progressive delivery)控制器,用 `Rollout` 这个 CRD **替代 Deployment**,实现金丝雀发布与蓝绿发布,并支持按流量比例切分、自动分析指标、失败自动回滚。

它和项目里另外两个 Argo 的分工要分清:

- **Argo Rollouts** —— 管**长期运行的服务**如何一步步换成新版本。
- **Argo Workflows** —— 管一次性的批处理/DAG 任务。
- **Argo CD** —— 管 Git 中的清单如何同步到集群。

`Rollout` 可以理解为「加强版 Deployment」:Pod 模板部分与 Deployment 写法一致,但把 `spec.strategy` 换成了 `canary` 或 `blueGreen`。核心 CRD(全部是 `argoproj.io/v1alpha1`):

```shell
Rollout                    工作负载,替代 Deployment
AnalysisTemplate           命名空间级指标分析模板
ClusterAnalysisTemplate    集群级分析模板(需 clusterScope: true)
AnalysisRun                AnalysisTemplate 的一次执行实例
Experiment                 用两个版本的 ReplicaSet 做对比实验
```

### 安装

```shell
# 1. 控制器
kubectl create namespace argo-rollouts
kubectl apply -n argo-rollouts -f \
  https://github.com/argoproj/argo-rollouts/releases/latest/download/install.yaml

# 2. kubectl 插件(macOS)
brew install argoproj/tap/kubectl-argo-rollouts

# 3. 手动安装插件(Linux 把 darwin 换成 linux)
curl -LO https://github.com/argoproj/argo-rollouts/releases/latest/download/kubectl-argo-rollouts-darwin-amd64
chmod +x ./kubectl-argo-rollouts-darwin-amd64
sudo mv ./kubectl-argo-rollouts-darwin-amd64 /usr/local/bin/kubectl-argo-rollouts

# 4. 验证:二进制必须以 kubectl-argo-rollouts 命名并在 PATH 中,
#    kubectl 才会识别出 kubectl argo rollouts 子命令
kubectl argo rollouts version
```

只要命名空间级别的安装(不装 CRD)时,CRD 需要单独安装:

```shell
kubectl apply --server-side -k "https://github.com/argoproj/argo-rollouts/manifests/crds?ref=stable"
```

### 从 Deployment 迁移

把 Deployment 改造成 Rollout 只需三处改动:

```shell
apiVersion: argoproj.io/v1alpha1   # 原来是 apps/v1
kind: Rollout                      # 原来是 Deployment
metadata:
  name: my-app
spec:
  replicas: 5
  selector:
    matchLabels:
      app: my-app
  # 原来是 strategy.rollingUpdate / recreate,现在换成下面两种之一
  strategy:
    canary: {}
  template:
    # Pod 模板部分与 Deployment 完全一致
    metadata:
      labels:
        app: my-app
    spec:
      containers:
      - name: my-app
        image: registry.example.com/my-app:1.0.0
        ports:
        - containerPort: 8080
```

同名 Deployment 与 Rollout 不能共存 —— 迁移时应先删除原 Deployment 再创建 Rollout,否则两套控制器会同时操作同一批 Pod,表现为副本数来回抖动。

### 金丝雀发布(canary)

```shell
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: my-app
spec:
  replicas: 10
  selector:
    matchLabels:
      app: my-app
  strategy:
    canary:
      # 流量切分需要这两个 Service:canary 版与 stable 版
      canaryService: my-app-canary
      stableService: my-app-stable
      trafficRouting:
        nginx:
          # 指向 stable Service 的 Ingress
          stableIngress: my-app-ingress
      steps:
      - setWeight: 10            # 10% 流量到新版本
      - pause: {duration: 5m}    # 观察 5 分钟
      - setWeight: 30
      - pause: {duration: 10m}
      - setWeight: 60
      - pause: {}                # 不带 duration:无限等待,需人工 promote
      analysis:
        templates:
        - templateName: success-rate
        startingStep: 1          # 从第 2 个步骤开始分析
        args:
        - name: service-name
          value: my-app-stable
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
      - name: my-app
        image: registry.example.com/my-app:2.0.0
```

**没有配置 `trafficRouting` 时,`setWeight` 只能近似**:控制器通过调整 canary/stable 的 Pod 数量比例来逼近目标权重,例如 10 个副本设 41% 只会得到 4 个新版本 Pod,并不是精确的流量比例。要精确切流就必须接入 Istio、NGINX Ingress 或 ALB。

### 蓝绿发布(blueGreen)

```shell
  strategy:
    blueGreen:
      # 必需:指向承载正式流量的 Service
      activeService: my-app-active
      # 可选:预览用的 Service,不填则新版本不对外暴露
      previewService: my-app-preview
      # 默认 true,即新版本起来后立即切流;设为 false 需人工 promote
      autoPromotionEnabled: false
      # 自动提升的等待秒数,与 autoPromotionEnabled: false 互斥
      # autoPromotionSeconds: 30
      # 切换后旧版本 ReplicaSet 保留多久再缩容,默认 30
      scaleDownDelaySeconds: 30
      # 上线前/后的分析
      prePromotionAnalysis:
        templates:
        - templateName: smoke-test
```

### 常用命令

```shell
# 查看状态与进度
kubectl argo rollouts list rollouts
kubectl argo rollouts get rollout my-app
kubectl argo rollouts get rollout my-app -w          # 持续观察(等价 --watch)

# 人工推进/放行
kubectl argo rollouts promote my-app                 # 推进到下一步
kubectl argo rollouts promote my-app --full          # 跳过所有分析与暂停,直接完成

# 中止与重试
kubectl argo rollouts abort my-app                   # 中止,流量切回 stable
kubectl argo rollouts retry rollout my-app           # 重试已中止的发布

# 变更镜像(等价于改清单,常用于临时发布)
kubectl argo rollouts set image my-app my-app=registry.example.com/my-app:2.0.1
kubectl argo rollouts set image my-app "*=registry.example.com/my-app:2.0.1"

# 其他
kubectl argo rollouts pause my-app
kubectl argo rollouts restart my-app
kubectl argo rollouts undo my-app
kubectl argo rollouts terminate my-app               # 终止 AnalysisRun / Experiment
kubectl argo rollouts lint rollout.yaml              # 本地校验清单

# Web 仪表盘:默认端口 3100,默认根路径 /rollouts
kubectl argo rollouts dashboard
kubectl argo rollouts dashboard --port 8080
```

### 流量路由的三种接法

```shell
# 1. NGINX Ingress:控制器给 Ingress 打上 canary 注解
#    固定写入 canary: "true" 与 canary-weight: "<数字>"
#    默认注解前缀 nginx.ingress.kubernetes.io,可用 annotationPrefix 覆盖
  trafficRouting:
    nginx:
      stableIngress: my-app-ingress
      # 需要同时指定 canaryService 与 stableService

# 2. Istio:按 VirtualService 的权重切流
  trafficRouting:
    istio:
      virtualService:
        name: my-app-vsvc

# 3. AWS ALB:通过 action 注解改写转发规则
  trafficRouting:
    alb:
      ingress: my-app-ingress     # 必填
      servicePort: 80             # 必填,Ingress 后端端口需写 use-annotation
```

### 分析(Analysis)

```shell
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: success-rate
spec:
  args:
  - name: service-name
  metrics:
  - name: success-rate
    interval: 1m
    count: 5                     # 采样次数
    successCondition: result[0] >= 0.95
    failureLimit: 2
    provider:
      prometheus:
        address: http://prometheus.monitoring.svc.cluster.local:9090
        query: |
          sum(rate(http_requests_total{service="{{args.service-name}}",code!~"5.."}[1m]))
          /
          sum(rate(http_requests_total{service="{{args.service-name}}"}[1m]))
```

```shell
kubectl get analysisrun
kubectl describe analysisrun my-app-2.0.0-abcde
kubectl argo rollouts get rollout my-app            # 视图中会显示分析结果
```

### 注意

1. **Rollout 不是 Deployment 的包装,而是替代品**。控制器只管理 Rollout;同一个应用不能既有 Deployment 又有同名 Rollout,迁移时必须先删掉 Deployment,否则两套控制器争抢 Pod。
2. **不开流量路由时 `setWeight` 只是按副本数近似**。10 个副本、目标 41% 的结果是 4 个新版本 Pod;要精确按百分比切流,必须配置 `trafficRouting` 接入 Istio / NGINX / ALB。
3. **`pause: {}` 不带 duration 会无限等待**。它必须由 `kubectl argo rollouts promote` 放行;在 CI 里误用会让你的流水线挂到天荒地老。带上 `duration` 才会自动继续。
4. **`promote --full` 会跳过全部分析与暂停**。这是应急手段,不是常规操作 —— 它会直接完成发布,所有金丝雀验证形同虚设。
5. **`canaryService` / `stableService` 需要你自己创建**。控制器只会**修改**已有 Service 的 selector 来导流,不会替你创建 Service;引用的 Service 不存在时 Rollout 会一直卡在 `Progressing`。
6. **NGINX 方案要求 Ingress 原本指向 stable Service**。控制器是在这个 Ingress 上加 canary 注解来切流的,如果 Ingress 的 backend 写的是别的 Service,切流不会生效。
7. **`autoPromotionEnabled` 与 `autoPromotionSeconds` 不要同时用**。前者为 `false` 意味着等待人工 promote,后者用于自动提升的延时场景,二者语义冲突。
8. **蓝绿的 `activeService` 是必填项**。`previewService` 可选,不填则新版本不会对外暴露任何入口,想先验证就一定要配上预览 Service。
9. **`kubectl argo rollouts` 是插件,名字和路径都不能错**。二进制必须叫 `kubectl-argo-rollouts` 并放在 `PATH` 中,kubectl 才会把它识别为子命令;改名成 `argo-rollouts` 后 `kubectl argo` 会报未知命令。
10. **避免直接编辑 Rollout 的 Pod 模板而不走版本控制**。Rollout 的状态机(`status.currentPodHash`、`stableRS` 等)记录了发布进度,手工改动会让状态与实际的 ReplicaSet 对不上,必要时用 `kubectl argo rollouts restart` 重新走一遍流程。
11. **分析失败会触发自动回滚**。`AnalysisRun` 达不到 `successCondition` 时 Rollout 会被中止并切回 stable,排查时应先看 AnalysisRun 的详情,而不是怀疑控制器本身。
12. **Rollout 与 HPA 会有副本数冲突**。若用 HPA 管理副本数,不要在清单里硬写 `spec.replicas`;用 Argo CD 管理时同样要忽略 `/spec/replicas` 的差异。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `argocd` — Kubernetes声明式GitOps持续交付工具
- `argo-workflows` — Kubernetes原生工作流引擎
- `argo-events` — Kubernetes事件驱动自动化框架
- `deployment` — Kubernetes无状态工作负载

### 参考链接

- [Argo Rollouts 官方文档](https://argo-rollouts.readthedocs.io/en/stable/)
- [安装指南](https://argo-rollouts.readthedocs.io/en/stable/installation/)
- [金丝雀发布](https://argo-rollouts.readthedocs.io/en/stable/features/canary/)
- [蓝绿发布](https://argo-rollouts.readthedocs.io/en/stable/features/bluegreen/)
- [流量管理](https://argo-rollouts.readthedocs.io/en/stable/features/traffic-management/)
- [kubectl 插件](https://argo-rollouts.readthedocs.io/en/stable/features/kubectl-plugin/)
