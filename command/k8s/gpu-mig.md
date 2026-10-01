gpu-mig
===

把一张NVIDIA GPU硬件切分成多个独立实例供多个Pod使用

## 补充说明

**MIG(Multi-Instance GPU)** 是 NVIDIA 在 Ampere 及以后架构上提供的**硬件级切分**能力:一张 GPU 可以被切成若干互相独立的实例,每个实例有**独立的显存、独立的 SM(计算单元)、独立的内存带宽**,并且**故障域也是隔离的** —— 一个实例上的进程崩溃或 OOM,不会影响同卡上的其他实例。

这是 MIG 与 time-slicing、MPS 的本质区别:后两者是**软件层共享**,MIG 是**硬件层切分**。需要 QoS 保证的多租户推理、需要防止「吵闹邻居」的场景,只有 MIG 能提供真正的隔离。

支持 MIG 的产品线(compute capability ≥ 8.0):

```shell
Blackwell   GB200 / B200 / RTX PRO 6000 Blackwell / RTX PRO 5000 / RTX PRO 4500
Hopper      H100-SXM5 / H100-PCIE / H200-SXM5 / H200 NVL / H20 / GH200 上的 H100
Ampere      A100-SXM4 / A100-PCIE / A30
```

驱动最低版本(节选,完整的要看官方支持表):A100/A30 需要 **R525.53+**,H100/H200 需要 **R450.80.02+**,B200 需要 **R570.133.20+**,RTX PRO 系列需要 **R575.51.03+**。

### Profile 命名

MIG 的切分形状(profile)是**每个 GPU 型号固定的**,不能任意组合。命名规则是 `<切片数>g.<显存>gb`:

```shell
A100-40GB   1g.5gb ×7   1g.5gb+me ×1   1g.10gb ×4   2g.10gb ×3
            3g.20gb ×2  4g.20gb ×1     7g.40gb ×1

A100-80GB   1g.10gb ×7  1g.10gb+me ×1  1g.20gb ×4  2g.20gb ×3
            3g.40gb ×2  4g.40gb ×1     7g.80gb ×1

A30-24GB    1g.6gb ×4   1g.6gb+me ×1   2g.12gb ×2  2g.12gb+me ×1  4g.24gb ×1

H100-80GB   1g.10gb ×7  1g.10gb+me ×1  1g.20gb ×4  2g.20gb ×3
            3g.40gb ×2  4g.40gb ×1     7g.80gb ×1

H200-141GB  1g.18gb ×7  1g.18gb+me ×1  1g.35gb ×4  2g.35gb ×3
            3g.71gb ×2  4g.71gb ×1     7g.141gb ×1

B200-180GB  1g.23gb ×7  1g.23gb+me ×1  1g.45gb ×4  2g.45gb ×3
            3g.90gb ×2  4g.90gb ×1     7g.180gb ×1
```

`+me` 表示该实例额外带 media engine(一张卡上只能有一个实例带),不带 `+me` 的是纯计算实例。

**同一个形状在不同型号上名字不同**:同样是「七分之一」,A100-40GB 叫 `1g.5gb`,A100-80GB 与 H100-80GB 叫 `1g.10gb`,H200 叫 `1g.18gb`。所以 `nvidia.com/mig-1g.10gb` 这个资源名在 A100-80GB 与 H100-80GB 上都有,在 A100-40GB 上**不存在** —— 照抄别人的 YAML 前先确认自己卡的型号。

### Kubernetes 里的资源名:mig-strategy 决定一切

device plugin 通过 `--mig-strategy`(Helm 值 `migStrategy`,取值 `none` / `single` / `mixed`,默认 `none`)决定把什么暴露给调度器:

```shell
none     只暴露 nvidia.com/gpu,枚举整卡。开着 MIG 也不识别
single   【仍然是】nvidia.com/gpu —— 只是语义从「整卡」变成「MIG 实例」,
         数量 = 该节点可调度的 MIG 设备总数。nvidia.com/mig-* 完全不存在。
         要求节点上所有 GPU 同型号、都已开 MIG、且几何完全一致
mixed    未开 MIG 的整卡 → nvidia.com/gpu
         每个 MIG 设备      → nvidia.com/mig-<切片数>g.<显存>gb
```

**「开了 MIG 之后 `nvidia.com/gpu` 就消失了」是一个流传很广的错误说法。** 准确的说法是:

- `single` 策略下 `nvidia.com/gpu` 依然存在,只是它现在代表 MIG 实例;
- `mixed` 策略下,只有**全部 GPU 都开了 MIG** 时节点上才完全没有 `nvidia.com/gpu`;只要还有一张整卡,它就在。

`mixed` 策略下还有一个硬限制:**一个容器一次只能请求一种设备类型**。不能同时写 `nvidia.com/gpu` 和 `nvidia.com/mig-3g.20gb`;同类可以请求多个,但如果请求了多种类型,拿到哪个设备是未定义的。

### 用 GPU Operator 的 MIG Manager 配置(推荐)

开启 MIG Manager 后,配置 MIG 的方式就是**改节点标签**,不需要登机器:

```shell
# 1. 确认 MIG Manager 已启用(安装或升级时打开)
helm upgrade gpu-operator nvidia/gpu-operator -n gpu-operator \
  --set migManager.enabled=true \
  --set mig.strategy=mixed

# 2. 给节点打标签,请求想要的几何
kubectl label node gpu-node-1 nvidia.com/mig.config=all-1g.10gb --overwrite

# 3. 观察状态标签的流转
kubectl get node gpu-node-1 -o jsonpath='{.metadata.labels}' | jq .
#   nvidia.com/mig.config.state: pending → (rebooting) → success / failed
```

两个标签分工明确:

```shell
nvidia.com/mig.config         请求的配置名(输入)
nvidia.com/mig.config.state   进度与结果(输出):pending / rebooting / success / failed
```

`nvidia.com/mig.config` 的合法取值来自 mig-parted 的 ConfigMap,官方内置的有:

```shell
all-disabled    所有 GPU 关闭 MIG(启用 MIG Manager 后的默认值)
all-enabled     所有 GPU 开启 MIG,但不指定几何
all-1g.10gb     所有 GPU 切成该 profile 的最大数量
all-3g.40gb     同上,换成 3g 切片
all-balanced    按型号给一组混合几何(如 H100-80GB:2×1g.10gb + 1×2g.20gb + 1×3g.40gb)
custom-mig      自定义配置名,在自建 ConfigMap 里定义
```

注意 **`single` 不是这里的取值**,它是 `mig.strategy` 的取值,两者经常被混为一谈。

配置来源是一个 mig-parted 格式的 ConfigMap:

```shell
apiVersion: v1
kind: ConfigMap
metadata:
  name: custom-mig-config
  namespace: gpu-operator
data:
  config.yaml: |-
    version: v1
    mig-configs:
      custom-mig:
        - devices: all
          mig-enabled: true
          mig-devices:
            "1g.10gb": 4
            "2g.20gb": 1
      all-disabled:
        - devices: all
          mig-enabled: false
```

**ConfigMap 里必须有一个名为 `config.yaml` 的键**,这是 MIG Manager 的硬性要求。自建 ConfigMap 通过 ClusterPolicy 引用:

```shell
kubectl patch clusterpolicies.nvidia.com/cluster-policy -n gpu-operator --type merge \
  -p '{"spec":{"migManager":{"config":{"name":"custom-mig-config"}}}}'
```

配置成功后,节点上会出现几何标签,可以用它们做调度约束:

```shell
nvidia.com/gpu.count          节点上的 GPU 数
nvidia.com/gpu.slices.gi      GPU instance 总数
nvidia.com/gpu.slices.ci      Compute instance 总数
nvidia.com/mig-1g.10gb.count  某个 profile 的实例数
```

新版本(v26.3.0+)的 MIG Manager 会通过 NVML 从硬件读取几何并**自动为每个节点生成 `<node-name>-mig-config`**;老驱动(如 535 分支)在 MIG 关闭时查不到信息,会回退到静态的 `default-mig-parted-config`。

### 手工配置(不开 MIG Manager 时)

不开 MIG Manager 就只能自己登机器切:

```shell
# 1. 开启 MIG 模式(Ampere 会触发 GPU reset,需要先停掉所有占用进程)
sudo nvidia-smi -i 0 -mig 1

# 2. 创建 GPU instance 与 compute instance
#    建议先清空已有几何,再按 profile 创建
sudo nvidia-smi mig -i 0 -dci
sudo nvidia-smi mig -i 0 -dgi
sudo nvidia-smi mig -i 0 -cgi 1g.10gb,1g.10gb,1g.10gb -C

# 3. 确认结果
nvidia-smi -L
nvidia-smi mig -lgip        # 列出可用的 profile
nvidia-smi mig -lgi         # 列出已创建的 GPU instance
```

创建/销毁实例默认需要 root;切换 MIG 模式需要 `CAP_SYS_ADMIN`。手工切完之后还要重启 device plugin,否则它不会感知到新的几何。

### Pod 里请求 MIG 设备

`mixed` 策略下直接按资源名请求:

```shell
apiVersion: v1
kind: Pod
metadata:
  name: mig-inference
spec:
  containers:
    - name: app
      image: nvcr.io/nvidia/pytorch:latest
      resources:
        limits:
          nvidia.com/mig-3g.20gb: 1     # 资源名随 GPU 型号而变
        requests:
          nvidia.com/mig-3g.20gb: 1
```

`single` 策略下请求 `nvidia.com/gpu`,并配合 GFD 写出的 product 标签选型号:

```shell
spec:
  nodeSelector:
    nvidia.com/gpu.product: A100-SXM4-40GB-MIG-3g.20gb
  containers:
    - name: app
      image: nvcr.io/nvidia/pytorch:latest
      resources:
        limits:
          nvidia.com/gpu: 1
```

确认容器里拿到的是哪一个实例:

```shell
kubectl exec -it mig-inference -- nvidia-smi -L
# GPU 0: A100-SXM4-40GB (UUID: GPU-4200ccc0-2667-d4cb-9137-f932c716232a)
#   MIG 1g.5gb Device 0: (UUID: MIG-GPU-4200ccc0-.../7/0)

kubectl exec -it mig-inference -- env | grep -i visible
kubectl exec -it mig-inference -- nvidia-smi -L | grep MIG
```

容器是**通过 `NVIDIA_VISIBLE_DEVICES` 拿到 MIG 设备的**(由 nvidia-container-toolkit 注入,格式可以是 `MIG-<GPU-UUID>/<GI ID>/<CI ID>` 或 `MIG-<UUID>`),不是靠 `CUDA_VISIBLE_DEVICES` 来选择设备 —— 后者虽然也接受 MIG 形式,但设备选择发生在更底层。

### 常用操作

```shell
# 看节点的 MIG 几何标签
kubectl get nodes -l nvidia.com/mig.config.state=success -o custom-columns=\
NAME:.metadata.name,CONFIG:.metadata.labels.nvidia\.com/mig\.config

# 看节点上暴露了哪些 MIG 资源
kubectl describe node gpu-node-1 | grep -A20 "Capacity"
kubectl get node gpu-node-1 -o json | jq '.status.capacity | with_entries(select(.key|test("nvidia")))'

# MIG Manager 日志
kubectl logs -n gpu-operator ds/nvidia-mig-manager --tail=100

# validator(校验节点是否配置正确)
kubectl logs -n gpu-operator -l app=nvidia-operator-validator --tail=50
```

### 注意

1. **`nvidia.com/gpu` 在 MIG 下不一定消失**。`single` 策略下它就是 MIG 实例的总数;`mixed` 策略下未开 MIG 的整卡仍然用它。写文档或做容量规划时别想当然。
2. **资源名随 GPU 型号变化**。A100-40GB 有 `nvidia.com/mig-1g.5gb`,H100-80GB 没有;H100-80GB 有 `nvidia.com/mig-1g.10gb`,A100-40GB 没有。跨型号复用的清单一定会踩这个坑。
3. **`single` 是 `mig.strategy` 的取值,不是 `nvidia.com/mig.config` 的取值**。后者用的是 `all-1g.10gb`、`all-balanced` 这类名字,填 `single` 会一直停在 `failed`。
4. **重配置会杀掉 GPU 上的所有 Pod**。MIG Manager 明确要求「被配置的 GPU 上不能有用户负载」,变更标签后它会主动停掉 device plugin、GFD、DCGM exporter 等 Pod,预装驱动场景下还会停掉宿主上的 DCGM/NVSM 服务。正确姿势是先 cordon(必要时 drain)节点,改标签,等 `state` 变成 `success` 再放业务进来。
5. **Ampere 与 Hopper 的 MIG 模式语义相反,这是最容易记反的一条**。A100/A30 开 MIG 需要 **GPU reset**(会让占用设备的进程全部失败),但 MIG 模式**跨系统重启持久**保存在 InfoROM 里;H100/H200/B200 开 MIG **不需要 reset**,但 MIG 模式**不跨重启持久**,卸载/重载内核模块就会关掉它。
6. **几何本身不跨重启持久**。无论哪一代,reset 或重启之后 GPU instance / compute instance 都要重建 —— 这正是用 MIG Manager(或 mig-parted)做自动化而不是手工 `nvidia-smi mig -cgi` 的原因。
7. **MIG 实例默认是独占的**。每个 MIG 设备按标准 device plugin 语义分配给一个容器;想让多个 Pod 共用一个 MIG 实例,必须在 `nvidia.com/mig-*` 资源上**再叠加 time-slicing** —— 官方明确说 mixed 策略产生的这些资源名是可以做 time-slicing 的。
8. **NCCL 不支持 MIG**。官方 MIG 文档写得很直接:「NCCL is currently not supported with MIG.」多卡集合通信训练不要指望跑在 MIG 实例上,这是选型时的硬约束。
9. **跨卡 P2P / NVLink 不可用**。R570 驱动起,同一张 GPU 上不同 MIG 实例之间的 P2P 可用,但**跨 GPU 的 MIG 实例之间、以及 MIG 实例与非 MIG 设备之间都不支持** P2P。CUDA IPC 同理:跨 GPU instance 不支持,跨 compute instance 支持。
10. **Profiling 与图形 API 受限**。共享 GPU 资源不支持 profiling(`DCGM_FI_PROF_*` 那类指标在这种场景下拿不到);除 RTX PRO 6000 Blackwell 的部分 profile 外,不支持 OpenGL/Vulkan 等图形 API。
11. **`NVIDIA_MIG_CONFIG_DEVICES` / `NVIDIA_MIG_MONITOR_DEVICES` 不是 device plugin 的参数**。它们属于 NVIDIA Container Runtime/Toolkit 的 OCI 环境变量,分别用于允许容器内**管理** MIG 配置和**监控** MIG 聚合信息,都需要 `CAP_SYS_ADMIN`。device plugin 的 Helm chart 在 MIG 策略非 `none` 时会自动注入 `NVIDIA_MIG_MONITOR_DEVICES=all`,但那是 chart 的行为,别把这些变量写成插件的 flag。
12. **MIG 分区不能被邻居借用**。这是硬件切分的代价:一个 3g 分区空闲时,它的 SM 与显存无法被同卡上忙碌的 1g 分区使用。追求利用率最大化应该用 time-slicing,追求隔离性与稳定性才用 MIG。
13. **一个容器一次只能有一种设备类型**(`mixed` 策略)。同时请求整卡与 MIG 实例会被拒绝;请求了多种 MIG 类型时,拿到哪个实例是未定义的。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `gpu-operator` — 提供MIG Manager,声明式配置MIG几何
- `nvidia-device-plugin` — 决定MIG资源以什么名字暴露
- `gpu-time-slicing` — 软件层共享,可与MIG叠加
- `dcgm-exporter` — MIG实例有独立UUID,指标可按实例采集
- `node` — 节点标签是MIG配置的入口
- `taints-tolerations` — GPU节点通常带污点,避免普通负载占用

### 参考链接

- [MIG User Guide](https://docs.nvidia.com/datacenter/tesla/mig-user-guide/latest/index.html)
- [支持 MIG 的 GPU 列表](https://docs.nvidia.com/datacenter/tesla/mig-user-guide/latest/supported-gpus.html)
- [各型号的 MIG Profile 列表](https://docs.nvidia.com/datacenter/tesla/mig-user-guide/latest/supported-mig-profiles.html)
- [MIG 的应用与部署限制](https://docs.nvidia.com/datacenter/tesla/mig-user-guide/latest/deployment-considerations.html)
- [GPU Operator 的 MIG Manager](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/gpu-operator-mig.html)
- [NVIDIA MIG in Kubernetes](https://docs.nvidia.com/datacenter/cloud-native/kubernetes/latest/index.html)
- [mig-parted 项目](https://github.com/NVIDIA/mig-parted)
