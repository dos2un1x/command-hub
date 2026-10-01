pvc
===

Kubernetes中由用户发起的持久化存储申请与绑定声明

## 补充说明

**PersistentVolumeClaim(PVC)** 是用户对存储资源的「申请单」。用户只描述需要多大容量、什么访问模式,不必关心底层是 NFS、Ceph 还是云厂商云盘 —— 由 PersistentVolume(PV)与 StorageClass 负责满足这份申请。

PVC 是 Pod 与真实存储之间的中间层。Pod 挂载的是 PVC,PVC 绑定到 PV,PV 再映射到底层存储卷。这层间接让存储的供给与消费彻底解耦:管理员换存储后端时,业务侧的 Pod 定义可以一行不改。

PVC 有三种归宿:Pending(找不到可绑定的 PV)、Bound(已绑定)、Lost(绑定的 PV 已消失)。生产环境遇到的存储问题,九成能从这三个状态里找到线索。

### 状态

```shell
Pending    没有匹配的 PV,或 StorageClass 还在等待 Pod 调度(WaitForFirstConsumer)
Bound      已成功绑定到某个 PV,可以正常挂载
Lost       绑定的 PV 已被删除,数据可能已不可用
```

### 语法

```shell
kubectl get pvc [名称] [选项]
kubectl describe pvc [名称]
kubectl delete pvc [名称]
kubectl patch pvc [名称] -p '{"spec":{"resources":{"requests":{"storage":"20Gi"}}}}'
```

### YAML 清单

使用默认 StorageClass 动态供给,这是目前最推荐的写法:

```shell
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: app-data
  namespace: default
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
```

指定 StorageClass 并限定供给模式:

```shell
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: fast-data
spec:
  storageClassName: fast-ssd       # 不写则用默认 SC,写 "" 则禁用动态供给
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 50Gi
  volumeMode: Filesystem
```

静态绑定到某个已存在的 PV,用 `volumeName` 精确指定,或靠 `selector` 按标签筛选:

```shell
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: static-data
spec:
  storageClassName: ""             # 空字符串表示不做动态供给,只匹配静态 PV
  volumeName: pv-nfs-01            # 精确指定要绑定的 PV
  accessModes:
    - ReadWriteMany
  resources:
    requests:
      storage: 100Gi
```

需要直接操作裸设备的场景(如某些数据库)可声明块设备模式,加 `volumeMode: Block` 即可,不加则默认为 `Filesystem`。

### 在 Pod 中使用

```shell
apiVersion: v1
kind: Pod
metadata:
  name: pvc-demo
spec:
  containers:
    - name: app
      image: nginx:1.27
      volumeMounts:
        - name: data
          mountPath: /usr/share/nginx/html
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: app-data
        readOnly: false
```

Deployment 中使用(注意 `ReadWriteOnce` 下副本数只能为 1):

```shell
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 1                     # RWO 卷不支持多副本同时挂载
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      containers:
        - name: web
          image: nginx:1.27
          volumeMounts:
            - name: data
              mountPath: /data
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: app-data
```

StatefulSet 用 `volumeClaimTemplates` 为每个副本自动生成独立的 PVC:

```shell
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mysql
spec:
  serviceName: mysql-headless      # 必须指向已存在的 Headless Service
  replicas: 2
  selector:
    matchLabels:
      app: mysql
  template:
    metadata:
      labels:
        app: mysql
    spec:
      containers:
        - name: mysql
          image: mysql:8.4
          ports:
            - containerPort: 3306
          volumeMounts:
            - name: data
              mountPath: /var/lib/mysql
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes:
          - ReadWriteOnce
        storageClassName: fast-ssd
        resources:
          requests:
            storage: 50Gi
```

### 扩容

只有 StorageClass 配置了 `allowVolumeExpansion: true` 才支持扩容,且**只能扩不能缩**:

```shell
# 1. 确认 StorageClass 允许扩容
kubectl get storageclass fast-ssd -o jsonpath='{.allowVolumeExpansion}'

# 2. 修改请求容量并观察状态(文件系统扩容可能需要重启 Pod 才完成)
kubectl patch pvc app-data -p '{"spec":{"resources":{"requests":{"storage":"20Gi"}}}}'
kubectl get pvc app-data -w
```

### 常用操作

```shell
# 查看所有 PVC 与绑定关系
kubectl get pvc -A
kubectl get pvc -A -o wide

# 查看详情,关注 Events 中的绑定失败原因
kubectl describe pvc app-data

# 查看绑定的 PV 名称
kubectl get pvc app-data -o jsonpath='{.spec.volumeName}'

# 删除 PVC(是否连带删除底层存储取决于 PV 的回收策略)
kubectl delete pvc app-data
```

### 排障

```shell
# 1. PVC 一直 Pending —— 看 Events 里的具体原因
kubectl describe pvc app-data

# 2. 没有任何 PV 可绑定
kubectl get pv
kubectl get storageclass

# 3. 没有默认 StorageClass
kubectl get storageclass
kubectl get storageclass -o jsonpath='{.items[*].metadata.annotations}'

# 4. 容量或访问模式不匹配(静态供给时最常见)
kubectl get pv -o custom-columns=\
NAME:.metadata.name,CAP:.spec.capacity.storage,MODE:.spec.accessModes,SC:.spec.storageClassName,STATUS:.status.phase

# 5. WaitForFirstConsumer 模式下 PVC 等 Pod 才会绑定
kubectl get storageclass <name> -o jsonpath='{.volumeBindingMode}'
kubectl describe pod <pending-pod>

# 6. Pod 卡在 ContainerCreating —— 卷挂载失败
kubectl describe pod <pod> | tail -30
kubectl -n kube-system logs -l app=csi-<driver>-node --tail=100
```

### 注意

1. **`accessModes` 必须与底层存储的实际能力匹配**。`ReadWriteMany` 要求后端支持多节点同时挂载,云盘(如 AWS EBS、阿里云云盘)通常**只支持 RWO**,PVC 写 RWX 会一直 Pending 且事件提示不明确;NFS、CephFS 才支持 RWX。
2. **`ReadWriteOnce` 的语义是「单节点读写」而非「单 Pod 读写」**。同一节点上的多个 Pod 可以同时挂载同一个 RWO 卷,这与直觉不符;真正限制单 Pod 独占要靠 `ReadWriteOncePod`(1.22+,需 CSI 驱动支持)。
3. **`storageClassName: ""` 与不写这个字段含义完全不同**。不写表示「用默认 StorageClass 动态供给」,写空字符串表示「禁止动态供给,只绑定静态 PV」。需要绑定手工创建的 PV 时漏写这一行,PVC 会一直 Pending。
4. **PVC 扩容只能增大不能减小**,且要求 StorageClass 的 `allowVolumeExpansion: true`。底层不支持在线扩容时,还需要重启 Pod 才能完成文件系统扩展,期间业务会中断。
5. **删除 PVC 时底层数据是否保留取决于 PV 的 `persistentVolumeReclaimPolicy`**。`Delete`(动态供给的默认值)会连同云盘一起删除,`Retain` 则保留数据但 PV 变成 `Released` 状态。生产环境的核心数据务必确认回收策略。
6. **StatefulSet 的 PVC 不会随 StatefulSet 删除而删除**,这是刻意设计(避免误删数据),但也意味着缩容后残留的 PVC 仍在计费,需要手动清理。
7. **`WaitForFirstConsumer` 模式下 PVC 在没有 Pod 使用时会一直 Pending**,这是正常现象而非故障 —— 绑定要等到 Pod 调度时才能确定可用区。排查前先确认 `volumeBindingMode`。
8. **PVC 一旦绑定就无法更换 `volumeName` 或存储类**,想换存储只能新建 PVC 再迁移数据,不能原地修改。
9. **跨可用区的 PV 无法被调度到其他可用区的 Pod 使用**。多副本工作负载配合单可用区云盘时,Pod 可能一直 Pending,需要靠 `volumeBindingMode: WaitForFirstConsumer` 让调度器参与决策。
10. **`volumeMode: Block` 的 PVC 不能当普通目录挂载**,只能作为裸设备使用,且应用需要自行处理格式化,写错会导致容器启动失败。
11. **静态供给时 PVC 的请求容量必须小于等于 PV 容量**,但 Kubernetes **不会**校验 PV 实际大小是否真的满足,填错只能靠底层存储自己报错。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `pv` — 与PVC绑定的持久卷资源
- `storageclass` — 定义动态存储供给策略
- `namespace` — PVC的作用域边界
- `kubeadm` — Kubernetes集群安装与生命周期管理工具

### 参考链接

- [PersistentVolumeClaim 官方文档](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#persistentvolumeclaims)
- [配置 Pod 使用 PVC 存储](https://kubernetes.io/docs/tasks/configure-pod-container/configure-persistent-volume-storage/)
- [扩容 PVC](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#expanding-persistent-volumes-claims)
- [访问模式说明](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#access-modes)
