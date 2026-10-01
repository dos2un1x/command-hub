gpu-time-slicing
===

让多个Pod共享同一张GPU的软件层分时方案

## 补充说明

**time-slicing(时间片共享)** 是 NVIDIA device plugin 提供的一种 GPU 共享方式:通过配置,**同一个 `nvidia.com/gpu` 资源被「复制」成多份**,让多个 Pod 各自拿到一张「虚拟 GPU」,底层其实是同一张物理卡在多个进程之间轮转时间片。

它的机制非常朴素 —— device plugin 只是把**可分配的数量**改掉:

```shell
节点有 8 张物理 GPU,replicas 设为 10
→ 插件向 Kubernetes 宣告 80 个 nvidia.com/gpu
→ kubectl describe node 里显示 Capacity: nvidia.com/gpu: 80
→ 调度器认为这台机器有 80 张卡,可以往上塞 80 个 Pod
```

这也是理解所有坑的起点:**Kubernetes 侧的「卡数」与物理现实脱钩了**。

与另外两条路线的对比:

```shell
MIG            硬件切分,独立显存/SM/故障域,隔离性最好;几何固定,不能借用邻居
time-slicing   软件分时,所有 GPU 通用,利用率最高;无显存隔离、无故障隔离
MPS            软件空间分区,可限制每个客户端的显存与算力,吞吐优于分时
               device plugin 侧自 v0.15.0 起标注为 experimental
```

### 配置格式

device plugin 的配置文件(不是 CRD,是一段 YAML):

```shell
version: v1
sharing:
  timeSlicing:
    renameByDefault: false
    failRequestsGreaterThanOne: false
    resources:
      - name: nvidia.com/gpu
        replicas: 4
```

三个字段的语义:

```shell
resources[].name     要共享的资源名,通常是 nvidia.com/gpu
                     也支持 mixed MIG 策略产生的 nvidia.com/mig-* 资源名
resources[].replicas 复制份数。宣告数量 = 物理设备数 × replicas
renameByDefault      true 时资源改名为 <name>.shared(即 nvidia.com/gpu.shared)
                     默认 false,即共享与独占混在同一个资源名里,无法区分
failRequestsGreaterThanOne
                     请求超过 1 个共享资源时直接判定失败(默认 false)
```

`renameByDefault` 回答了「要不要单独的资源名」这个问题:**默认不分离** —— 开了共享之后,`nvidia.com/gpu` 既代表整卡也代表共享份额,调度侧无法区分一个 Pod 要的是独占还是共享。需要区分(例如只想让一部分业务共享、另一部分独占)时才打开它,共享池变成 `nvidia.com/gpu.shared`。

`failRequestsGreaterThanOne` 官方推荐打开,但默认是 `false` 以保持向后兼容;打开后,请求 `nvidia.com/gpu: 2` 的 Pod 会分配失败并进入 `UnexpectedAdmissionError`,需要手工删除或更新。

两条硬限制:

- **共享方式对整个节点统一**。不能给某张卡配分时、另一张配 MPS;同一个节点上所有 GPU 采用同一种共享方式。
- **time-slicing 与 MPS 互斥**,不能同时启用。

### 通过 GPU Operator 应用

GPU Operator 的做法是:先建一个 ConfigMap,再让 ClusterPolicy 指向它。**ConfigMap 的名字由你自己定**(官方示例用 `time-slicing-config`),但必须与 GPU Operator 在同一个命名空间。

```shell
apiVersion: v1
kind: ConfigMap
metadata:
  name: time-slicing-config
  namespace: gpu-operator
data:
  any: |-
    version: v1
    flags:
      migStrategy: none
    sharing:
      timeSlicing:
        resources:
          - name: nvidia.com/gpu
            replicas: 4
```

安装时指定:

```shell
helm upgrade --install gpu-operator nvidia/gpu-operator -n gpu-operator \
  --set devicePlugin.config.name=time-slicing-config
```

装好之后改 ClusterPolicy(把 `default` 指向 ConfigMap 里的键名,即可全局生效):

```shell
kubectl patch clusterpolicies.nvidia.com/cluster-policy -n gpu-operator --type merge \
  -p '{"spec":{"devicePlugin":{"config":{"name":"time-slicing-config","default":"any"}}}}'
```

**不设 `default` 时不会全局生效**,必须用节点标签逐台指定用哪个配置键:

```shell
kubectl label node gpu-node-1 nvidia.com/device-plugin.config=any
```

配套的 GFD(GPU Feature Discovery)会写出描述共享状态的标签,可用于调度约束:

```shell
nvidia.com/gpu.sharing-strategy        none / mps / time-slicing
nvidia.com/<resource-name>.replicas    复制份数
nvidia.com/gpu.product                 开启 renameByDefault 或共享后名字会带 -SHARED 后缀
```

### 校验

```shell
# 节点上宣告的数量
kubectl describe node gpu-node-1 | grep -A15 "Capacity:"
kubectl get node gpu-node-1 -o json | jq '.status.capacity | with_entries(select(.key|test("nvidia")))'

# 谁在共享同一张卡
kubectl get pods -A -o json | jq -r '.items[] | select(.spec.containers[].resources.limits["nvidia.com/gpu"]!=null) | "\(.metadata.namespace)/\(.metadata.name)"'

# 真正落在同一张卡上的进程
kubectl exec -it <pod> -- nvidia-smi
# 会看到多个进程共享同一块 GPU 的显存与算力

# device plugin 日志
kubectl logs -n gpu-operator ds/nvidia-device-plugin-daemonset --tail=50
```

### 改配置为什么要重启

**GPU Operator 不会监听 ConfigMap 的变化。** 改完 `time-slicing-config` 之后,device plugin 不会自动感知,必须手工滚动重启:

```shell
kubectl rollout restart -n gpu-operator daemonset/nvidia-device-plugin-daemonset
```

已经在运行的 Pod **不受影响,继续运行**;新的配置只作用于**后续的分配**。官方建议把这类变更安排在维护窗口。相对地,改 ClusterPolicy 的 `devicePlugin.config` 字段会由 Operator 主动触发 device plugin 与 GFD 的滚动重启。

如果用的是独立的 device plugin Helm chart(不经 GPU Operator),机制不同:chart 会部署一个 config-manager sidecar 监听节点标签 `nvidia.com/device-plugin.config`,变更时向插件进程发 **SIGHUP 热加载**,不重启 Pod。

### MPS:另一种共享方式

MPS(CUDA Multi-Process Service)在配置上长得几乎一样,只是把 `timeSlicing` 换成 `mps`:

```shell
version: v1
sharing:
  mps:
    renameByDefault: false
    resources:
      - name: nvidia.com/gpu
        replicas: 4
```

区别在于底层机制:**MPS 会启动一个 control daemon 管理对 GPU 的访问,做的是「空间分区」** —— 可以显式限制每个客户端能用的显存与算力并强制执行,每个客户端拿到的是总资源的 1/replicas。因此 MPS 的吞吐与延迟表现通常好于 time-slicing。

但 MPS 有两个限制:

- **device plugin 侧的 MPS 只能用于整卡,且不能用于已开启 MIG 的设备**。官方 README 原文是「Sharing with MPS is currently not supported on devices with MIG enabled」。(驱动层面 CUDA MPS 是可以跑在 MIG 之上的,那是另一回事,需要自行管理。)
- **自 device plugin v0.15.0 起,MPS 支持被标注为 experimental**。它不是一个有生产背书的功能。

使用 MPS 时,per-client 的资源上限由两级控制,且**环境变量只能进一步收紧,不能放宽**:daemon 侧设置默认值(device plugin 会设成总量的 1/replicas),容器里还可以用

```shell
CUDA_MPS_ACTIVE_THREAD_PERCENTAGE    客户端上下文可用的线程百分比
CUDA_MPS_PINNED_DEVICE_MEM_LIMIT     客户端可分配的显存上限,语法同 CUDA_VISIBLE_DEVICES
```

独立 Helm chart 部署 MPS 时会带出 control daemon 的 DaemonSet,默认路径 `/run/nvidia/mps`,并且需要 `hostPID: true`(让 MPS server 通过 `/proc/self` 找到自己的 PID)。

### 注意

1. **time-slicing 没有显存隔离,这是最大的坑**。官方 README 写得很直白:被授予 replicas 的负载之间「没有做任何隔离,每个负载都能访问整块 GPU 的显存,并且处在同一个故障域里**(意味着一个负载崩溃,它们全都崩溃)**」。一个 Pod 里发生 `CUDA out of memory`,同卡上其他 Pod 的进程会一起被杀掉 —— 即使它们只申请了 1/4 的份额。
2. **它不是「按份额分配显存」**。`replicas: 4` 只是把可分配数量变成 4 倍,并没有把 80GB 切成 4×20GB。一个 Pod 完全可以吃掉整块显存,直到把邻居撑爆。
3. **请求多个共享 GPU 不等于拿到多倍算力**。官方明确说明:请求超过 1 个共享 GPU 并不意味着能获得成比例的计算能力,底层 CUDA 只是把时间片**平均分给所有 GPU 进程**。想限制算力要靠 MPS 或 MIG。
4. **「吵闹邻居」现象无法避免**。同一个节点上所有 GPU 用一种共享方式,重负载会拖慢同卡的其他进程。生产环境若要求 QoS,应该用 MIG 而不是 time-slicing。
5. **不要把共享资源当作安全边界**。既然显存与故障域都是共用的,不同租户、不同安全级别的负载不应该共用一张卡;按量计费也没法基于这种共享来做。
6. **`nvidia.com/gpu` 的数量会变得不可信**。`describe node` 显示的 80 张卡是虚构的,容量规划、告警阈值、HPA 的容量判断都会因此失真,排障时先确认节点是不是开了共享。
7. **改配置必须重启 device plugin**,因为 Operator 不监听 ConfigMap。只改 ConfigMap 不重启,现象是「配置看起来改了但资源数量没变」。
8. **对运行中的 Pod 无影响,但新 Pod 会按新配置分配**。这意味着**同一个节点上可能同时存在按 4 份和按 8 份分配的 Pod**,滚动重启期间要意识到这种错配。
9. **time-slicing 与 MPS 互斥,且不能按单卡配置**。一个节点一种策略,不能给同节点的 A100 和 H100 配不同的共享方式。
10. **DCGM 无法把指标归属到容器**。开启 time-slicing 后,DCGM-Exporter 无法把用量映射到具体容器(这是官方记录在案的限制);要按容器做计量就得用 MIG —— MIG 实例有独立 UUID,指标可以按实例采集。
11. **`renameByDefault` 一旦启用,清单里的资源名要跟着改**。共享池变成 `nvidia.com/gpu.shared`,老的 `nvidia.com/gpu` 清单会去抢独占卡(或直接 Pending),这类改动必须同步所有工作负载与配额(`ResourceQuota` 里的 `requests.nvidia.com/gpu` 也要改)。
12. **共享不改变单卡的"独占"语义之外的任何东西**:Pod 里仍然能看到整块 GPU,`nvidia-smi` 会列出同卡的所有进程,容器内的 `CUDA_VISIBLE_DEVICES` 也只有一张卡的编号 —— 排查「为什么我的显存不够」时不要被这些假象带偏。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `gpu-mig` — 硬件切分,真隔离;与分时是两条路线
- `nvidia-device-plugin` — 共享配置的提供方
- `gpu-operator` — 通过ClusterPolicy下发共享配置
- `dcgm-exporter` — 分时场景下无法按容器归属指标
- `resource-quota` — 共享资源数量变化后需同步配额
- `node` — 节点标签决定用哪个共享配置
- `pod` — 共享导致的OOM与崩溃排障

### 参考链接

- [GPU Operator:GPU 共享](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/gpu-sharing.html)
- [k8s-device-plugin README(共享配置)](https://github.com/NVIDIA/k8s-device-plugin)
- [NVIDIA:整合低利用率 GPU 负载(隔离性对比)](https://developer.nvidia.com/blog/maximize-ai-infrastructure-throughput-by-consolidating-underutilized-gpu-workloads)
- [CUDA MPS 环境变量](https://docs.nvidia.com/deploy/mps/appendix-environment-variables.html)
- [CUDA MPS 排障](https://docs.nvidia.com/deploy/mps/615/troubleshooting.html)
- [DCGM-Exporter 与 time-slicing 的归属限制](https://github.com/NVIDIA/dcgm-exporter/issues/307)
