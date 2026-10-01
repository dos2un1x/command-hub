volume-snapshot
===

Kubernetes标准化的卷快照API,用CRD实现PVC的时点快照与恢复

## 补充说明

**VolumeSnapshot** 是 Kubernetes 的卷快照扩展 API,自 **v1.20 起 GA**,API 组为 `snapshot.storage.k8s.io/v1`。它让「给一个 PVC 打个快照,再从快照恢复出一个新 PVC」成为集群的标准能力,而不依赖某个存储厂商自己的私有接口。

它**不是 Kubernetes 核心的一部分**,而是由 **kubernetes-csi** 社区(external-snapshotter 仓库)独立维护的一套 CRD + 控制器。这是最关键的认知:**新建集群不会自带 VolumeSnapshot 能力**,必须单独安装 CRD 与 snapshot-controller,否则 `kubectl apply` 一个 VolumeSnapshot 清单会直接报 `no matches for kind`。

快照能力也不是所有存储都支持。底层驱动的 CSI 实现必须提供 `CreateSnapshot` / `DeleteSnapshot` / `ListSnapshots` 三个 RPC。云盘、Ceph RBD、Longhorn、OpenEBS 等通常支持;而 NFS、`local-path-provisioner`、`hostPath` 这类没有块设备快照原语的方案**不支持**。

当前版本线为 **external-snapshotter v8.x**(v8.5.0 有配套镜像发布,v8.6.0 将 VolumeGroupSnapshot 提升为 GA),v8.x 要求 Kubernetes **v1.25 及以上**。

### 三个 CRD

```shell
VolumeSnapshotClass      集群级,描述「用哪个 CSI 驱动、什么参数、什么删除策略」打快照
VolumeSnapshot           命名空间级,用户发起的快照请求,类似 PVC 的角色
VolumeSnapshotContent    集群级,真正被创建出来的快照实体,类似 PV 的角色
```

三者关系与 PVC/PV 完全对称:`VolumeSnapshot` 是申请单,`VolumeSnapshotContent` 是实体,`VolumeSnapshotClass` 相当于 StorageClass。

### 架构与组件

```shell
snapshot-controller        Deployment,监听 VolumeSnapshot / VolumeSnapshotContent CRD
                          把 VolumeSnapshot 转换成 VolumeSnapshotContent 并负责绑定
csi-snapshotter            sidecar,与 CSI 驱动同 Pod,监听 VolumeSnapshotContent
                          调用驱动 RPC 真正执行 CreateSnapshot / DeleteSnapshot
```

注意 `snapshot-controller` 是**集群级单例**,不属于任何 CSI 驱动,整个集群装一份即可;而 `csi-snapshotter` 是**每个 CSI 驱动各自带一个**(通常打包在 controller 插件的 Pod 里)。

### 安装

```shell
# 1. 克隆仓库(CRD 与控制器都在里面)
git clone https://github.com/kubernetes-csi/external-snapshotter.git
cd external-snapshotter
git checkout v8.5.0

# 2. 安装 CRD(集群级,只需一次)
kubectl create -k client/config/crd

# 3. 安装 snapshot-controller(默认装到 kube-system)
kubectl create -k deploy/kubernetes/snapshot-controller

# 4. 确认
kubectl -n kube-system get pods -l app=snapshot-controller
kubectl get crd | grep snapshot
kubectl api-resources | grep snapshot
```

对应的容器镜像:

```shell
registry.k8s.io/sig-storage/snapshot-controller:v8.5.0
registry.k8s.io/sig-storage/csi-snapshotter:v8.5.0
registry.k8s.io/sig-storage/snapshot-conversion-webhook:v8.5.0
```

**CRD 与控制器的版本必须来自同一次发布**,混用不同版本的 CRD 与控制器会在存储版本(stored version)转换时出问题。集群升级后建议重新执行一次安装步骤,确认控制器仍在运行。

### VolumeSnapshotClass

```shell
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotClass
metadata:
  name: csi-snapclass
  annotations:
    snapshot.storage.kubernetes.io/is-default-class: "true"
driver: rook-ceph.rbd.csi.ceph.com         # 必须与 StorageClass 的 provisioner 同源
deletionPolicy: Delete                     # Delete / Retain
parameters:
  clusterID: rook-ceph
  csi.storage.k8s.io/snapshotter-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/snapshotter-secret-namespace: rook-ceph
```

`driver` 必须与目标卷所属的 CSI 驱动一致 —— 快照是由具体驱动执行的,不能跨驱动。

### 创建快照

```shell
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: app-data-snap-01
  namespace: default
spec:
  volumeSnapshotClassName: csi-snapclass
  source:
    persistentVolumeClaimName: app-data          # 要打快照的 PVC
```

```shell
kubectl apply -f snapshot.yaml

# 观察是否就绪
kubectl get volumesnapshot app-data-snap-01
kubectl get volumesnapshot app-data-snap-01 -o yaml | grep -A5 status
```

`status.readyToUse: true` 才代表快照可用。常用的状态字段:

```shell
status.readyToUse                      快照是否创建完成并可用于恢复
status.restoreSize                     从该快照恢复时所需的最小容量
status.creationTime                    快照的数据时点
status.boundVolumeSnapshotContentName  绑定到的 VolumeSnapshotContent
status.error                           出错时的具体原因
```

### 从快照恢复

```shell
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: app-data-restored
  namespace: default
spec:
  storageClassName: rook-ceph-block
  dataSource:
    name: app-data-snap-01
    kind: VolumeSnapshot
    apiGroup: snapshot.storage.k8s.io
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 20Gi                # 必须 ≥ 快照的 restoreSize
```

```shell
kubectl apply -f restore.yaml
kubectl get pvc app-data-restored -w
```

恢复出来的是一个**全新的、与源卷完全独立**的 PVC,后续对它的读写不会影响快照。

### 预置快照

如果快照已经在存储侧存在(例如由存储管理员手工创建),可以用「预置」方式把它纳管进集群:

```shell
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshotContent
metadata:
  name: snapcontent-preprovisioned
spec:
  deletionPolicy: Retain
  driver: rook-ceph.rbd.csi.ceph.com
  source:
    snapshotHandle: 0001-0009-rook-ceph-0000000000000001-abc123
  volumeSnapshotRef:
    name: imported-snap
    namespace: default
```

对应的 `VolumeSnapshot` **不要写 `source`**,只写 `volumeSnapshotContentName`:

```shell
apiVersion: snapshot.storage.k8s.io/v1
kind: VolumeSnapshot
metadata:
  name: imported-snap
  namespace: default
spec:
  volumeSnapshotClassName: csi-snapclass
  source:
    volumeSnapshotContentName: snapcontent-preprovisioned
```

### 卷组快照

external-snapshotter **v8.6.0** 起,**VolumeGroupSnapshot** 提升为 GA(v1),用于对**同一时点**的多个 PVC 一起打快照 —— 这对「数据库数据卷 + WAL 卷」这类需要一致性的多卷应用非常关键:

```shell
apiVersion: groupsnapshot.storage.k8s.io/v1
kind: VolumeGroupSnapshot
metadata:
  name: app-group-snap
  namespace: default
spec:
  volumeGroupSnapshotClassName: csi-group-snapclass
  source:
    selector:
      matchLabels:
        app: mysql
```

需要在 snapshot-controller 上显式开启 `--enable-volume-group-snapshots`,并且 CSI 驱动本身实现了组快照 RPC(CSI spec v1.11.0 起定义)。

### 常用操作

```shell
# 列出所有快照
kubectl get volumesnapshot -A
kubectl get volumesnapshotcontent

# 查看详情(Events 里有失败原因)
kubectl describe volumesnapshot app-data-snap-01

# 查看快照大小与就绪状态
kubectl get volumesnapshot -A -o custom-columns=\
NS:.metadata.namespace,NAME:.metadata.name,READY:.status.readyToUse,SIZE:.status.restoreSize

# 删除快照(是否连带删除底层快照取决于 VolumeSnapshotClass 的 deletionPolicy)
kubectl delete volumesnapshot app-data-snap-01
```

### 排障

```shell
# 1. 报 no matches for kind "VolumeSnapshot" —— CRD 没装
kubectl get crd | grep snapshot
kubectl create -k client/config/crd

# 2. 快照一直不 readyToUse
kubectl describe volumesnapshot <name>
kubectl get volumesnapshotcontent
kubectl get events -A --field-selector reason=SnapshotCreationFailed

# 3. snapshot-controller 是否在跑
kubectl -n kube-system logs deploy/snapshot-controller --tail=100

# 4. csi-snapshotter sidecar 的日志(真正调用驱动的地方)
kubectl -n rook-ceph logs deploy/csi-rbdplugin-provisioner -c csi-snapshotter --tail=100

# 5. 恢复出来的 PVC 一直 Pending
kubectl describe pvc app-data-restored
#    常见原因:容量小于 restoreSize,或 StorageClass 与快照驱动不一致

# 6. 快照删不掉(finalizer 卡住)
kubectl get volumesnapshotcontent <name> -o yaml | grep finalizers
```

### 注意

1. **VolumeSnapshot 必须单独安装,新集群默认没有**。CRD、snapshot-controller、各驱动的 csi-snapshotter 三样缺一不可。只装了 CRD 而没有控制器时,`kubectl apply` 会安静地成功创建对象,但快照永远停在未就绪状态 —— 比直接报错更难排查。
2. **托管集群的控制面升级可能会清掉手动部署的 snapshot-controller**。它通常装在 `kube-system` 而不是由云厂商托管,集群升级后需要重新确认控制器与 CRD 是否存在。这是生产环境快照突然「失效」的常见原因。
3. **CRD 与控制器必须同版本**。external-snapshotter 在不同版本间调整过存储版本(如 v1beta1 → v1、VolumeGroupSnapshot 的 v1beta2 → v1),版本错配会在转换时出现静默失败或数据无法读取。
4. **快照不等于备份**。快照由底层存储创建,通常与源卷在**同一个存储后端**上:存储集群整体故障、误删存储池、勒索软件加密后端,快照会与源数据一起消失。真正的备份必须复制到独立的存储介质(对象存储、异地集群)。
5. **应用一致性需要应用自己保证**。CSI 快照只保证「块设备的某个时点状态」,不保证数据库事务完整。对 MySQL、PostgreSQL 这类应用,应先用 `fsfreeze` 冻结文件系统、或走应用自身的备份接口(如 `pg_start_backup`),否则恢复出来的实例可能需要长时间崩溃恢复甚至无法启动。
6. **不能跨 CSI 驱动、跨存储类恢复**。快照是由具体驱动在具体存储池上创建的,`dataSource` 恢复时新 PVC 的 StorageClass 必须指向同一驱动。跨驱动迁移只能靠逻辑导出导入。
7. **恢复的 PVC 容量必须 ≥ `status.restoreSize`**。部分驱动的 `restoreSize` 可能为空或小于实际数据量,写小了会导致恢复失败或静默截断。拿不准时宁可写大一些。
8. **`deletionPolicy` 决定了删 `VolumeSnapshot` 时底层快照是否一起删**。`Delete`(常见默认)会连带删除,`Retain` 则保留底层快照并把 `VolumeSnapshotContent` 留在集群里。核心数据的快照建议用 `Retain`,避免误删 `VolumeSnapshot` 对象时把唯一一份快照也带走。
9. **不是所有存储都支持快照**。`local-path-provisioner`、`nfs-provisioner`、`hostPath` 这类方案没有快照原语,创建 `VolumeSnapshot` 时驱动会直接返回不支持的错误。选存储方案时如果依赖快照,必须提前确认驱动是否实现了快照 RPC。
10. **`volumeSnapshotClassName` 不写时取默认 VolumeSnapshotClass**,集群里没有默认类则会失败。这与 StorageClass 的行为一致,但快照类多了一条约束:它必须是**目标驱动的**类。
11. **组快照需要额外开启特性并依赖驱动支持**。`--enable-volume-group-snapshots` 默认关闭,且只有实现了组快照 RPC 的驱动才能用。多卷一致性场景不要用「分别打多个快照」来替代 —— 那些快照的时点并不一致。
12. **快照会占用存储空间且持续计费**。增量快照链越长,底层存储需要保留的差异块越多。要有保留策略(定时删除旧快照),否则快照本身会成为容量事故的来源。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `pvc` — 快照的源与恢复目标
- `storageclass` — 与快照类配套的供给策略
- `csi` — 快照能力由 CSI 驱动提供
- `longhorn` — 内置快照与备份的存储方案
- `rook` — Ceph 的 RBD 快照支持
- `velero` — 集群级备份恢复工具,常与快照配合

### 参考链接

- [卷快照官方文档](https://kubernetes.io/docs/concepts/storage/volume-snapshots/)
- [external-snapshotter 仓库](https://github.com/kubernetes-csi/external-snapshotter)
- [snapshot-controller 说明](https://kubernetes-csi.github.io/docs/snapshot-controller.html)
- [从快照恢复 PVC](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#volume-snapshot-and-restore-volume-from-snapshot-support)
