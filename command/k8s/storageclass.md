storageclass
===

Kubernetes中定义存储分级与动态供给策略的集群级资源

## 补充说明

**StorageClass** 描述集群里「可以供给哪一类存储」,包括用什么插件供给(provisioner)、什么参数(parameters)、什么回收策略(reclaimPolicy)、什么时候绑定(volumeBindingMode)。用户创建 PVC 时只需写上 `storageClassName`,底层存储卷就会被自动创建出来,无需管理员预先手工建 PV。

没有 StorageClass 时,管理员必须为每一个存储需求提前创建 PV,容量、访问模式都得预先猜好,规模一大就难以维护。动态供给(Dynamic Provisioning)把这件事彻底自动化,是目前生产环境的默认做法。

StorageClass 是**集群级资源**,不属于任何命名空间;但通过它可以创建出属于各命名空间的 PV。它还支持设置「默认存储类」,让不写 `storageClassName` 的 PVC 自动落进来。

### 供给模式

```shell
静态供给(Static)    管理员预先创建 PV,PVC 从中匹配绑定
动态供给(Dynamic)   StorageClass 检测到未绑定的 PVC,自动调用 provisioner 创建 PV 并绑定
```

### 卷绑定模式

```shell
Immediate                PVC 创建后立即绑定,可能出现 Pod 与存储不在同一可用区而无法调度
WaitForFirstConsumer    等 Pod 调度后再绑定,保证存储与 Pod 同可用区/同节点
```

对云盘、本地盘这类有拓扑限制的存储,必须使用 `WaitForFirstConsumer`,否则会频繁出现「PVC 已 Bound 但 Pod 一直 Pending」的跨可用区问题。

### 语法

```shell
kubectl get storageclass [名称] [选项]
kubectl describe storageclass [名称]
kubectl patch storageclass [名称] -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
kubectl delete storageclass [名称]
```

### YAML 清单

AWS EBS 动态供给,生产环境最常见的形态:

```shell
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-ssd
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "6000"
  throughput: "250"
  encrypted: "true"
reclaimPolicy: Retain
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
```

NFS 类的动态供给(需要部署 nfs-subdir-external-provisioner):

```shell
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: nfs-client
provisioner: k8s-sigs.io/nfs-subdir-external-provisioner
parameters:
  server: 192.168.1.10
  path: /data/nfs/k8s
  archiveOnDelete: "true"          # 删除 PVC 时把目录改名归档而非删除
reclaimPolicy: Delete
allowVolumeExpansion: false        # NFS 通常不支持在线扩容
volumeBindingMode: Immediate
```

Ceph RBD 块存储:

```shell
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: ceph-rbd
provisioner: rbd.csi.ceph.com
parameters:
  clusterID: 1234abcd-56ef-78gh-90ij-klmnopqrstuv
  pool: k8s-pool
  imageFeatures: layering
  csi.storage.k8s.io/provisioner-secret-name: ceph-csi-secret
  csi.storage.k8s.io/provisioner-secret-namespace: ceph-csi
  csi.storage.k8s.io/node-stage-secret-name: ceph-csi-secret
  csi.storage.k8s.io/node-stage-secret-namespace: ceph-csi
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: Immediate
```

本地盘,必须用 `WaitForFirstConsumer`:

```shell
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-storage
provisioner: kubernetes.io/no-provisioner    # 表示不做动态供给,只用于静态 PV 分组
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Retain
```

阿里云云盘:

```shell
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: alicloud-disk-essd
provisioner: diskplugin.csi.alibabacloud.com
parameters:
  type: cloud_essd
  fstype: ext4
reclaimPolicy: Delete
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer
```

### 设置为默认存储类

```shell
# 方式一:加注解
kubectl patch storageclass fast-ssd \
  -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'

# 方式二:取消原有默认类,再设置新的(集群中只应有一个默认类)
kubectl patch storageclass old-sc \
  -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}'

# 确认当前默认类
kubectl get storageclass
kubectl get storageclass -o jsonpath='{range .items[?(@.metadata.annotations.storageclass\.kubernetes\.io/is-default-class=="true")]}{.metadata.name}{"\n"}{end}'
```

### 常用操作

```shell
# 查看所有存储类(namespace 列会显示 default 标记)
kubectl get storageclass
kubectl get sc

# 查看详情
kubectl describe storageclass fast-ssd

# 以 YAML 查看全部参数
kubectl get sc fast-ssd -o yaml

# 查看某个 SC 下已创建的 PV
kubectl get pv -o json | jq -r '.items[] | select(.spec.storageClassName=="fast-ssd") | .metadata.name'

# 试运行:验证 PVC 是否能被正确供给(不实际创建)
kubectl apply -f pvc.yaml --dry-run=server

# 删除存储类(已存在的 PV/PVC 不受影响)
kubectl delete storageclass fast-ssd
```

### SCSI 驱动与 provisioner 名称

`provisioner` 字段必须是集群中**实际部署了的 CSI 驱动或内置插件的名称**,写错不会有任何报错,只是 PVC 永远 Pending:

```shell
ebs.csi.aws.com                            AWS EBS
disk.csi.azure.com                         Azure Disk
pd.csi.storage.gke.io                      GCE PD
diskplugin.csi.alibabacloud.com            阿里云云盘
csi.ceph.com / rbd.csi.ceph.com            Ceph
k8s-sigs.io/nfs-subdir-external-provisioner  NFS Subdir
kubernetes.io/no-provisioner               不做动态供给
kubernetes.io/aws-ebs                      已废弃的 in-tree 插件,不要再用
```

查看集群中实际可用的 CSI 驱动:

```shell
kubectl get csidrivers
kubectl get pods -n kube-system | grep -i csi
```

### 排障

```shell
# 1. PVC 一直 Pending —— 先看 SC 是否存在、名称是否拼对
kubectl get sc
kubectl describe pvc app-data

# 2. provisioner 是否真的在运行
kubectl get pods -A | grep -iE "csi|provisioner"
kubectl -n kube-system logs <provisioner-pod> --tail=100

# 3. 存储类是否设置了但不生效 —— 检查 volumeBindingMode
kubectl get sc fast-ssd -o jsonpath='{.volumeBindingMode}'
# WaitForFirstConsumer 时 PVC 在无 Pod 使用前一直 Pending 属正常

# 4. Pod 与存储不在同一可用区
kubectl describe pod <pending-pod> | grep -A5 "FailedScheduling"

# 5. 扩容失败
kubectl get sc fast-ssd -o jsonpath='{.allowVolumeExpansion}'
kubectl describe pvc app-data | grep -A5 Events

# 6. CSI 驱动本身的报错
kubectl get events -A --field-selector reason=ProvisioningFailed
```

### 注意

1. **`provisioner` 写错不会报错,只会让 PVC 永远 Pending**。删除 StorageClass 后重建同名对象时最容易发生,排查第一步永远是确认 provisioner 名称与集群中实际部署的 CSI 驱动一致。
2. **集群中只应有一个默认 StorageClass**。多个类都标了 `is-default-class: "true"` 时,Kubernetes 会选择**最新创建的那个**,行为不确定且难以察觉,务必及时清理旧的默认标记。
3. **删除默认 StorageClass 后,不写 `storageClassName` 的 PVC 会全部 Pending**,因为不再有默认供给者。切换默认类时要先建新的、再取消旧的。
4. **`volumeBindingMode: WaitForFirstConsumer` 下 PVC 一直 Pending 是正常的**。绑定必须等到有 Pod 引用它、调度器确定节点之后才发生,拿 PVC 状态判断故障会得出错误结论。
5. **`reclaimPolicy` 在 StorageClass 上只是「默认值」**,动态创建的 PV 会继承它,但已创建的 PV 修改回收策略只影响自身,不会回溯到 StorageClass。
6. **`allowVolumeExpansion: true` 不代表底层一定支持扩容**。是否支持取决于存储后端,且多数云盘要求扩容后重启 Pod 才能完成文件系统扩展;NFS 类存储通常根本不支持。
7. **删除 StorageClass 不会影响已存在的 PV 与 PVC**。已供给的存储照常工作,但后续新的 PVC 无法再通过它供给。
8. **StorageClass 是集群级资源,不受命名空间隔离**,任何命名空间的 PVC 都能引用它。多租户环境下要配合 RBAC 限制谁能创建 StorageClass 与 PVC。
9. **`parameters` 里的值几乎都必须是字符串**。`iops: 6000` 会被类型校验拒绝,必须写成 `iops: "6000"`,这是 CSI 参数最常见的语法错误。
10. **`kubernetes.io/no-provisioner` 表示「不做动态供给」**,只用于给静态 PV 分组并启用延迟绑定,用它创建 PVC 而集群里没有匹配的静态 PV 时,会一直 Pending。
11. **in-tree 插件(如 `kubernetes.io/aws-ebs`)已大规模废弃**,新集群应统一使用 CSI 驱动,继续使用旧插件在升级时会出现卷无法挂载的问题。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `pv` — 由存储类动态创建或静态供给的持久卷
- `pvc` — 引用存储类发起存储申请
- `namespace` — PVC的作用域边界
- `kubeadm` — Kubernetes集群安装与生命周期管理工具

### 参考链接

- [StorageClass 官方文档](https://kubernetes.io/docs/concepts/storage/storage-classes/)
- [动态存储供给](https://kubernetes.io/docs/concepts/storage/dynamic-provisioning/)
- [改变默认 StorageClass](https://kubernetes.io/docs/tasks/administer-cluster/change-default-storage-class/)
- [CSI 驱动列表](https://kubernetes-csi.github.io/docs/drivers.html)
