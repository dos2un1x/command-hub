node-exporter
===

Prometheus官方的主机指标采集器,暴露节点级CPU、内存、磁盘与网络指标

## 补充说明

**node-exporter**(全称 Prometheus Node Exporter)是 Prometheus 官方维护的主机指标采集器。它读取 Linux 内核暴露的 `/proc` 与 `/sys` 文件系统,把 CPU、内存、磁盘、文件系统、网络、中断、压力等指标转换成 Prometheus 格式,在 `/metrics` 端点暴露出来 —— **它不做任何持久化,也不主动推送**,只负责把本机状态翻译成指标。

在 Kubernetes 中它以 DaemonSet 形态运行在每个节点上,采集的是**宿主机的指标而不是容器的指标**。这一点是理解它的关键:

```shell
node-exporter       宿主机视角。CPU 总核数、整机内存、块设备 IO、物理网卡
kubelet/cAdvisor    容器视角。每个 Pod 的 CPU、内存、文件系统用量
kube-state-metrics  Kubernetes 对象视角。Deployment 副本数、Pod 状态、PVC 容量
```

**三者互补,不能相互替代**。想查「某个 Pod 用了多少内存」要找 cAdvisor 的 `container_memory_working_set_bytes`,在 node-exporter 里是找不到的。

数据流:`/proc、/sys、宿主机根文件系统 → node-exporter(DaemonSet)→ /metrics:9100 → Prometheus → Grafana`

采集器(collector)按需启用。默认开启的包括:

```shell
cpu  cpufreq  cpuidle  diskstats  filesystem  hwmon  loadavg  meminfo
netdev  netclass  netstat  pressure  rapl  schedstat  stat  time
timex  uname  vmstat  filefd  entropy  conntrack  edac  nvme  xfs  zfs
```

默认**关闭**的需要显式打开:

```shell
interrupts  中断统计      processes   进程统计      systemd     systemd 单元
cgroups     控制组        mounts      挂载点        tcpstat    TCP 统计
ethtool     网卡详情      perf        硬件性能       slabinfo   内核 slab
watchdog    看门狗        wifi        无线           logind     登录会话
```

### 安装

```shell
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

# 独立安装
helm install node-exporter prometheus-community/prometheus-node-exporter \
  -n monitoring --create-namespace

# 用 kube-prometheus-stack 时,它已作为子 Chart 一并部署
# 通过 nodeExporter 段覆盖,不要再单独装一次
helm upgrade prometheus prometheus-community/kube-prometheus-stack -n monitoring \
  --set nodeExporter.enabled=true

# 查看默认值
helm show values prometheus-community/prometheus-node-exporter > node-exporter-values.yaml
```

Chart 默认值要点:

```shell
hostNetwork: true              # 默认使用宿主机网络命名空间
hostPID: true                  # 默认使用宿主机 PID 命名空间
service:
  port: 9100
  targetPort: 9100
  annotations:
    prometheus.io/scrape: "true"
hostRootFsMount:
  enabled: true                # 挂载宿主机根文件系统
  mountPropagation: HostToContainer
hostProcFsMount:
  mountPropagation: ""         # /proc 的挂载传播,默认不设
hostSysFsMount:
  mountPropagation: ""         # /sys 的挂载传播,默认不设
tolerations:
  - effect: NoSchedule
    operator: Exists           # 默认容忍所有污点,包括控制平面节点
resources: {}
kubeRBACProxy:
  enabled: false               # 可选的端点保护
  enableHostPort: false
```

### 挂载与启动参数

node-exporter 的容器内路径与宿主机路径必须显式对应:

```shell
--path.procfs=/host/proc      # 对应宿主机 /proc
--path.sysfs=/host/sys        # 对应宿主机 /sys
--path.rootfs=/host/root      # 对应宿主机 /,filesystem 采集器依赖它
--web.listen-address=:9100
--collector.textfile.directory=/var/lib/node_exporter/textfile_collector
```

过滤掉噪声是必修课。容器运行时会产生大量无意义的挂载点与伪文件系统:

```shell
--collector.filesystem.mount-points-exclude=^/(dev|proc|sys|run|var/lib/docker/.+|var/lib/kubelet/.+|var/lib/containerd/.+)($|/)
--collector.filesystem.fs-types-exclude=^(autofs|binfmt_misc|bpf|cgroup2?|configfs|debugfs|devpts|devtmpfs|fusectl|hugetlbfs|iso9660|mqueue|nsfs|overlay|proc|procfs|pstore|rpc_pipefs|securityfs|selinuxfs|squashfs|sysfs|tracefs)$
--collector.netdev.device-exclude=^(veth|br-|docker|cali|flannel|cni|nodelocaldns).*
--collector.netclass.ignored-devices=^(veth|br-|docker|cali|flannel|cni).*
--collector.diskstats.device-exclude=^(loop|ram|dm-|sr)\d*
--no-collector.hwmon
--collector.interrupts
--collector.processes
--collector.systemd
--collector.tcpstat
```

启用更多采集器时要注意**它们需要对应的宿主机视图**:

```shell
# interrupts / processes 依赖 hostPID,才能看到宿主机的进程与中断
--collector.interrupts
--collector.processes

# systemd 采集器需要挂载 dbus 套接字
--collector.systemd
--path.systemd=/run/systemd

# textfile 采集器需要一个可写目录
--collector.textfile.directory=/var/lib/node_exporter/textfile_collector
```

### 常用指标

```shell
# CPU:空闲时间占比换算使用率
100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)

# 负载
node_load1
node_load5
node_load15

# 内存
node_memory_MemTotal_bytes
node_memory_MemAvailable_bytes
node_memory_MemFree_bytes
node_memory_Cached_bytes
node_memory_Buffers_bytes

# 内存使用率
(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100

# 文件系统容量与 inode
node_filesystem_size_bytes{fstype!~"tmpfs|overlay|squashfs"}
node_filesystem_avail_bytes
node_filesystem_files
node_filesystem_files_free

# 磁盘 IO
rate(node_disk_read_bytes_total[5m])
rate(node_disk_written_bytes_total[5m])
rate(node_disk_io_time_seconds_total[5m])

# 网卡收发与错误
rate(node_network_receive_bytes_total{device!~"veth.*"}[5m])
rate(node_network_transmit_bytes_total{device!~"veth.*"}[5m])
rate(node_network_receive_errs_total[5m])
rate(node_network_receive_drop_total[5m])

# 压力失速(PSI),比负载更直观
rate(node_pressure_cpu_waiting_seconds_total[1m])
rate(node_pressure_memory_stalled_seconds_total[1m])
rate(node_pressure_io_stalled_seconds_total[1m])

# 文件描述符与连接跟踪
node_filefd_allocated / node_filefd_maximum
node_nf_conntrack_entries / node_nf_conntrack_entries_limit

# 时间同步偏移
node_timex_offset_seconds
node_timex_sync_status

# 温度与硬件
node_hwmon_temp_celsius

# 开机时间(用于识别重启)
node_boot_time_seconds
```

典型告警规则:

```shell
groups:
  - name: node.rules
    rules:
      - alert: NodeFilesystemAlmostFull
        expr: |
          node_filesystem_avail_bytes{fstype!~"tmpfs|overlay|squashfs",mountpoint!~"/var/lib/kubelet/.*"}
            / node_filesystem_size_bytes < 0.15
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "{{ $labels.instance }} 的 {{ $labels.mountpoint }} 剩余空间不足 15%"

      - alert: NodeMemoryPressure
        expr: (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) > 0.95
        for: 10m
        labels:
          severity: critical

      - alert: NodeClockNotSynchronising
        expr: node_timex_sync_status != 1
        for: 10m
        labels:
          severity: warning
```

### 验证与排障

```shell
kubectl get ds -n monitoring node-exporter
kubectl get po -n monitoring -l app.kubernetes.io/name=prometheus-node-exporter -o wide

# 直接抓取一个 Pod 的指标
kubectl port-forward -n monitoring ds/node-exporter-prometheus-node-exporter 9100:9100
curl -s localhost:9100/metrics | head -40
curl -s localhost:9100/metrics | grep -c '^node_'         # 指标条数

# 确认看到的是宿主机而非容器
kubectl exec -n monitoring ds/node-exporter-prometheus-node-exporter -- cat /host/proc/loadavg
kubectl exec -n monitoring ds/node-exporter-prometheus-node-exporter -- ls /host/root

# 采集器与构建信息
curl -s localhost:9100/metrics | grep node_exporter_build_info
curl -s localhost:9100/metrics | grep -E '^node_scrape_collector'

# 在 Prometheus 侧确认目标状态
kubectl exec -n monitoring sts/prometheus-prometheus-kube-prometheus-prometheus -c prometheus -- \
  wget -qO- 'localhost:9090/api/v1/targets?state=active' | tr ',' '\n' | grep -i node-exporter | head

# 服务发现
kubectl get svc -n monitoring node-exporter-prometheus-node-exporter
kubectl get servicemonitor -n monitoring node-exporter-prometheus-node-exporter -o yaml | head -40
```

### 注意

1. **`hostNetwork` 与 `hostPID` 默认为 `true`**,这不是可有可无的选项。`hostNetwork` 让 Pod 使用宿主机网络命名空间(因此 9100 端口直接绑在节点上),`hostPID` 让它能读到宿主机的进程与中断信息 —— **`interrupts`、`processes` 采集器没有 hostPID 就无法工作**。去掉这两项会导致指标缺失或语义错误。
2. **`hostNetwork: true` 时 9100 端口会和节点上的其它服务冲突**。若节点上已有进程监听 9100(例如另一个 node-exporter 或自建 exporter),Pod 会一直 `CrashLoopBackOff` 并报 `bind: address already in use`。
3. **`--path.rootfs` 必须指向宿主机根目录的挂载点**。不设置或指向错误路径时,`node_filesystem_*` 系列指标反映的是容器自己的文件系统,容量看起来永远是几百 MB,基于磁盘的告警要么永不触发要么疯狂误报。
4. **`mountPropagation: HostToContainer` 不能省**。宿主机上新增或卸载挂载点(例如新挂载一块数据盘、Kubernetes 挂载 PVC)时,没有正确的传播设置,容器内的挂载表不会更新,`node_filesystem_*` 会长期停留在旧状态。
5. **文件系统指标默认噪音极大**。`/var/lib/kubelet`、`/var/lib/docker`、`/var/lib/containerd` 下的每个 Pod 卷、每个 overlay 层都会生成一组序列,单节点轻松产生上万条。**必须配置 `mount-points-exclude` 与 `fs-types-exclude`**,否则既浪费存储又会让「磁盘快满」的告警在临时卷上反复触发。
6. **虚拟网卡指标同样需要过滤**。`veth`、`cali`、`flannel`、`cni`、`docker`、`br-` 开头的接口数量随 Pod 数变化,把它们算进网卡流量统计会让数据完全失真,也会造成序列数量随 Pod 数量波动。用 `device-exclude` 正则过滤掉。
7. **node-exporter 不提供任何容器或 Pod 级指标**。这是最常见的误解。Pod 的 CPU/内存来自 kubelet 的 cAdvisor 端点(`container_cpu_usage_seconds_total`、`container_memory_working_set_bytes`),Kubernetes 对象状态来自 kube-state-metrics。三套指标用 `instance` 与 `node` 标签关联。
8. **`instance` 标签在 hostNetwork 下是节点 IP**。这既是优点(可以直接与 `kube_node_info` 的 `internal_ip` 关联),也是坑:通过 Ingress 或 Service 访问时,重写 target 会丢失这个语义。需要节点名时用 relabel 把 `__meta_kubernetes_pod_node_name` 提升为 `node` 标签。
9. **默认容忍所有污点**。Chart 的 `tolerations` 使用 `operator: Exists` 且不限定 key,所以 node-exporter 会跑在包括控制平面在内的所有节点上。这通常是想要的;若不希望如此,必须显式重写 `tolerations`,而不是简单删掉 —— 删掉后带污点的节点就没有主机指标了。
10. **`--collector.systemd` 需要 dbus 套接字**。启用它必须额外挂载宿主机的 `/run/dbus/system_bus_socket`,否则 node-exporter 会启动失败或该采集器持续报错。
11. **textfile 采集器要求原子写入**。自定义脚本写 `.prom` 文件时如果直接原地覆盖,node-exporter 可能读到写了一半的内容并记 `node_textfile_scrape_error 1`。正确做法是先写临时文件再 `rename`。
12. **`resources` 默认为空**。node-exporter 本身很轻,但在核数与磁盘数很多的大机型上,每次抓取都要遍历 `/proc` 下大量文件,CPU 占用会明显上升。给一个合理的 `requests: 50m/64Mi` 有助于调度器正确评估节点容量。
13. **启用过多的关闭态采集器会显著增加抓取耗时**。`perf`、`cgroups`、`slabinfo`、`ethtool` 这些采集器读取的数据量大,在小机器上可能让单次 `/metrics` 响应超过 Prometheus 的 `scrapeTimeout`,表现为目标间歇性 `up == 0`。按需开启,不要一股脑全开。
14. **node-exporter 只读宿主机文件系统,不需要 API 权限**。它不需要 ClusterRole 去访问 API Server;真正需要 RBAC 的是 Prometheus(发现目标)与 kube-state-metrics(读对象)。看到「node-exporter 权限不足」的判断通常是找错了方向。
15. **`node_boot_time_seconds` 是识别节点重启最可靠的信号**。用 `changes(node_boot_time_seconds[1h]) > 0` 可以直接捕获节点重启事件,比依赖 `up` 的抖动更准确。
16. **数据敏感性**。node-exporter 能读到宿主机的大量信息(内核版本、挂载点、硬件型号、进程数),在共享集群中应通过 `kubeRBACProxy.enabled: true` 或 NetworkPolicy 限制 `/metrics` 端点的访问范围。

### 相关命令

- `prometheus` — Kubernetes集群监控系统与时间序列数据库
- `metrics-server` — Kubernetes集群资源指标采集组件
- `alertmanager` — Prometheus 告警路由与去重组件
- `grafana` — 指标可视化与大盘平台
- `kubectl` — Kubernetes集群管理工具

### 参考链接

- [node_exporter GitHub 仓库](https://github.com/prometheus/node_exporter)
- [node_exporter 采集器列表](https://github.com/prometheus/node_exporter#collectors)
- [prometheus-node-exporter Chart](https://github.com/prometheus-community/helm-charts/tree/main/charts/prometheus-node-exporter)
- [Prometheus 主机监控最佳实践](https://prometheus.io/docs/guides/node-exporter/)
- [Linux 内核 /proc 文档](https://www.kernel.org/doc/html/latest/filesystems/proc.html)
