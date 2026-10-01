seccomp
===

限制容器可用系统调用的内核安全机制,Kubernetes 中通过 securityContext 配置

## 补充说明

**seccomp(secure computing mode)** 是 Linux 内核提供的系统调用过滤器。它让进程在进入内核之前先过一层白名单/黑名单:不在允许列表里的系统调用直接返回错误或被杀死。在容器场景里,它的价值是**砍掉容器根本不需要的内核接口**——容器里跑的是 nginx,就没有理由让它调用 `kexec_load`、`bpf`、`ptrace` 这些提权与内核利用常用到的调用。

seccomp 过滤器以 BPF 程序的形式加载(所以也叫 seccomp-bpf),一旦加载**无法撤销**,只能在创建时指定。这是它比 AppArmor、SELinux 更难「调试中放开」的原因。

在 Kubernetes 里配置 seccomp 的字段是 **`securityContext.seccompProfile`**,自 **v1.19 起 GA**。此前只能用 Pod 注解,那条路径已经在 **v1.25 被移除**。

### 三种类型

```shell
Unconfined      不做任何限制(默认行为,除非节点显式开启 seccompDefault)
RuntimeDefault  使用容器运行时的默认 profile(containerd / CRI-O 各自定义)
Localhost       使用节点上的自定义 profile,需要用 localhostProfile 指定
```

`RuntimeDefault` 的具体内容由运行时决定,containerd 与 CRI-O 的默认 profile **并不相同**,同一份配置换运行时可能拦下不同的系统调用。官方文档也提醒了这一点。

### 语法

```shell
apiVersion: v1
kind: Pod
metadata:
  name: seccomp-demo
spec:
  securityContext:                 # Pod 级:所有容器继承
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: app
      image: nginx:alpine
      securityContext:             # 容器级:覆盖 Pod 级
        seccompProfile:
          type: Localhost
          localhostProfile: profiles/nginx.json
```

优先级规则:**容器级高于 Pod 级,未设置的容器继承 Pod 的设置**。可写的位置有四处:`spec.securityContext`、`containers[*].securityContext`、`initContainers[*].securityContext`、`ephemeralContainers[*].securityContext`。

### 自定义 profile

profile 是 OCI runtime 规范的 JSON,核心是 `defaultAction` 加一组 `syscalls`:

```shell
{
  "defaultAction": "SCMP_ACT_ERRNO",
  "architectures": ["SCMP_ARCH_X86_64"],
  "syscalls": [
    {
      "names": ["read", "write", "exit", "exit_group", "rt_sigreturn",
                "brk", "mmap", "munmap", "close", "fstat"],
      "action": "SCMP_ACT_ALLOW"
    },
    {
      "names": ["socket", "connect", "accept4", "sendto", "recvfrom"],
      "action": "SCMP_ACT_LOG"
    }
  ]
}
```

常用 action:

```shell
SCMP_ACT_ALLOW        放行
SCMP_ACT_ERRNO        返回错误(默认的拒绝方式,最温和)
SCMP_ACT_LOG          只记日志不拦截,用来观察需要哪些 syscall
SCMP_ACT_KILL_PROCESS 直接杀死进程(最严格)
SCMP_ACT_NOTIFY       交给用户态程序裁决,不能作为 defaultAction
```

**用 `SCMP_ACT_LOG` 先观察再收紧**是最稳妥的落地路径:先记一周日志,统计实际用到的 syscall,再写白名单。注意 `SCMP_ACT_LOG` 需要内核 4.14+。

### 在节点上放置 profile

profile 文件必须**预先存在于每个可能调度到的节点**上,默认目录是 `/var/lib/kubelet/seccomp`:

```shell
# 节点上
sudo mkdir -p /var/lib/kubelet/seccomp/profiles
sudo cp nginx.json /var/lib/kubelet/seccomp/profiles/nginx.json
```

```shell
# 本地 kind 集群:把宿主机目录挂进节点容器
apiVersion: kind.x-k8s.io/v1alpha4
kind: Cluster
nodes:
  - role: control-plane
    extraMounts:
      - hostPath: ./profiles
        containerPath: /var/lib/kubelet/seccomp/profiles
```

生产集群的常见做法是把 profile 打进一个镜像,用 DaemonSet 或 initContainer 分发到各节点的 `/var/lib/kubelet/seccomp/`。

### 把 RuntimeDefault 变成集群默认

即使 seccomp 在 1.19 就 GA,**不显式配置的容器默认仍然是 Unconfined**。要让所有未声明 profile 的工作负载自动用上 RuntimeDefault,必须逐节点开启 kubelet 选项:

```shell
# 命令行参数
kubelet --seccomp-default

# 或在 KubeletConfiguration 里
seccompDefault: true
```

对应的特性门控 `SeccompDefault` 的演进是:**1.22 alpha → 1.25 beta → 1.27 stable**。stable 意味着门控默认开启,但**行为本身仍由 `seccompDefault` 这个 kubelet 配置项控制**,不配置就不会生效。

### 验证

```shell
# 容器内查看当前进程的 seccomp 状态:0=未启用 1=strict 2=filter
kubectl exec seccomp-demo -- grep Seccomp /proc/self/status
# Seccomp:        2
# Seccomp_filters:        1

# 观察被拦截的系统调用(需要 profile 里配了 LOG,或在节点上)
kubectl exec seccomp-demo -- dmesg | grep -i seccomp

# 看节点上已有的 profile 文件
ls -l /var/lib/kubelet/seccomp/
```

被拦截的典型表现是应用报 `Operation not permitted` / `EPERM`,而 strace 显示某个 syscall 直接返回错误。

### 生成自定义 profile 的工具

手写白名单不现实,主流做法是用工具从真实运行中采集:

```shell
security-profiles-operator   用 SeccompProfile CRD 声明并分发 profile,
                             支持 log 模式自动记录容器用到的系统调用
oci-seccomp-bpf-hook         容器跑起来后记录 syscall,导出 OCI seccomp profile
                             (podman/docker 场景常用)
inspektor-gadget             用 eBPF 观察系统调用,适合定位"到底哪个调用被拦了"
```

用 security-profiles-operator 的最小流程:

```shell
# 1) 先声明一个只记录不拦截的 profile
apiVersion: security-profiles-operator.x-k8s.io/v1beta1
kind: SeccompProfile
metadata:
  name: my-app-log
  namespace: default
spec:
  defaultAction: SCMP_ACT_LOG
---
# 2) 在 Pod 上引用,跑一段真实业务流量
# 3) 用 spoc 把记录下来的 syscall 导出成可用的 profile
#    spoc record / spoc profile ...
```

### 注意

1. **`RuntimeDefault` 不是「Kubernetes 1.19 之后的默认值」**。1.19 只是让 `seccompProfile` 字段 GA;**不写这个字段的容器默认仍然是 Unconfined**。要让它成为默认,必须在 kubelet 上设置 `--seccomp-default`(或 KubeletConfiguration 里的 `seccompDefault: true`),该能力在 1.27 才 stable。混淆这两件事会导致「以为已经加固了,实际没有」。
2. **seccomp 注解已在 v1.25 被移除**。`seccomp.security.alpha.kubernetes.io/pod` 与 `container.seccomp.security.alpha.kubernetes.io/<容器名>` 在 1.19 随字段 GA 被弃用,1.25 起 kubelet 不再支持。升级到 1.25+ 后这些注解**静默失效**——Pod 照常启动,但 seccomp 约束没了。用 `kubectl get pod -o yaml | grep seccomp.security` 全量排查一遍,该迁移到 `securityContext.seccompProfile`。顺带说明:被移除的是 **seccomp** 注解,和 SELinux 无关——SELinux 一直用的是 `securityContext.seLinuxOptions`,历史上没有过注解形式。
3. **`localhostProfile` 是相对路径,不是绝对路径**。它是相对于 kubelet 配置的 seccomp 根目录的「下降路径」,该根目录默认是 `/var/lib/kubelet/seccomp`。所以写 `profiles/nginx.json` 对应节点上的 `/var/lib/kubelet/seccomp/profiles/nginx.json`;**写成绝对路径 `/var/lib/kubelet/seccomp/profiles/nginx.json` 会被当成相对路径去拼接而找不到文件**。profile 不存在时容器创建失败,报 `CreateContainerError`,错误信息里往往只说「no such file or directory」,很容易误判成镜像问题。
4. **profile 必须在所有可能被调度到的节点上都存在**。只在部分节点上放了文件,Pod 落到别的节点就起不来,表现为「时好时坏」。要么全量分发,要么用 nodeSelector/nodeAffinity 把工作负载钉在有 profile 的节点上。
5. **privileged 容器永远是 Unconfined**。官方明确说明:无法对 `privileged: true` 的容器应用 seccomp profile。想给特权容器加限制,只能改用细粒度 capability 而不是 `privileged`。
6. **Pod Security Admission 的 `restricted` 级别强制要求 seccomp**。它要求 `seccompProfile.type` 必须是 `RuntimeDefault` 或 `Localhost`,留空会被拒绝。`baseline` 只禁止显式写 `Unconfined`。这是「为什么升级到开 PSA 之后 Pod 被拒」的常见原因。
7. **`SCMP_ACT_ERRNO` 与 `SCMP_ACT_KILL_PROCESS` 的排障成本差一个数量级**。前者只是 syscall 返回错误,应用可能还能降级运行;后者直接杀进程,表现为 Pod 莫名其妙重启且日志里什么都没有。自定义 profile 从 ERRNO 起步,确认稳定后再考虑收紧。
8. **默认 profile 会随运行时版本变化**。containerd/CRI-O 升级后 `RuntimeDefault` 的实际内容可能改变,表现为「升级运行时之后某个服务挂了」。对 syscall 敏感的负载(旧版 glibc、自研 JIT、某些安全软件)建议钉死 Localhost profile,别依赖 RuntimeDefault 的稳定性。
9. **`SCMP_ACT_NOTIFY` 有限制**。它不能作为 `defaultAction`,对 `write` 这类高频 syscall 也不可用。需要用户态裁决的场景应该评估 seccomp 之外的手段。
10. **seccomp 不是万能的**。它只在内核入口过滤系统调用,挡不住内核漏洞本身、挡不住已获得的能力滥用、也不管文件路径与网络。它与 AppArmor/SELinux(基于标签与路径的强制访问控制)是互补关系,不是替代关系。
11. **自己写白名单非常容易漏**。一个 Go 程序在启动阶段用到的 syscall 就有几十个,且随 Go 版本变化。不要手写,用 **security-profiles-operator** 的 `SeccompProfile` CRD 配合 `log` 模式自动生成,或先用 `SCMP_ACT_LOG` 收集真实调用集合。
12. **profile 文件不随 Pod 走**。它不会被镜像打包,也不会被 ConfigMap 引用(除非你自己写分发逻辑)。集群重建、节点扩容后要保证 profile 分发链路先于工作负载就绪。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `apparmor` — 基于路径的强制访问控制,与 seccomp 互补
- `selinux-k8s` — 基于标签的强制访问控制
- `securitycontext` — seccompProfile 所在的字段组
- `pod-security-admission` — restricted 级别强制要求 seccomp
- `pod` — 安全上下文的落点
- `kubelet` — `--seccomp-default` 的配置位置
- `falco` — 从运行时行为侧补充检测

### 参考链接

- [Seccomp 与 Kubernetes(参考)](https://kubernetes.io/docs/reference/node/seccomp/)
- [用 seccomp 限制容器的系统调用(教程)](https://kubernetes.io/docs/tutorials/security/seccomp/)
- [Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/)
- [KEP-2413: Seccomp Default](https://github.com/kubernetes/enhancements/tree/master/keps/sig-node/2413-seccomp-by-default)
- [OCI Runtime Spec: seccomp](https://github.com/opencontainers/runtime-spec/blob/main/config-linux.md#seccomp)
- [security-profiles-operator](https://github.com/kubernetes-sigs/security-profiles-operator)
