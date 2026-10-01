openebs
===

CNCF沙箱的容器原生存储项目,提供本地卷与复制卷两类引擎

## 补充说明

**OpenEBS** 是 **CNCF 沙箱项目**,定位是「为 Kubernetes 而生的容器原生存储」。它与 Longhorn、Rook 的最大区别在于**它不是一套存储,而是一组可选引擎的集合**:每个引擎对应一类存储需求,可以按工作负载分别选用,互不干扰。

当前版本线为 **v4.x**(v4.6.x 系列),架构上把能力收敛为两个核心服务:

```shell
Local       本地卷。数据只存在于单个节点,不做副本。容量大、延迟低、无冗余。
            包含 Hostpath、LVM、ZFS、Rawfile 四种实现。
Replicated  复制卷。以 Mayastor 为唯一实现,基于 NVMe-oF TCP 跨节点复制,有副本冗余。
```

这条边界要记牢:**只有 Mayastor 提供冗余**,其余引擎都是本地卷,节点故障即数据不可用。很多人以为「装了 OpenEBS 就有高可用」,这是最常见的误解。

**历史包袱提醒**:早期广泛使用的 **cStor** 与 **Jiva** 两个引擎已于 **2024 年 4 月**被废弃,相关仓库迁入 CNCF 名下的 `openebs-archive` 组织并逐步归档。它们仍能从归档仓库安装到老集群上,但**不在新 Helm chart 中提供,也不推荐用于任何新部署**。看到基于 cStor 的教程时,应当直接跳过。

### 引擎一览

```shell
引擎              类型      冗余   调度约束        典型场景
Local PV Hostpath 本地卷    无     节点亲和        开发测试、单节点、缓存
Local PV LVM      本地卷    无     节点亲和        需要快照/克隆的本地块设备
Local PV ZFS      本地卷    无     节点亲和        需要压缩、去重、校验和的场景
Local PV Rawfile  本地卷    无     节点亲和        基于文件的卷,支持 CoW 快照/克隆
Mayastor          复制卷    有     跨节点复制      需要高可用的数据库、有状态服务
```

### 环境要求

```shell
# 所有引擎通用
Kubernetes 1.23 及以上、Linux 内核 5.15 及以上、Helm 3.2 及以上

# Local PV Hostpath:仅需一个可写的目录(默认 /var/openebs/local)

# Local PV LVM:节点需装 LVM2,并加载 dm-snapshot 模块,预先建好卷组
sudo apt-get install -y lvm2 && sudo modprobe dm-snapshot
sudo pvcreate /dev/sdb && sudo vgcreate lvmvg /dev/sdb

# Local PV ZFS:节点需装 ZFS 工具并预先建好池
sudo apt-get install -y zfsutils-linux
sudo zpool create zfspv-pool /dev/sdb

# Mayastor:要求最高,详见下一节
```

### 安装

```shell
helm repo add openebs https://openebs.github.io/openebs && helm repo update

# 默认安装:Hostpath + LVM + ZFS + Replicated(Mayastor)
helm install openebs --namespace openebs openebs/openebs --create-namespace

# 只要本地卷,不装 Mayastor(推荐的轻量用法)
helm install openebs --namespace openebs openebs/openebs --create-namespace \
  --set engines.replicated.mayastor.enabled=false

# 额外启用 Rawfile 引擎(默认关闭)
helm install openebs --namespace openebs openebs/openebs --create-namespace \
  --set engines.local.rawfile.enabled=true

# 非标准发行版必须覆盖 kubelet 目录
# --set lvm-localpv.lvmNode.kubeletDir=/var/lib/k0s/kubelet/
# --set zfs-localpv.zfsNode.kubeletDir=/var/lib/k0s/kubelet/
# --set mayastor.csi.node.kubeletDir=/var/lib/k0s/kubelet/

kubectl get pods -n openebs && kubectl get storageclass
```

常见发行版的 kubelet 目录:标准 kubeadm 为 `/var/lib/kubelet/`,MicroK8s 为 `/var/snap/microk8s/common/var/lib/kubelet/`,k0s 为 `/var/lib/k0s/kubelet/`,RancherOS 为 `/opt/rke/var/lib/kubelet/`。

### Mayastor 的额外要求

Mayastor 是唯一提供冗余的引擎,也是要求最高的一个:

```shell
# 1. 大页内存:每个存储节点预留 2GiB 的 2MiB 大页
echo 1024 | sudo tee /sys/kernel/mm/hugepages/hugepages-2048kB/nr_hugepages
grep HugePages /proc/meminfo           # 期望 HugePages_Total: 1024
echo "vm.nr_hugepages = 1024" | sudo tee -a /etc/sysctl.conf

# 2. 加载内核模块(高可用场景可启用 nvme_core.multipath=Y)
sudo modprobe nvme-tcp

# 3. 修改大页数量后必须重启 kubelet 或重启节点
sudo systemctl restart kubelet

# 4. 给存储节点打标签,Mayastor 只会调度到这些节点上
kubectl label node node1 openebs.io/engine=mayastor

lsblk -f                               # 5. 准备专用裸盘,不能有文件系统、不能被挂载
```

每个 io-engine 节点需要**独占 2 个 CPU 核心与 1GiB 内存**,并要求 CPU 支持 SSE4.2。涉及端口:`10124`(Mayastor gRPC)、`8420` 与 `4421`(NVMe-oF target),防火墙必须放行节点间通信。存储节点至少 3 个。

创建 DiskPool 把裸盘交给 Mayastor:

```shell
apiVersion: openebs.io/v1beta2
kind: DiskPool
metadata:
  name: pool-on-node1
  namespace: openebs
spec:
  node: node1
  disks:
    - "aio:///dev/sdb"        # 块设备写 /dev/sdb,文件用 aio:// 前缀
```

### 各引擎的 StorageClass

Hostpath 的类由 chart 自动创建,名字固定为 `openebs-hostpath`,provisioner 为 `openebs.io/local`。LVM 与 ZFS 的类需要自行创建(前提是节点上已建好 VG / pool):

```shell
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: openebs-lvmpv
provisioner: local.csi.openebs.io
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
parameters:
  storage: "lvm"
  volgroup: "lvmvg"            # 或 vgpattern: "lvmvg.*"
  fsType: "ext4"
  thinProvision: "yes"
```

```shell
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: openebs-zfspv
provisioner: zfs.csi.openebs.io
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
parameters:
  poolname: "zfspv-pool"
  fstype: "zfs"                # 用 zfs 建 dataset,或填 ext4/xfs/btrfs 建 ZVOL
  compression: "lz4"
  recordsize: "128k"
```

Mayastor 的类在 DiskPool 就绪后由 chart 创建,名字形如 `openebs-single-replica`(provisioner `io.openebs.csi-mayastor`)。生产环境应另建多副本的类:

```shell
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: mayastor-3
provisioner: io.openebs.csi-mayastor
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
parameters:
  repl: "3"                    # 副本数,不能超过 io-engine 节点数
  protocol: "nvmf"
  ioTimeout: "30"
```

### 使用

```shell
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: app-data
spec:
  storageClassName: openebs-hostpath
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
```

### 升级与卸载

```shell
helm repo update && helm get values openebs -n openebs > openebs-values.yaml
helm upgrade openebs openebs/openebs -n openebs -f openebs-values.yaml
kubectl -n openebs get pods -w && kubectl get diskpools -n openebs
```

```shell
kubectl get pvc -A | grep -E "openebs|mayastor"    # 1. 确认数据不再需要
helm uninstall openebs -n openebs                  # 2. 卸载 chart

kubectl get crd | grep openebs | awk '{print $1}' | xargs kubectl delete crd   # 3. 删 CRD
# 注意:这会连带删除所有 DiskPool 等自定义资源

# 4. 节点侧残留(危险,确认后再执行)
ls -l /var/openebs/local/        # Hostpath 数据
sudo vgs && sudo vgremove lvmvg  # LVM 残留
sudo zpool destroy zfspv-pool    # ZFS 残留
sudo wipefs -a /dev/sdb          # Mayastor 磁盘残留
```

### 排障

```shell
kubectl -n openebs get pods                                   # 1. 各引擎的 Pod 是否都起来了
kubectl -n openebs get pods | grep -E "mayastor|lvm|zfs|localpv"

kubectl describe pvc app-data                                 # 2. PVC 一直 Pending
kubectl -n openebs logs deploy/openebs-localpv-provisioner --tail=100
kubectl -n openebs logs deploy/openebs-lvm-localpv-controller --tail=100
kubectl -n openebs logs deploy/openebs-zfs-localpv-controller --tail=100

kubectl -n openebs get diskpools                              # 3. Mayastor 专用
kubectl -n openebs describe diskpool pool-on-node1
kubectl -n openebs logs daemonset/mayastor-io-engine --tail=100

grep HugePages /proc/meminfo && lsmod | grep -E "nvme_tcp|vfio"   # 4. 大页与内核模块
kubectl get nodes -l openebs.io/engine=mayastor                   # 5. 节点标签
```

### 注意

1. **只有 Mayastor 提供副本冗余,其余引擎都是本地卷**。Hostpath / LVM / ZFS / Rawfile 的数据只存在于单个节点上,节点故障数据即不可用。选错引擎会让「装了高可用存储」变成一句空话,先用 `kubectl get storageclass` 确认业务到底落在哪个类上。
2. **cStor 与 Jiva 已于 2024 年 4 月废弃并迁入 `openebs-archive`**。它们不在新 chart 里,也不会有新修复。老集群可以继续跑,但新部署一律不要使用。
3. **Mayastor 依赖大页内存,且改完必须重启 kubelet**。大页数量不足时 io-engine 会启动失败,而报错信息通常不会直接说「大页不够」。每节点预留 2GiB 的 2MiB 大页是官方要求的下限。
4. **Mayastor 需要 `nvme-tcp` 内核模块与专用裸盘**。磁盘上存在文件系统、分区表或 LVM 残留时 DiskPool 无法上线;内核模块没加载则卷无法挂载到业务节点。上线前用 `lsblk -f` 和 `lsmod` 逐节点确认。
5. **Mayastor 的副本数不能超过 io-engine 节点数**,且官方要求存储节点至少 3 个。3 副本跑在 2 个节点上不会报错,只会一直处于降级状态,和 Longhorn 的坑完全一致。
6. **Local PV Hostpath 的默认目录是 `/var/openebs/local`**,数据不会随 Pod 迁移,节点故障即丢失 —— 与 `local-path-provisioner` 是同一类风险。它只是比裸 `hostPath` 多了动态供给与目录隔离。
7. **LVM 与 ZFS 引擎要求节点上预先建好 VG 或 pool**。没有 `lvmvg` 却写了 `volgroup: lvmvg`,PVC 只会一直 Pending。如果用了 `vgpattern` 而节点上没有匹配的 VG,同样静默失败。
8. **chart 会一次性创建多个 StorageClass,其中还有给 Mayastor 内部依赖(etcd、Loki)用的 `mayastor-etcd-localpv` 与 `mayastor-loki-localpv`**。这些是支撑用类,不要误设为集群默认类,更不要让业务 PVC 落到上面。
9. **卸载时 CRD 与磁盘残留必须一起清理**。残留的 LVM VG、ZFS dataset、Mayastor 磁盘标签会让下次部署在同一批盘上失败;反过来,误删 CRD 会连带删除所有 DiskPool 等自定义资源,该操作不可回滚。
10. **非标准发行版必须设置 `kubeletDir`**。MicroK8s、k0s、RKE 等把 kubelet 目录放在非默认位置,不覆盖 `lvm-localpv.lvmNode.kubeletDir` 等参数,CSI node 插件会挂载到错误路径,卷挂载失败。
11. **ZFS 引擎在部分发行版上有许可证与内核兼容性的顾虑**(ZFS 为 CDDL,Linux 内核为 GPL),选用前确认目标发行版是否官方支持并预编译了模块。内核升级后 DKMS 重建失败会导致整个节点上的 ZFS 卷不可用。
12. **各引擎的扩容支持程度不同**。Hostpath 不支持在线扩容,LVM/ZFS/Mayastor 通常支持但需要 StorageClass 上开启 `allowVolumeExpansion`。用错引擎会让「数据库磁盘不够了」变成一次停机迁移。
13. **Local PV 类的 StorageClass 必须使用 `volumeBindingMode: WaitForFirstConsumer`**。本地卷有节点拓扑约束,`Immediate` 会让 PV 在先于 Pod 调度时被创建到随机节点上,随后 Pod 无法挂载。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `csi` — OpenEBS 各引擎均以 CSI 驱动形式接入
- `storageclass` — 选择具体使用哪个 OpenEBS 引擎
- `pvc` — 向 OpenEBS 申请存储
- `longhorn` — 同为分布式块存储,提供更简单的副本方案
- `rook` — 功能更完整的分布式存储编排
- `local-path-provisioner` — 更轻量的本地目录供给器

### 参考链接

- [OpenEBS 官方文档](https://openebs.io/docs)
- [OpenEBS 安装指南](https://openebs.io/docs/main/quickstart-guide/installation)
- [OpenEBS 前置条件](https://openebs.io/docs/main/quickstart-guide/prerequisites)
- [Mayastor 文档](https://openebs.io/docs/main/user-guides/replicated-storage-user-guide/replicated-pv-mayastor/rs-installation)
- [本地存储用户指南(LVM/ZFS/Hostpath)](https://openebs.io/docs/main/user-guides/local-storage-user-guide)
