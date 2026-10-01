gpu-operator
===

NVIDIA官方的GPU节点全套组件管理与生命周期编排Operator

## 补充说明

**NVIDIA GPU Operator** 把「让一个节点具备 GPU 能力」所需的全部组件打包成一个 Operator 管理:驱动、容器工具链、device plugin、特性发现、监控导出器、MIG 管理…… 全部由它部署与升级。它的价值在于**不再需要手工在每个节点上装驱动、配 runtime、装插件**,新增节点只要打上标签就会被自动配置好。

最新版本 **v26.7.0(2026-08-21)**。官方按版本给支持等级:

```shell
26.7.x         Supported
26.3.x         Deprecated
25.10.x 及以下   End of Support
```

升级时按这个表判断目标版本的处境,不要停在已经 End of Support 的分支上。

### 安装

官方文档给出的 Helm 仓库是 **NGC**:

```shell
helm repo add nvidia https://helm.ngc.nvidia.com/nvidia
helm repo update

helm install --wait --generate-name \
  -n gpu-operator --create-namespace \
  nvidia/gpu-operator --version=v26.7.0
```

`https://nvidia.github.io/gpu-operator` 这个地址也能用(同样提供 `gpu-operator` chart),但文档指定的是上面那个。26.7.0 起还提供 OCI 制品:

```shell
helm install --wait gpu-operator -n gpu-operator --create-namespace \
  oci://nvcr.io/nvidia/cloud-native-charts/gpu-operator --version=v26.7.0
```

装好之后会创建一个名为 **`cluster-policy`** 的 `ClusterPolicy` 对象,所有开关都在它上面。

### 组件与开关

Helm 值与 ClusterPolicy 字段是一一对应的(`deployments/gpu-operator/templates/clusterpolicy.yaml`):

```shell
组件                        Helm 值                         ClusterPolicy 字段                默认
driver                     driver.enabled                  spec.driver.enabled              true
container-toolkit          toolkit.enabled                 spec.toolkit.enabled             true
device-plugin              devicePlugin.enabled            spec.devicePlugin.enabled        true
gfd(特性发现)              gfd.enabled                     spec.gfd.enabled                 true
mig-manager                migManager.enabled              spec.migManager.enabled          true
dcgm-exporter              dcgmExporter.enabled            spec.dcgmExporter.enabled        true
cdi                        cdi.enabled                     spec.cdi.enabled                 true
dcgm(独立 hostengine)      dcgm.enabled                    spec.dcgm.enabled                false
node-status-exporter       nodeStatusExporter.enabled      spec.nodeStatusExporter.enabled  false
gds(GPUDirect Storage)     gds.enabled                     spec.gds.enabled                 false
gdrcopy                    gdrcopy.enabled                 spec.gdrcopy.enabled             false
vgpu-manager               vgpuManager.enabled             spec.vgpuManager.enabled         false
sandbox 工作负载            sandboxWorkloads.enabled        spec.sandboxWorkloads.enabled    false
psa                        psa.enabled                     spec.psa.enabled                 false
nfd                        nfd.enabled                     (子 chart)                        true
```

几个容易踩的点:

- **`validator` 没有开关**。它不是 Helm 值也不是 ClusterPolicy 字段,`state-operator-validation` 的状态判断恒为 true —— **validator 一定会被部署**。想排除某个节点,用节点标签 `nvidia.com/gpu.deploy.operator-validator=false`。
- **NFD 的开关是 `nfd.enabled`**,不是 `node-feature-discovery.enabled`(后者是子 chart 的 values 段名)。
- **vGPU、vfio、Kata、sandbox device plugin 这些组件的 `enabled` 默认是 true,但不会部署**,除非同时打开 `sandboxWorkloads.enabled=true` 且节点带上匹配的 `nvidia.com/gpu.workload.config` 标签 —— 这是「两级门控」。
- **Kata 相关已经废弃**:状态判断里 `state-kata-manager` 恒返回 false,官方注释写明对该字段的任何修改都不会被采纳。不要再往 `kataManager` 里写配置。

### CRD

```shell
ClusterPolicy     nvidia.com/v1          clusterpolicies.nvidia.com
NVIDIADriver      nvidia.com/v1alpha1    nvidiadrivers.nvidia.com
GPUCluster        nvidia.com/v1alpha1    gpuclusters.nvidia.com
```

常用的 `ClusterPolicy` 顶层字段(`spec` 下):

```shell
hostPaths{rootFS, driverInstallDir, kubeletRootDir}
operator{runtimeClass, defaultGPUMode, use_ocp_driver_toolkit, metrics.serviceMonitor}
daemonsets{labels, annotations, tolerations, priorityClassName, updateStrategy, podSecurityContext}
mig.strategy                    single | mixed
driver{enabled, kernelModuleType, usePrecompiled, version, repository,
       rdma{enabled, useHostMofed}, upgradePolicy, ...}
toolkit{enabled, installDir}
devicePlugin{enabled, config{name, default}}
dcgmExporter{enabled, config.name, serviceMonitor, ...}
migManager{enabled, config{name, default}}
gfd{enabled}
cdi{enabled, nriPluginEnabled}
sandboxWorkloads{enabled, defaultWorkload, mode}
```

**注意没有顶层的 `nodeSelector` / `tolerations`**,容忍度写在 `spec.daemonsets.tolerations` 下。`driver.kernelModuleType` 取值 `auto`(默认)/ `proprietary` / `open`;旧的 `driver.useOpenKernelModules` 已废弃且被忽略。

查看与修改:

```shell
kubectl get clusterpolicy
kubectl describe clusterpolicy cluster-policy
kubectl get clusterpolicy cluster-policy -o yaml

# 改一个字段(会触发相关组件的滚动重启)
kubectl patch clusterpolicy cluster-policy --type merge \
  -p '{"spec":{"dcgmExporter":{"enabled":false}}}'
```

### 节点选择与已装驱动的场景

节点是否需要被管理,由 NFD 的 PCI 标签 `feature.node.kubernetes.io/pci-10de.present=true` 决定。想单独排除某台机器:

```shell
# 保持驱动不动,只让 Operator 跳过这台机器上的驱动部署
kubectl label node gpu-node-2 nvidia.com/gpu.deploy.driver=false --overwrite

# 干脆跳过全部组件
kubectl label node gpu-node-2 nvidia.com/gpu.deploy.operands=false --overwrite
```

节点**已经装好驱动**时,安装时就要关掉驱动组件:

```shell
helm install --wait --generate-name \
  -n gpu-operator --create-namespace \
  nvidia/gpu-operator --version=v26.7.0 \
  --set driver.enabled=false

# 容器工具链也已装好时,再补一条
# --set toolkit.enabled=false
```

不显式关闭的话,驱动 Pod 的 init 容器会检测到已有的驱动、给节点打上标签,然后**驱动 Pod 自己终止且不再被重建** —— 看起来像「部署失败了」,其实是设计行为。

**就绪判断在 26.x 已改为基于文件**:validator 的 init 容器会在宿主机写 `/run/nvidia/validations/{driver,toolkit,cuda,plugin}-ready`,device plugin 的 DaemonSet 等待其中的 `driver-ready` 与 `toolkit-ready`。所以「设备插件一直不启动」时,应该去看这几个文件,而不是找某个 ready 标签。

```shell
ls -l /run/nvidia/validations/     # 在 GPU 节点上执行
```

### NFD 与 GPU 标签

NFD 是硬依赖(官方原文:「Node Feature Discovery (NFD) is a dependency for the Operator on each node」),chart 默认带 `nfd.enabled=true`,集群里已经有 NFD 时把它关掉。Operator 的 NFD worker 配置里会把 GPU 相关的 PCI class(`02`、`0200`、`0207`、`0300`、`0302`)纳入白名单,并把 `nvidia.com` 加入 `extraLabelNs`。

GFD 随后写出可调度的标签,最常用的几个:

```shell
nvidia.com/gpu.product         型号
nvidia.com/gpu.count           卡数
nvidia.com/gpu.memory          显存(MiB)
nvidia.com/gpu.family          架构家族
nvidia.com/gpu.replicas        共享份数
nvidia.com/gpu.mode            compute | display
nvidia.com/cuda.driver-version.major   驱动主版本(旧的 cuda.driver.major 已废弃)
```

### 前置条件与平台支持

```shell
Kubernetes      1.33 - 1.37
containerd      2.0 - 2.3(或 CRI-O;RHCOS 只支持 CRI-O)
节点系统        Ubuntu 22.04 / 24.04 / 26.04 LTS
                RHEL 8.8 / 8.10、9.2-9.8、10.0-10.2
                Rocky Linux 8.10 / 9.7 / 10.1
                OpenShift / RHCOS 4.18 - 4.22
```

**内核头文件是一个条件性前置条件**:驱动容器需要与当前内核匹配的 `kernel-headers`/`kernel-devel`,如果节点跑的不是最新内核,可能装不上并报 `Could not resolve Linux kernel version`。两条出路:升级内核,或者把归档的软件源挂进去(`driver.repoConfig.configMapName` + `destinationDir`)。**用预编译驱动可以绕开这个问题**(`driver.usePrecompiled=true`):预编译驱动的容器不需要联网下载内核头文件、GCC 工具链与系统包。

容器运行时路径非默认时,用环境变量告诉工具链:

```shell
--set toolkit.env[0].name=CONTAINERD_CONFIG
--set toolkit.env[1].name=CONTAINERD_SOCKET
--set toolkit.env[2].name=RUNTIME_CONFIG_SOURCE
--set toolkit.env[3].name=CONTAINERD_SET_AS_DEFAULT
```

命名空间如果开了 Pod Security Admission,需要放行:

```shell
kubectl label --overwrite ns gpu-operator pod-security.kubernetes.io/enforce=privileged
```

### 常用操作

```shell
# 组件状态总览
kubectl get clusterpolicy cluster-policy -o jsonpath='{.status}' | jq .
kubectl -n gpu-operator get pods

# 驱动构建日志(装不上驱动时看这里)
kubectl -n gpu-operator logs ds/nvidia-driver-daemonset -c nvidia-driver-ctr --tail=200

# validator 的结论
kubectl -n gpu-operator logs -l app=nvidia-operator-validator --tail=100

# 节点上最终暴露的资源
kubectl get nodes -o custom-columns=\
NAME:.metadata.name,GPU:.status.allocatable.nvidia\\.com/gpu

# 卸载(先删 ClusterPolicy 再删 release,否则会留下残留)
kubectl delete clusterpolicy cluster-policy
helm uninstall -n gpu-operator <release-name>
```

### 注意

1. **它管的是节点,不是负载**。Operator 负责让 GPU 可用;Pod 里怎么写 `resources`、怎么选卡是使用方的事。调度层面的排障(资源不够、nodeSelector 选不中)不在 Operator 的日志里。
2. **不要与独立安装的 device plugin、dcgm-exporter、NFD 重复**。Operator 会把它们作为受管组件部署,重复安装会导致设备重复注册或标签互相覆盖。集群里已有 NFD 时先 `--set nfd.enabled=false`。
3. **`--set driver.enabled=false` 是预装驱动场景的关键**。不关的话驱动 Pod 会检测到已有驱动、打完标签就退出,不重建;这个「静默退出」经常被误判为安装失败。
4. **就绪判断看文件而不是标签**。26.x 用 `/run/nvidia/validations/*-ready` 这套文件做门控,老的 `nvidia.com/gpu.driver.ready` 标签**不存在**,照着旧文档找它会一无所获。
5. **`validator` 无法通过开关关闭**,想排除某个节点只能用 `nvidia.com/gpu.deploy.operator-validator=false`。
6. **`migManager.enabled` 默认就是 `true`**,不需要「额外打开」;`mig.strategy` 默认为 `single`。改 MIG 配置是**破坏性**的:被配置的 GPU 上不能有用户负载,变更时 device plugin、GFD、DCGM exporter 都会被停掉。生产环境先 cordon/drain。
7. **内核头文件与内核版本是驱动安装失败的头号原因**。报错通常是 `Could not resolve Linux kernel version`;预编译驱动或归档软件源是两种解法,升级前先确认目标内核在支持列表里。
8. **各组件版本随 Operator 一起升级**。v26.7.0 里带的是 driver 610.57.04(可选 595/580/535)、container-toolkit 1.20.0、device-plugin 0.20.0、dcgm-exporter 4.6.0-4.8.3、NFD 0.19.0、GFD 0.20.0、MIG Manager 0.15.0 等。升级 Operator 等于升级这一整套,**升级窗口要按「会不会重启业务节点上的 GPU 组件」来安排**。
9. **`sandboxWorkloads` 类组件是两级门控**。values 里 `enabled: true` 但没打开 `sandboxWorkloads.enabled` 时它们不会部署,也不是故障。
10. **卸载顺序有讲究**。先删 `ClusterPolicy` 再卸载 Helm release,否则驱动的 DaemonSet 等资源可能残留,后续重装会冲突。卸载驱动组件还会影响正在运行的 GPU 负载,务必安排窗口。
11. **doc 里的 Helm 仓库有两个地址**,`https://helm.ngc.nvidia.com/nvidia`(文档指定)与 `https://nvidia.github.io/gpu-operator`(同样可用)。混用两个仓库名做 `helm upgrade` 会因为 chart 来源不同而报错,固定用一个。
12. **它不替代 Kubernetes 层面的配额与隔离**。GPU 是扩展资源、不可超卖,想做多租户共享要靠 MIG 或 time-slicing,相关配置在 `spec.devicePlugin.config` 与 `spec.migManager.config` 里。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `nvidia-device-plugin` — Operator管理的核心组件之一
- `gpu-mig` — 通过MIG Manager声明式配置MIG
- `gpu-time-slicing` — 通过devicePlugin.config下发共享配置
- `dcgm-exporter` — Operator会一并部署的监控组件
- `crd` — ClusterPolicy是本Operator的核心CRD
- `operator` — Operator模式与调谐循环
- `node` — 节点标签决定哪些组件部署到哪台机器
- `taints-tolerations` — 组件DaemonSet的容忍度配置位置
- `prometheus` — 采集dcgm-exporter指标

### 参考链接

- [GPU Operator 仓库](https://github.com/NVIDIA/gpu-operator)
- [v26.7.0 Release](https://github.com/NVIDIA/gpu-operator/releases/tag/v26.7.0)
- [安装指南](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/getting-started.html)
- [平台支持矩阵](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/platform-support.html)
- [预编译驱动](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/precompiled-drivers.html)
- [内核过旧时的驱动安装](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/install-gpu-operator-outdated-kernels.html)
