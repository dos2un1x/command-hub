ulimit-k8s
===

容器内的进程资源限制,为什么Kubernetes没有ulimit字段以及该怎么调

## 补充说明

`ulimit` 是 shell 内建命令,用于查看和设置进程的资源限制(准确说是 POSIX 的 **rlimit**)。容器里 `open too many files` 是最常见的生产故障之一,而 Kubernetes **没有提供任何直接设置 ulimit 的 API**。

这一点必须先说清楚,因为它是很多误解的源头:

```shell
Kubernetes 的 securityContext 【没有】 ulimits 字段
  容器级 SecurityContext 没有
  Pod 级 PodSecurityContext 也没有
  PodSecurityPolicy 时代的 selinux/capabilities 里同样没有

任何形如下面的清单都是【无效的】,会被 API 拒绝:
  securityContext:
    ulimits:
      - name: nofile
        soft: 65536
        hard: 65536
```

所以容器里的 nofile 上限从哪来?答案是**继承自容器运行时进程本身**,而运行时进程的上限又来自它的 systemd 单元。这条继承链是理解一切的关键:

```shell
systemd 默认值（DefaultLimitNOFILE）
      ↓ 继承
containerd / CRI-O 守护进程
      ↓ 继承（容器默认不覆盖）
容器内的 PID 1
      ↓ 继承
容器内的所有子进程
```

### 关键限制:三个层次

排查「too many open files」时必须分清三个不同层次的限制,它们互相独立:

```shell
fs.file-max          系统级,整个内核能打开的文件句柄总数
                     /proc/sys/fs/file-max
                     查看当前用量：cat /proc/sys/fs/file-nr

fs.nr_open           单进程硬上限的天花板
                     /proc/sys/fs/nr_open
                     任何进程的 RLIMIT_NOFILE 硬上限【不能超过】它

RLIMIT_NOFILE        单个进程的限制,分 soft / hard 两个值
                     这才是 ulimit -n 操作的对象
```

**soft 与 hard 的区别是最容易被忽略的一点:**

```shell
soft limit   当前生效的值。进程可以自行调高,但【不能超过 hard limit】
hard limit   天花板。非特权进程【只能调低】,不能调高
             要调高 hard limit,需要 CAP_SYS_RESOURCE 权限（即特权容器）
```

这解释了一个常见现象:容器里 hard limit 是 1024,应用自己调 `setrlimit` 也无济于事 —— 它没有权限突破 hard limit。

### 容器里实际是多少

```shell
# 在容器内查看
ulimit -Sn                 # soft
ulimit -Hn                 # hard
cat /proc/1/limits         # 最准确,直接读 PID 1 的限制表
# Max open files  1024  524288  files
```

**containerd 2.0 是一个分水岭**。1.x 时代的 `containerd.service` 单元里写了 `LimitNOFILE=infinity`,所以容器内的上限非常高;2.0 **移除了这一行**,于是 containerd 直接继承 systemd 的默认值,容器内变成:

```shell
soft = 1024
hard = 524288
```

大量「升级 containerd 之后突然开始报 too many open files」的故障都源于此。老集群里应用能开几万个连接,升级后一到 1024 就崩,代码却一行没改。

### 修改方式

因为没有 Kubernetes 字段,只能从**运行时**或**进程启动方式**两个方向解决。

**方式一:改 containerd 的 base runtime spec(推荐,全局生效)**

containerd 的 CRI 配置支持 `base_runtime_spec`,指向一份 OCI runtime spec JSON,在其中声明 rlimit:

```shell
# 1. 生成一份基础 spec
ctr oci spec > /etc/containerd/cri-base.json

# 2. 在里面加上 process.rlimits
```

```shell
{
  "process": {
    "rlimits": [
      {
        "type": "RLIMIT_NOFILE",
        "hard": 1048576,
        "soft": 1048576
      }
    ]
  }
}
```

```shell
# 3. 在 containerd config.toml 的 CRI 运行时配置里引用它
```

```shell
# containerd 1.x 的路径
[plugins."io.containerd.grpc.v1.cri"]
  base_runtime_spec = "/etc/containerd/cri-base.json"

# containerd 2.x 的 CRI 运行时插件（插件 ID 已改名）
[plugins."io.containerd.cri.v1.runtime"]
  base_runtime_spec = "/etc/containerd/cri-base.json"
```

```shell
sudo systemctl restart containerd
```

改完后**只对新建的容器生效**,已有容器需要重建。

**方式二:改 systemd 单元的限制**

不推荐单独改,但如果只是想让 containerd 继承更大的值:

```shell
sudo systemctl edit containerd
```

```shell
[Service]
LimitNOFILE=1048576
```

```shell
sudo systemctl daemon-reload
sudo systemctl restart containerd
```

**方式三:CRI-O 的 default_ulimits**

CRI-O 比 containerd 直接,配置项在 `[crio.runtime]` 下:

```shell
[crio.runtime]
default_ulimits = [
  "nofile=1048576:1048576",
  "nproc=65536:65536",
]
```

格式是 `"<类型>=<soft>:<hard>"`。**默认值是空数组**,官方文档明确说明:未配置时,容器**继承 CRI-O 守护进程的设置**。

**方式四:容器内自己调(局部生效,最常用)**

不改造运行时的前提下,用 shell 包装一层:

```shell
spec:
  containers:
    - name: app
      image: my-app:1.0
      command:
        - sh
        - -c
        - "ulimit -n 65536 && exec /usr/local/bin/app --serve"
```

这个写法有两个要点:

```shell
1. ulimit -n 只能往上调到 hard limit 为止
   如果 hard limit 也是 1024,这行会失败（此时需要先调 hard,即方式一/二/三）

2. 【必须加 exec】
   不加 exec 的话,PID 1 是 sh,应用是它的子进程
   SIGTERM 发给 sh 后不会转发给应用,优雅退出直接失效
   结果是每次滚动更新都要等满 terminationGracePeriodSeconds 再被 SIGKILL
```

### 排查

```shell
# 1. 确认是谁撞到了限制
kubectl logs <pod> --previous | grep -i "too many open files"
kubectl exec -it <pod> -- cat /proc/1/limits | grep -i "open files"

# 2. 看进程当前打开了多少
kubectl exec -it <pod> -- ls /proc/1/fd | wc -l
kubectl exec -it <pod> -- lsof -p 1 2>/dev/null | wc -l

# 3. 看系统级用量
cat /proc/sys/fs/file-nr        # 已分配 / 未使用 / 上限
sysctl fs.file-max fs.nr_open

# 4. 看运行时的限制来源
systemctl show containerd -p LimitNOFILE
cat /proc/$(pgrep -x containerd)/limits | grep -i "open files"

# 5. 看 kubelet 自己的限制（大规模集群值得定期核对）
systemctl show kubelet -p LimitNOFILE
cat /proc/$(pgrep -x kubelet)/limits | grep -i "open files"
```

### 注意

1. **Kubernetes 没有 ulimits 字段,这是设计而非遗漏**。所有在 `securityContext` 里写 `ulimits` 的清单都是无效的。看到教程这么写,可以直接判断它不可靠。
2. **containerd 2.0 移除了 `LimitNOFILE=infinity`**。这是最容易踩的版本坑:升级 containerd 后容器内 nofile 软上限掉到 1024,表现为「代码没改、集群没改,突然开始报 too many open files」。升级前务必检查 `LimitNOFILE` 并预先规划。
3. **`ulimit -n` 只能调到 hard limit**。hard limit 是 1024 时,`ulimit -n 65536` 会静默失败(或报错)。很多「我明明调了却没用」的案例都卡在这里 —— 得先改 runtime 抬高 hard limit。
4. **`fs.file-max` 很大不代表够用**。它约束的是**系统总量**,而 `RLIMIT_NOFILE` 约束的是**单个进程**。内核参数调到几百万、容器里只有 1024,照样报错。反过来,大量小容器加起来超过 `fs.file-max` 也会失败。
5. **`fs.nr_open` 是所有 rlimit 硬上限的天花板**。把容器 hard limit 设成比 `fs.nr_open` 还大的值没有意义,内核会拒绝;调优时要三处一起看。
6. **不写 `exec` 会让优雅退出失效**。用 `sh -c "ulimit ... && app"` 时,信号发给的是 shell。这是一个与 ulimit 无关但几乎总是一起出现的坑:排查「Pod 退出总是慢 30 秒」时先看这里。
7. **在 Dockerfile 里 `RUN ulimit -n ...` 不生效**。rlimit 由**运行时**在创建进程时设置,构建阶段设置的不会保留到运行阶段。同理,镜像里改 `limits.conf` 对容器也无效。
8. **特权容器才能调高 hard limit**。非特权进程只能调低 hard limit。所以极端场景(应用启动时需要先 setrlimit)必须走 runtime 的 base spec,而不是指望应用自己提权。
9. **Java 是最容易撞限制的负载**。JVM 会为每个连接、每个 JAR、每个线程栈打开文件句柄,默认 1024 在高并发下远远不够。跑 Java 服务时应当把 nofile 显式调大。
10. **`nproc` 之类的限制同样不在 Kubernetes API 里**。除了 nofile,`nproc`(进程数)、`memlock` 等 rlimit 都只能通过运行时配置调整。如果应用有线程数上限的困扰,别只盯着 nofile。
11. **改 runtime 配置需要重启 containerd,会影响节点上所有容器**。虽然 containerd 支持 reload,但 `base_runtime_spec` 一类的变更通常要重启守护进程。生产上应逐节点滚动执行,而不是一次改完整个集群。
12. **监控要盯住 `file-nr` 而不是等报错**。`cat /proc/sys/fs/file-nr` 的第一个字段是已分配句柄数。给它建立基线告警,比事后从日志里翻 "too many open files" 要可靠得多。

### 相关命令

- `kernel-tuning` — 节点级内核参数(含 `fs.file-max`、`fs.nr_open`)
- `pod-sysctl` — 可以通过 Pod 设置的那部分内核参数
- `cgroup` — 另一层资源隔离机制
- `containerd` — 默认 rlimit 的实际来源
- `kubelet` — 自身 fd 用量也会随集群规模增长
- `crictl` — 在节点上直接查看容器进程

### 参考链接

- [Pod 安全上下文(不含 ulimits)](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/)
- [containerd CRI 配置](https://github.com/containerd/containerd/blob/main/docs/CRI/README.md)
- [containerd base_runtime_spec](https://github.com/containerd/containerd/blob/main/docs/cri/config.md)
- [CRI-O 配置参考(default_ulimits)](https://github.com/cri-o/cri-o/blob/main/docs/crio.conf.5.md)
- [OCI Runtime Spec:process.rlimits](https://github.com/opencontainers/runtime-spec/blob/main/config.md)
