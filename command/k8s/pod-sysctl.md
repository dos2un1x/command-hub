pod-sysctl
===

通过securityContext.sysctls为Pod设置内核参数,以及安全与不安全参数的边界

## 补充说明

`sysctl` 是 Linux 上读写内核运行参数的接口。Kubernetes 允许 Pod 在启动时修改**一部分**内核参数,入口是 **`spec.securityContext.sysctls`**(注意是 **Pod 级**,不是容器级)。

```shell
apiVersion: v1
kind: Pod
metadata:
  name: sysctl-example
spec:
  securityContext:
    sysctls:
      - name: kernel.shm_rmid_forced
        value: "0"
      - name: net.core.somaxconn
        value: "1024"
      - name: kernel.msgmax
        value: "65536"
  containers:
    - name: app
      image: my-app:1.0
```

与 `securityContext` 里的其他字段不同,**sysctls 字段本身不区分「安全」与「不安全」** —— 写法完全一样,区别体现在**能不能真的生效**:

```shell
安全 sysctl      默认放行,直接生效
不安全 sysctl    API 会接受,Pod 也能被调度
                 但在没开白名单的节点上【容器起不来】
```

这个「能被调度、却起不来」的行为是排查时的关键特征:Pod 停在 `ContainerCreating` 或反复 `CreateContainerError`,事件里通常只有含糊的运行时错误。

### 默认安全(safe)的 sysctl

这些参数被官方认定安全,**全部都是 namespaced 的**,加上内核层面有正确的隔离,因此在任何集群上都能直接用:

```shell
kernel.shm_rmid_forced

net.ipv4.ip_local_port_range
net.ipv4.tcp_syncookies
net.ipv4.ping_group_range                 自 Kubernetes 1.18
net.ipv4.ip_unprivileged_port_start       自 Kubernetes 1.22
net.ipv4.ip_local_reserved_ports          自 1.27（要求内核 3.16+）
net.ipv4.tcp_keepalive_time               自 1.29（要求内核 4.5+）
net.ipv4.tcp_keepalive_intvl              自 1.29（要求内核 4.5+）
net.ipv4.tcp_keepalive_probes             自 1.29（要求内核 4.5+）
net.ipv4.tcp_fin_timeout                  自 1.29（要求内核 4.6+）
net.ipv4.tcp_rmem                         自 1.32（要求内核 4.15+）
net.ipv4.tcp_wmem                         自 1.32（要求内核 4.15+）
net.ipv4.tcp_slow_start_after_idle        自 1.37（要求内核 4.15+）
net.ipv4.tcp_notsent_lowat                自 1.37（要求内核 4.6+）
```

两条硬性例外:

```shell
1. 开启 hostNetwork 时,所有 net.* sysctl 都【不允许】
   原因很直白:此时 Pod 与节点共用网络命名空间
   改 Pod 的参数等于改整台节点的参数

2. 内核 4.5 及更早版本上，net.ipv4.tcp_syncookies 并非 namespaced
   这类节点上它不安全
```

### 不安全(unsafe)的 sysctl

**「不安全」的定义是:所有 namespaced 但不在上面安全列表里的 sysctl。** 官方并没有一份固定的「不安全清单」,规则就是「安全列表之外 + namespaced」。

典型例子:

```shell
kernel.msg*               消息队列相关（kernel.msgmax、kernel.msgmnb、kernel.msgmni）
net.core.somaxconn        listen 队列长度
kernel.sem                信号量
fs.mqueue.*               消息队列文件系统
```

启用方式是在 **kubelet 侧**加白名单,**按节点生效**:

```shell
kubelet --allowed-unsafe-sysctls 'kernel.msg*,net.core.somaxconn' ...
```

minikube 上的等价写法:

```shell
minikube start \
  --extra-config="kubelet.allowed-unsafe-sysctls=kernel.msg*,net.core.somaxconn"
```

支持 glob 通配。使用 kubelet 配置文件时对应字段是 `allowedUnsafeSysctls`:

```shell
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
allowedUnsafeSysctls:
  - kernel.msg*
  - net.core.somaxconn
```

两条边界必须记住:

```shell
1. 只有【namespaced】的 sysctl 才可能通过这个白名单放行
   node 级 sysctl（没有 namespace 的）【根本无法】用这个开关打开
2. 白名单是【节点级】的
   同一个集群里,开了白名单的节点能跑,没开的节点上 Pod 直接起不来
```

### namespaced 与 node 级

这是理解 sysctl 能力边界的关键。Linux 内核参数按是否有命名空间隔离分为两类:

```shell
namespaced（可以通过 Pod 设置）
  kernel.shm*        共享内存
  kernel.msg*        消息队列
  kernel.sem         信号量
  fs.mqueue.*        POSIX 消息队列
  net.*              网络相关（下文有例外）

node 级（【无法】通过 Pod 设置,只能改节点本身）
  vm.*               虚拟内存（如 vm.swappiness、vm.max_map_count）
  kernel.* 中的大部分（如 kernel.pid_max、kernel.threads-max）
  fs.* 中的大部分（如 fs.file-max、fs.inotify.max_user_watches）
  net.core.* 中的部分（需具体判断）
```

一个容易踩的例外:

```shell
net.netfilter.nf_conntrack_max
net.netfilter.nf_conntrack_expect_max
  这两个参数在容器网络命名空间里【可以】设置,
  但在 Linux 5.12.2 之前它们并非真正 namespaced
```

**想改 `vm.*` 或 `fs.*` 这类 node 级参数,唯一可行的办法是改节点本身**:直接写 `/etc/sysctl.d/`,或用特权 DaemonSet 在节点上执行 `sysctl -w`。

### 常用操作

```shell
# 看 Pod 里实际生效的参数
kubectl exec -it sysctl-example -- sysctl net.ipv4.tcp_keepalive_time
kubectl exec -it sysctl-example -- sysctl -a | grep net.ipv4

# 对照节点上的值
nsenter -t 1 -m sysctl net.ipv4.tcp_keepalive_time

# 看节点上 kubelet 的白名单
kubectl get --raw "/api/v1/nodes/<node>/proxy/configz" | python3 -m json.tool | grep -i unsafe

# 排查 Pod 起不来
kubectl describe pod sysctl-example | tail -20
kubectl get events --field-selector involvedObject.name=sysctl-example
sudo journalctl -u kubelet | grep -i sysctl
```

### 注意

1. **`sysctls` 是 Pod 级字段,不是容器级**。它属于 `PodSecurityContext`(`spec.securityContext.sysctls`),**写在 `spec.containers[].securityContext` 下会被 API 直接拒绝**。这是最常见的一处笔误。
2. **改了不生效,先查 kubelet 白名单**。请求的是 unsafe sysctl 而节点没开 `--allowed-unsafe-sysctls` 时,Pod 可以被调度,但容器创建会失败 —— 不是「不生效」,是「根本没起来」。事件里通常只有一句含糊的运行时错误。
3. **白名单是节点级、且必须重启 kubelet**。给一部分节点开了白名单,另一部分没开,同一个 Deployment 会在不同节点上有不同表现:部分副本反复失败。这是最典型的「有时能起有时起不来」。
4. **node 级 sysctl 永远改不了**。`vm.swappiness`、`vm.max_map_count`、`fs.file-max`、`kernel.pid_max` 这些没有命名空间隔离,写进 Pod 的 `sysctls` 不会生效,而且**不会有明确报错**。必须改节点。
5. **hostNetwork 下所有 `net.*` 均被拒绝**。这是硬性限制:此时 Pod 与节点共用网络命名空间,改它就是改节点。想给这类 Pod 调网络参数,只能改节点配置。
6. **`net.ipv4.tcp_syncookies` 在老内核上不安全**。内核 ≤ 4.5 时它并非 namespaced,因此在安全列表里但实际不受隔离保护。异构内核版本的老集群要留意。
7. **参数值必须是字符串**。YAML 里 `value: 1024` 会被解析成整数而报类型错误,必须写成 `value: "1024"`。
8. **`/` 与 `.` 两种分隔符都可用**。自 1.23 起 kubelet 接受 `/` 作为分隔符,自 1.25 起 Pod 里也可以写 `kernel/shm_rmid_forced`。两种写法等价,但混用会让日志与文档对不上,建议统一用点号。
9. **sysctl 只在 Linux 上可用**。Windows 节点上不存在这个概念,混合集群里的清单需要按 OS 区分。
10. **放行 unsafe sysctl 是在降低隔离性**。官方建议的做法是给这类节点打污点,用 tolerations 只让确实需要该参数的 Pod 调度上去 —— 而不是把白名单开遍全集群。`kernel.msg*` 这类参数在多租户集群里改错会影响同节点的其他负载。
11. **Pod 里改的是「自己命名空间内的值」,不会影响节点**。这正是 namespaced 参数安全的原因。看到「Pod 里 sysctl 改了,节点上没变」不必惊讶,那是预期行为。
12. **不要用 sysctl 做本该在应用层做的事**。想调大 backlog 或改 TCP 重试参数时,先确认这确实是需求,而不是在掩盖应用层的连接管理问题 —— 内核参数往往是最后一道调优手段。

### 相关命令

- `kernel-tuning` — 节点级内核参数的系统性调优
- `securitycontext` — sysctls 所在的父字段
- `ulimit-k8s` — 另一类常被混淆的进程级限制
- `kubelet` — 白名单 `--allowed-unsafe-sysctls` 的配置位置
- `cgroup` — 资源隔离的另一层机制

### 参考链接

- [在集群中使用 sysctl](https://kubernetes.io/docs/tasks/administer-cluster/sysctl-cluster/)
- [Pod 安全上下文](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/)
- [PodSecurityContext API 参考](https://kubernetes.io/docs/reference/kubernetes-api/core/pod-v1/#PodSecurityContext)
- [sysctl.d(5) 手册](https://man7.org/linux/man-pages/man5/sysctl.d.5.html)
