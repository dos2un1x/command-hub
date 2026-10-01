gvisor
===

用户态内核沙箱容器运行时,为不可信工作负载提供第二层隔离

## 补充说明

**gVisor** 是 Google 开源的容器运行时沙箱。它的做法和 runc 完全不同:runc 让容器进程直接跑在宿主机内核上,靠 namespace 和 cgroup 做隔离;gVisor 则在应用和宿主机内核之间插进一个**用 Go 写的用户态内核(Sentry)**,应用的所有系统调用先被 Sentry 拦截和实现,只有少数必要操作才转发给真正的内核。

这样做的直接收益是:**容器逃逸的攻击面从「整个 Linux 内核」缩小到「Sentry 这个用户态进程 + 少量转发接口」**。代价同样直接:Sentry 需要自己实现一遍 Linux 系统调用,兼容性必然有缺口,而且每次 syscall 都要多走一层,性能有损耗。

它服务于一个非常具体的场景:**你要跑的是不完全信任的代码**——多租户 SaaS 的客户代码、CI 里执行用户提交的构建脚本、在线判题、插件市场里的第三方插件。这些场景下 runc 的隔离强度不够,gVisor 才划算。

### 三种平台

gVisor 的「平台(platform)」指它拦截系统调用的机制,直接决定性能与硬件要求:

```shell
systrap   通过 seccomp 的 SECCOMP_RET_TRAP 让内核把 SIGSYS 交给 gVisor
          2023 年年中起成为默认平台;在虚拟机里跑通常是最优选择
KVM       Sentry 同时充当 guest OS 与 VMM,利用硬件虚拟化
          只在裸金属上才能发挥全部性能;需要 CPU 虚拟化扩展与 /dev/kvm
ptrace    用 PTRACE_SYSEMU 拦截,上下文切换开销大
          官方已标注不再支持,并预告未来会移除
```

除非有明确理由,直接使用默认的 systrap。

### 安装与接入 Kubernetes

gVisor 以 `runsc` 二进制发布,同时提供 containerd 的 shim `containerd-shim-runsc-v1`:

```shell
# 官方 apt 源安装(推荐)
sudo apt-get update && sudo apt-get install -y runsc

# 从 release 包安装时,runsc 与 containerd-shim-runsc-v1 必须放在一起
# gvisor-bin/ 目录要与 runsc 相邻,移动时三个一起移

runsc --version
```

在 containerd 里注册一个 runtime handler:

```shell
# containerd 2.x(config version 3)的插件 ID 已经变了
[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runsc]
  runtime_type = "io.containerd.runsc.v1"

# containerd 1.x 的写法(旧教程里常见,2.x 上不生效)
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc]
  runtime_type = "io.containerd.runsc.v1"

# 改完重启 containerd
sudo systemctl restart containerd
```

然后创建 RuntimeClass 并在 Pod 上引用:

```shell
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor
handler: runsc
```

```shell
apiVersion: v1
kind: Pod
metadata:
  name: sandboxed
spec:
  runtimeClassName: gvisor
  containers:
    - name: app
      image: nginx:alpine
```

```shell
# 确认 RuntimeClass 已经存在并指向正确的 handler
kubectl get runtimeclass
kubectl get runtimeclass gvisor -o yaml

# 确认 Pod 真的跑在沙箱里:容器内执行 dmesg 会看到 gVisor 的启动信息
kubectl exec sandboxed -- dmesg | head -3
kubectl exec sandboxed -- uname -a
```

托管方案:**GKE Sandbox** 直接提供同一套能力,节点池级别开启即可,不需要自己维护 runsc。

### 与 Kata 的区别

两者常被放在一起比较,但原理完全不同:

```shell
维度        gVisor                        Kata Containers
隔离机制    用户态内核拦截 syscall          每个 Pod 一个真正的轻量虚拟机
硬件要求    无(纯软件)                    需要嵌套虚拟化或裸金属 + /dev/kvm
启动速度    快,与普通容器接近              慢,需要启动 guest 内核
兼容性      系统调用需要被 Sentry 实现       与宿主机内核一致,兼容性更好
内存开销    中等(Sentry 常驻)              较高(每个 Pod 一份 guest 内核)
```

简单说:**gVisor 用兼容性换隔离,不需要虚拟化;Kata 用资源开销换隔离,需要虚拟化**。两者可以同时存在于一个集群,靠不同的 RuntimeClass 区分。

### 上生产前的兼容性验证清单

gVisor 的问题几乎都出在「启动没问题、跑起来才炸」。上线前按这份清单过一遍:

```shell
# 1) 完整跑一遍业务回归,不要只验证容器能起来
#    重点覆盖：启动参数解析、文件读写、子进程创建、信号处理、优雅退出

# 2) 检查是否依赖下列能力（任一命中就要仔细评估）
/proc 与 /sys 的具体字段            gVisor 实现的是子集
mount / 文件系统操作                块设备文件系统不支持
iptables / nftables 规则            只有部分支持
io_uring                            默认关闭
自定义设备文件（/dev 下非 GPU/TPU）  基本不支持
在容器里跑虚拟机（KVM）             明确不支持

# 3) 用 strace 观察是否存在大量 EPERM/ENOSYS
kubectl exec sandboxed -- strace -f -e trace=all -p 1 2>&1 | grep -E 'ENOSYS|EPERM'

# 4) 压测对比：同一服务在 runc 与 gvisor 下的 P50 / P99 / CPU 使用率
#    以压测结果决定是否接受，而不是相信任何外部基准
```

### 性能与平台选择

```shell
平台选择
  裸金属 + CPU 虚拟化可用   → KVM 通常最快
  虚拟机里的节点            → systrap(嵌套虚拟化开销大于拦截开销)
  不确定                    → 用默认 systrap,它是 2023 年以来的默认值

负载类型与损耗
  syscall 密集(大量小文件读写、频繁网络往返)  损耗最明显
  计算密集(syscall 少)                        影响较小
  启动阶段                                    影响小,问题多出在运行期
```

调整平台用运行时的配置项(在 containerd 的 runtime 配置里给 runsc 加参数):

```shell
[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runsc]
  runtime_type = "io.containerd.runsc.v1"
  [plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runsc.options]
    TypeUrl = "io.containerd.runsc.v1.options"
    # 平台、网络实现、缓冲区大小等都在这里配
```

### 注意

1. **gVisor 要求 Linux 5.6 及以上**,仅支持 x86_64 与 ARM64。这个门槛比很多人以为的高——官方安装文档写得很明确。老内核(如 RHEL 8 的 4.18)无法使用,不要照着旧教程硬试。
2. **系统调用兼容性是最大的坑,而且是「能跑起来但行为不对」的那类**。官方态度很坦诚:「永远会有未实现的特性和 bug」。实践上要注意的是:很多程序启动阶段只用到常见 syscall,跑得好好的;等到某个特定场景触发了一个未实现的 syscall,才在运行期报出莫名其妙的 `ENOSYS`。**上线前必须跑完整的业务回归,而不是只看容器起没起来**。
3. **cgroup 的资源限制在沙箱内不生效**。gVisor 在沙箱内部实现了 cgroup 的**统计**能力,但**不强制**limits。要限制整个沙箱的资源,必须把它放进宿主机的 cgroup;沙箱内部多个进程之间的资源隔离则做不到。依赖 `limits.cpu` 做精确控制的场景要重新评估。
4. **块设备文件系统不能从沙箱内挂载**。`ext3`、`ext4`、`fat32` 在 gVisor 内核里没有原生实现,必须在宿主机挂载好再把目录暴露进去。想在沙箱里跑 `mount` 的镜像构建类工作负载会直接失败。
5. **网络相关的兼容缺口很集中**。`iptables` 只有部分支持(目标是让 Docker-in-gVisor 能用,不保证更多);`nftables` 同样受限;`io_uring` 默认关闭,打开后也只支持基础 I/O。容器里跑 VPN、代理、需要精细防火墙规则的软件要慎用。
6. **自定义硬件的设备文件通常不支持**。除了 NVIDIA GPU 与 TPU,其他设备节点基本没办法在沙箱里使用。需要访问 `/dev` 下专有设备的应用(FPGA、加密卡、串口设备)不要指望 gVisor。
7. **不能在沙箱里再跑 KVM**。gVisor 明确不支持在沙箱内部使用 KVM——注意这是说「沙箱里跑虚拟机」不行,和 gVisor 自己用 KVM 平台是两件事。在 gVisor 上跑 QEMU/Kata 这类嵌套场景不成立。
8. **性能损耗与负载类型强相关**。syscall 密集、网络密集的负载损耗最明显;计算密集、syscall 少的负载影响小。公开的基准数字差异很大,唯一可靠的做法是**用你自己的服务做 A/B 压测**。KVM 平台在裸金属上性能最好;systrap 在虚拟机里反而更快——因为嵌套虚拟化的开销比 systrap 的拦截开销更大。
9. **ptrace 平台已经不再支持**。老教程里 `runsc --platform=ptrace` 的写法要清理掉,它开销大且官方已预告移除,不要在新部署里使用。
10. **不是所有工作负载都能用同一个 RuntimeClass**。RuntimeClass 是 Pod 级配置,同一个 Deployment 里的所有 Pod 用同一个 handler。遇到「大部分服务没问题、个别服务不兼容」时,只能把这些服务拆出去用 runc,或者放弃 gVisor。
11. **调试体验会变差**。`kubectl exec` 进去看到的 `/proc`、`/sys` 是 Sentry 实现的版本,内容与真实节点不同;`perf`、`bpftrace`、eBPF 类可观测工具在沙箱里取不到数据;`strace` 看到的 syscall 序列也可能与真实内核不一致。排障时要意识到「你看到的内核不是真的内核」。
12. **在 gVisor 里跑的容器,宿主机侧看到的进程形态不同**。`ps` 在节点上看到的是 runsc 的进程树而不是应用的完整进程树,依赖节点侧进程信息的安全 agent(如某些运行时检测工具)会失效或误报。
13. **升级 runsc 前先在测试节点验证**。Sentry 对 syscall 的支持是逐个版本补的,升级通常变好,但也出现过行为变化导致业务异常的案例。按节点池灰度,别一次全量。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kata-containers` — 基于虚拟化的另一种强隔离运行时
- `containerd` — 注册 runsc runtime handler 的地方
- `crictl` — 直接调试 CRI 层面的容器
- `securitycontext` — 容器权限与安全字段
- `pod-security-admission` — 沙箱工作负载的准入控制
- `confidential-containers` — 在 Kata 之上叠加内存加密的方案
- `ebpf-observability` — 沙箱内不可用的观测手段

### 参考链接

- [gVisor 官方文档](https://gvisor.dev/docs/)
- [平台选择(systrap / KVM / ptrace)](https://gvisor.dev/docs/architecture_guide/platforms/)
- [应用兼容性说明](https://gvisor.dev/docs/user_guide/compatibility/)
- [安装与内核要求](https://gvisor.dev/docs/user_guide/install/)
- [Kubernetes 快速上手](https://gvisor.dev/docs/user_guide/quick_start/kubernetes/)
- [gVisor GitHub 仓库](https://github.com/google/gvisor)
