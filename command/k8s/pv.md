pv
===

Kubernetes集群中由管理员供给的持久化存储卷资源

## 补充说明

**PersistentVolume(PV)** 是集群级别的存储资源,代表一块真实存在的存储 —— 可能是 NFS 共享目录、云厂商云盘、Ceph RBD 镜像或本地磁盘。它由管理员预先创建(静态供给),或由 StorageClass 自动创建(动态供给),生命期独立于任何 Pod。

PV 与 PVC 是「供给」与「消费」的两端:PV 描述「我有什么」,PVC 描述「我要什么」,两者由控制器按容量、访问模式、存储类、标签等条件撮合绑定。这种解耦让存储的生命周期与业务 Pod 彻底分开 —— Pod 删了数据还在,PV 删了才是真的没了。

PV 是**集群级资源,不属于任何命名空间**;而 PVC 是命名空间级的。这是两者最容易混淆的地方,也是 `kubectl get pv -n xxx` 看不到命名空间列的原因。

### 状态

```shell
Available   空闲,尚未被任何 PVC 绑定
Bound       已绑定到某个 PVC
Released    PVC 已删除,但 PV 尚未被回收(数据仍在)
Failed      自动回收失败,需要人工介入清理
```

### 回收策略

```shell
Retain   保留数据,PV 变为 Released,需管理员手工清理才能重新使用(生产环境推荐)
Delete   删除 PV 的同时删除底层存储(AWS EBS、GCE PD、Ceph RBD 等动态供给的默认值)
Recycle  已废弃,等价于在卷上执行 rm -rf,不要使用
```

### 访问模式

```shell
ReadWriteOnce (RWO)    单节点读写,同一节点上的多个 Pod 可同时挂载
ReadOnlyMany  (ROX)    多节点只读
ReadWriteMany (RWX)    多节点读写,要求 NFS、CephFS 等共享文件系统
ReadWriteOncePod (RWOP) 单 Pod 读写,1.22+ 引入,需 CSI 驱动支持
```

访问模式是**存储后端能力的声明,不是访问控制**。写了一个后端不支持的模式,PV 照样能创建,但 PVC 会一直绑定不上或挂载失败。

### 语法

```shell
kubectl get pv [名称] [选项]
kubectl describe pv [名称]
kubectl delete pv [名称]
kubectl patch pv [名称] -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'
```

### YAML 清单

NFS 静态卷,支持多节点读写,是最常见的自建存储方案:

```shell
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pv-nfs-01
  labels:
    env: production
    tier: gold
spec:
  capacity:
    storage: 100Gi
  accessModes:
    - ReadWriteMany
  persistentVolumeReclaimPolicy: Retain
  storageClassName: nfs-slow
  mountOptions:
    - hard
    - nfsvers=4.1
  nfs:
    server: 192.168.1.10
    path: /data/nfs/pv-nfs-01
```

local 卷,性能接近本地盘,但**必须**配合 nodeAffinity 与 `WaitForFirstConsumer`:

```shell
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pv-local-01
spec:
  capacity:
    storage: 200Gi
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Retain
  storageClassName: local-storage
  local:
    path: /mnt/disks/ssd1
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - key: kubernetes.io/hostname
              operator: In
              values:
                - node-01
```

云厂商云盘(AWS EBS 示例,通常由动态供给自动创建,这里展示静态形态):

```shell
apiVersion: v1
kind: PersistentVolume
metadata:
  name: pv-aws-ebs-01
spec:
  capacity:
    storage: 500Gi
  accessModes:
    - ReadWriteOnce
  persistentVolumeReclaimPolicy: Delete
  storageClassName: gp3
  csi:
    driver: ebs.csi.aws.com
    volumeHandle: vol-0123456789abcdef0
    fsType: ext4
```

### 与 PVC 绑定

PVC 与 PV 的绑定条件必须**全部满足**,任一不符都会导致 Pending:

```shell
1. PV 的 capacity 大于等于 PVC 的 requests.storage
2. PV 的 accessModes 覆盖 PVC 的 accessModes
3. storageClassName 完全一致(两边都为空也视为一致)
4. volumeMode 一致(Filesystem / Block)
5. 若 PVC 指定了 volumeName,则必须精确匹配该 PV
6. 若 PVC 指定了 selector,则 PV 的标签必须匹配
```

绑定成功后,PV 的 `spec.claimRef` 会写入对应 PVC 的信息,`status.phase` 变为 `Bound`:

```shell
kubectl get pv pv-nfs-01 -o jsonpath='{.spec.claimRef}'
kubectl get pv pv-nfs-01 -o jsonpath='{.status.phase}'
```

### 常用操作

```shell
# 查看所有 PV 与绑定情况
kubectl get pv
kubectl get pv -o wide

# 自定义列,快速看清容量、模式、存储类
kubectl get pv -o custom-columns=\
NAME:.metadata.name,CAP:.spec.capacity.storage,ACCESS:.spec.accessModes,\
RECLAIM:.spec.persistentVolumeReclaimPolicy,SC:.spec.storageClassName,\
STATUS:.status.phase,CLAIM:.spec.claimRef.name

# 查看详情,关注 Events
kubectl describe pv pv-nfs-01

# 修改回收策略(常用于把动态供给的 Delete 改为 Retain)
kubectl patch pv pv-nfs-01 -p '{"spec":{"persistentVolumeReclaimPolicy":"Retain"}}'

# 删除 PV(底层数据是否保留取决于回收策略)
kubectl delete pv pv-nfs-01

# 强制删除卡在 Terminating 的 PV
kubectl patch pv pv-nfs-01 -p '{"metadata":{"finalizers":null}}'
```

### 释放与重新使用

`Retain` 策略下删除 PVC 后,PV 会停在 `Released` 状态,**且无法被新 PVC 绑定** —— 因为它仍记着旧的 claimRef:

```shell
# 1. 删除 PVC 后查看 PV 状态
kubectl get pv
# NAME        CAPACITY   ...   STATUS     CLAIM
# pv-nfs-01   100Gi      ...   Released   default/old-claim

# 2. 清除 claimRef 让 PV 回到 Available
kubectl patch pv pv-nfs-01 -p '{"spec":{"claimRef":null}}'

# 3. 确认状态已变为 Available
kubectl get pv pv-nfs-01

# 4. 底层数据仍在,需要手工清理后再交给新的使用方
#    例如在 NFS 服务器上:rm -rf /data/nfs/pv-nfs-01/*
```

### 排障

```shell
# 1. PVC Pending,列出所有可绑定 PV 做对比
kubectl get pv
kubectl describe pvc app-data

# 2. 检查容量与访问模式是否匹配
kubectl get pv -o custom-columns=\
NAME:.metadata.name,CAP:.spec.capacity.storage,MODE:.spec.accessModes,SC:.spec.storageClassName

# 3. 检查 storageClassName 大小写与拼写
kubectl get pv pv-nfs-01 -o jsonpath='{.spec.storageClassName}'
kubectl get pvc app-data -o jsonpath='{.spec.storageClassName}'

# 4. local 卷的 nodeAffinity 是否与调度到的节点一致
kubectl get pv pv-local-01 -o jsonpath='{.spec.nodeAffinity}'
kubectl get pod <pod> -o jsonpath='{.spec.nodeName}'

# 5. PV 卡在 Terminating
kubectl get pv pv-nfs-01 -o jsonpath='{.metadata.finalizers}'

# 6. NFS 挂载失败(最常见的是服务端未导出该路径)
showmount -e 192.168.1.10
```

### 注意

1. **PV 是集群级资源,不属于任何命名空间**,而 PVC 是命名空间级的。`kubectl get pv -n kube-system` 与 `kubectl get pv` 结果完全一样,命名空间参数会被忽略。
2. **`Released` 状态的 PV 不能直接被新 PVC 使用**。必须手工清空 `spec.claimRef` 才能回到 `Available`,这一步经常被忽略,导致「明明有闲置 PV 却一直 Pending」。
3. **回收策略为 `Delete` 时,删除 PVC 会连底层云盘一起删掉**。动态供给的 PV 默认就是 `Delete`,核心数据务必在 StorageClass 或单个 PV 上改成 `Retain`。
4. **访问模式是声明而非强制**。在支持 RWX 的 NFS 上写 RWO,多个节点同时挂载也不会被阻止,数据损坏风险完全由使用方承担。
5. **`local` 卷必须配合 `nodeAffinity` 使用**,否则 Pod 可能被调度到没有该磁盘的节点上,卷挂载直接失败。同时 `volumeBindingMode` 应为 `WaitForFirstConsumer`,让调度器先决定节点再绑定卷。
6. **`hostPath` 不适合生产环境**。它把 Pod 与特定节点绑死,且几乎没有隔离,节点故障即数据丢失,多租户场景下还存在越权访问节点文件系统的风险。
7. **PV 的 `capacity` 只用于匹配,不做配额**。写 100Gi 但底层实际只有 10Gi 也能绑定成功,超用后才会在写入时报错。
8. **PV 创建后 `capacity` 不可修改**。需要更大容量只能新建 PV 并迁移数据,或依赖 CSI 驱动的扩容能力直接扩 PVC。
9. **静态 PV 与 PVC 的绑定是「先到先得」**。多个 Pending 的 PVC 可能抢到同一类 PV,想精确控制绑定关系应使用 `volumeName` 或 `selector`。
10. **删除 PV 前必须先确认没有 PVC 绑定**。有绑定关系时删除会被拒绝或卡在 Terminating,强删 finalizer 可能留下永不回收的僵尸存储,持续产生云费用。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `pvc` — 消费PV的持久卷声明
- `storageclass` — 定义PV的动态供给策略
- `namespace` — PVC的作用域边界
- `kubeadm` — Kubernetes集群安装与生命周期管理工具

### 参考链接

- [PersistentVolume 官方文档](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)
- [存储类与动态供给](https://kubernetes.io/docs/concepts/storage/dynamic-provisioning/)
- [PV 回收策略](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#reclaiming)
- [本地卷 local volume](https://kubernetes.io/docs/concepts/storage/volumes/#local)
