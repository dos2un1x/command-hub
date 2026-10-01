coroot
===

基于 eBPF 的 Kubernetes 可观测性与 APM 平台,自带根因分析与 SLO 告警

## 补充说明

**Coroot** 是一个开源的 Kubernetes 可观测性平台,把指标、日志、链路、持续剖析和 SLO 告警放进同一个界面,并用一组预置的「检查项(inspections)」自动做根因分析。它的定位介于「Prometheus + Grafana 自己拼大盘」和「商业 APM」之间:部署一套就能看到服务拓扑、每个服务的黄金指标、以及具体是哪一环出了问题。

它有两个数据来源,理解这两者的区别是使用 Coroot 的第一件事:

```shell
eBPF node agent   每节点一个 DaemonSet,内核态采集 TCP 连接、延迟、DNS、OOM 等
Prometheus        作为指标存储与查询后端,Coroot 本身不做长期存储(默认)
```

**eBPF 模式与 Prometheus 模式的差异是实质性的**:

```shell
只有 eBPF agent 才能拿到
  - 服务之间的 TCP 连接级信息(谁连谁、连接失败、重传)
  - 跨节点/跨可用区的网络往返延迟(RTT)与连接建立耗时
  - 容器 OOM 事件、CPU/磁盘延迟记账(delay accounting)
  - 节点上的容器日志(part of the agent)

Prometheus 模式能拿到
  - 所有已接入 Prometheus 的指标(kube-state-metrics、node-exporter、应用自定义指标)
  - 基于这些指标的服务黄金指标、资源用量、Kubernetes 对象状态

Prometheus 模式拿不到
  - 没有指标暴露的服务就是盲区(比如只跑了个 TCP 服务、没接 exporter 的中间件)
  - 服务间调用关系要靠指标标签推断,不如 eBPF 的连接跟踪准确
```

所以只接 Prometheus 时 Coroot 依然可用,但服务地图与网络延迟会明显稀疏。

### 安装

Coroot 官方推荐通过 Operator 安装,operator 负责拉起 Coroot 实例、内置 Prometheus(或 ClickHouse)和 node agent:

```shell
helm repo add coroot https://coroot.github.io/helm-charts
helm repo update coroot

# 1) 先装 operator
helm install -n coroot --create-namespace coroot-operator coroot/coroot-operator

# 2) 再装 Coroot 社区版(operator 会创建对应的 CR)
helm install -n coroot coroot coroot/coroot-ce \
  --set "clickhouse.shards=2,clickhouse.replicas=2"

# 3) 访问界面
kubectl port-forward -n coroot service/coroot-coroot 8080:8080
```

企业版把 chart 换成 `coroot/coroot-ee` 并额外提供 `licenseKey`。

Coroot 需要特权容器,Pod Security Admission 会拦:

```shell
kubectl label ns coroot pod-security.kubernetes.io/enforce=privileged --overwrite
```

### node agent

`coroot-node-agent` 是 eBPF 采集器,由 operator 自动以 DaemonSet 部署(用 `Privileged: true` 与 `HostPID: true`)。它有两种指标输出模式:

```shell
# 模式一:暴露 /metrics,交给 Prometheus 抓取(pull)
--listen=0.0.0.0:80

# 模式二:用 Prometheus Remote Write 协议推送到远端(push)
--collector-endpoint=https://coroot.example.com   # 统一入口,自动推导各子路径
--metrics-endpoint=<url>                          # 单独覆盖指标地址
--scrape-interval=15s
--wal-dir=/tmp/coroot-node-agent                  # push 模式的本地 WAL
```

配置了 `--collector-endpoint` 或 `--metrics-endpoint` 后,agent 会**从抓取模式切换到推送模式**,本地监听地址退回 `127.0.0.1:10300`。日志与链路走 OTLP/HTTP,profiles 走独立的 HTTP 协议。

### 数据存储

```shell
指标     默认走 Prometheus(operator 内置实例默认保留 2 天)
         Coroot 自身在磁盘上维护一份指标缓存,所以 Prometheus 保留期可以很短
         设 storeMetricsInClickhouse 可把指标放进 ClickHouse,operator 会跳过 Prometheus
日志     保留期由你配置,默认 7 天
链路     默认 7 天
剖析     默认 7 天
```

因为 Coroot 有自己的缓存层,即便 Prometheus 只留 2 天,UI 上仍能看到更长的时间范围——但**这是缓存,不是完整历史**,做容量规划时不要把它当成 Prometheus 的替代。

### 主要能力

```shell
服务地图       基于 eBPF 连接跟踪,展示服务依赖与每条边的延迟/错误
检查项         自动诊断:CPU 节流、内存泄漏、重启循环、磁盘压力、DNS 失败等
SLO / 告警     基于指标定义目标与错误预算,不达标即告警
持续剖析       集成的 CPU profiling,可定位到函数级热点
日志           节点上的容器日志采集与按 Pod/服务聚合
部署追踪       把一次发布前后的指标变化直接并排展示
```

### 检查项与根因分析

Coroot 的「检查项」是一组内置的诊断规则,会在每个服务、每个节点上持续运行,把「哪里不对」直接标出来,而不是让你去读一堆图:

```shell
应用侧    CPU 节流、内存不足与 OOM、重启循环、实例不可用、错误率升高
         实例间延迟不一致、DNS 解析失败、对下游依赖的错误率
数据库    连接池耗尽、慢查询、复制延迟
节点侧    CPU/内存/磁盘饱和、磁盘延迟、网络丢包与重传
Kubernetes 探针失败、副本数不达标、资源 requests 与 limits 不合理
自建检查   可以用 PromQL 写自己的检查项
```

工作流通常是:打开服务页 → 看被标红的检查项 → 顺着它给出的指标下钻到具体实例或时间段。**注意这是启发式规则**,它给的是「值得看的候选方向」,不是结论。

### SLO 与告警

```shell
# 在服务页创建 SLO:选 SLI(可用性 / 延迟)、设定目标(如 99.9%)、选时间窗口
# Coroot 会据此计算错误预算,并在预算消耗过快时告警

# 告警通知支持常见渠道:Slack、PagerDuty、webhook、邮件等
# 通知渠道在项目设置里配置,API key 用于 agent 上报鉴权
```

SLO 的指标来源依赖数据源:走 eBPF 时可用性来自连接层成功率,走 Prometheus 时来自应用的请求指标。**没有请求指标的服务,基于 SLO 的告警会不可靠**。

### 升级与卸载

```shell
# Coroot 实例由 operator 自动升级;要固定版本就在 CR 里钉住镜像
# 升级 operator 本身
helm upgrade -n coroot coroot-operator coroot/coroot-operator

# 查看当前版本
kubectl get pods -n coroot -o jsonpath='{.items[*].spec.containers[*].image}' | tr ' ' '\n' | sort -u

# 卸载
helm uninstall coroot -n coroot
helm uninstall coroot-operator -n coroot
```

### 自建检查项

内置检查项覆盖不到的业务规则,可以用 PromQL 写成自己的检查:

```shell
# 检查项本质上是一段查询 + 一个期望的判定方式
# 在项目设置的检查项页面里新增,填写:
#   名称、分类、用于哪个范围(项目/服务/节点)
#   PromQL 表达式
#   判定方式(比如"结果为空表示健康"或"结果大于阈值表示异常")
```

示例:检查某个中间件的连接数是否接近上限

```shell
# 表达式
sum by (instance) (middleware_connections_used)
  / sum by (instance) (middleware_connections_max) > 0.9

# 这条规则命中时,Coroot 会在对应服务/节点上标红,并给出当前值
```

自建检查项的价值在于**把运维知识固化下来**。团队里「CPU 超过 80% 要看一下」这类口头经验,写成检查项之后就不依赖某个人的记忆了。

### 接入现有 Prometheus

不想让 operator 部署内置 Prometheus 时,把 Coroot 指向已有的 Prometheus:

```shell
# 在 Coroot 的 CR / 配置里指定 Prometheus 地址
# 注意:Coroot 会按自己的节奏查询该 Prometheus,
# 需要评估额外的查询压力,尤其是大范围的聚合查询
# 已有 VictoriaMetrics / Thanos / Mimir 时同样兼容(Prometheus 兼容 API)
```

混合数据源是常见形态:**eBPF agent 负责连接层与节点层,已有 Prometheus 负责应用指标**,两者在同一个服务页上合并展示。

### 注意

1. **`coroot-node-agent` 要求 Linux 内核 5.1 及以上**,这是官方 README 明确的 eBPF 门槛。低于这个版本的节点上 agent 会启动失败或采集不全,而 Coroot 的很多独有能力(连接跟踪、延迟记账)都会随之消失。
2. **agent 需要特权,而且不只是「加几个 capability」**。官方文档明确写着 node agent 需要 privileged 访问,用于 eBPF 监控、宿主机文件系统访问与容器检查。在 Talos 这类锁定型节点系统上,必须给命名空间打 `pod-security.kubernetes.io/enforce=privileged` 标签才能装上。
3. **eBPF 模式与 Prometheus 模式不是「二选一」,而是互补**。eBPF 提供连接级与内核级信息,Prometheus 提供应用与 Kubernetes 指标。**只接 Prometheus 时服务地图会退化成基于标签的推断**,跨可用区延迟、连接失败这类信息直接没有。反过来,只跑 eBPF 也拿不到应用的业务指标。
4. **operator 与 chart 是两层,升级方式不同**。Coroot 实例由 operator 自动升级(除非在 CR 里钉死了镜像版本),operator 本身要用 `helm upgrade` 升级。忘了升级 operator 会出现「Coroot 版本比 operator 新」的兼容问题。
5. **内置 Prometheus 默认只留 2 天,这是设计而非缺陷**。Coroot 靠自己的磁盘缓存补齐展示窗口。如果你的流程依赖 Prometheus 直接查询历史数据(比如自建 Grafana 大盘),必须自己调大 retention 或改用外部 Prometheus。
6. **改用 ClickHouse 存指标会改变部署形态**。`storeMetricsInClickhouse` 打开后 operator 不再部署 Prometheus,ClickHouse 的运维(分片、副本、磁盘)就落到你头上。示例里的 `clickhouse.shards=2,clickhouse.replicas=2` 是高可用配置,小集群用单副本即可,否则资源开销会超过收益。
7. **ClickHouse 是重组件**。Coroot 将日志与 profiles 放在 ClickHouse,磁盘与内存占用会随日志量线性增长。上线前先按日志吞吐估算磁盘,不要等集群被写满。
8. **服务地图的准确度依赖 eBPF 版本与内核特性**。同一套 Coroot 在不同内核版本上能画出的图不完全一样,跨节点池混用旧内核会导致部分边缺失。节点内核尽量统一。
9. **eBPF 只能看到网络与内核层**。业务维度的错误(比如「订单状态机走错分支」)不在 Coroot 的视野里,仍要靠日志或链路里的自定义属性。
10. **检查项是启发式的,会误报**。Coroot 的自动诊断基于阈值与模式匹配,在负载特征特殊的服务上会给出并不成立的结论。把它当作「快速定位候选方向」的起点,不要直接当成结论。
11. **日志采集是节点级的,会读取宿主机路径**。agent 从 `/var/log`、journald、Docker JSON、containerd CRI 日志里取数据。宿主机日志目录结构不同的发行版上需要调整配置。
12. **Coroot 不是 Prometheus 的替代品,而是它的消费方**。已有 Prometheus 体系的团队接入 Coroot 的成本很低(指过去就行);反过来想用 Coroot 取代 Prometheus 做长期存储与告警,会遇到保留期、查询能力与生态兼容性三方面的问题。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `helm` — Kubernetes包管理器
- `prometheus` — Coroot 的指标后端与主要数据来源
- `ebpf-observability` — eBPF 采集的原理与权限要求
- `pixie` — 另一套免埋点的协议级观测方案
- `grafana` — 指标可视化
- `loki` — 日志存储的另一种选择
- `pyroscope` — 持续性能剖析

### 参考链接

- [Coroot 官方文档](https://docs.coroot.com/)
- [架构说明(数据流与存储)](https://docs.coroot.com/installation/architecture/)
- [Kubernetes 安装](https://docs.coroot.com/installation/kubernetes)
- [coroot-node-agent 仓库](https://github.com/coroot/coroot-node-agent)
- [Coroot GitHub 仓库](https://github.com/coroot/coroot)
