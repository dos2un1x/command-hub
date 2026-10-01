feature-gates
===

特性门控:按版本开关 Kubernetes 的 Alpha / Beta 功能

## 补充说明

**feature-gates**(特性门控)是 Kubernetes 控制"某个功能是否启用"的开关。每个组件都有一组自己认识的特性门控,通过 `--feature-gates` 传入 `键=值` 对来打开或关闭。

它存在的意义是:让新功能可以**先默认关闭、逐步放量**。Alpha 阶段默认关闭,谁想尝鲜谁自己开;Beta 阶段默认打开,想回退的人自己关;GA 之后门控本身会被移除,功能变成不可关闭的默认行为。

这是**每个组件各自独立**的开关 —— 在 apiserver 上打开某个门控,不会让 kubelet 也打开它。

### 语法

```shell
# 逗号分隔的 key=value 列表,值只能是 true/false
--feature-gates=FeatureA=true,FeatureB=false

kube-apiserver --feature-gates=APIServerWebhookAuthenticationToken=true
kubelet --feature-gates=GracefulNodeShutdown=true
```

```shell
# 查看某个组件认识哪些门控(帮助文本里会完整列出,含默认值)
kube-apiserver --help | grep -A 200 'feature-gates'
kubelet --help | grep -A 200 'feature-gates'

# 只看当前生效状态:组件 /metrics 上的门控指标
kubectl get --raw /metrics | grep kubernetes_feature_enabled
```

`kubernetes_feature_enabled` 的标签是 `name` 与 `stage`,值为 `0`(关闭)或 `1`(开启):

```shell
kubernetes_feature_enabled{name="GracefulNodeShutdown",stage="BETA"} 1
kubernetes_feature_enabled{name="SomeAlphaFeature",stage="ALPHA"} 0
```

### 三个阶段

| 阶段 | 默认值 | 含义 |
|---|---|---|
| Alpha | **false** | 默认关闭,可能有 bug,随时可能变更或移除;只在测试集群启用 |
| Beta | **true** | 默认开启,API 细节仍可能变化,但功能认为可用 |
| GA(Stable) | 无门控 | 功能固化,门控被移除;写进 `--feature-gates` 会导致组件启动失败 |

注意:**Alpha/Beta 说的是"特性门控的阶段",与 API 版本的 alpha/beta 是两套体系**,虽然二者常常同步演进。同理,一个门控进入 Beta 不代表可以放心在生产长期依赖 —— Beta 期间行为仍可能调整。

### 门控状态的表格与例外

官方参考页用 `Feature | Default | Stage | Since | Until` 四列记录每个门控的历史;`Since` 是引入或阶段变更的版本,`Until` 是最后一个还能用它的版本。已移除的门控另有一张表(见参考链接)。

v1.37 文档中的几个例子:

| 门控 | 阶段 | 默认 | 起始版本 |
|---|---|---|---|
| APIServerWebhookAuthenticationToken | Alpha | false | 1.37 |
| ContainerCheckpoint | Beta | true | 1.30(Alpha 1.25–1.29,false) |
| GracefulNodeShutdown | Beta | true | 1.21(Alpha 1.20,false) |
| HPAScaleToZero | Beta | true | 1.37(Alpha 1.16–1.36,false) |
| CoordinatedLeaderElection | Beta | **false** | 1.33 |
| GenericWorkload | Beta | **false** | 1.37 |
| DRAWorkloadResourceClaims | Beta | **false** | 1.37 |
| InOrderInformers | Beta | **true** | 1.33(Alpha 阶段默认就是 true) |

最后四行说明:**"Alpha 默认 false、Beta 默认 true"是惯例而非铁律**,判断某个门控的默认值必须查对应版本文档或直接看 `--help`。

### 常见使用场景

```shell
# 1. kubeadm 集群:静态 Pod 清单里直接加参数
sudo vi /etc/kubernetes/manifests/kube-apiserver.yaml
#    spec.containers[0].command 里追加:
#    - --feature-gates=SomeGate=true

# 2. kube-controller-manager / kube-scheduler 同样改各自的静态 Pod 清单
sudo vi /etc/kubernetes/manifests/kube-controller-manager.yaml
sudo vi /etc/kubernetes/manifests/kube-scheduler.yaml

# 3. kubelet:命令行可以写,但推荐写进配置文件(见下方注意 4)
kubectl -n kube-system get cm kubelet-config -o yaml | grep -A 5 featureGates
```

```shell
# kubelet 配置文件里的写法
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
featureGates:
  GracefulNodeShutdown: true
  SomeAlphaGate: false
```

```shell
# 4. 组件自己带的工具,也常支持按门控选择行为
kubectl get --raw /metrics | grep kubernetes_feature_enabled | sort

# 5. 对比升级前后的门控状态(升级前务必做)
kubectl get --raw /metrics | grep kubernetes_feature_enabled > before.txt
```

### 集群里各组件的位置

| 组件 | 门控来源 |
|---|---|
| kube-apiserver | 静态 Pod 清单 `/etc/kubernetes/manifests/kube-apiserver.yaml` |
| kube-controller-manager | 静态 Pod 清单 |
| kube-scheduler | 静态 Pod 清单 / KubeSchedulerConfiguration |
| kubelet | `/var/lib/kubelet/config.yaml` 的 `featureGates` 字段(或命令行) |
| 各类 Operator | 各自的 Deployment 参数 |

### 门控与 API 版本是两回事

初学者最容易混淆的一点:**特性门控管的是"这段代码跑不跑",API 版本管的是"这个接口能不能访问"**。二者常常同步演进,但操作方式完全不同。

| 目标 | 手段 | 例子 |
|---|---|---|
| 关闭某个 API 版本 | `--runtime-config` | `--runtime-config=flowcontrol.apiserver.k8s.io/v1beta3=false` |
| 关闭某个特性 | `--feature-gates` | `--feature-gates=SomeFeature=false` |
| 查看已启用的 API 版本 | `kubectl api-versions` | — |
| 查看门控状态 | `/metrics` 的 `kubernetes_feature_enabled` | — |

典型演进路径是:新功能先以 Alpha API(`v1alpha1`)+ Alpha 门控出现,成熟后升为 Beta API(`v1beta1`)+ Beta 门控,GA 时 API 版本变成 `v1`、门控被移除。所以"某个 API 版本还在不在"与"某个门控还在不在"要分别查。

### 核对与监控

```shell
# 门控状态指标:标签是 name 与 stage,值为 0(关)/ 1(开)
kubernetes_feature_enabled{name="GracefulNodeShutdown",stage="BETA"} 1

# 找出所有被显式打开的非 GA 门控 —— 排查"谁动了门控"最快的办法
kubectl get --raw /metrics \
  | grep kubernetes_feature_enabled \
  | grep '} 1' | grep -v 'stage="GA"'

# 升级前后各导出一份,做差集
kubectl get --raw /metrics | grep kubernetes_feature_enabled | sort > before.txt
#   ... 升级 ...
kubectl get --raw /metrics | grep kubernetes_feature_enabled | sort > after.txt
diff before.txt after.txt
```

升级前的核对清单:

```shell
# 1. 收集所有组件的门控设置(静态 Pod 清单 + kubelet 配置 + Operator 参数)
sudo grep -r 'feature-gates' /etc/kubernetes/manifests/
sudo grep -A 5 'featureGates' /var/lib/kubelet/config.yaml
kubectl get deploy -A -o yaml | grep -B 3 'feature-gates' | head -40

# 2. 逐个对照目标版本的特性门控参考页,确认:是否已 GA(门控被移除)、默认值是否变化
# 3. 清理已经失效的门控参数,否则组件会启动失败
```

### 注意

1. **门控名写错,组件会直接启动失败**。`--feature-gates` 的值在解析阶段就会校验:名字不在该组件的已知列表里会报 `unrecognized feature gate`,值不是合法布尔值也会报错,组件随之退出。控制面组件起不来时,kubectl 连不上,只能靠 `crictl` 和 `journalctl -u kubelet` 定位。
2. **门控是各组件独立的,必须成套设置**。只在 apiserver 上打开某个门控,kubelet、controller-manager、scheduler 不会跟着打开,结果是"功能一半生效一半不生效",这类问题极难排查。启用前先列清楚它涉及哪些组件。
3. **写已经 GA 或已移除的门控同样会失败**。功能 GA 后门控会被移除,旧清单里遗留的 `--feature-gates=SomeGate=true` 在升级后会变成启动错误 —— 升级前清扫一遍所有静态 Pod 清单、KubeletConfiguration 与 Operator 的启动参数是标准动作。
4. **kubelet 的 `--feature-gates` 命令行参数已被标记为废弃**,推荐写进配置文件 `featureGates` 字段。更微妙的是优先级:官方给出的合并顺序是 **命令行上的 feature gates 优先级最低**,低于配置文件与 drop-in 文件,所以"命令行写了却好像没生效"是真实存在的现象。
5. **门控阶段的默认值会随版本变化**,这是升级中最容易被忽略的行为变更来源。Beta 门控从 false 变 true,等于升级后功能自动打开;GA 门控被移除,等于功能永久打开且无法回退。升级前一定要读对应版本的 release notes,并用 `kubernetes_feature_enabled` 对比升级前后的实际状态。
6. **不要用 `--feature-gates` 去做长期配置**。门控的语义是"临时开关",功能稳定后门控会被删掉。用它长期承载生产行为,等于给自己埋一个升级即炸的雷。
7. **Alpha 门控不要在生产开**。文档措辞很直接:Alpha 可能有 bug、可能随时移除、可能不向后兼容;即便只是开在测试集群,也要清楚它可能影响的是**整个组件**,而不只是那个功能。
8. **同一个特性在不同组件上的门控名可能不同**。例如客户端侧的 list-then-watch 涉及服务端与客户端两侧各自的门控,只开一边不会生效。
9. **有些门控被锁定为默认值**(lockToDefault),此时显式写相反的值会被拒绝;遇到"写了不生效甚至报错"的情况,先看 `--help` 里该门控的说明。
10. **门控状态是排障的必备上下文**。同一个版本、同一份清单,两个集群行为不同,十有八九是门控状态不同 —— 提交 issue 或求助时附上 `kubectl get --raw /metrics | grep kubernetes_feature_enabled` 的输出能省下大量来回。
11. **升级路径上别跨版本连跳**。门控的引入/废弃是按版本线推进的,跨多个次版本升级时,某个门控可能在中间版本已被移除,而你的清单还带着它,结果就是升级失败。
12. **`kubernetes_feature_enabled` 是 BETA 稳定级别的指标**,可以放心用于监控与告警;它的值反映的是**该组件进程内**的真实状态,比翻配置文件更可靠。
13. **不要一次性打开多个 Alpha 门控**。同时打开三四个实验特性,一旦集群出问题,你无法判断是哪一个造成的;正确做法是一次一个,并保留回退方案。
14. **有些门控会改变写入数据的格式或内容**(加密、序列化、存储相关),这类门控的回退成本远高于普通功能开关 —— 官方通常会在发布说明里特别标注"不可逆"或"需要额外迁移步骤",启用前务必读完那一段。
15. **门控改动需要重启组件才生效**。它不像大多数 API 对象那样热更新:apiserver/kcm/scheduler 要重建静态 Pod,kubelet 要 `systemctl restart kubelet`,并确认节点回到 Ready。
16. **以组件自己的 `--help` 为准**。官方文档按版本给出列表,而你手上的二进制可能是自编译的、或是别的补丁版本;`<component> -h` 输出的门控清单才是这个二进制真正认识的集合。
17. **门控不是长期配置手段,也不是"隐藏功能开关"**。它的生命周期由社区决定,GA 即删除;把生产行为建立在门控上,等于把稳定性押在一次升级上。需要长期生效的配置,应该找对应的正式字段(如 KubeletConfiguration、KubeSchedulerConfiguration)。

### 相关命令

- `kube-apiserver` — 集群 API 服务器
- `kubelet` — 节点代理
- `kube-scheduler` — 调度器
- `kubeadm` — Kubernetes集群安装工具
- `kubelet-config` — KubeletConfiguration 与 kubelet-config ConfigMap
- `ecosystem-status` — 已退役项目与重大变更记录

### 参考链接

- [特性门控](https://kubernetes.io/docs/reference/command-line-tools-reference/feature-gates/)
- [已移除的特性门控](https://kubernetes.io/docs/reference/command-line-tools-reference/feature-gates-removed/)
- [kubelet 配置文件](https://kubernetes.io/docs/tasks/administer-cluster/kubelet-config-file/)
- [Kubernetes 弃用策略](https://kubernetes.io/docs/reference/using-api/deprecation-policy/)
