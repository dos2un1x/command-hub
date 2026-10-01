cgroup
===

Kubernetes的资源隔离基石,cgroup v1与v2的差异及cgroup driver选型

## 补充说明

**cgroup**(control group)是 Linux 内核的资源隔离机制。Kubernetes 里所有的 CPU/内存限制、QoS 分级、驱逐决策,最终都落在 cgroup 上。`kubectl describe node` 里的 `Allocated resources`、Pod 的 `requests/limits`,在节点上都有对应的 cgroup 层级。

Kubernetes 与 cgroup 的关系经历过一次大的代际更替:

```shell
cgroup v1   第一代,每种资源一个独立层级（cpu、memory、blkio……各自一棵树）
            在 Linux 上表现为 /sys/fs/cgroup/ 下挂载了多个 tmpfs

cgroup v2   第二代,统一层级（一棵树管所有资源）
            挂载点类型为 cgroup2fs
            自 Kubernetes 1.25 起【稳定支持】
            自 Kubernetes 1.35 起 v1 被标记为【已废弃】
```

### v1 与 v2 的差异

```shell
设计
  v1  多个独立层级,进程在不同层级里的归属可能不一致,
      导致「内存在这个 cgroup、CPU 在另一个 cgroup」的混乱
  v2  单一统一层级,一个进程在树里只有一个位置,归属清晰

资源管理
  v1  各控制器各自为政,内存统计口径不统一
  v2  统一统计各类内存分配(含网络内存、内核内存)
      能统计非即时变化的资源占用（如 page cache 回写）

委派与隔离
  v2  支持更安全的子树委派(subtree delegation),
      这是容器运行时把 cgroup 子树交给容器内进程的前提
      新的隔离特性基本只在 v2 上实现

新特性
  v2  PSI（Pressure Stall Information,资源压力指标）
      MemoryQoS（Kubernetes 的内存服务质量特性,【仅 v2 可用】）
      cgroup.freeze 等
```

一句话概括:**v2 不是 v1 的语法升级,而是重新设计的模型。** 它们的内核接口不同,直接读写 cgroupfs 的工具必须跟着改。

### 检查当前用的是哪一代

```shell
# 最可靠的方法:看挂载点类型
stat -fc %T /sys/fs/cgroup/
# cgroup2fs  → cgroup v2
# tmpfs      → cgroup v1

# 其他辅助判断
mount | grep cgroup
cat /proc/filesystems | grep cgroup
ls /sys/fs/cgroup/            # v2 下有 cgroup.controllers、cgroup.procs 等
                              # v1 下是一堆子目录（cpu、memory、blkio……）

# 从 kubelet 侧确认
kubectl get --raw "/api/v1/nodes/<node>/proxy/configz" | python3 -m json.tool | grep -i cgroup
```

### 启用 cgroup v2 的前提

```shell
1. 发行版启用 cgroup v2（见下表）
2. 内核版本 5.8 或更高
3. 容器运行时支持 v2
     containerd  v1.4 及以上
     CRI-O       v1.20 及以上
4. kubelet 与容器运行时【都】使用 systemd 作为 cgroup driver
```

默认启用 cgroup v2 的发行版:

```shell
Container-Optimized OS   M97 起
Ubuntu                   21.10 起（22.04+ 更推荐）
Debian GNU/Linux         11 bullseye 起
Fedora                   31 起
Arch Linux               2021-04 起
RHEL 及兼容发行版         9 起
```

手动启用**(不推荐)**—— 在 GRUB 系发行版上:

```shell
# /etc/default/grub
GRUB_CMDLINE_LINUX="... systemd.unified_cgroup_hierarchy=1"
```

```shell
sudo update-grub
sudo reboot
```

**kubelet 会自动探测 cgroup 版本**,不需要额外配置 —— 它检测到 v2 就按 v2 的方式工作。真正需要人工干预的是 **cgroup driver**(下一节)。

### cgroup driver:systemd 与 cgroupfs

这是比 v1/v2 更容易出问题的一环。cgroup driver 决定**由谁来创建和管理 cgroup**:

```shell
cgroupfs   kubelet 直接操作 cgroupfs 文件系统
systemd    通过 systemd 的 D-Bus 接口管理
```

**默认值与推荐值不一致,这是坑的根源:**

```shell
kubelet 的 cgroupDriver 字段默认是 cgroupfs
containerd 的 SystemdCgroup 默认是 false（即 cgroupfs）

但两边的官方推荐都是 systemd:
  - 系统 init 是 systemd 时,再引入 cgroupfs 就等于有了【两个 cgroup 管理者】
  - 资源紧张时两个管理者会互相覆盖对方的设置,导致不稳定
  - 使用 cgroup v2 时,必须用 systemd driver
```

配置方式:

```shell
# kubelet 侧:/var/lib/kubelet/config.yaml
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
cgroupDriver: systemd
```

```shell
# containerd 1.x:/etc/containerd/config.toml
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
  SystemdCgroup = true

# containerd 2.x:插件已改名,路径变成
[plugins."io.containerd.cri.v1.runtime".containerd.runtimes.runc.options]
  SystemdCgroup = true
```

```shell
sudo systemctl restart containerd
sudo systemctl restart kubelet
```

CRI-O 的对应配置是 `crio.conf` 里的 `cgroup_manager`(默认为 `systemd`)。

### 自动探测:KubeletCgroupDriverFromCRI

kubelet 已经可以**从容器运行时自动获知**该用哪个 driver,不需要手工对齐:

```shell
特性门控 KubeletCgroupDriverFromCRI
  alpha   1.28（默认 false）
  beta    1.31（默认 true）
  stable  1.34（默认 true）

行为
  门控开启【且】运行时支持 RuntimeConfig 这个 CRI 调用时,
  kubelet 自动探测 cgroup driver,并【忽略】cgroupDriver 配置项
  （连已废弃的 --cgroup-driver 命令行参数也一并忽略）

  运行时【不】支持时,回退到使用 cgroupDriver 配置的值

运行时支持情况
  containerd   v2.0.0 起支持
  CRI-O        v1.28.0 起支持

相关的 kubelet 指标
  kubelet_cri_losing_support   用来发现集群里哪些节点即将失去回退支持
```

**关于回退行为何时取消,官方文档两处说法不一致**:特性门控文件写的是 Kubernetes 1.36 将停止回退,而容器运行时文档(1.37 版)写的是 1.38。不管哪个准确,**结论是一致的 —— 旧版本容器运行时迟早会无法与新 kubelet 配合**,升级运行时是必须做的事。

### 迁移到 cgroup v2 的排查清单

迁移本身通常「无感」,但如果**有组件直接读 cgroupfs**,就会出问题。官方点名的几类:

```shell
监控与安全 agent
  直接读 cgroupfs 的第三方 agent 必须升级到支持 v2 的版本

cAdvisor
  以独立 DaemonSet 方式运行时,需要 v0.43.0 或更高
  （kubelet 内置的 cAdvisor 随 Kubernetes 版本走,不用单独管）

Java
  OpenJDK / HotSpot    jdk8u372、11.0.16、15 及更高
  IBM Semeru Runtimes  8.0.382.0、11.0.20.0、17.0.8.0 及更高
  IBM Java             8.0.8.6 及更高
  旧版本读不到 v2 的内存限制,会把【宿主机的总内存】当成容器可用内存,
  从而把堆开得过大,最终被 OOM Kill

uber-go/automaxprocs
  需要 v1.5.1 或更高（Go 应用按 CPU 限额自动调 GOMAXPROCS 的常用库）

Node.js
  cgroup v2 的内存限制自 Node.js v20.3.0 起才被 libuv 正确读取
  v18 系列【无法可靠识别】v2 的内存限制
  受害版本上表现为堆大小按宿主机内存计算,然后被 OOM Kill
  临时绕行:显式设置 --max-old-space-size
```

### cgroup v1 的废弃

```shell
Kubernetes 1.35 起,cgroup v1 被标记为 deprecated

kubelet 【默认不再】在 cgroup v1 节点上启动
  要让老节点继续工作,需要在 kubelet 配置中显式设置:
    failCgroupV1: false
  这只是一个临时缓冲,长期方案是升级到 cgroup v2
```

### 排障

```shell
# 1. 确认节点的 cgroup 版本与 driver
stat -fc %T /sys/fs/cgroup/
kubectl get --raw "/api/v1/nodes/<node>/proxy/configz" | python3 -m json.tool | grep -i cgroup

# 2. 直接看某个 Pod 的 cgroup(v2)
POD_UID=$(kubectl get pod <pod> -o jsonpath='{.metadata.uid}')
CID=$(kubectl get pod <pod> -o jsonpath='{.status.containerStatuses[0].containerID}' | sed 's|.*://||')
ls /sys/fs/cgroup/kubepods.slice/kubepods-*.slice/ | grep ${CID:0:32}

# 3. 看内存限制是否真的生效了
cat /sys/fs/cgroup/.../memory.max       # v2
cat /sys/fs/cgroup/memory/.../memory.limit_in_bytes   # v1

# 4. 看 CPU 限额
cat /sys/fs/cgroup/.../cpu.max          # v2，形如 "20000 100000"

# 5. kubelet 日志里的 cgroup 报错
sudo journalctl -u kubelet | grep -i cgroup
sudo crictl info | grep -i cgroup
```

### 注意

1. **kubelet 与容器运行时的 cgroup driver 必须一致**。kubelet 用 `systemd` 而 containerd 用 `cgroupfs`(默认值就是它)时,两边各管一套 cgroup,典型症状是 **Pod 频繁重启、资源限制不生效、驱逐行为异常**。这是「kubelet 起不来」与「Pod 莫名重启」的高频根因。
2. **两个组件的默认值都不是 systemd**。kubelet 的 `cgroupDriver` 默认 `cgroupfs`,containerd 的 `SystemdCgroup` 默认 `false`。也就是说**默认配置就是错的**(在 systemd 发行版上),必须显式改。很多「照着教程装完就出问题」都源于此。
3. **containerd 2.x 的插件路径变了**。`[plugins."io.containerd.grpc.v1.cri"]` 是 1.x 的写法,2.x 下 CRI 被拆成 `io.containerd.cri.v1.runtime` 与 `.v1.images`。**把旧插件 ID 贴进 v3 配置不会报错,也不会生效** —— 这是最隐蔽的一类失效。
4. **在已加入集群的节点上改 cgroup driver 是敏感操作**。官方明确警告:如果 kubelet 已用某种 driver 创建过 Pod,再切换 driver 会让已有 Pod 的 sandbox 重建失败,**重启 kubelet 也修不好**。安全做法是换新节点,或整节点重装。
5. **cgroup v2 下必须用 systemd driver**。用 cgroupfs 配 v2 是不受支持的组合,会遇到资源限制不生效或 kubelet 直接报错。
6. **迁移到 v2 后,读 cgroupfs 的工具要跟着改**。cgroup v1 的路径形如 `/sys/fs/cgroup/memory/...`,`memory.limit_in_bytes` 这类文件名在 v2 里变成 `memory.max`。自研监控脚本、老版本监控 agent 常常是这里出问题。
7. **Java 与 Node.js 的版本必须核对**。旧版本会把宿主机内存误判为容器可用内存,然后按宿主机的容量开堆,结果被 OOM Kill。**这个故障在 v2 迁移后集中爆发**,因为 v1 时代它们读的是 v1 的路径。
8. **`kubelet_cri_losing_support` 应该被监控**。它标记出「运行时太旧、即将失去 cgroup driver 回退能力」的节点。等回退被移除(1.36 或 1.38)再发现就晚了。
9. **cgroup v1 的废弃已进入执行阶段**。1.35 起 kubelet 默认拒绝在 cgroup v1 节点上启动。老节点上必须显式 `failCgroupV1: false` 才能继续跑,而这只是缓兵之计。
10. **PSI 与 MemoryQoS 只在 v2 上可用**。如果你的优化方案依赖这两者(如基于 PSI 的调度、内存 QoS 分级),那就不是「可以慢慢迁」的问题,而是必须迁到 v2。
11. **`/sys/fs/cgroup` 在容器内的视图不等于节点**。容器里看到的是自己那棵子树(加上只读的父级视图),不要拿容器内的内容去判断节点整体状态,那需要用 `nsenter` 或直接登录节点。
12. **kubelet 自动探测不等于可以不管配置**。即使 `KubeletCgroupDriverFromCRI` 已 GA,容器运行时自身的 `SystemdCgroup` 仍要正确设置 —— 探测到的正是运行时的值。两边都配对,才是完整的配置。

### 相关命令

- `kubelet` — cgroupDriver 与资源限制的实际执行者
- `containerd` — SystemdCgroup 配置所在
- `pod-sysctl` — 与 cgroup 互补的命名空间隔离机制
- `ulimit-k8s` — 另一层进程级限制
- `kernel-tuning` — 节点级内核参数

### 参考链接

- [Kubernetes 中的 cgroup](https://kubernetes.io/docs/concepts/architecture/cgroups/)
- [容器运行时与 cgroup driver](https://kubernetes.io/docs/setup/production-environment/container-runtimes/)
- [KubeletCgroupDriverFromCRI 特性门控](https://kubernetes.io/docs/reference/command-line-tools-reference/feature-gates/)
- [Kubelet 配置 API 参考](https://kubernetes.io/docs/reference/config-api/kubelet-config.v1beta1/)
- [Linux 内核 cgroup v2 文档](https://docs.kernel.org/admin-guide/cgroup-v2.html)
