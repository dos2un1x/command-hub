kernel-tuning
===

Kubernetes节点级内核参数调优,以及为什么这些参数不能用Pod设置

## 补充说明

Kubernetes 集群的很多「诡异故障」最终都落在节点的内核参数上:Pod 莫名其妙起不来、连接被静默丢弃、ARP 表溢出、inotify 耗尽。这些参数**没有一个是 Pod 能改的** —— 它们都是节点级参数。

理解这一点的前提是分清两类 sysctl:

```shell
namespaced 参数     有独立的内核命名空间,Pod 改自己的不影响别人
                    net.* 的大部分、kernel.shm*、kernel.msg*、kernel.sem、fs.mqueue.*
                    这一类【可以】通过 spec.securityContext.sysctls 设置

node 级参数         全局共享,没有命名空间隔离
                    vm.*、fs.*、kernel.* 的大部分、net.core.* 的部分
                    这一类【只能改节点本身】,Pod 里写破天也没用
```

本文讨论的是**第二类**。想改第一类请见 `pod-sysctl`。

### 三个必须记住的节点级参数

这三个是 Kubernetes 节点上故障率最高的内核参数,值得单独列出来:

```shell
fs.inotify.max_user_instances
  每个用户可以创建的 inotify 实例数,内核默认【只有 128】
  节点上每个 Pod、每个容器运行时、每个监控 agent 都可能占一个
  耗尽后创建 inotify 实例失败,报错是极具误导性的
    "no space left on device"
  典型受害负载：.NET、Java(NIO watch)、Node.js 文件监听、
              日志采集器、IDE 类工具、热重载框架

fs.inotify.max_user_watches
  每个实例能监视的文件数,默认值各发行版差异很大
  监视大目录树(如整个代码仓库、大日志目录)时会撞到

net.netfilter.nf_conntrack_max
  连接跟踪表大小,建立连接数超过它之后新连接被丢弃
  内核日志里会刷 "nf_conntrack: table full, dropping packet"
  表现是【间歇性】超时 —— 已建立的连接正常,新连接随机失败,
  这是最难排查的一类故障
```

### 其他常见参数

```shell
vm.max_map_count
  mmap 区域数量上限,内核默认 65530
  Elasticsearch / OpenSearch 官方要求至少 262144
  撞到时的报错是 "max virtual memory areas vm.max_map_count [65530] is too low"

vm.overcommit_memory
  内存分配策略,Redis 等应用建议设为 1
  注意它影响的是整台节点的行为,不要在共享节点上随意改

vm.swappiness
  kubelet 要求关闭 swap（或显式 failSwapOn: false）
  这里保持一致设为 0 更稳妥

net.ipv4.neigh.default.gc_thresh1 / gc_thresh2 / gc_thresh3
  ARP 邻居表阈值,默认值很小
  节点上跑几十上百个 Pod、每个 Pod 一个虚拟网卡时容易溢出
  溢出后同一网段内通信会出现随机丢包

kernel.pid_max
  全系统进程/线程数上限
  高密度节点上,大量线程的 JVM 会把 PID 空间吃满

kernel.keys.maxkeys / kernel.keys.maxbytes
  keyring 配额,默认很小
  某些语言运行时与安全组件会创建 keyring,配额耗尽时
  报 "unable to create kernel key" 之类的错误

net.core.somaxconn
  listen backlog 上限,高并发服务需要调大
  注意它同时是【namespaced】的,Pod 里也能设置自己网络命名空间的值

fs.file-max / fs.nr_open
  系统级文件句柄总量 / 单进程硬上限天花板,见 ulimit-k8s 页
```

### 设置方式

**方式一:`/etc/sysctl.d`(推荐,最稳定)**

```shell
sudo tee /etc/sysctl.d/99-kubernetes.conf <<'EOF'
# inotify —— 高密度节点的第一优先级
fs.inotify.max_user_instances = 8192
fs.inotify.max_user_watches   = 524288

# 连接跟踪
net.netfilter.nf_conntrack_max = 1048576

# ARP 邻居表
net.ipv4.neigh.default.gc_thresh1 = 8192
net.ipv4.neigh.default.gc_thresh2 = 32768
net.ipv4.neigh.default.gc_thresh3 = 65536

# 文件句柄
fs.file-max = 2097152
fs.nr_open  = 2097152

# 进程数
kernel.pid_max = 4194304

# keyring
kernel.keys.maxkeys  = 20000
kernel.keys.maxbytes = 40000

# mmap（跑 Elasticsearch 时需要）
vm.max_map_count = 262144
EOF

# 应用并验证
sudo sysctl --system
sudo sysctl fs.inotify.max_user_instances net.netfilter.nf_conntrack_max
```

这套配置在**重启后依然生效**,是首选做法。

**方式二:特权 DaemonSet(需要动态调整或统一纳管时)**

适合想用「集群声明式配置」而不是靠配置管理工具下发节点的场景:

```shell
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-sysctl
  namespace: kube-system
spec:
  selector:
    matchLabels:
      app: node-sysctl
  template:
    metadata:
      labels:
        app: node-sysctl
    spec:
      # 关键:要改 net.* 必须用节点的网络命名空间
      hostNetwork: true
      hostPID: true
      tolerations:
        - operator: Exists        # 控制平面节点也要跑
      initContainers:
        - name: apply
          image: busybox:1.36
          securityContext:
            privileged: true
          command:
            - sh
            - -c
            - |
              set -e
              sysctl -w fs.inotify.max_user_instances=8192
              sysctl -w fs.inotify.max_user_watches=524288
              sysctl -w net.netfilter.nf_conntrack_max=1048576
              sysctl -w net.ipv4.neigh.default.gc_thresh3=65536
              sysctl -w vm.max_map_count=262144
      containers:
        - name: pause
          image: registry.k8s.io/pause:3.10
```

两个必须注意的细节:

```shell
hostNetwork: true
  不设这一条，容器有自己的网络命名空间
  写 net.* 只会改容器自己（或直接失败），【改不到节点】

privileged: true
  改内核参数需要 CAP_SYS_ADMIN / CAP_NET_ADMIN
  普通容器即使 hostNetwork 也写不进去
```

**方式三:systemd 单元或 tuned**

```shell
# 只对某个服务生效时（不是节点级）
sudo systemctl edit kubelet
# [Service]
# LimitNOFILE=1048576

# RHEL 系可用 tuned（OpenShift 上是 Node Tuning Operator）
tuned-adm profile throughput-performance
```

OpenShift 用户可以直接用 **Node Tuning Operator** 的 `Tuned` CR 声明式下发,不需要自己写 DaemonSet。

### 验证与排障

```shell
# 确认参数真的生效了
sysctl fs.inotify.max_user_instances
cat /proc/sys/fs/inotify/max_user_instances

# 看当前的 inotify 用量（需要 root，且要逐个 PID 统计）
sudo find /proc/*/fd -lname anon_inode:inotify 2>/dev/null | wc -l
sudo ls -l /proc/*/fd 2>/dev/null | grep -c inotify

# 看连接跟踪表用量
sudo conntrack -C                       # 当前条目数
sysctl net.netfilter.nf_conntrack_max
sudo conntrack -S                       # 统计（含 insert_failed）

# 看 ARP 表
ip neigh | wc -l
sysctl net.ipv4.neigh.default.gc_thresh3

# 看内核日志里的相关告警
sudo dmesg -T | grep -iE "conntrack|neighbour|inotify|max_map_count|out of memory"
sudo journalctl -k --since "1 hour ago" | grep -iE "conntrack|nf_conntrack"
```

### 注意

1. **这些参数用 Pod 的 `securityContext.sysctls` 改不了**。`vm.*`、`fs.*`、`kernel.*` 大多没有命名空间隔离,写进 Pod 不会生效,**而且不会有明确报错** —— 只是静默无效。这是最容易浪费时间的一类误判。想改节点参数,见上文三种方式。
2. **`fs.inotify.max_user_instances` 默认只有 128,是节点上最常见的瓶颈**。症状极具误导性:创建 inotify 实例失败会报 `no space left on device`,让人去查磁盘,而磁盘完全正常。高密度节点或跑 .NET / Java NIO / 文件监听的负载,第一件事就是把它调大。
3. **`net.netfilter.nf_conntrack_max` 不足会造成间歇性连接失败**。已建立的连接一切正常,新连接随机超时,`dmesg` 里才有 `nf_conntrack: table full, dropping packet`。**不查内核日志几乎不可能定位**。kube-proxy 的 iptables/IPVS 模式都重度依赖 conntrack。
4. **调 conntrack 要连带调哈希桶**。只改 `nf_conntrack_max` 而不动 `net.netfilter.nf_conntrack_buckets`,表大了但桶没变,查找会退化成链表遍历,延迟反而升高。一般让 buckets 约为 max 的 1/4。
5. **节点上的内核参数是全局共享的**。给一个负载调的参数会影响同节点所有 Pod。尤其 `vm.overcommit_memory`、`vm.swappiness` 这类内存策略,改了就是整台节点的行为,多租户集群里要慎重。
6. **`vm.max_map_count` 不改,Elasticsearch 起不来**。它的报错信息很直白(`max virtual memory areas vm.max_map_count [65530] is too low`),但很多部署清单只想着调 JVM 堆,忘了这一项。这类应用通常要求节点侧统一配置。
7. **NTP 与内核参数一样重要**。短有效期的证书、租约续期、日志排序都依赖时钟。内核参数调得再好,时钟漂移照样会让集群出现难以解释的间歇故障。
8. **参数是否对已有连接生效,取决于具体参数**。例如窗口大小之类的参数只在新连接建立时读取,改完不重启服务也能看到「新连接生效、旧连接照旧」。排查时不要因为「部分生效」就怀疑配置没写进去。
9. **`sysctl --system` 的加载顺序有讲究**。它会按文件名顺序读取 `/etc/sysctl.d/*.conf` 与 `/usr/lib/sysctl.d/*.conf`,**同名参数后被读取的覆盖先读取的**。用 `99-` 前缀可以确保自己的配置最后生效。
10. **容器里看到的 `/proc/sys` 是命名空间视图,不代表节点真实值**。在 Pod 里 `sysctl vm.max_map_count` 看到的是节点值(因为它是非 namespaced 的),但 `net.core.somaxconn` 看到的可能是容器自己的值。要确认节点真实状态,用 `nsenter` 或直接在节点上执行。
11. **修改内核参数不会自动重启或重载已有工作负载**。绝大多数节点级参数对所有进程立即生效(因为它们是全局的),但**已经被打开的 fd、已建立的 socket** 不受影响。对这类场景,滚动重启工作负载是必要的。
12. **内核参数不是性能问题的第一手段**。调参前先用 `pidstat`、`ss`、`perf`、`node_exporter` 确认瓶颈到底在应用、网络还是内核。把 `somaxconn` 从 128 调到 65535 却不去看应用的连接池配置,通常什么也解决不了。

### 相关命令

- `pod-sysctl` — 可以通过 Pod 设置的 namespaced 参数
- `ulimit-k8s` — 进程级 rlimit 与运行时配置
- `cgroup` — cgroup v1/v2 与资源隔离
- `kubelet` — 节点参数对调度与驱逐的影响
- `kube-proxy` — conntrack 的主要消耗方

### 参考链接

- [在集群中使用 sysctl](https://kubernetes.io/docs/tasks/administer-cluster/sysctl-cluster/)
- [sysctl.d(5) 手册](https://man7.org/linux/man-pages/man5/sysctl.d.5.html)
- [Kubernetes 节点的内核参数实践](https://kubernetes.io/docs/setup/best-practices/)
- [Linux 内核文档:IP sysctl](https://docs.kernel.org/networking/ip-sysctl.html)
- [Linux 内核文档:inotify](https://man7.org/linux/man-pages/man7/inotify.7.html)
