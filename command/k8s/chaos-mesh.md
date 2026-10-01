chaos-mesh
===

Kubernetes混沌工程平台:以CRD方式注入Pod、网络、IO与时间故障

## 补充说明

**Chaos Mesh** 是一个云原生的混沌工程平台。它把各类故障抽象成 **Kubernetes CRD**,用声明式 YAML 描述「在哪些 Pod 上、注入什么故障、持续多久」,由控制器负责执行与回收。它是 CNCF 孵化项目。

和 kube-monkey 这类「只会删 Pod」的工具相比,Chaos Mesh 的故障类型覆盖了绝大多数真实故障场景:

| CRD | 故障类型 | 典型用途 |
| --- | --- | --- |
| `PodChaos` | Pod 被杀、Pod 不可用、容器被杀 | 验证副本冗余与重启恢复 |
| `NetworkChaos` | 延迟、丢包、乱序、分区、限速 | 验证超时、重试与熔断 |
| `StressChaos` | CPU、内存压力 | 验证资源竞争与驱逐策略 |
| `IOChaos` | IO 延迟、错误、属性篡改 | 验证存储依赖的容错 |
| `TimeChaos` | 时间偏移 | 验证依赖时钟的业务逻辑 |
| `DNSChaos` | DNS 解析错误、随机返回 | 验证服务发现的容错 |
| `HTTPChaos` | 请求中止、延迟、替换、篡改 | 验证上下游接口异常处理 |

所有 CRD 都归属于 `chaos-mesh.org/v1alpha1` 这个 API 组。

它的工作方式是在每个节点上运行一个特权守护进程 `chaos-daemon`,由它调用容器运行时与内核接口完成故障注入,因此**注入能力依赖宿主机权限**,这也决定了它的部署前提。

### 安装

```shell
helm repo add chaos-mesh https://charts.chaos-mesh.org
helm repo update
kubectl create ns chaos-mesh

# containerd 运行时(绝大多数现代集群)
helm install chaos-mesh chaos-mesh/chaos-mesh -n=chaos-mesh \
  --set chaosDaemon.runtime=containerd \
  --set chaosDaemon.socketPath=/run/containerd/containerd.sock
```

**`chaosDaemon.runtime` 与 `chaosDaemon.socketPath` 必须与节点上的容器运行时一致**,这是安装环节最常见的失败原因:运行时填错或 socket 路径不对,`chaos-daemon` 会启动但注入任何故障都失败。安装后用 `kubectl get pods -n chaos-mesh` 与 `kubectl get crds | grep chaos-mesh` 确认。

### 语法

```shell
kubectl apply -f <chaos-yaml>      创建实验
kubectl get podchaos               查询各类实验
kubectl describe podchaos <name>   查看执行状态与事件
kubectl delete -f <chaos-yaml>     提前结束实验
```

所有实验共有的顶层字段:

```shell
duration        持续时间,如 30s、5m;不写则一直生效直到被删除
scheduler       定时调度,内部使用 cron 表达式
mode            作用范围,决定爆炸半径
selector        目标选择器:namespaces、labelSelectors、pods、annotationSelectors
```

`mode` 的取值:

```shell
one                 随机挑一个目标
all                 全部目标
fixed               固定数量,配合 value 使用
fixed-percent       固定百分比,配合 value 使用
random-max-percent  最多百分之多少,配合 value 使用
```

### PodChaos

```shell
apiVersion: chaos-mesh.org/v1alpha1
kind: PodChaos
metadata:
  name: pod-kill-example
  namespace: default
spec:
  action: pod-kill
  mode: one
  duration: '30s'
  selector:
    namespaces:
      - default
    labelSelectors:
      app: nginx
```

三种 action 的差别:

```shell
pod-kill        杀掉 Pod,由控制器重建 —— 验证副本冗余
pod-failure     让 Pod 在一段时间内不可用(注入 pause 镜像),不触发重建
container-kill  只杀指定容器,Pod 本身保留 —— 验证容器级重启
```

### NetworkChaos

```shell
apiVersion: chaos-mesh.org/v1alpha1
kind: NetworkChaos
metadata:
  name: network-delay-example
  namespace: default
spec:
  action: delay
  mode: one
  duration: '30s'
  selector:
    namespaces:
      - default
    labelSelectors:
      app: nginx
  delay:
    latency: '90ms'
    correlation: '25'
    jitter: '90ms'
```

各类 action 与其专属参数:

```shell
delay       延迟,参数 delay.latency、delay.correlation、delay.jitter
loss        丢包,参数 loss.loss(百分比)、loss.correlation
duplicate   报文重复,参数 duplicate.duplicate、duplicate.correlation
corrupt     报文损坏,参数 corrupt.corrupt、corrupt.correlation
bandwidth   带宽限速,参数 bandwidth.rate、bandwidth.limit、bandwidth.buffer
partition   网络分区,配合 direction(to/from/both)与 target 指定隔离方向
```

### StressChaos

```shell
apiVersion: chaos-mesh.org/v1alpha1
kind: StressChaos
metadata:
  name: cpu-stress-example
  namespace: default
spec:
  mode: one
  duration: '30s'
  selector:
    namespaces:
      - default
    labelSelectors:
      app: nginx
  stressors:
    cpu:
      workers: 2
      load: 80
    memory:
      workers: 1
      size: '256MB'
```

`workers` 是压测线程数,`load` 是 CPU 负载百分比,`size` 是每个 worker 申请的内存。**压力测试本身会真的消耗节点资源**,在接近满载的节点上执行有可能直接触发驱逐。

### IOChaos / TimeChaos / DNSChaos / HTTPChaos

```shell
apiVersion: chaos-mesh.org/v1alpha1
kind: IOChaos
metadata:
  name: io-delay-example
spec:
  action: latency
  mode: one
  duration: '30s'
  selector:
    labelSelectors:
      app: nginx
  volumePath: /var/run/data
  path: '/var/run/data/*'
  delay: '100ms'
  percent: 50
```

```shell
apiVersion: chaos-mesh.org/v1alpha1
kind: HTTPChaos
metadata:
  name: http-abort-example
spec:
  mode: all
  target: Request
  duration: '30s'
  selector:
    labelSelectors:
      app: nginx
  port: 80
  method: GET
  path: '/api/*'
  abort: true
```

`TimeChaos` 与 `DNSChaos` 的结构与之类似,只是参数不同:`TimeChaos` 用 `timeOffset`(如 `-10m`)与 `clockIds` 让容器内时间发生偏移;`DNSChaos` 用 `patterns` 指定域名列表。四者的 action 取值:

```shell
IOChaos    latency、fault、attrOverride、mistake
TimeChaos  time-shift
DNSChaos   error、random
HTTPChaos  abort、delay、replace、patch
```

### 定时与工作流

一次性实验之外,`Schedule` 负责周期执行:

```shell
apiVersion: chaos-mesh.org/v1alpha1
kind: Schedule
metadata:
  name: pod-kill-schedule
  namespace: default
spec:
  schedule: '@every 1m'
  historyLimit: 5
  concurrencyPolicy: Forbid
  type: PodChaos
  podChaos:
    action: pod-kill
    mode: one
    selector:
      namespaces:
        - default
      labelSelectors:
        app: nginx
```

`Workflow` 用于编排多个实验的顺序与依赖,可以表达「先注入网络延迟、观察 30 秒、再杀掉一个 Pod」这类复合场景。

### Dashboard 与排障

```shell
# 打开 Dashboard(默认端口 2333)
kubectl port-forward -n chaos-mesh svc/chaos-dashboard 2333:2333
# 浏览器打开 http://localhost:2333

# 实验没有生效时,按下面的顺序看
kubectl get podchaos -n <namespace>                      # 对象是否已创建
kubectl describe podchaos <name> -n <namespace>          # 事件里通常有直接原因
kubectl logs -n chaos-mesh ds/chaos-daemon --tail=100    # 注入失败多半是运行时配置问题
kubectl logs -n chaos-mesh deploy/chaos-controller-manager --tail=100
```

### 注意

1. **`chaos-daemon` 是特权组件**。它需要访问容器运行时 socket 与内核接口,在每个节点上以高权限运行。这意味着**装上 Chaos Mesh 就等于给集群开了一个能做任意故障注入的后门**,生产集群必须配合 RBAC 限制谁能创建 Chaos 对象。
2. **爆炸半径必须靠 `mode` 与 `selector` 双重收紧**。`mode: all` 加上宽泛的 `labelSelectors` 是最危险组合,一条命令就能让整个业务不可用。建议每次实验都显式写死命名空间与标签,优先使用 `one` 或 `fixed-percent`。
3. **生产演练前必须满足的前提条件**:有可回滚的方案、有明确的观测指标与停止条件、有值班人员在场、避开业务高峰、并且**先在预发环境完整跑一遍同样的实验**。缺任何一条都不应当直接在生产上做。
4. **`pod-kill` 不遵守 PodDisruptionBudget**。它走的是删除操作而非 Eviction API,PDB 拦不住它。副本数不足时一次 `pod-kill` 就可能造成真实中断。
5. **`pod-failure` 与 `pod-kill` 的恢复语义完全不同**。`pod-failure` 期间 Pod 不会被重建,故障持续时间等于 `duration`;`pod-kill` 删掉后控制器会立刻拉起新 Pod。想验证「长时间不可用」要用前者。
6. **容器运行时配置错误是安装后的头号问题**。`chaosDaemon.runtime` 与 `chaosDaemon.socketPath` 与实际节点不匹配时,`chaos-daemon` 看起来运行正常,但所有实验都注入失败,错误只出现在 daemon 的日志里。
7. **`TimeChaos` 与 `KernelChaos` 对内核与运行时要求更苛刻**。前者依赖时间命名空间与特定内核能力,后者需要加载内核模块,在托管集群(如多数云厂商的 Serverless 容器)上通常无法使用;`JVMChaos` 还需要目标 JVM 提前挂载 byteman agent,忘了这一步的表现是实验永远不生效。
8. **`IOChaos` 需要以特定卷类型挂载目标路径**,使用 emptyDir 或 hostPath 之外的存储驱动时可能不生效,并且要配合 `percent` 控制命中比例。
9. **未设置 `duration` 的实验会一直生效**。控制器不会自动回收,忘记删除会让故障长期存在,排障时务必先确认是否还有存活的 Chaos 对象。
10. **卸载时 CRD 的 finalizer 可能让资源卡在 Terminating**。`helm uninstall chaos-mesh -n chaos-mesh` 之后,如果还有 Chaos 对象存在,它们会因为 finalizer 无法被清理而卡住;正确顺序是**先删除所有 Chaos 对象,再卸载组件,最后删除 CRD**。
11. **`Schedule` 会持续产生新实验**。忘掉一个 `@every 1m` 的调度,等于给系统装了一台永不停歇的故障注入机,`concurrencyPolicy: Forbid` 只能防止并发,不能防止长期运行。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `litmus` — 基于实验库的另一套混沌工程框架
- `kube-monkey` — 轻量的随机删 Pod 工具
- `helm` — Kubernetes包管理器
- `poddisruptionbudget` — 中断预算,注意 Chaos Mesh 的 pod-kill 不受其约束

### 参考链接

- [Chaos Mesh 官方网站](https://chaos-mesh.org/)
- [Chaos Mesh GitHub 仓库](https://github.com/chaos-mesh/chaos-mesh)
- [使用 Helm 安装 Chaos Mesh](https://chaos-mesh.org/docs/production-installation-using-helm/)
- [Chaos Mesh 实验类型文档](https://chaos-mesh.org/docs/simulate-pod-chaos-on-kubernetes/)
- [Chaos Mesh 常见问题](https://chaos-mesh.org/docs/faqs/)
