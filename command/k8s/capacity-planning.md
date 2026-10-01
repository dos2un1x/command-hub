capacity-planning
===

集群容量规划:节点选型、装箱率、资源预留与超卖

## 补充说明

**capacity-planning** 要回答的问题是:给定业务规模,该买什么样的机器、每台跑多少个 Pod、留多少余量,才能在不出事的前提下把资源用满。

容量规划里最容易出错的地方不是"买少了",而是**把可分配资源算多了**:

- 节点上真正能被 Pod 用的是 **Allocatable**,不是机器标称的 Capacity;
- 调度器**只看 requests**,不看实际使用量,所以 requests 写得离谱会同时造成"浪费"和"抢不到";
- CPU 可以超卖(压缩型资源),内存**不能**(申请超额必然 OOM);
- 云上节点能跑多少 Pod,常常不是 `max-pods` 说了算,而是 IP 供给说了算。

### Node Allocatable 的计算

```shell
Allocatable = Capacity − kubeReserved − systemReserved − 硬驱逐阈值(evictionHard)
```

三块预留的含义:

| 预留 | 留给谁 | 典型值 |
|---|---|---|
| kubeReserved | kubelet、容器运行时、CNI 等 Kubernetes 自身组件 | cpu 100m、memory 100Mi、ephemeral-storage 1Gi、pid 1000 |
| systemReserved | 内核、sshd、监控 agent、登录会话等系统进程 | 同上量级,内存要额外给内核留一份 |
| evictionHard | 触发驱逐的硬阈值,等价于从 Allocatable 里扣掉 | memory.available 100Mi、nodefs.available 10%、nodefs.inodesFree 5%、imagefs.available 15% |

注意 kubeReserved 的官方定位:**它通常与节点上的 Pod 密度成正比** —— 跑 30 个 Pod 和跑 110 个 Pod 的节点,容器运行时和 kubelet 的开销完全不同,预留值不该照抄。

### 节点选型

- **按 SLO 反推单节点密度**。社区的规模阈值给出的是 `min(110, 10 × 核数)`:8 核节点约 80 个 Pod,16 核以上才考虑接近 110。超过这个密度,kubelet 的状态上报、cgroup 操作、日志轮转都会变慢,节点更容易 NotReady。
- **控制面节点与工作节点分开**。etcd 对磁盘延迟极其敏感,控制面节点必须用低延迟 SSD,且不要与 IO 密集的业务混部。
- **机型尽量统一**。机型越杂,装箱、故障域、升级窗口都越难管;同构集群的调度与容量预测都简单得多。
- **留出故障域**。按可用区规划时,任一可用区故障后剩余节点的 Allocatable 仍要能承载全部业务(如果需要 N+1 甚至 N+2 的冗余)。

### 装箱率与超卖

```shell
# 单个节点的可分配量(kubeadm 默认没有设预留,这里演示的是手工配置后的效果)
kubectl describe node <node> | grep -A 8 'Allocatable'
kubectl describe node <node> | grep -A 8 'Capacity'

# 节点上 requests 与 limits 的汇总,用来判断装箱率
kubectl describe node <node> | grep -A 6 'Allocated resources'
```

| 资源 | 是否可超卖 | 说明 |
|---|---|---|
| CPU | 可以 | 压缩型资源,超卖后表现为 throttling,不会杀死进程 |
| 内存 | 不可以 | 不可压缩,超卖后触发 OOMKilled 或节点驱逐 |
| ephemeral-storage | 不可以 | 写满会触发磁盘压力驱逐 |
| GPU / 大页 | 不可以 | 独占资源,必须精确匹配 |

实务上的做法:

- **CPU 的 requests 按实际用量给**,limits 可以高于 requests(甚至不设 limits),用 throttling 兜底;
- **内存的 requests 尽量贴近真实峰值**,limits 略高于 requests 即可,不要为了"看起来能塞更多"把内存 requests 压低;
- 对延迟敏感的服务给 **Guaranteed QoS**(requests = limits),避免被驱逐和被其他 Pod 挤占;
- 批处理类负载用 **Burstable / BestEffort** 填充碎片资源。

统一用 requests/limits 与 QoS 的完整规则见 `qos` 与 `limitrange` 页面。

### 计算示例

一台 **8 vCPU / 32 GiB** 的工作节点,预留配置如下:

```shell
kubeReserved:   cpu: 1000m, memory: 2Gi, ephemeral-storage: 2Gi
systemReserved: cpu: 1000m, memory: 2Gi, ephemeral-storage: 2Gi
evictionHard:   memory.available: 100Mi, nodefs.available: 10%, imagefs.available: 15%
```

```shell
Allocatable(vCPU) = 8 − 1 − 1 = 6
Allocatable(内存) = 32 − 2 − 2 − 0.1 ≈ 27.9 GiB
```

再按 Pod 密度分摊:该节点按 80 个 Pod 规划,则平均每个 Pod 能拿到的内存 requests 约为 `27.9GiB / 80 ≈ 357MiB`。如果业务 Pod 的平均内存 requests 是 512MiB,这台节点实际只能跑约 55 个 Pod —— **这就是"按 Pod 数规划"和"按资源规划"的差别**。

### 预留的配置方式

```shell
# 推荐写在 KubeletConfiguration 里(命令行 flag 已标记废弃)
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
kubeReserved:
  cpu: 1000m
  memory: 2Gi
  ephemeral-storage: 2Gi
systemReserved:
  cpu: 1000m
  memory: 2Gi
  ephemeral-storage: 2Gi
evictionHard:
  memory.available: "100Mi"
  nodefs.available: "10%"
  nodefs.inodesFree: "5%"
  imagefs.available: "15%"
enforceNodeAllocatable:
  - pods
```

```shell
# 把关键系统进程的 CPU 从调度里彻底摘出去(电信/NFV 场景常用,自 1.17 稳定)
reservedSystemCPUs: "0-1"
```

```shell
# 验证节点是否真的按预期预留
kubectl get node <node> -o jsonpath='{.status.allocatable}' | jq .
kubectl get --raw "/api/v1/nodes/<node>/proxy/configz" | jq '.kubeReserved, .systemReserved, .evictionHard'
```

### 容量规划的例行工作

```shell
# 1. 集群当前规模与增长趋势
kubectl get nodes --no-headers | wc -l
kubectl get pods -A --no-headers | wc -l

# 2. 每个节点的装箱率(requests 占 Allocatable 的比例)
kubectl describe node <node> | grep -A 6 'Allocated resources'

# 3. 是否有节点已经逼近驱逐阈值
kubectl get nodes -o custom-columns=\
NAME:.metadata.name,CPU:.status.allocatable.cpu,MEM:.status.allocatable.memory

# 4. 实际用量 vs requests(判断 requests 是否虚高)
kubectl top node
kubectl top pod -A --sort-by=memory | head -20
```

- 长期趋势用 `metrics-server` 或 Prometheus 采集,按周/月看增长斜率,而不是等出事才看。
- requests 明显虚高的服务,用 VPA 的推荐值(只跑 recommender 模式即可)作为调整依据。
- 定期排查**没有设置 requests/limits 的 Pod** —— 它们是装箱计算里最大的不确定因素。

### 按业务反推节点数

假设业务侧统计出:内存 requests 合计约 **1.2 TiB**、CPU requests 合计约 **300 核**、Pod 总数约 **4000** 个。选用机型为 8 vCPU / 32 GiB(单节点 Allocatable 约 6 vCPU / 27.9 GiB),按每节点 80 个 Pod 规划:

```shell
按内存:1.2 TiB / 27.9 GiB ≈ 45 台
按 CPU:300 / 6         = 50 台
按 Pod:4000 / 80       = 50 台

取三者最大值 50 台,再叠加故障冗余(按可用区 N+1)→ 约 60 台
```

```shell
# 落到节点上校验:requests 汇总不得超过 Allocatable
kubectl describe node <node> | grep -A 6 'Allocated resources'

# 如果内存维度先撞线(常见),说明该给内存 requests 做瘦身或换更大内存的机型
```

经验规律:**内存通常是主要约束**(不可压缩,超了就是 OOM),CPU 因为有超卖空间相对宽松。两个维度都要算,取上限;三个维度里谁先撞线,就先优化谁。

### 云环境额外的容量约束

- **IP 供给**:云上节点能挂多少 Pod,常常由网卡的 IP 配额决定,而不是 `max-pods`。规划前先算清 IPAM 能提供多少个地址。
- **本地磁盘**:镜像、容器可写层、日志都落在一块盘上,`imagefs.available` 与 `nodefs.available` 的驱逐阈值实际是在保护它;镜像大的业务要单独评估磁盘容量。
- **实例与网络配额**:云厂商对 vCPU、弹性网卡、负载均衡、快照数量都有限额,大规模扩容前要提前申请提额,否则会卡在配额而不是容量上。
- **可用区容量**:某个可用区的机型可能临时售罄,导致自动扩缩容拿不到实例;规划时应准备备选机型与可用区。

### 注意

1. **Allocatable 的公式里包含驱逐阈值**。只按 `Capacity − kubeReserved − systemReserved` 估算会高估可分配内存,大规模集群里这个误差足以造成批量驱逐。
2. **改 `evictionHard` 时,只写一项会清空其余项**。KubeletConfiguration 的 map 字段是整体替换的:只写 `memory.available` 会让 `nodefs.available`、`imagefs.available` 等默认值变成 0,等于取消了对它们的驱逐保护。要么把全部阈值写全,要么设置 `mergeDefaultEvictionSettings: true` 表示与默认值合并。
3. **`enforceNodeAllocatable` 默认只有 `pods`**。也就是说 kubeReserved/systemReserved 默认只是"账面扣除",并不会真的限制系统进程的用量。要让预留真正生效,需要额外配置 `kubeReservedCgroup` / `systemReservedCgroup` 并把 `kube-reserved` / `system-reserved` 加进 `enforceNodeAllocatable`。
4. **kubelet 不会替你创建预留 cgroup**。官方文档明确说明:kubelet **不会**创建 `kubeReservedCgroup`,如果指定了不存在的 cgroup,会直接启动失败;用 systemd 作为 cgroup driver 时,名字要带 `.slice` 后缀。
5. **cgroupDriver 必须与容器运行时一致**。kubelet 自身默认是 `cgroupfs`,而 containerd 等运行时通常用 `systemd`;两者不一致会导致 kubelet 管理不到容器的 cgroup,表现为 Pod 起不来或资源限制失效。kubeadm 生成的配置会显式设为 `systemd`。
6. **内存不要超卖**。CPU 超卖只是 throttling,内存超卖是 OOMKilled 与节点级驱逐连锁反应,恢复过程比 CPU 慢得多。
7. **`max-pods` 不是节点能跑多少 Pod 的真实上限**。云环境里弹性网卡数量 × 每张网卡的 IP 数、以及集群的 Pod CIDR 大小,往往更早成为瓶颈;规划前先确认 IPAM 的供给能力,再决定 `max-pods`。
8. **requests 写得离谱会让集群两头难受**:写太高,节点早早"满"了却没人用资源;写太低,调度器把 Pod 塞进来之后互相抢资源,触发驱逐。定期用实际用量校准 requests,是容量规划最重要的日常工作。
9. **`pid` 也是一种可预留资源**。跑大量进程的节点(如 sidecar 多、构建类负载)要预留 pid 额度,否则会撞上内核的 pid 上限并波及整机。
10. **预留值要随 Pod 密度调整**。官方明确说 kubeReserved 是 Pod 密度的函数;把预留值从低密度机型直接复制到高密度机型,会让 kubelet 与运行时在高峰时抢不到 CPU。
11. **容量规划要包含"故障后"的容量**。可用区故障、一批节点被驱逐或正在升级时,剩余节点的 Allocatable 必须还放得下全部业务;只按常态算容量,等于把风险留给故障时刻。
12. **别忽视 churn**。社区 SLO 要求集群 churn ≤ 20/秒(Pod 规格创建/更新/删除 + 用户请求)。容量规划只算"能装多少",不算"每秒能变多少次",在滚动更新风暴或大批短命 Job 场景下会严重失真。
13. **控制面容量要单独规划**。工作节点可以加,控制面受 etcd 磁盘与 watch cache 内存限制;业务规模增长时应同步评估控制面规格,而不是只加工作节点。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `node` — 节点资源与状态
- `qos` — Pod 服务质量等级与驱逐顺序
- `limitrange` — 命名空间级默认 requests/limits
- `vpa` — 垂直自动扩缩容与 requests 推荐
- `scalability` — 大规模集群的规模阈值与 SLO
- `kubelet-config` — KubeletConfiguration 的配置方式

### 参考链接

- [为系统守护进程预留计算资源](https://kubernetes.io/docs/tasks/administer-cluster/reserve-compute-resources/)
- [节点可分配资源(Node Allocatable)](https://kubernetes.io/docs/tasks/administer-cluster/reserve-compute-resources/#node-allocatable)
- [为容器管理资源](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
- [大规模集群的注意事项](https://kubernetes.io/docs/setup/best-practices/cluster-large/)
- [Kubernetes 可扩展性阈值](https://github.com/kubernetes/community/blob/master/sig-scalability/configs-and-limits/thresholds.md)
