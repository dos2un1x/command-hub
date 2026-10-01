kube-monkey
===

Kubernetes混沌工程工具:按计划随机删除Pod以验证服务韧性

## 补充说明

**kube-monkey** 是 Netflix Chaos Monkey 在 Kubernetes 上的实现。它按照配置好的计划,**随机删除**集群中自愿参与的工作负载的 Pod,以此逼迫团队把服务做成真正能扛住实例消失的形态。

它的定位非常窄,可以概括为三句话:

- 只做一件事:**删 Pod**。不注入网络延迟、不制造磁盘错误、不模拟资源耗尽。
- 采用**完全自愿**的参与模型:工作负载必须显式打上标签才会被纳入,否则永远不会被碰。
- 需要**提前排期**:按 MTBF(平均无故障时间)算出每天要杀几个,再在指定时间窗口内随机挑时刻执行。

删除对象是 Deployment、StatefulSet、DaemonSet 这三种控制器管理的 Pod。ReplicaSet、Job、CronJob 不在支持范围内。

它和当下的混沌工程平台(Chaos Mesh、LitmusChaos)的关系是:后者功能全面得多,而 kube-monkey 胜在配置简单 —— 一个 ConfigMap 加几个标签就能跑起来,适合作为团队接触混沌工程的第一站。

### 安装

```shell
# 方式一:Helm
helm repo add kubemonkey https://asobti.github.io/kube-monkey/charts/repo
helm repo update
helm install kube-monkey kubemonkey/kube-monkey --namespace kube-system

# 指定版本
helm install kube-monkey kubemonkey/kube-monkey --version 1.6.0 --namespace kube-system

# 方式二:手工 ConfigMap + Deployment
kubectl create configmap kube-monkey-config-map -n kube-system --from-file=config.toml=km-config.toml
kubectl apply -f https://raw.githubusercontent.com/asobti/kube-monkey/master/examples/deployment.yaml
```

查看与升级:

```shell
kubectl get deploy,cm -n kube-system | grep kube-monkey
kubectl logs -n kube-system deploy/kube-monkey --tail=100

# 调高日志级别可以看到完整的排期过程(L5 最详细)
kubectl -n kube-system get deploy kube-monkey -o jsonpath='{.spec.template.spec.containers[0].args}'
```

kube-monkey 使用 glog 风格的日志级别,`-v=5` 能看到最详细的调度与配置信息。

### 配置

配置是 **TOML** 格式,通过 ConfigMap 挂载到 `/etc/kube-monkey/config.toml`:

```shell
[kubemonkey]
dry_run = true                            # 只记录不删除,首次接入务必保持 true
run_hour = 8                              # 每天 8 点生成当天的杀戮计划
start_hour = 10                           # 不在 10 点前动手
end_hour = 16                             # 不在 16 点后动手
graceperiod_sec = 5                       # 删除 Pod 时的优雅终止时间
time_zone = "America/New_York"            # 注意字段名是 time_zone,不是 timezone
blacklisted_namespaces = ["kube-system"]  # 黑名单优先级最高
whitelisted_namespaces = []               # 空列表等价于「所有命名空间」

[debug]
enabled = false                           # 打开后会打印更多调试信息
schedule_immediate_kill = false           # 配合 enabled 使用,可以立刻执行一次
```

几处容易写错的键名:

```shell
graceperiod_sec    不是 gracePeriod,也不是 grace_period
time_zone          不是 timezone
run_hour           不是 runHour
dry_run            不是 dryRun
```

Helm 安装时用的是另一套驼峰命名(values.yaml 里的 `config.dryRun`、`config.runHour`、`config.blacklistedNamespaces` 等),由模板渲染成上面的下划线 TOML 键。两套名字混用是常见的踩坑来源。

所有键都可以用环境变量覆盖,前缀是 `KUBEMONKEY_`:

```shell
KUBEMONKEY_DRY_RUN=true
KUBEMONKEY_RUN_HOUR=8
KUBEMONKEY_START_HOUR=10
KUBEMONKEY_END_HOUR=16
KUBEMONKEY_BLACKLISTED_NAMESPACES=kube-system
KUBEMONKEY_TIME_ZONE=America/New_York
```

配置有交叉校验:`start_hour` 必须小于 `end_hour`,且 `run_hour` 必须小于 `start_hour`,三者都必须在 0–23 之间。kube-monkey 会监听配置文件变化并热加载,**加载到非法配置会直接 panic 退出**。

### 工作负载标签

只有打了标签的工作负载才会被纳入,这是它的准入机制:

```shell
apiVersion: apps/v1
kind: Deployment
metadata:
  name: monkey-victim
  namespace: app-namespace
spec:
  replicas: 5
  selector:
    matchLabels:
      app: monkey-victim
  template:
    metadata:
      labels:
        app: monkey-victim
        kube-monkey/enabled: enabled
        kube-monkey/identifier: monkey-victim
        kube-monkey/mtbf: '2'
        kube-monkey/kill-mode: "fixed"
        kube-monkey/kill-value: '1'
```

各标签的含义:

| 标签 | 作用 |
| --- | --- |
| `kube-monkey/enabled` | 值为 `enabled` 才参与,其他值一律视为未启用 |
| `kube-monkey/identifier` | 标识符,删 Pod 时按 `kube-monkey/identifier=<值>` 匹配 Pod |
| `kube-monkey/mtbf` | 平均无故障时间,决定杀戮频率,必填 |
| `kube-monkey/kill-mode` | `fixed`、`fixed-percent`、`random-max-percent`、`kill-all` |
| `kube-monkey/kill-value` | 与 kill-mode 配合的数量或百分比 |

`kill-mode` 的取值含义:

```shell
fixed                删除固定数量的 Pod,kill-value 填整数
fixed-percent        删除固定百分比的 Pod,kill-value 填 0-100
random-max-percent   最多删除百分之多少,kill-value 填 0-100
kill-all             删除全部,kill-value 可以省略
```

### MTBF 与杀戮计划

`mtbf` 决定「平均多久杀一次」,支持天、小时、分钟三种单位:

```shell
kube-monkey/mtbf: '2'     2 天一次(不带单位默认按天)
kube-monkey/mtbf: '3d'    3 天一次
kube-monkey/mtbf: '6h'    6 小时一次
kube-monkey/mtbf: '30m'   30 分钟一次,这是允许的最小值
```

每天要执行的次数按 `24 小时 ÷ MTBF` 计算:MTBF 为 `2d` 时平均每天杀 0.5 次,MTBF 为 `6h` 时平均每天杀 4 次。具体时刻在 `start_hour` 到 `end_hour` 之间随机分布,**且只在工作日(周一至周五)执行**。

计划在 `run_hour` 生成,之后按各自的时间点依次执行。`kill-value` 大于 1 时会连续删除多个 Pod,但每次都从同一份初始列表中独立随机挑选,因此**同一个 Pod 有可能被选中多次**。

### 与 Chaos Mesh / Litmus 的分工

```shell
kube-monkey       只删 Pod,配置最简单,适合入门与常态化的「每周随机杀一杀」
Chaos Mesh        故障类型全面(网络、IO、时间、DNS、HTTP、内核),有工作流与看板
LitmusChaos       实验库丰富,有 ChaosCenter 门户与混沌编排
```

三者的理念差异在于:kube-monkey 追求「像背景辐射一样长期存在」,混沌工程平台追求「可编排、可复现、可观测的实验」。二者可以并存,不必二选一。

### 注意

1. **首次接入必须保持 `dry_run = true`**。代码里 `dry_run` 的默认值就是 true,但它很容易在调整配置时被顺手改成 false。开启时 kube-monkey 只打印 `[DryRun Mode] Terminated pod ...` 日志,不会真的删除任何东西,应当先用它观察一段时间的排期是否符合预期。
2. **它不遵守 PodDisruptionBudget**。kube-monkey 走的是 `Pods().Delete()`,**完全不走 Eviction API**,而 PDB 只约束 Eviction API。因此 PDB 对它是无效的,不要指望用 PDB 来兜底。
3. **优雅终止时间由配置写死,会覆盖 Pod 自身的设置**。删除 Pod 时使用的 `graceperiod_sec` 默认是 5 秒,**它会覆盖 Pod 上的 `terminationGracePeriodSeconds`**。对需要较长时间优雅退出的应用,这个默认值会让进程被强行中断,务必按业务情况调大。
4. **黑名单优先级高于白名单**。白名单决定「扫描哪些命名空间」,黑名单则是一票否决。默认黑名单是 `kube-system`,默认白名单是空列表(等价于全部命名空间)——也就是说,**装上之后默认会扫描所有业务命名空间**,只是被 `dry_run=true` 挡住了。
5. **标签必须打在 Pod 模板上,也要考虑补到工作负载对象上**。它按工作负载对象的标签做筛选,较新的 Kubernetes 版本里可能需要同时在工作负载的 `metadata.labels` 上补一份。只打一边可能永远不会被选中。
6. **它杀的是 Pod,不是容器**。删除后由控制器重新拉起,所以对无状态服务基本等同于一次「计划内重启」。真正考验的是应用能否容忍实例数瞬时下降,以及是否有本地状态。
7. **`mtbf` 是必填项**。缺失时该工作负载会被跳过,日志里只有一行警告,很容易被忽略。
8. **它不会自我熔断**。如果集群已经处于故障状态,kube-monkey 仍然会按计划继续删 Pod。接入监控后应当在集群健康度下降时主动停掉它(例如把 Deployment 缩到 0)。
9. **ReplicaSet、Job、CronJob 不在支持范围内**。想对这些对象做混沌实验,需要改用 Chaos Mesh 之类的平台。
10. **配置热加载遇到非法内容会 panic**。修改 ConfigMap 时务必保证 `run_hour < start_hour < end_hour` 且取值在 0–23 之间,否则 Pod 会直接崩溃重启。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `chaos-mesh` — 功能全面的混沌工程平台
- `litmus` — 基于实验库的混沌工程框架
- `deployment` — 无状态工作负载,常见的混沌实验对象
- `statefulset` — 有状态工作负载,混沌实验影响更大

### 参考链接

- [kube-monkey GitHub 仓库](https://github.com/asobti/kube-monkey)
- [kube-monkey 配置说明](https://github.com/asobti/kube-monkey#configuration)
- [kube-monkey Helm Chart](https://github.com/asobti/kube-monkey/tree/master/helm/kubemonkey)
- [Chaos Monkey 原始理念](https://netflix.github.io/chaosmonkey/)
