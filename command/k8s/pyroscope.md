pyroscope
===

Grafana 的持续性能剖析平台,持续采集火焰图并可长期回溯

## 补充说明

**Pyroscope** 是 Grafana 旗下的持续性能剖析(continuous profiling)平台,由 **Grafana Alloy** 负责采集、Pyroscope 服务端负责存储与查询,在 Grafana 里以火焰图的形式展示「时间轴上每一刻的 CPU 花在哪里」。它和 Parca 属于同一类工具,差别主要在生态归属:Pyroscope 天然和 Grafana / Alloy / Loki / Tempo 一套体系打通。

当前版本节奏很快:主线版本 **v2.3.1(2026-09-08)**,几乎每月都有发布。

### 三种接入方式

```shell
Alloy 的 eBPF profiler   零侵入,采集节点上所有进程的 CPU 火焰图,不需要改代码
SDK 埋点                 在应用里引入 Pyroscope SDK,可打业务标签(租户、接口、订单号)
SDK + Alloy              SDK 把 profile 推给 Alloy 的 pyroscope.receive_http,再由 Alloy 转发
```

选择逻辑很简单:**想知道「哪个函数慢」用 eBPF,想知道「哪个租户慢」必须用 SDK**。eBPF 能自动拿到进程名、容器、命名空间这类标签,但拿不到业务维度。

### Alloy 组件

```shell
pyroscope.ebpf           eBPF 采集器,发现节点上的进程并采样 CPU 栈
pyroscope.java           针对 JVM 的 async-profiler 采集
pyroscope.scrape         抓取应用的 pprof 端点(Go 等原生支持 pprof 的语言)
pyroscope.receive_http   接收 SDK 推送的 profiles
pyroscope.write          把 profiles 写入 Pyroscope 服务端
pyroscope.relabel        标签处理
pyroscope.enrich         用 Kubernetes 元数据补全标签
```

一段最小配置:

```shell
pyroscope.ebpf "default" {
  targets    = discovery.kubernetes.pods.targets
  forward_to = [pyroscope.write.local.receiver]
}

pyroscope.write "local" {
  endpoint {
    url = "http://pyroscope.monitoring.svc.cluster.local:4040"
  }
}
```

### 服务端部署

```shell
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update

kubectl create namespace pyroscope

# 单进程模式(开发与小集群)
helm -n pyroscope install pyroscope grafana/pyroscope

# 微服务模式(生产,需要分布式存储与对象存储)
curl -Lo values-micro-services.yaml \
  https://raw.githubusercontent.com/grafana/pyroscope/main/operations/pyroscope/helm/pyroscope/values-micro-services.yaml
helm -n pyroscope install pyroscope grafana/pyroscope --values values-micro-services.yaml

kubectl -n pyroscope get pods
```

Pyroscope 2.x 的默认架构把 profiles 直接写进对象存储,**不再依赖内存中的 ingester 和本地磁盘**,扩容与运维比 1.x 简单很多,但也就意味着对象存储(S3/GCS/Azure Blob 或兼容实现)是生产部署的必选项。

### 自动发现与注解

Helm chart 自带的抓取配置通过注解发现目标,注解前缀是 `profiles.grafana.com/<profile 类型>.<字段>`:

```shell
# 支持的 profile 类型
cpu / memory / goroutine / block / mutex

# 支持的字段
scrape / port / port_name / scheme / path
```

```shell
# 让一个 Go 服务被抓取 CPU profile
kubectl annotate pod my-app \
  profiles.grafana.com/cpu.scrape=true \
  profiles.grafana.com/cpu.port=6060 \
  profiles.grafana.com/cpu.path=/debug/pprof/profile
```

端口发现默认要求目标有名字为 `http2` 的端口,或以 `-metrics`、`-profiles` 结尾的端口;没有命名端口的目标会被丢弃,这是「注解写了但没数据」的常见原因。

### SDK 接入(以 Go 为例)

需要业务维度标签时,直接用 SDK:

```shell
import "github.com/grafana/pyroscope-go"

func main() {
    pyroscope.Start(pyroscope.Config{
        ApplicationName: "my-app",
        ServerAddress:   "http://pyroscope.monitoring.svc.cluster.local:4040",
        ProfileTypes: []pyroscope.ProfileType{
            pyroscope.ProfileCPU,
            pyroscope.ProfileAllocObjects,
        },
        // 静态标签
        Tags: map[string]string{"region": "cn-north"},
    })
    // ...
}
```

```shell
# 动态标签:在请求处理路径上打业务维度
pyroscope.TagWrapper(ctx, pyroscope.Labels("tenant", tenantID), func(ctx context.Context) {
    handleRequest(ctx)
})
```

**Go 的特别之处**在于运行时的采样器本身就理解 goroutine 调用栈,所以 SDK 采出来的火焰图质量高、开销低;其他语言(JVM、Python、Ruby、Node.js)依赖各自的运行时接口或 eBPF 采集器,符号与精度受语言实现影响更大。

### Pyroscope 2.x 的架构变化

```shell
1.x    内存中的 ingester + 本地磁盘,扩容与故障恢复都比较麻烦
2.x    默认架构把 profiles 直接写进对象存储,去掉 ingester 与本地磁盘依赖
```

带来的实际影响:

```shell
生产部署必须准备对象存储(S3 / GCS / Azure Blob 或兼容实现)
扩容更简单,但对象存储的延迟与成本成为新的关注点
微服务模式的 values 文件(values-micro-services.yaml)是官方推荐的生产起点
```

### 与 Grafana 联动

```shell
Pyroscope 作为 Grafana 的 Profile 数据源接入,数据源 URL 指向 querier 服务
从指标面板可以跳到对应时间段的火焰图(前提是标签能对上)
从链路(Tempo)的 span 可以跳到该时间段该服务的火焰图,这是排障效率最高的一条路径
```

### 注意

1. **eBPF 采集器需要 root,并且要挂宿主机的 tracing 目录**。官方配置给出的最小能力集是 `BPF`、`PERFMON`、`SYS_PTRACE`、`CHECKPOINT_RESTORE`、`SYS_RESOURCE`、`DAC_READ_SEARCH`、`SYSLOG`,同时要把 `/sys/kernel/tracing`(老内核是 `/sys/kernel/debug`)以只读方式挂进容器。**`CHECKPOINT_RESTORE` 需要内核 5.9+**,更老的内核上要退回 `SYS_ADMIN`。最省事的做法仍是 `privileged: true`,但那过不了 `restricted` 级别的 Pod Security Admission。
2. **eBPF 只能采 CPU**。「为什么内存涨了」「锁竞争在哪」这类问题,eBPF 采集器回答不了——官方文档明确说明它不支持内存与 contention/lock 剖析。这类需求要用 SDK 或其他 profile 类型,而 `cpu`/`memory`/`block`/`mutex` 这些类型只在 SDK 与抓取路径上才有。
3. **符号表决定了火焰图能不能看**。eBPF 采集器通过 `.eh_frame` 展开栈(不要求编译时带帧指针),但把地址翻译成函数名仍需要符号:C/C++/Rust/Zig 要保留调试信息;Go 因为有 pclntab 通常开箱可用;JIT 语言(Java、Node.js、.NET)依赖运行时的 JIT 符号映射,新版本运行时支持更好。页面上出现大片 unknown 时,先查符号而不是查采样配置。
4. **采集器需要一块本地缓存目录**。Alloy 的 eBPF profiler 会把符号缓存在 `/tmp/symb-cache`,容器内 `/tmp` 是 tmpfs 时这块会占用内存,大集群上要给足够的内存或挂一块可写卷。
5. **不要同时跑多个 `pyroscope.ebpf` 实例**。官方明确说明多实例可行但**不推荐**,会叠加内存与 CPU 开销。需要按命名空间/节点筛选目标时,用 targets 过滤,而不是再起一个采集器。
6. **部分 eBPF 配置项已经失效**。`collect_kernel_profile`、`collect_user_profile` 以及一批 cache size 选项在新的 Alloy 里标记为 deprecated no-op,写了也不会生效。老教程里的这些参数已经过时。
7. **跳过内核检查是危险操作**。采集器提供 `no_kernel_version_check` 用于绕过内核特性检测,官方给的定性是「无法确认内核是否具备所需 eBPF 特性」——结果是采集可能部分失败或静默丢数据。只在受控环境下短期使用。
8. **profiles 不走 OTLP 管线**。Alloy 里的 `otelcol.*` 组件只处理指标、日志、链路,profiles 必须通过原生 `pyroscope.*` 组件才能到达 Pyroscope。把 profile 当成「第四种信号」接进现有 OTLP 管道是行不通的。
9. **Grafana Agent 已于 2025-11-01 EOL**,替代品是 Alloy。旧教程里的 `pyroscope.*` Agent 配置需要迁移到 Alloy 配置语法;**这是本领域最容易踩的时效性坑**——文档、博客、Helm chart 注释里大量引用 Agent。
10. **采样开销与采样频率要实测**。低频率采样对长尾不敏感,高频率在高密度节点上会明显吃 CPU。上线时先在一个节点池灰度,观察 Alloy 的 CPU 与内存,再决定全量铺开。
11. **标签基数会拖垮查询**。给 profile 打上 request_id、用户 ID 这类高基数标签,火焰图的查询会急剧变慢,存储成本也会上升。业务标签只保留有限枚举的维度(租户、接口名、地域)。
12. **Go 的 pprof 抓取与 eBPF 是两条路,各有取舍**。对 Go 服务用 `pyroscope.scrape` 抓 `/debug/pprof/profile` 更准确、开销更低(Go 运行时的采样器知道调用栈),而 eBPF 的好处是零侵入、无需暴露端点。两者不要对同一目标同时开启,否则同一份 CPU 会被记两遍。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `helm` — Kubernetes包管理器
- `grafana` — 火焰图的展示入口
- `parca` — 同类持续剖析平台
- `coroot` — 内置持续剖析的 APM
- `loki` — 日志,与 profiles 联动的另一半
- `opentelemetry` — 指标、日志、链路的采集标准
- `ebpf-observability` — eBPF 采集的权限与内核要求
- `prometheus` — 指标监控与告警

### 参考链接

- [Grafana Pyroscope 官方文档](https://grafana.com/docs/pyroscope/latest/)
- [Pyroscope GitHub 仓库](https://github.com/grafana/pyroscope)
- [Grafana Alloy 的 pyroscope.ebpf 组件](https://grafana.com/docs/alloy/latest/reference/components/pyroscope/pyroscope.ebpf/)
- [Kubernetes Helm 部署](https://grafana.com/docs/pyroscope/latest/deploy-kubernetes/helm/)
- [配置客户端发送 profiles](https://grafana.com/docs/pyroscope/latest/configure-client/)
- [Grafana Alloy 文档](https://grafana.com/docs/alloy/latest/)
