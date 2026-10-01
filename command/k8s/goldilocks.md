goldilocks
===

Kubernetes资源建议工具:基于VPA为工作负载推荐requests与limits

## 补充说明

**goldilocks** 是一个资源配额建议工具。它为命名空间里的每个工作负载自动创建一个 **VerticalPodAutoscaler(VPA)**,再把 VPA 给出的建议汇总到一个看板上,让你一眼看到「这个应用的 requests 设得偏高还是偏低、该填多少」。

它的价值在于把 VPA 从「自动调整」变成「只给建议」:

```shell
VPA 的三种能力:recommender(算建议) / updater(实际改 Pod) / admission-controller(拦截新建 Pod 时改写)
goldilocks 只需要 recommender,后两者关掉 —— 这样 VPA 只出建议,不动任何线上 Pod
```

它**不产生**自己的算法。所有数字都来自 VPA recommender 的统计模型,因此建议质量完全取决于 VPA 能拿到多少历史数据。

自动创建出来的 VPA 命名规则是固定的:

```shell
goldilocks-<工作负载名>

# 例如 dev 命名空间里名为 nginx 的 Deployment
# 对应的 VPA 就是 goldilocks-nginx
```

### 安装

goldilocks 依赖 VPA 与 metrics-server,推荐把 VPA 单独安装管理:

```shell
# 1. 安装 VPA —— 只启用 recommender
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm repo update
helm install vpa fairwinds-stable/vpa -n vpa --create-namespace \
  --set updater.enabled=false \
  --set admissionController.enabled=false

# 2. 安装 metrics-server(VPA recommender 的前置依赖,集群已有则跳过)
kubectl get apiservice v1beta1.metrics.k8s.io
kubectl top nodes

# 3. 安装 goldilocks
kubectl create namespace goldilocks
helm install goldilocks fairwinds-stable/goldilocks --namespace goldilocks
```

也可以让 goldilocks 的 chart 一并带上 VPA 子 chart,但**必须显式关掉 updater 与 admission controller**:

```shell
helm install goldilocks fairwinds-stable/goldilocks --namespace goldilocks \
  --set vpa.enabled=true \
  --set vpa.updater.enabled=false \
  --set vpa.admissionController.enabled=false
```

子 chart 的默认值里 admission controller 是**开启**的,不显式关闭会往集群里装一个会拦截 Pod 创建的准入 Webhook,这与「只做建议」的初衷相悖。

不用 Helm 时也可以直接套用清单:

```shell
kubectl -n goldilocks apply -f hack/manifests/controller
kubectl -n goldilocks apply -f hack/manifests/dashboard
```

安装后会得到:

```shell
Deployment/goldilocks-controller    1 副本,负责创建与清理 VPA
Deployment/goldilocks-dashboard     2 副本,提供 Web 看板
Service/goldilocks-dashboard        ClusterIP,服务端口 80 → 容器端口 8080
```

### 启用命名空间

goldilocks 以命名空间为单位生效,**必须给命名空间打标签**:

```shell
# 纳入管理
kubectl label namespace dev goldilocks.fairwinds.com/enabled=true

# 显式排除
kubectl label namespace kube-system goldilocks.fairwinds.com/enabled=false

# 查看所有已启用的命名空间
kubectl get ns -l goldilocks.fairwinds.com/enabled=true
```

标签值的解析用的是 `strconv.ParseBool`,因此 `true`、`True`、`1`、`t` 都算启用;无法解析时按 `false` 处理,并且只会在日志里留一条记录,不会报错。

把标签改成 `false` 或直接删掉标签,goldilocks 会**清理掉它在那个命名空间里创建的所有 VPA**。

### 查看建议

```shell
# 方式一:Web 看板
kubectl -n goldilocks port-forward svc/goldilocks-dashboard 8080:80
# 浏览器打开 http://localhost:8080

# 方式二:直接看 VPA 对象
kubectl get vpa -n dev
kubectl describe vpa goldilocks-nginx -n dev
kubectl get vpa goldilocks-nginx -n dev -o yaml

# 方式三:命令行摘要(输出 JSON)
goldilocks summary
```

VPA 的建议分三档,target 是要重点看的那个:

```shell
lowerBound    建议的下限,通常作为 requests
target        VPA 认为最合适的值
upperBound    建议的上限,通常作为 limits
uncappedTarget 不受 minAllowed / maxAllowed 约束的原始建议
```

goldilocks 在看板上给出的解读是:工作负载属于 `Guaranteed` QoS 时,target 同时作为 requests 与 limits;属于 `Burstable` 时,把 lowerBound 当 requests、upperBound 当 limits。

### 命名空间与工作负载级别配置

除了 `enabled`,还有几个同样挂在 `goldilocks.fairwinds.com/` 下的键:

```shell
# 修改该命名空间下 VPA 的 updateMode
kubectl label namespace dev goldilocks.fairwinds.com/vpa-update-mode=auto

# 为 VPA 配置 resourcePolicy,可限定上下限或关掉某些容器
kubectl annotate namespace dev goldilocks.fairwinds.com/vpa-resource-policy='{"containerPolicies":[{"containerName":"nginx","minAllowed":{"cpu":"250m","memory":"100Mi"}},{"containerName":"istio-proxy","mode":"Off"}]}'

# 排除某些容器不参与建议(打在工作负载上)
kubectl label deployment myapp -n dev goldilocks.fairwinds.com/exclude-containers=linkerd-proxy,istio-proxy

# 限制 VPA 的最小副本数
kubectl annotate deployment myapp -n dev goldilocks.fairwinds.com/vpa-min-replicas=2
```

`vpa-update-mode` 的合法取值是 `Off`、`Initial`、`Recreate`、`InPlaceOrRecreate`、`InPlace`,以及作为兼容别名的 `auto`(等价于 `Recreate`)。取值非法时会回退到 `Off` 并打一条警告。**默认值是 `Off`**,也就是只建议不执行。

### 典型接入流程

goldilocks 的正确用法是「先看后改」,把建议当作评审材料而不是自动执行的配置:

```shell
# 1. 先在一个非核心命名空间上试水
kubectl label namespace staging goldilocks.fairwinds.com/enabled=true

# 2. 确认 VPA 已被创建(工作负载必须有存活的 Pod)
kubectl get vpa -n staging

# 3. 等 VPA 累积足够历史数据,期间用看板观察建议值是否趋于稳定
kubectl -n goldilocks port-forward svc/goldilocks-dashboard 8080:80

# 4. 查看某个工作负载的完整建议
kubectl describe vpa goldilocks-my-app -n staging
kubectl get vpa goldilocks-my-app -n staging -o jsonpath='{.status.recommendation.containerRecommendations}'

# 5. 人工确认后,把建议值写回工作负载
kubectl set resources deployment/my-app -n staging \
  --requests=cpu=250m,memory=256Mi \
  --limits=cpu=500m,memory=512Mi

# 6. 改完观察一段时间,确认没有 OOMKilled 与明显的 CPU 限流
kubectl get events -n staging --field-selector reason=OOMKilling
kubectl top pod -n staging
```

第 5 步是关键:goldilocks 给出的是**参考值**,直接照搬有可能把 requests 抬到节点放不下的程度,导致 Pod 无法调度。落库前要一并考虑节点的可分配资源与整个命名空间的配额。

### 注意

1. **goldilocks 自己不做任何资源计算**。所有建议都来自 VPA recommender。VPA 没有装、metrics-server 没装、或者数据不足,goldilocks 都只能显示 `null` 或空建议。
2. **建议需要时间积累,刚接上时数字会很不靠谱**。VPA 的统计模型要 **8 天左右的历史数据**才能给出稳定且准确的上下界;刚部署完看到的 `100G`、`100T` 这类夸张数字通常不是 bug,而是模型上界。
3. **默认 updateMode 是 `Off`,这是安全的默认值,不要随手改**。改成 `auto`/`Recreate` 后 VPA 会真的重建 Pod 来套用新配额,可能在毫无预告的情况下滚动重启整个工作负载。
4. **只给 VPA recommender,不要装 updater 与 admission controller**。用 goldilocks 的 chart 带 VPA 子 chart 时,admission controller 默认是开的,它会注册准入 Webhook 拦截 Pod 创建,属于「会改线上行为」的组件,必须显式 `--set vpa.admissionController.enabled=false`。
5. **工作负载必须至少有一个 Pod 才会被发现**。goldilocks 是通过「列出 Pod → 反查顶层控制器」来识别工作负载的,因此**副本数为 0 的工作负载拿不到 VPA**。想给尚未启动的应用做规划,只能先跑起来或直接手写 VPA。
6. **命名空间标签可以后打,但不会立刻生效**。控制器监听的是 Pod 与 Namespace 事件,打标签后需要等到下一次事件触发才会创建 VPA;工作负载长期没有变动时可能要多等一会儿。
7. **它会删掉自己创建但已无对应工作负载的 VPA**,也会在命名空间取消标签时清空该命名空间的 VPA。但它只管理带 `creator=Fairwinds`、`source=goldilocks` 标签且名字形如 `goldilocks-<工作负载>` 的对象 —— **手工创建的、名字不同的 VPA 不会被它接管或删除**。
8. **同一个工作负载上同时存在两个 VPA 的行为没有明确定义**。goldilocks 会照常创建自己的 VPA,至于两个 VPA 同时指向一个工作负载时 VPA 组件如何取舍,官方文档并未说明,应在接入前先清理掉已有的手写 VPA。
9. **对 HPA 管理的工作负载要格外小心**。基于 CPU 的 HPA 与 VPA 同时调整同一个工作负载会互相冲突,需要靠 VPA 的 `resourcePolicy` 分别限定各自管理的资源(例如 VPA 只管内存、HPA 只管 CPU)。由于 goldilocks 默认是 `Off`,风险会在切到主动模式时才显现。
10. **看板默认没有认证**。`goldilocks-dashboard` 的 Service 是普通 ClusterIP,靠端口转发访问尚可;要用 Ingress 对外暴露,必须自行在前面加上认证层,否则等于把整个集群的资源画像与命名空间结构公开出去。
11. **数据不会自动清理**。看板上看到的是当前存活工作负载的建议,删掉工作负载后对应的 VPA 也会被清理,历史建议不留档。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `hpa` — 水平自动扩缩容,与 VPA 组合使用时需要划分职责
- `metrics-server` — 集群资源指标采集组件,VPA recommender 的前置依赖
- `kube-state-metrics` — 对象状态指标导出器,与 VPA 建议可交叉印证
- `deployment` — 常见的工作负载类型,资源建议的主要对象

### 参考链接

- [Goldilocks GitHub 仓库](https://github.com/FairwindsOps/goldilocks)
- [Goldilocks 安装与使用文档](https://github.com/FairwindsOps/goldilocks/tree/master/docs)
- [Vertical Pod Autoscaler 官方文档](https://github.com/kubernetes/autoscaler/tree/master/vertical-pod-autoscaler)
- [VPA 常见问题(含与 HPA 的配合)](https://github.com/kubernetes/autoscaler/blob/master/vertical-pod-autoscaler/docs/faq.md)
- [Fairwinds Helm Charts](https://charts.fairwinds.com/stable)
