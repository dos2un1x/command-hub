parca
===

持续性能剖析平台,eBPF 无侵入采集 CPU 火焰图并长期留存

## 补充说明

**Parca** 是一套持续性能剖析(continuous profiling)系统,由 Polar Signals 发起。它由两部分组成:**Parca Agent** 用 eBPF 在所有节点上持续采样调用栈,**Parca Server** 负责存储与查询,并用火焰图展示「哪一行代码在消耗 CPU」。它把过去只能在性能工地上跑一次的 `pprof`,变成了一条常态化的数据管道——任何时刻的性能问题,都能回溯到当时的火焰图。

**维护状态说明(2026-09)**:Polar Signals 于 **2026-08-17** 宣布加入 **Dash0**,公告中明确 **Parca 保持开源并继续维护**,Polar Signals Cloud 服务不变。实际节奏上 **Parca Agent 活跃**(v0.49.0,2026-07-07;并为 v0.48.0 加入基于 CUPTI 的 CUDA PC 采样,可做 GPU 持续剖析),而 **Parca Server 明显放缓**(最新 v0.28.0,2026-05-07;主干上人工提交停在 2026-07-22,之后主要是依赖更新)。结论是:**项目没有归档也没有停更,但服务端的推进速度慢于同类竞品**。选型时如果重点在服务端能力与迭代速度,应同时评估 Grafana Pyroscope;如果只需要「无侵入地看火焰图」,Agent 一侧依然健康。

### 与一次性 profiling 的区别

```shell
一次性 pprof     出问题才去采集,采完就丢;无法回看历史,也无法做前后对比
持续 profiling   常态化低开销采样,数据长期留存;可以对比"发布前后""昨天同时刻"
```

价值在于**对比**:两张火焰图的差分(differential flame graph)能直接指出某次发布新引入的热点,这是单次采样做不到的。

### 架构

```shell
Parca Agent      DaemonSet,每节点一个;eBPF 采样用户态与内核态调用栈
                 默认 19Hz,把样本打包成 pprof 格式;也可对 Go 程序抓 pprof 端点
Parca Server     接收 profiles 与 symbols,写入对象存储,提供查询与 UI
Symbols          调试符号,用于把地址翻译成函数名与行号
```

### 安装

```shell
helm repo add parca https://parca-dev.github.io/helm-charts/
helm repo update parca

# 一体化部署(server + agent)
helm install parca parca/parca -n parca --create-namespace

# 查看 Agent 是否在每个节点上跑起来
kubectl get pods -n parca -l app.kubernetes.io/name=parca-agent

# 端口转发到 UI
kubectl port-forward -n parca svc/parca 7070:7070
```

Agent 需要能看到宿主机,典型配置:

```shell
# 关键参数(agent)
--node=my-node                          # 标识自身
--http-address=:7071                    # 暴露指标与调试信息
--debuginfo-directories=/usr/lib/debug  # 调试符号搜索目录(默认值)
--debuginfo-strip                      # 只上传符号化所需信息,而非整个二进制
--debuginfo-compress                   # 压缩 DWARF 段
--debuginfo-upload-disable             # 完全关闭符号上传
--remote-store-address=<server:7070>    # 把 profiles 与 symbols 直接推给 server
```

### 查询

UI 上的核心操作是选标签、选时间范围、看火焰图。查询维度由 profile 的标签决定,常见的有 `namespace`、`pod`、`container`、`service`、`job`。

火焰图可以直接切到 **diff 视图**,对比两个时间窗口的差异——这是定位「某次发布引入了什么热点」最有效的手段。服务端通过 gRPC/Connect 接口对外提供查询,UI 与 `parca-server` 自带的工具都走这套接口;需要拿原始 profile 做二次分析时,UI 上的下载入口可以直接导出 pprof 格式文件,再用标准工具处理:

```shell
# 导出的 pprof 文件可以用 Go 自带工具链分析
go tool pprof -http=:9090 cpu.pb.gz

# agent 自身暴露的采集指标(Prometheus 格式),用于确认采集是否正常
kubectl port-forward -n parca ds/parca-agent 7071:7071
curl -s localhost:7071/metrics | grep parca_agent
```

### 采样对象的发现

Agent 自动发现节点上的容器进程,无需应用配合:

```shell
# 查看 agent 发现了哪些 profiling targets
curl -s localhost:7071/metrics | grep parca_agent_profiler_targets

# 排除不需要采集的命名空间(减少开销与噪音)
# Helm 值中通过 agent 的 extraArgs 或 relabel 配置控制
```

### 火焰图怎么读

火焰图纵向是调用栈深度,横向是样本占比。几个容易读错的地方:

```shell
宽度 = 在该函数里的采样数占比,不是耗时绝对值
自底向上才是调用关系(默认视图),从下往上依次是调用者到被调用者
看"平顶"       某个函数很宽且下面没有更深的帧 —— 它就是热点本身
看"窄而深"     单个调用很深但很窄 —— 通常是初始化路径或边缘分支
看"孤儿帧"     出现 [unknown] 或地址,说明符号没解析出来,不是没有数据
```

**差分火焰图(differential flame graph)是持续剖析真正的杀手锏**:选两个时间段(比如发布前 1 小时与发布后 1 小时),红色表示新增的热点,蓝色表示消失的热点。定位「这次发布把哪个函数搞慢了」只需要几秒钟。

```shell
# 典型工作流:先看服务总览,发现某个服务 CPU 上涨
# → 选该服务 → 时间范围拉到发布前后 → 切到 diff 视图 → 看红色面积最大的函数
# → 用它下面的调用路径判断是哪条代码路径引入的
```

### 部署拓扑

```shell
一体化        Agent + Server 在同一个 chart 里,小集群与测试环境最省事
分离部署      Agent 只负责采集与推送,Server 独立部署并接对象存储
              适合生产:存储与服务生命周期解耦,Server 升级不影响采集
```

Agent 有两种输出方式,按集群网络条件选择:

```shell
# 直接推送:agent 主动把 profiles 与 symbols 推给 server
--remote-store-address=<server>:7070

# 或暴露指标与 pprof 端点,由 server 侧抓取(适合网络策略严格的场景)
--http-address=:7071
```

无论哪种方式,都要确认 agent 能解析到 server 的地址,否则表现是「UI 上一个 target 都没有」。

### 与其他信号的关系

持续剖析回答的是「CPU 花在哪」,它需要和另外两类数据配合才有完整结论:

```shell
指标(Prometheus)  告诉你"什么时候变慢了、变慢了多少"
链路(Tracing)     告诉你"哪个请求、哪一跳变慢了"
剖析(Parca)       告诉你"变慢的那段代码在干什么"
```

三者连线的方式是**标签对齐**:让 profile 的标签(service、pod、namespace)与指标、链路里的标签保持一致,才能在 Grafana 里从一个面板跳到另一个面板。上线前把标签规范定下来,比事后补要便宜得多。

### 采样与开销控制

```shell
# 采样频率:默认 19Hz,越低开销越小、长尾越不准
# 采样范围:按命名空间 / Pod 过滤,把不关心的工作负载排掉
# 栈深度:深层调用栈展开更贵,业务栈不深时可以调小
# 内核态采样:只在需要看内核热点时开启,默认只采用户态更省
```

分目标类型的开关:

```shell
Go 程序       优先用 pull 模式抓 pprof 端点,精度更高、开销更低
其他语言      走 eBPF 采样;对精度要求不高时降低采样频率
不想采的目标  relabel 阶段直接丢掉,别让 agent 处理完再丢
```

判断开销是否可接受的方法很简单:**在灰度节点上对比开启前后的 CPU 使用率与 P99**。任何外部给的「开销约 X%」数字都只能当参考,因为开销取决于采样目标的代码特征。

### 注意

1. **Agent 要求 Linux 内核 5.3+ 且带 BTF**。这是官方 README 的明确要求,低于此版本直接不可用。没开 `CONFIG_DEBUG_INFO_BTF` 的内核(比如 RHEL 8 的 4.18)即使版本够也跑不起来。部署前用 `ls /sys/kernel/btf/vmlinux` 逐节点确认。
2. **Agent 需要 root 或 `CAP_SYS_ADMIN`**。它要读取其他进程的内存来展开栈,普通 capability 组合不够用。这在 `baseline` 及以上级别的 Pod Security Admission 下会被拦下,通常需要给监控命名空间打 privileged 豁免标签。
3. **符号化(symbolization)是使用持续剖析最常踩的坑**。火焰图里出现一堆 `[unknown]` 或纯地址,基本都出在符号表:程序被 strip 掉了符号、调试信息不在 `--debuginfo-directories` 搜索路径下、或者符号上传被关掉了。**Go 是特例**——Go 二进制自带符号与 pclntab,即使 strip 过也能还原函数名,所以 Go 服务的火焰图通常开箱即用。C/C++/Rust 需要保留 DWARF(`-g` 编译且不要 strip),再靠 agent 上传。
4. **`--debuginfo-strip` 会改变上传内容**。打开时上传的是裁剪过的调试信息;关闭时上传的是 agent 看到的**完整二进制**。这不仅影响符号质量,也涉及合规——把生产二进制原样上传到剖析后端前先评估。
5. **符号上传有存储与网络成本**。大镜像的 DWARF 段动辄几百 MB,首次上传会明显占用带宽与对象存储。用 `--debuginfo-compress` 压缩,或对无法符号化的目标直接 `--debuginfo-upload-disable`。
6. **采样是有偏的,低频采样看不到长尾**。19Hz 是按时间的采样,单次极慢的请求很可能一次都没被采到。剖析适合回答「总体上 CPU 花在哪」,不适合回答「P99 慢在哪」——后者要靠链路追踪。
7. **eBPF profiling 的栈展开依赖帧信息**。老式 `-fno-omit-frame-pointer` 之外的编译方式、被内联掉的函数、JIT 生成的代码(Java、Node.js、.NET)都可能展开不全。Java 等语言还需要 JIT 符号支持,效果不如原生编译语言稳定。
8. **Server 端迭代放缓,升级前先确认版本兼容**。Agent 与 Server 之间的协议会随版本变化;Agent 是活跃开发的一侧,如果钉死了较老的 Server,新 Agent 的部分数据字段可能无法被识别。反之,长期不升级 Agent 也会错过对新一代内核的适配。
9. **对象存储是必须规划的一环**。profiles 与 symbols 都是持续写入的,本地磁盘很快会满。生产部署应把存储指向 S3/GCS/Azure Blob,并设置好生命周期策略(比如符号保留 90 天、profile 保留 30 天)。
10. **CPU 剖析最成熟,内存与 GPU 是另外的话题**。Parca 的主线是 CPU;内存剖析依赖语言运行时支持,GPU 剖析是较新的能力(需要特定驱动与硬件)。不要假设「装了 Parca 就能看内存泄漏」。
11. **节点上的 agent 会读 `/proc` 与 `/sys`**,包括 `/sys/kernel/tracing`(老内核 `/sys/kernel/debug`)。容器运行时如果对 procfs 做了屏蔽(如 gVisor),agent 无法工作。
12. **不要把剖析数据当指标用**。profiles 的采样特性决定了它不适合做告警阈值;需要「CPU 使用率超 80% 告警」时,用 Prometheus 指标,把 Parca 留给「为什么 CPU 这么高」。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `helm` — Kubernetes包管理器
- `pyroscope` — 同类持续剖析平台,服务端迭代更快
- `coroot` — 内置持续剖析的 APM 平台
- `ebpf-observability` — eBPF 采集的原理与权限要求
- `prometheus` — 指标侧的监控与告警
- `opentelemetry` — 链路与指标的采集标准

### 参考链接

- [Parca 官方文档](https://www.parca.dev/docs/overview)
- [Parca GitHub 仓库](https://github.com/parca-dev/parca)
- [Parca Agent GitHub 仓库](https://github.com/parca-dev/parca-agent)
- [Parca Helm Chart](https://github.com/parca-dev/helm-charts)
- [Polar Signals 加入 Dash0 的公告](https://blog.polarsignals.com/blog/posts/2026/08/17/polar-signals-is-joining-dash0)
- [pprof 格式说明](https://github.com/google/pprof/blob/main/doc/README.md)
