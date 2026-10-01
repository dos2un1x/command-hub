ebpf-observability
===

基于 eBPF 的内核态免埋点可观测性,理解它的原理、边界与选型取舍

## 补充说明

**eBPF observability** 指在不修改应用代码、不重启进程的前提下,把可观测数据从**内核**里取出来的那一类方案。代表工具有 Pixie、Coroot、Cilium/Tetragon、Falco、Grafana Beyla、Parca Agent、Pyroscope 的 eBPF profiler。它们解决的是同一个问题:**埋点式可观测性(OpenTelemetry SDK、各类 agent)需要改代码、发版、重启,而线上服务往往没有这个条件**。

要判断一套 eBPF 方案能不能用,只需要回答三个问题:内核版本够不够、权限给不给得起、它到底能看到哪一层。这一页就围绕这三点展开。

### eBPF 是什么

eBPF 是 Linux 内核里的一个**受验证的字节码执行环境**。用户态程序把一段 eBPF 字节码交给内核,内核的 verifier 逐条检查它不会越界、不会死循环、不会崩溃内核,通过后 JIT 编译成机器码,挂到某个**挂载点(hook)**上。挂载点命中时内核调用这段程序,程序把数据写进 ring buffer / perf buffer 交给用户态。

用一句更直白的话:**eBPF 让你在不改内核、不写内核模块的前提下,在内核的既定位置插入一段只读的旁路逻辑**。因此它天然具备三个性质——不需要应用配合、不需要重启、挂载点失效时不影响业务。

常用挂载点与它们能看到的东西:

```shell
kprobe / kretprobe   挂在内核函数入口/返回,看 syscall 与内核子系统行为
uprobe / uretprobe   挂在用户态二进制的函数符号上,比如 OpenSSL、Go runtime
tracepoint           内核预置的稳定探针点,比 kprobe 稳定但覆盖面窄
fentry / fexit       BPF trampoline,比 kprobe 快得多,需要 5.5+
XDP / TC             网络包进入协议栈之前,做过滤、采样、统计
LSM                  内核安全钩子,用于运行时安全策略
```

可观测工具基本都是组合使用:`uprobe` 挂到 SSL 库的读写函数上还原明文协议,`kprobe` 挂到 `tcp_connect` 上统计连接延迟,`tracepoint` 采集调度与内存事件。

### 为什么能免埋点

传统 APM 的链路是「引入 SDK → 改代码 → 发版 → 上报」。eBPF 的链路是「内核挂钩子 → 协议解析 → 上报」,应用完全不知情。

协议解析是免埋点的关键。以 HTTP 为例:eBPF 程序挂在内核 socket 读写路径(或用户态 SSL 库)上,拿到的是字节流;用户态 agent 再按 HTTP 报文格式解析出 method、path、status、耗时,还原出一条 span。数据库协议(MySQL/Postgres/Redis)、gRPC、DNS、Kafka 同理,每种协议对应一份解析器。

这就是为什么 eBPF 方案的**覆盖范围取决于解析器列表**,而不是取决于你的代码。解析器没写的协议就是盲区,再新的内核也看不到。

### 与 sidecar 方案的取舍

Service Mesh 的 sidecar(Envoy)同样能做到免埋点,但两者的代价完全不同:

```shell
维度          eBPF 方案                       sidecar 方案
资源开销      每节点一个 agent,与 Pod 数弱相关   每 Pod 一个代理,与 Pod 数强相关
延迟影响      挂钩子,通常微秒级                 多一跳网络,通常毫秒级
部署粒度      节点级 DaemonSet                 工作负载级注入
可见层次      内核 syscall / 网络栈             进程内 7 层协议
加密流量      需要 uprobe 挂 SSL 库,或看不到     天然能看到(mTLS 自动处理)
协议覆盖      取决于解析器实现                   取决于 Envoy filter 实现
可编程性      受限于 verifier,开发门槛高         配置化,生态成熟
升级成本      升级 DaemonSet                     重建所有业务 Pod 才生效
```

几条实践经验:

- **延迟敏感、Pod 密度高的集群**偏向 eBPF,sidecar 的每 Pod 内存占用会随规模线性放大。
- **需要 mTLS、流量治理、限流熔断**的场景仍要 sidecar,这些是数据面代理的职责,eBPF 工具不做。
- **两者不冲突**。常见组合是 sidecar 负责治理,eBPF agent 负责零成本的网络与服务指标,把「谁在跟谁说话、慢在哪一跳」补齐。

### 内核版本要求

这是选型时第一个要对着 `uname -r` 核对的东西。eBPF 的能力是逐版本长出来的:

```shell
4.9      kprobe/uprobe 可用的实际下限,同时也是 bpftrace 的最低要求
4.14     RHEL 8 / CentOS 8 内核线,长期被当作「能跑但功能受限」的基线
5.2      引入 BTF 与 CO-RE,从此一份字节码可以跨内核版本运行
5.4      Ubuntu 20.04 / 主流云厂商镜像内核,当前最普遍的推荐基线
5.5      BPF trampoline(fentry/fexit),低开销函数追踪
5.7      BPF LSM,运行时安全策略可用
5.8      BPF ring buffer;同时拆分出 CAP_BPF / CAP_PERFMON
```

**CO-RE(Compile Once – Run Everywhere)是 5.2 之后的分水岭**。没有 CO-RE,程序要针对每个内核版本现场编译(依赖节点装内核头文件与编译器);有了 CO-RE,发行版一份字节码全平台通用。判断节点是否支持:

```shell
# 内核版本
uname -r

# 是否带 BTF(CO-RE 的前提),有输出即支持
ls /sys/kernel/btf/vmlinux

# 是否开启 CONFIG_DEBUG_INFO_BTF
zgrep CONFIG_DEBUG_INFO_BTF /proc/config.gz 2>/dev/null || \
  grep CONFIG_DEBUG_INFO_BTF /boot/config-$(uname -r)

# 内核是否开启了 BPF JIT
cat /proc/sys/net/core/bpf_jit_enable
```

### 权限要求

eBPF 需要的能力按内核版本分两代:

```shell
老内核(< 5.8)   CAP_SYS_ADMIN,一把万能钥匙,安全上最不受欢迎
新内核(>= 5.8)  CAP_BPF         装载 BPF 程序
                CAP_PERFMON     使用 perf 事件与 tracepoint
                CAP_SYS_RESOURCE 突破 rlimit 限制(如 memlock)
                CAP_SYS_PTRACE   读取其他进程的用户态内存(做 uprobe 符号解析)
                CAP_DAC_READ_SEARCH / CAP_SYSLOG  读取符号与内核日志
```

只给 capability 而不用 `privileged: true` 是可行的,但**必须同时放开 memlock rlimit 并挂载 host 的 `/sys/kernel/tracing`(老内核是 `/sys/kernel/debug`)**,否则 agent 报的错会是「权限不足」而不是「缺少挂载」。多数工具的 Helm chart 默认直接给 `privileged: true` + `hostPID: true`,能跑通但过不了 `restricted` 级别的 Pod Security Admission:

```shell
# 命名空间启用 privileged 级别的 PSA(常见做法)
kubectl label ns observability pod-security.kubernetes.io/enforce=privileged --overwrite

# 检查集群是否有内核锁定(lockdown)或未关闭的 unprivileged_bpf_disabled
cat /sys/kernel/security/lockdown
sysctl kernel.unprivileged_bpf_disabled
```

### 典型工具分工

```shell
Pixie                 免埋点协议观测(HTTP/gRPC/DB/DNS),短期存储
Coroot                eBPF 指标 + APM + SLO,落 Prometheus / ClickHouse
Grafana Beyla         OpenTelemetry 生态的 eBPF 自动埋点,直接产出 OTLP
Cilium / Tetragon     网络与运行时安全,内核态策略执行
Falco                 运行时威胁检测,规则匹配系统调用
Parca Agent           eBPF 无侵入 CPU profiling
Pyroscope + Alloy     eBPF profiling,写入 Pyroscope
OpenTelemetry         eBPF profiler,产出 OTLP profiles
```

### 每个工具的硬门槛

选型时先对齐这张表,可以省掉大量试错:

```shell
bpftrace / BCC          内核 4.9+,带内核头文件或 BTF
Cilium                 4.19+(基础),5.4+ 才能用到大部分特性
Pixie                  4.14+,官方推荐新版内核
Falco(modern_ebpf)     5.8+,关键 hook 需要 5.10+
Coroot node agent      5.1+
Parca Agent            5.3+,且必须带 BTF
Pyroscope(Alloy eBPF)  需要 BPF/PERFMON/CHECKPOINT_RESTORE 等能力,CHECKPOINT_RESTORE 要求 5.9+
```

注意这些数字**不是同一类要求**:有的是「能加载程序」的下限,有的是「某个能力可用」的下限。低版本内核上工具可能能启动,但功能静默缺失。

### 选型自检清单

在把任何一套 eBPF 方案推进生产之前,按顺序回答下面这些问题。任何一条答不上来,方案就还没有落地条件:

```shell
# 1) 节点内核分布(按节点池看,不要只看一个节点)
kubectl get nodes -o custom-columns='NAME:.metadata.name,KERNEL:.status.nodeInfo.kernelVersion'

# 2) 是否带 BTF
for n in $(kubectl get nodes -o name); do
  echo "$n: $(kubectl debug node/${n#node/} -it --image=busybox -- \
    sh -c 'ls /sys/kernel/btf/vmlinux' 2>/dev/null)"
done
# 更简单的做法:登录节点或看配置管理里的内核 build config

# 3) 容器运行时(决定 cgroup 版本与 CRI 行为)
kubectl get nodes -o custom-columns='NAME:.metadata.name,RUNTIME:.status.nodeInfo.containerRuntimeVersion'

# 4) 是否允许特权工作负载(PSA 标签)
kubectl get ns --show-labels | grep pod-security

# 5) 是否有内核锁定(Secure Boot)
# 逐节点执行:cat /sys/kernel/security/lockdown

# 6) 预估开销:节点可分配内存与 agent 的 requests/limits 对比
kubectl describe node <node> | grep -A5 'Allocated resources'
```

### 常见故障与排查

```shell
程序加载失败,报 invalid argument 或 operation not permitted
  → 大概率是内核不支持该挂载点,或缺少 CAP_BPF / kernel.unprivileged_bpf_disabled=1
  → 用 bpftrace -l 看该内核究竟暴露了哪些探针点

程序加载失败,报 failed to load BTF / -ENOENT
  → 节点没有 /sys/kernel/btf/vmlinux,CO-RE 不可用

agent 起来了但采集不到数据
  → 先确认 hostPID 是否为 true,再确认 cgroup 版本与 PID 映射
  → 再看 agent 的自身指标里 targets 数量是否为 0

同一个工具换个节点池就报权限错误
  → 不同节点池的内核版本或 PSA 标签不一致,逐池核对

CPU 占用异常高
  → 采样率过高或挂载点命中过频(高频 syscall 上挂 kprobe 最典型)
```

### 注意

1. **内核版本是硬门槛,不是「性能差异」**。4.9 是能跑 kprobe 的下限,但绝大多数现代工具真正要求 5.2+(CO-RE/BTF)甚至 5.8+(ring buffer、CAP_BPF)。托管 Kubernetes 上你**改不了节点内核**,选型前先在所有节点池上跑一遍 `uname -r` 与 `ls /sys/kernel/btf/vmlinux`,再决定用哪套方案。
2. **没有 BTF 的节点上,CO-RE 方案直接不可用**。RHEL 8 系(4.18)默认不带 `CONFIG_DEBUG_INFO_BTF`,表现为 agent 启动即失败,而错误信息往往只说「failed to load program」,不会直接告诉你缺 BTF。
3. **`CAP_SYS_ADMIN` 与 `privileged: true` 是两件事,但都会被 Pod Security 拦下**。`restricted` 级别不允许特权容器,`baseline` 不允许 `CAP_SYS_ADMIN`。要么给监控命名空间单独打 `pod-security.kubernetes.io/enforce=privileged` 标签,要么逐项列 capability 并配上正确的 hostPath 挂载。
4. **Secure Boot + 内核 lockdown 会让 eBPF 工具失效**。lockdown 模式下 `bpf()` 系统调用被限制,而且报错通常是「operation not permitted」,容易误判成 capability 没给对。用 `cat /sys/kernel/security/lockdown` 确认。
5. **eBPF 看不到应用内部**。它看到的是 syscall 与网络报文。业务逻辑分支、内存里的对象、线程池排队、GC 停顿这类信息,eBPF 拿不到——别指望它替代 SDK 与 pprof。
6. **TLS 是常见盲区**。内核层看到的是加密后的字节流。要还原 HTTP 明文,agent 必须用 uprobe 挂到进程内的 SSL 库(OpenSSL/BoringSSL/Go crypto/tls)上——如果应用静态链接了自己改过的 TLS 实现,或者用了语言自带的非标准实现,这条链路就断了。
7. **协议解析器列表等于能力边界**。上线前先确认要观察的中间件(比如某国产数据库、自研 RPC)是否在支持列表里,不在的话 eBPF 方案只能给你 TCP 层的连接数与延迟。
8. **采样率决定开销,也决定能不能定位长尾**。eBPF profiler 通常按固定频率采样(如 19Hz、99Hz),低频采样对 P99 的还原是不准的;而全量采集在高流量节点上会吃满 CPU。上线时必须实测 agent 的 CPU 占用,而不是相信厂商给的「<1%」。
9. **`hostPID: true` 是多数 agent 的隐含要求**。采集容器内进程信息需要看到宿主机的 PID 命名空间,这会让 agent 具备看到节点上所有进程的能力,安全评审时通常会被单独拎出来讨论。
10. **容器内的 PID 与宿主机 PID 需要映射**。eBPF 采集到的是宿主机视角的 PID 与 cgroup id,工具必须把它们映射回 Pod/容器。cgroup v1 与 cgroup v2 的映射方式不同,节点混用两代 cgroup 时数据会错位。
11. **eBPF 程序有内核崩溃风险,虽然很低**。verifier 保证了内存安全,但历史上多次出现过内核 bug 导致节点 panic(尤其在老内核上跑新程序)。生产灰度时优先选非核心节点池,并确认节点的自动恢复能力。
12. **不要同时上三套 eBPF agent**。Pixie、Coroot、Falco、Cilium 各自都会挂载自己的探针,在同一节点上叠加会成倍增加内存与 CPU 开销,而且它们的挂载点会互相影响性能。先明确每套工具解决哪一类问题,再决定并存的必要性。
13. **托管集群的「无节点访问」限制会直接否决方案**。EKS Fargate、GKE Autopilot 这类不暴露节点的环境无法加载 eBPF 程序,只能退回 sidecar 或应用埋点。

### 相关命令

- `cilium` — 基于 eBPF 的 CNI 与网络可观测性
- `falco` — 基于系统调用的运行时安全检测
- `pixie` — 免埋点的 Kubernetes 协议观测
- `coroot` — eBPF 指标与 APM 平台
- `parca` — eBPF 持续性能剖析
- `pyroscope` — 持续性能剖析平台
- `opentelemetry` — 埋点式可观测性的标准与采集器
- `pod-security-admission` — eBPF agent 常见的准入冲突来源
- `securitycontext` — capability 与特权字段的落点

### 参考链接

- [eBPF 官方文档](https://ebpf.io/what-is-ebpf/)
- [Linux 内核 BPF 文档](https://docs.kernel.org/bpf/index.html)
- [BPF 与 CO-RE 参考(libbpf)](https://docs.kernel.org/bpf/libbpf/libbpf-intro.html)
- [bpftrace 安装与内核要求](https://github.com/bpftrace/bpftrace/blob/master/INSTALL.md)
- [Cilium 内核版本要求](https://docs.cilium.io/en/stable/architecture/requirements/)
- [OpenTelemetry eBPF profiler](https://opentelemetry.io/docs/specs/otel/profiles/)
