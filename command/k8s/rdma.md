rdma
===

在Kubernetes中为Pod提供RDMA高速网络(InfiniBand/RoCE)访问

## 补充说明

**RDMA**(Remote Direct Memory Access)让一台机器直接读写另一台机器的内存,绕过 CPU 与内核协议栈。在 AI 训练与 HPC 场景里,它决定了多机通信是不是瓶颈 —— 没有 RDMA,多机 all-reduce 基本跑不出应有的速度。

在 Kubernetes 里用 RDMA 要同时解决三件事:**宿主机可用**(RDMA 子系统与 `/dev/infiniband` 就绪)、**网络可达**(靠 Multus + CNI 把网卡送进 Pod)、**资源可调度**(设备以 `rdma/<name>` 扩展资源暴露)。

主流有**两条互斥的路线**:

```shell
共享设备插件      Mellanox/k8s-rdma-shared-dev-plugin
                把同一块 HCA 以 rdma/<name> 的形式共享给多个 Pod
                要求宿主 RDMA 子系统处于 shared 模式
                适合:IPoIB、Macvlan 等共享网络模型

SR-IOV + rdma-cni  k8snetworkplumbingwg/rdma-cni
                 每个 Pod 分到一个 VF,RDMA 设备做网络命名空间隔离
                 要求 RDMA 子系统处于 exclusive 模式
                 依赖:Multus + SR-IOV CNI + SR-IOV Device Plugin
                 适合:需要隔离的多租户或高性能场景
```

**两者对宿主 RDMA 子系统的模式要求相反,不能在同一节点上混用** —— 共享设备插件在启动时若发现模式不是 `shared` 会直接 fatal 退出,而 rdma-cni 必须用 `exclusive`。两个仓库都活跃维护、均未归档,也没有弃用公告:共享设备插件最新 **v1.5.4(2026-07-28)**,rdma-cni 最新 **v1.6.0(2026-02-15)**。

### 宿主机需要准备什么

```shell
内核模块(RDMA 子系统)可用;rdma-core 用户态库(inbox 驱动路线)
或 DOCA-OFED 驱动容器(GPU Operator / Network Operator 路线)
内核 >= 5.3.0:RDMA 子系统支持网络命名空间隔离的前提
用 MLNX_OFED >= 4.7 可以绕开这个内核要求
```

**MLNX_OFED 已经改名,这是一个容易踩空的时间点**:NVIDIA 于 2024-10 宣布转向 **DOCA-OFED**,它是 MLNX_OFED 的 1:1 替代品,以内置 profile(`doca-ofed`)的形式存在于统一的 DOCA-Host 包里。最后一个独立的 MLNX_OFED 版本停在 2024-10,新功能只进 DOCA-OFED,缺陷与安全修复支持到 **2027-10** 之后 EOL。MLNX_EN 同步停更,ConnectX-4 的支持也已在 DOCA-OFED 2.10.0 中移除。

对应的 Operator 字段是 `ofedDriver`,镜像是 `doca-driver`(例如 `doca3.5.0-26.07-0.7.7.0-0`,来自 `nvcr.io/nvidia/mellanox`)。照着老文档找 `MLNX_OFED` 版本号会找不到对应制品。

### 路线一:共享设备插件

配置是一个**普通 JSON**(没有 `apiVersion`,没有 `kind`),放在 ConfigMap **`rdma-devices`** 的 **`config.json`** 键里,命名空间 `kube-system`:

```shell
{
  "periodicUpdateInterval": 300,
  "configList": [
    {
      "resourceName": "hca_shared_devices_a",
      "resourcePrefix": "rdma",
      "rdmaHcaMax": 1000,
      "selectors": {
        "vendors": ["15b3"],
        "drivers": ["mlx5_core"],
        "linkTypes": ["ether"]
      }
    }
  ]
}
```

字段语义:

```shell
periodicUpdateInterval   秒;0 表示不做周期更新;不填默认 60
resourceName             必填,同一 prefix 下唯一
resourcePrefix           资源前缀,默认 "rdma"
                         完整资源名 = <prefix>/<resourceName>,如 rdma/hca_shared_devices_a
rdmaHcaMax               必填,该资源可被分配的最大次数
devices                  直接列网卡名(如 ["ib0", "ib1"])
selectors                按属性筛选:vendors / deviceIDs / drivers / ifNames / linkTypes
                         selectors 内部各项是 AND,同一项的值之间是 OR
```

`devices` 与 `selectors` 至少要有一个,推荐用 `selectors`(机器换代后不会因为网卡改名而失效)。部署:

```shell
cd deployment/k8s/base && kubectl apply -k .
```

它会创建 DaemonSet `rdma-shared-dp-ds`(命名空间 `kube-system`),特征比较"重":`hostNetwork: true`、**`privileged: true`**、`priorityClassName: system-node-critical`,并把宿主机的 **整个 `/dev/` 挂进容器**(不只是 `/dev/infiniband`),配置挂到 `/k8s-rdma-shared-dev-plugin/config.json`。要开 CDI 模式就用 `deployment/k8s/base/overlay` 这个 overlay。插件默认面向带 `feature.node.kubernetes.io/custom-rdma.available=true` 标签的节点(用 NFD 打)。

工作负载侧只需要**请求扩展资源 + 加 `IPC_LOCK` 能力**:

```shell
apiVersion: v1
kind: Pod
metadata:
  name: rdma-app
spec:
  containers:
    - name: app
      image: <你的镜像>
      securityContext:
        capabilities:
          add: ["IPC_LOCK"]
      resources:
        limits:
          rdma/hca_shared_devices_a: 1
        requests:
          rdma/hca_shared_devices_a: 1
```

`IPC_LOCK` 是必须的 —— 没有它 RDMA 应用拿不到内存锁定的权限;`privileged: true` **不需要**加在业务 Pod 上(那是插件自己 DaemonSet 的需要),设备文件由 device plugin 在分配时注入。不走设备插件的手工方式是把宿主 `/dev/infiniband` 挂进容器再加 `IPC_LOCK`。

### 路线二:SR-IOV + rdma-cni

这条路线靠 Multus 把多个 CNI 插件串起来。rdma-cni 的类型名就叫 **`rdma`**,以链式插件的形式跟在 SR-IOV CNI 后面:

```shell
{
  "cniVersion": "0.3.1",
  "type": "rdma",
  "args": {"cni": {"debug": true}}
}
```

依赖栈是:SR-IOV 网卡 + SR-IOV Network Device Plugin + Multus CNI(≥ v3.4.1)+ SR-IOV CNI(以太网场景)+ rdma-cni。注意 **`isRdma` 不是 NetworkAttachmentDefinition 里的字段**,它写在 **SR-IOV Device Plugin 的 ConfigMap** 里:

```shell
{
  "resourceList": [
    {
      "resourceName": "sriov_rdma",
      "selectors": {
        "vendors": ["15b3"],
        "drivers": ["mlx5_core"],
        "isRdma": true
      }
    }
  ]
}
```

NVIDIA Network Operator 里对应的是 `SriovNetwork` 的 `metaPlugins` 追加 `{"type": "rdma"}`,而 `isRdma` 由 `SriovNetworkNodePolicy` 承载。

**网络命名空间模式必须切到 `exclusive`**:

```shell
rdma system set netns exclusive        # 运行时切换;要求当时没有任何网络命名空间存在

# 永久生效
echo "options ib_core netns_mode=0" >> /etc/modprobe.d/ib_core.conf
```

以太网/RDMA-CM 场景下,Mellanox 卡还需要预先分配 VF 的 MAC 并重新绑定驱动:

```shell
ip link set <pf-netdev> vf <vf-index> mac <mac-address>
echo <vf-pci-address> > /sys/bus/pci/drivers/mlx5_core/unbind
echo <vf-pci-address> > /sys/bus/pci/drivers/mlx5_core/bind
```

支持 ConnectX-4 及以上。**Macvlan + RDMA** 是另一种常见组合,但它走共享设备插件而不是 rdma-cni:先用 Multus 建一个 macvlan 网络,再装共享设备插件,Pod 里同时申请 `rdma/<name>` 并加入该网络。

### RoCE:必须让交换机也配合

RoCEv2 跑在无损以太网上,**PFC 与 ECN 必须端到端配置** —— 只配主机或只配交换机都不会生效;PFC 是逐跳的,链路上任何一跳没配好都会在压力下丢包。

主机侧(NIC):

```shell
mlnx_qos -i <iface>                        # 查看 trust / dscp2prio / PFC / ETS
mlnx_qos -i <iface> --trust dscp           # 信任 DSCP(RoCEv2 的优先级靠它承载)
mlnx_qos -i <iface> --pfc 0,0,0,1,0,0,0,0  # 只在优先级 3 开 PFC
mlnx_qos -i <iface> --dscp2prio set,26,3   # DSCP 26 → 优先级 3
cma_roce_tos -d <rdma-dev> -t 106          # RDMA_CM 使用的 ToS
```

主机侧(ECN):

```shell
echo 1   > /sys/class/net/<iface>/ecn/roce_np/enable/3
echo 1   > /sys/class/net/<iface>/ecn/roce_rp/enable/3
echo 150 > /sys/class/net/<iface>/ecn/roce_np/min_threshold/3    # 单位 KB
```

交换机侧必须与主机侧对齐:

```shell
nv set qos roce && nv config apply         # Cumulus Linux:一条命令打开 lossless RoCE
roce lossless                              # Onyx
```

验证与固化:

```shell
ethtool -S <iface> | grep prio3            # rx_prio3_discards 应长期为 0
ethtool -a <iface>                         # 全局 pause 应为 off(靠 PFC 而非全局流控)
```

**`mlnx_qos` 的配置重启后会丢失**,需要用 systemd unit、NetworkManager dispatcher 或 ifup 脚本固化。RoCE 版本与 GID 表这样查:

```shell
cma_roce_mode -d <dev> -p <port>           # 查看当前是 RoCEv1 还是 v2
cma_roce_mode -d <dev> -p <port> -m 2      # 设为 RoCEv2
show_gids
cat /sys/class/infiniband/<dev>/ports/<port>/gid_attrs/types/<index>
```

### GPUDirect RDMA

让网卡直接读写 GPU 显存,必须加载 **`nvidia_peermem`** 模块(近期的 NVIDIA 驱动会自动加载)。用 GPU Operator 时:

```shell
--set driver.rdma.enabled=true         # 切到传统 nvidia-peermem 模块方案
--set driver.rdma.useHostMofed=true    # 使用宿主机已有的网络驱动(DMA-BUF 路径)
--set driver.kernelModuleType=open     # 驱动分支早于 R570 时需要

kubectl -n gpu-operator logs ds/nvidia-driver-daemonset -c nvidia-peermem-ctr | grep -i peermem
# 期望看到:successfully loaded nvidia-peermem module
```

拓扑对性能影响很大,用 `nvidia-smi topo -m` 检查网卡与 GPU 的位置:同一 PCIe 交换机内(PIX/PXB)最好,跨 NUMA 或跨 socket(PHB/SYS)会明显变慢。官方也提示过,要让 GPUDirect RDMA 达到较优性能,网卡与 GPU 应位于同一个 PCIe IO root complex 下。

### 诊断命令

```shell
ibstat                          # 端口状态
ibv_devinfo                     # 设备详情
rdma link show                  # iproute2 的 rdma 子命令(还有 dev/resource/system 等对象)
rdma system                     # 当前 netns 模式:shared / exclusive
ib_write_bw -d mlx5_0 --report_gbits    # 带宽测试
ib_read_lat -d mlx5_0                   # 延迟测试
lspci -tv | grep -i mellanox    # 拓扑
lsmod | grep -E "mlx5|ib_core|nvidia_peermem"
dmesg | grep -i -E "mlx5|infiniband|roce"
```

### NCCL 相关环境变量

```shell
NCCL_DEBUG=INFO           日志级别 VERSION/WARN/INFO/TRACE
NCCL_IB_DISABLE=1         禁用 IB/RoCE 回落到 IP socket(用于对比排查)
NCCL_IB_HCA=mlx5_0,mlx5_1 指定 HCA;^ 前缀排除;最多 32 个
NCCL_SOCKET_IFNAME=eth0   指定 socket 网口;^ 排除,= 精确匹配
NCCL_IB_GID_INDEX=3       RoCE 模式下的 GID 索引(默认 -1),用 show_gids 确认
NCCL_NET_GDR_LEVEL=PIX    GPUDirect RDMA 的拓扑阈值 LOC/PIX/PXB/PHB/SYS
```

`NCCL_NET_GDR_LEVEL` 在 2.4.0 之前叫 `NCCL_IB_GDR_LEVEL`,**老的整数取值(0-4)已废弃** —— 还在用旧名字的启动脚本不会报错,只是不生效。

### 注意

1. **共享设备插件与 rdma-cni 的 netns 模式要求相反**。前者要求 `shared`(不满足会直接 fatal 退出),后者要求 `exclusive`。同一节点只能选一条路线,切换模式时要保证当时没有网络命名空间存在。
2. **`IPC_LOCK` 能力是业务 Pod 的必需品**。少了它,RDMA 应用会因为无法锁定内存而失败,报错出现在应用层而不是 Kubernetes 层,容易被误判为业务问题。
3. **插件的 DaemonSet 是 privileged 且挂了整个 `/dev/`,但业务 Pod 不需要 privileged**。把 privileged 一起抄进业务清单会带来不必要的权限扩大。
4. **`isRdma` 不在 NetworkAttachmentDefinition 里**,它在 SR-IOV Device Plugin 的 ConfigMap 选择器里。写错位置的现象是「网络通了但 RDMA 设备没进容器」。
5. **RoCE 的 PFC/ECN 要端到端一致**。只配一侧不成立,而且 PFC 是逐跳的 —— 链路上任意一跳缺失都会在压力下丢包,典型现象是「小包测试正常、大流量训练超时」。
6. **`mlnx_qos` 的设置在重启后丢失**,必须固化;否则节点重启后 RoCE 性能会悄无声息地退化。
7. **MLNX_OFED 已进入过渡期**。最后一个独立版本是 2024-10,新功能只进 DOCA-OFED,安全修复支持到 2027-10;新部署直接用 DOCA-OFED,别再把 MLNX_OFED 写进装机流程。
8. **GID 索引选错会导致 RoCE 连不上**。RoCEv1 与 RoCEv2 在 GID 表里各占条目,`NCCL_IB_GID_INDEX` 必须与 `cma_roce_mode` 的设置一致;先 `show_gids` 看清楚再下发。
9. **GPUDirect RDMA 依赖 `nvidia_peermem` 模块,且收益取决于 PCIe 拓扑**。跨 NUMA / 跨 socket 的配置会退化甚至不如普通路径,上线前用 `nvidia-smi topo -m` 确认。
10. **网卡驱动通常不由 Kubernetes 管理**。宿主上的 OFED/DOCA-OFED 版本、内核模块、固件属于集群外的运维事项;编排层只负责把设备暴露给 Pod,排障时要把这两层分开看。
11. **`rdma-cni` 的定位是 SR-IOV 场景**(其 README 自述主要用例是容器化的 SR-IOV 负载)。共享网络模型(IPoIB、Macvlan)请走共享设备插件,不要强行套 rdma-cni。
12. **以太网 RDMA-CM 需要预先分配 VF MAC 并重新绑定驱动**,这一步不做链路起不来,Mellanox 卡上尤其明显。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `multus` — 多网络方案,rdma-cni路线的前提
- `cni` — 容器网络接口规范
- `nvidia-device-plugin` — GPU设备暴露,与GPUDirect配合
- `gpu-operator` — 管理nvidia-peermem与OFED驱动容器
- `node` — NFD标签决定RDMA插件部署在哪些节点
- `daemonset` — RDMA插件以DaemonSet形式运行
- `pod` — 设备注入与能力配置的最小单位

### 参考链接

- [RDMA 共享设备插件](https://github.com/Mellanox/k8s-rdma-shared-dev-plugin)
- [rdma-cni](https://github.com/k8snetworkplumbingwg/rdma-cni)
- [SR-IOV Device Plugin 的 RDMA 文档](https://github.com/k8snetworkplumbingwg/sriov-network-device-plugin/blob/master/docs/rdma/README.md)
- [MLNX_OFED 到 DOCA-OFED 的迁移指南](https://networking-docs.nvidia.com/doca/archive/3-4-0/mlnx_ofed-to-doca-ofed-transition-guide)
- [NVIDIA Network Operator 部署指南](https://docs.nvidia.com/networking/display/kubernetes2670/deployment-guide-kubernetes.html)
- [GPU Operator 的 RDMA 配置](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/gpu-operator-rdma.html)
- [NCCL 环境变量](https://docs.nvidia.com/deeplearning/nccl/user-guide/docs/env.html)
