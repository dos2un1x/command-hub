nvidia-device-plugin
===

把NVIDIA GPU作为可调度资源暴露给Kubernetes的Device Plugin

## 补充说明

**NVIDIA Device Plugin** 是最基础的 GPU 接入组件:作为 DaemonSet 运行在每个 GPU 节点上,通过 kubelet 的 Device Plugin 接口把 GPU 注册成扩展资源 `nvidia.com/gpu`。**没有它,节点上的 GPU 对 Kubernetes 就是不可见的** —— 调度器不知道节点有卡,Pod 也无法申请。

它同时提供三个相关组件:

```shell
nvidia-device-plugin      主组件,负责设备发现与分配
gpu-feature-discovery     即 GFD,把 GPU 型号、显存、驱动版本写成节点标签
node-feature-discovery    NFD,通用硬件特征发现,GFD 依赖它
```

注意 **GFD 的独立仓库已经归档**,它的开发自 device plugin v0.15.0 起并入了 `k8s-device-plugin` 仓库,由同一个 Helm chart 一起发布。

状态:项目活跃维护,最新版本 **v0.20.0(2026-08-19)**,未归档也无弃用公告。(仓库 README 正文里仍写着「verify that the latest release (v0.17.1)」,这是没跟着改的旧文本;`deployments/static/` 里的清单与 `versions.mk` 都指向 v0.20.0,以它们为准。)

它有两种装法,选一种即可:

```shell
独立部署       直接用 nvidia-device-plugin 的 Helm chart
               GPU 节点少、只想装插件时用

随 GPU Operator 装   Operator 会把它作为受管组件一起部署
                     需要驱动、容器工具链、监控成套时用
```

两套东西**不要同时装**,同一个节点上跑两个 device plugin 会争抢设备注册。

### 安装

```shell
helm repo add nvdp https://nvidia.github.io/k8s-device-plugin
helm repo update

helm upgrade -i nvdp nvdp/nvidia-device-plugin \
  --namespace nvidia-device-plugin \
  --create-namespace \
  --version 0.20.0

kubectl get pods -n nvidia-device-plugin
kubectl get nodes -o json | jq '.items[].status.capacity | with_entries(select(.key|test("nvidia")))'
```

不用 Helm 也可以直接 apply 静态清单:

```shell
kubectl apply -f \
  https://raw.githubusercontent.com/NVIDIA/k8s-device-plugin/v0.20.0/deployments/static/nvidia-device-plugin.yml
```

上游的前置条件(README 原文):NVIDIA 驱动(`~= 384.81`)、`nvidia-docker >= 2.0` 或 `nvidia-container-toolkit >= 1.7.0`、并且 **`nvidia-container-runtime` 已配置为默认的低层运行时**、Kubernetes `>= 1.10`。

### 节点可见性:标签与 DaemonSet

设备要能被调度,需要同时满足两件事:

```shell
1. DaemonSet 在该节点上跑起来了(没有被污点挡住)
2. 节点带有被识别的 GPU 标签
```

**独立部署时,`nvidia.com/gpu.present=true` 这个标签是管理员自己打的。** chart 的 ClusterRole 只有 `nodes: get/list/watch` 权限,没有 `patch`/`update`,它**不会**自动写这个标签 —— 它只把该标签当作 nodeAffinity 的一个条件(与 NFD 的 `feature.node.kubernetes.io/pci-10de.present=true`、`feature.node.kubernetes.io/cpu-model.vendor_id=NVIDIA` 三选一)。**GPU Operator 部署的版本会自动维护这个标签**,与 NFD 的 PCI 标签保持同步。

```shell
# 手工给 GPU 节点打标(独立部署时)
kubectl label node gpu-node-1 nvidia.com/gpu.present=true

# 确认 DaemonSet 有没有被污点挡掉
kubectl -n nvidia-device-plugin get pods -o wide
kubectl describe node gpu-node-1 | grep -A5 Taints
```

默认容忍度只有一条:`nvidia.com/gpu` 这个键 `Exists`,效果 `NoSchedule`。节点上如果还有别的自定义污点,需要自己加 toleration。

### 配置文件

配置文件路径是 **`/config/config.yaml`**(由环境变量 `CONFIG_FILE` 或 `--config-file` 指定,后者没有短参数)。**不是** `/etc/nvidia/k8s-device-plugin/config.yaml`,后一个路径在仓库里根本不存在。

优先级是:**命令行 flag > 环境变量 > 配置文件**。

`version: v1` 的完整结构:

```shell
version: v1
flags:
  migStrategy: "none"            # none | single | mixed
  failOnInitError: true
  nvidiaDriverRoot: "/"          # 容器化驱动场景通常是 /run/nvidia/driver
  deviceDiscoveryStrategy: "auto"   # auto | nvml | tegra
  mpsRoot: ""                    # 使用 MPS 时必填
  gdrcopyEnabled: false
  gdsEnabled: false
  mofedEnabled: false
  plugin:
    passDeviceSpecs: false
    deviceListStrategy: "envvar"    # envvar | volume-mounts | cdi-annotations | cdi-cri
    deviceIDStrategy: "uuid"        # uuid | index
    sharedDevicesAllocationPolicy: "distributed"   # distributed | packed
resources: []                    # 会被忽略,见「注意」
sharing:
  timeSlicing:
    renameByDefault: false
    failRequestsGreaterThanOne: false
    resources:
      - name: nvidia.com/gpu
        replicas: 4              # 必须 >= 2,写 1 会解析失败
  mps:
    renameByDefault: false
    resources:
      - name: nvidia.com/gpu
        replicas: 4
```

`deviceListStrategy` 决定设备信息怎么传给容器:

```shell
envvar            默认。通过 NVIDIA_VISIBLE_DEVICES 环境变量传递
volume-mounts     挂载设备文件,老方式
cdi-annotations   用 CDI 注解,需要 CDI 能力的容器引擎(containerd 1.7+/CRI-O 1.24+)
cdi-cri           走 CRI 原生 CDI 支持
```

选后两者时**不再需要 nvidia-container-runtime**,但仍要有 CDI 能力的引擎和一个 `nvidia` 的 RuntimeClass。

### 常用 flag 与环境变量

```shell
--mig-strategy            $MIG_STRATEGY               none | single | mixed,默认 none
--fail-on-init-error      $FAIL_ON_INIT_ERROR         默认 true
--nvidia-driver-root      $NVIDIA_DRIVER_ROOT         默认 /
--pass-device-specs       $PASS_DEVICE_SPECS          默认 false
--device-list-strategy    $DEVICE_LIST_STRATEGY       默认 envvar
--device-id-strategy      $DEVICE_ID_STRATEGY         默认 uuid
--config-file             $CONFIG_FILE                默认空
--mps-root                $MPS_ROOT                   使用 MPS 时必填
```

`--fail-on-init-error=false` 时,插件初始化失败会**无限阻塞**而不是退出 —— 这是为了保留「Node 上没卡也能部署 DaemonSet」的老行为。想让它在没有 GPU 的节点上快速失败并不断重启,保持默认的 `true`。

### 资源名

```shell
nvidia.com/gpu                          默认。整卡;single MIG 策略下代表 MIG 实例
nvidia.com/gpu.shared                   renameByDefault: true 时的共享池名字
nvidia.com/mig-<切片数>g.<显存>gb       仅 mixed MIG 策略下出现
                                       例如 nvidia.com/mig-1g.5gb、nvidia.com/mig-7g.40gb
```

`nvidia.com/gpu.shared` **不是一个独立的资源类型**,它只是开启 `renameByDefault` 之后给同一个资源换的名字。不开启时,共享与独占共用 `nvidia.com/gpu`,调度侧无法区分。

v0.20.0 修了一个老问题:带后缀的 MIG profile(`-me`、`+me.all`、`+gfx`)以前会被暴露成独立资源,现在不会了。

### 逐节点配置

独立 chart 支持用节点标签选择不同的配置:

```shell
kubectl label node gpu-node-1 nvidia.com/device-plugin.config=time-slicing-config
```

chart 会部署一个 `config-manager` init 容器与 sidecar 监听该标签,变更时向插件进程发 **SIGHUP 热加载**,不重启 Pod。未设置的节点回落到默认配置;标签值不存在时跳过。

### GFD 生成的节点标签

```shell
nvidia.com/gpu.product         型号,如 A100-SXM4-40GB
nvidia.com/gpu.count           卡数
nvidia.com/gpu.memory          显存,单位 MiB
nvidia.com/gpu.family          架构家族
nvidia.com/gpu.machine         整机型号
nvidia.com/gpu.compute.major   计算能力主版本
nvidia.com/gpu.compute.minor   计算能力次版本
nvidia.com/gpu.replicas        共享份数
nvidia.com/gpu.mode            compute | display
nvidia.com/gfd.timestamp       生成时间戳
nvidia.com/mig.strategy        MIG 策略
```

驱动与 CUDA 版本的标签换过名字,老写法仍在但已标注废弃:

```shell
废弃   nvidia.com/cuda.driver.major | .minor | .rev
       nvidia.com/cuda.runtime.major | .minor
现在   nvidia.com/cuda.driver-version.major | .minor | .revision | .full
       nvidia.com/cuda.runtime-version.major | .minor | .full
```

用这些标签做 nodeSelector 时,按 GFD 的版本核对实际存在的键,否则会出现「标签明明有,调度却选不中」。

### 验证与排障

```shell
# 1. 节点上有没有可分配资源
kubectl get node gpu-node-1 -o json | jq '.status.allocatable | with_entries(select(.key|test("nvidia")))'

# 2. 插件日志(最有用)
kubectl -n nvidia-device-plugin logs ds/nvdp-nvidia-device-plugin --tail=100

# 3. 分配是否成功:看 Pod 里的设备
kubectl exec -it gpu-pod -- nvidia-smi -L
kubectl exec -it gpu-pod -- env | grep -i NVIDIA_VISIBLE_DEVICES

# 4. kubelet 侧是否注册成功
kubectl get node gpu-node-1 -o jsonpath='{.status.conditions[?(@.type=="Ready")]}'
journalctl -u kubelet | grep -i deviceplugin | tail

# 5. 直接问 kubelet 要注册列表(需要登节点)
curl -s --unix-socket /var/lib/kubelet/device-plugins/kubelet.sock http://localhost/deviceplugin
```

### 注意

1. **GPU 要「可见」需要两件事同时成立:节点带上正确的 GPU 标签 + device plugin 的 DaemonSet 真的在该节点运行**。独立部署时 `nvidia.com/gpu.present=true` 必须自己打;DaemonSet 被污点挡住时 Pod 是 Pending,节点上自然也没有 `nvidia.com/gpu` 资源。排障时先查这两项,再查卡本身。
2. **配置文件路径是 `/config/config.yaml`**。网上流传的 `/etc/nvidia/k8s-device-plugin/config.yaml` 在官方仓库里不存在,照抄会得到一个「配置没生效但也不报错」的结果。
3. **配置里的顶层 `resources` 段会被静默忽略**。插件启动时会调用 `DisableResourceNamingInConfig`,并打一条 klog 警告(「Customizing the 'resources' field is not yet supported in the config. Ignoring...」),单个资源配置里的 `rename`、`devices` 字段同样无效。**只有 `renameByDefault` 是真正生效的**。写自定义资源名之前先确认版本支持情况。
4. **`replicas` 必须 ≥ 2**。写 `replicas: 1` 会直接解析失败,插件起不来 —— 想要「不共享」就不要配 `sharing` 段,而不是写 1。
5. **共享配置改完必须重启插件**。独立 chart 靠 config-manager 的 SIGHUP 热加载;GPU Operator 部署的版本**不监听 ConfigMap**,必须手工 `kubectl rollout restart`。
6. **`--fail-on-init-error=false` 会让失败的插件无限阻塞**。容器看起来是 Running,但资源一个都不注册,排障时容易误判为「插件正常」。
7. **它不负责装驱动**。驱动、容器工具链、runtime 配置都不在这个组件的职责范围内;容器里跑 `nvidia-smi` 报错时,先确认节点上的驱动与 `nvidia-container-runtime` 是否就绪,而不是看插件日志。
8. **CDI 模式与默认模式的前置条件不同**。`cdi-annotations`/`cdi-cri` 不需要 nvidia-container-runtime 作为默认运行时,但需要 CDI 能力的容器引擎和 `nvidia` RuntimeClass;混用两套假设是常见的启动失败原因。
9. **与 GPU Operator 二选一**。独立装了插件之后再用 Operator 装一遍,两个 DaemonSet 会同时向 kubelet 注册同一批设备,表现为资源数量异常或分配随机失败。
10. **`NVIDIA_MIG_CONFIG_DEVICES` / `NVIDIA_MIG_MONITOR_DEVICES` 不是本插件的参数**。它们属于 NVIDIA Container Toolkit 的环境变量,chart 会在 MIG 策略非 `none` 时替你的容器注入 `NVIDIA_MIG_MONITOR_DEVICES=all`,但不要把它们写成插件的 flag。
11. **GFD 生成的标签是排障与调度的主要依据,但键名在演进**。CUDA/驱动版本的标签已从点分隔改为连字符分隔(`cuda.driver.major` → `cuda.driver-version.major`),写死标签的调度规则在升级 GFD 后可能失效。
12. **节点上没有 GPU 时,DaemonSet 会在所有节点上各起一个 Pod**(除非用 nodeAffinity 限制)。这不是故障,但会浪费少量资源;正规做法是让 NFD 的标签来决定调度范围。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `gpu-operator` — 成套部署时的替代方案,内含本插件
- `gpu-mig` — MIG 策略决定资源如何暴露
- `gpu-time-slicing` — 共享配置由本插件提供
- `dcgm-exporter` — 指标采集,依赖插件暴露的设备
- `daemonset` — 插件以DaemonSet形式运行
- `taints-tolerations` — 插件默认只容忍nvidia.com/gpu污点
- `node` — 节点标签决定调度与配置选择
- `resource-quota` — GPU作为扩展资源不能超卖

### 参考链接

- [k8s-device-plugin 仓库](https://github.com/NVIDIA/k8s-device-plugin)
- [v0.20.0 Release](https://github.com/NVIDIA/k8s-device-plugin/releases/tag/v0.20.0)
- [GFD 生成的标签列表](https://github.com/NVIDIA/k8s-device-plugin/blob/main/docs/gpu-feature-discovery/README.md)
- [CDI 支持](https://github.com/NVIDIA/k8s-device-plugin/blob/main/docs/cdi.md)
- [NVIDIA GPU 在 Kubernetes 中的使用](https://docs.nvidia.com/datacenter/cloud-native/kubernetes/latest/index.html)
