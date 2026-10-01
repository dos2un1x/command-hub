nfs-provisioner
===

在已有NFS服务器上动态创建子目录卷的external-provisioner

## 补充说明

**nfs-subdir-external-provisioner** 是 **kubernetes-sigs**(SIG Storage)维护的 external provisioner。它**不是 NFS 服务器**,而是一个「目录分发器」:接入一台**已经存在**的 NFS 服务器,每当有 PVC 创建时,就在 NFS 的共享目录下新建一个子目录,并以该子目录为单位供给出一个 PV。

它解决的是「有一台 NFS 服务器,但不想手工为每个 PVC 建目录、写 PV」这个非常具体的痛点。因为在很多内网环境里,NFS 是唯一现成可用的共享存储,而这个 provisioner 让它具备了动态供给能力 —— 一行 `storageClassName` 就能拿到一个 `ReadWriteMany` 的卷。

需要明确它的**能力边界**:它没有任何冗余、没有配额、不支持扩容,底层就是一台可能宕机的 NFS 服务器。它适合开发测试环境、共享配置文件、CI 缓存这类场景,不适合放核心生产数据。

**维护状态提醒**:该项目由 kubernetes-sigs 托管,目前处于**轻度维护**状态 —— 容器镜像长期停留在 `v4.0.2`,没有新功能迭代,只有零星的 CI 与 chart 维护提交。它依然可用且被广泛部署,但不应当期待功能演进,选型时可与 `longhorn`、`rook`、`openebs` 等方案一并比较。

### 工作原理

```shell
1. 用户创建 PVC(storageClassName: nfs-client)
2. provisioner 收到请求,在 NFS 共享目录下创建子目录
   默认命名:${PVC 所在命名空间}-${PVC 名称}
3. provisioner 生成对应的 PV,source 指向 NFS 服务器 + 该子目录
4. kubelet 在目标节点上把该子目录挂载进容器
5. 删除 PVC 时,按策略决定子目录是删除、保留还是改名归档
```

子目录的命名规则可通过 StorageClass 的 `pathPattern` 参数定制,例如按命名空间分层。

### 前置条件

```shell
# 1. NFS 服务器必须已存在并导出共享目录(本 provisioner 不负责搭建)
#    在 NFS 服务器上编辑 /etc/exports
/data/nfs/k8s *(rw,sync,no_subtree_check,no_root_squash)
#    生效
exportfs -arv
showmount -e localhost

# 2. 集群每个节点都必须装 NFS 客户端工具
#    Debian / Ubuntu
sudo apt-get install -y nfs-common
#    RHEL / CentOS / Rocky
sudo yum install -y nfs-utils

# 3. 确认节点能挂载(在任意节点上试)
sudo mount -t nfs 192.168.1.10:/data/nfs/k8s /mnt && ls /mnt && sudo umount /mnt
```

节点上没有 NFS 客户端时,kubelet 无法完成挂载,Pod 会卡在 `ContainerCreating` 并报 `mount: wrong fs type` 或 `bad option`。

### 安装

```shell
# 添加 Helm 仓库
helm repo add nfs-subdir-external-provisioner \
  https://kubernetes-sigs.github.io/nfs-subdir-external-provisioner/
helm repo update

# 安装并同时创建一个名为 nfs-client 的 StorageClass
helm install nfs-subdir-external-provisioner \
  nfs-subdir-external-provisioner/nfs-subdir-external-provisioner \
  --namespace nfs-provisioner \
  --create-namespace \
  --set nfs.server=192.168.1.10 \
  --set nfs.path=/data/nfs/k8s \
  --set storageClass.name=nfs-client \
  --set storageClass.defaultClass=false

# 确认部署
kubectl -n nfs-provisioner get pods
kubectl get storageclass
```

使用 `values.yaml` 的等价写法:

```shell
nfs:
  server: 192.168.1.10
  path: /data/nfs/k8s
  mountOptions:
    - nfsvers=4.1
    - hard
    - timeo=600
    - retrans=2
storageClass:
  name: nfs-client
  defaultClass: false
  reclaimPolicy: Delete
  archiveOnDelete: true
  pathPattern: "${.PVC.namespace}/${.PVC.name}"
```

### StorageClass

```shell
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: nfs-client
provisioner: k8s-sigs.io/nfs-subdir-external-provisioner
parameters:
  server: 192.168.1.10
  path: /data/nfs/k8s
  onDelete: retain                 # delete / retain,新版本推荐写法
  pathPattern: "${.PVC.namespace}/${.PVC.name}"
reclaimPolicy: Delete
allowVolumeExpansion: false        # 本项目不支持扩容,务必显式关闭
volumeBindingMode: Immediate
mountOptions:
  - nfsvers=4.1
  - hard
  - timeo=600
  - retrans=2
```

关键参数:

```shell
server          NFS 服务器地址(也可在 provisioner 的部署参数里统一指定)
path            NFS 上的共享根目录
onDelete        子目录处置策略:delete(直接删)/ retain(保留)
pathPattern     子目录命名模板,支持 ${.PVC.namespace}、${.PVC.name}、${.PVC.labels.xxx}
archiveOnDelete 旧版参数,true 时删除 PVC 会把目录改名为 archived-<原名>
mountOptions    传给 mount 的参数,直接影响可用性与稳定性
```

### 在 Pod 中使用

```shell
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: shared-data
spec:
  storageClassName: nfs-client
  accessModes:
    - ReadWriteMany              # NFS 天生支持多节点共享
  resources:
    requests:
      storage: 10Gi              # 注意:这个值不会被真正限制
```

```shell
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 3                    # RWX 卷可以多副本共享
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
    spec:
      securityContext:
        fsGroup: 1000            # 关键:让容器内进程有权限写 NFS 目录
      containers:
        - name: web
          image: nginx:1.27
          volumeMounts:
            - name: data
              mountPath: /usr/share/nginx/html
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: shared-data
```

### 权限与 UID/GID

NFS 的权限模型完全由服务器端的 export 选项与目录属主决定,和 Kubernetes 的 securityContext 之间经常对不上:

```shell
# 服务器端为了允许容器以 root 写入,常需要 no_root_squash
/data/nfs/k8s *(rw,sync,no_subtree_check,no_root_squash)

# 目录属主尽量放宽,或与容器内的运行用户对齐
chown -R 1000:1000 /data/nfs/k8s
chmod 2775 /data/nfs/k8s
```

容器侧配合 `securityContext.fsGroup` 或 `runAsUser` 使用。若坚持保留 `root_squash`(更安全),则容器必须以非 root 运行且 UID 与服务端目录属主一致。

### 排障

```shell
# 1. PVC 一直 Pending
kubectl describe pvc shared-data
kubectl -n nfs-provisioner logs deploy/nfs-subdir-external-provisioner --tail=100

# 2. Pod 卡在 ContainerCreating —— 多半是节点侧 NFS 挂载失败
kubectl describe pod <pod> | tail -30
# 手工在目标节点上验证挂载
showmount -e 192.168.1.10
sudo mount -t nfs 192.168.1.10:/data/nfs/k8s /mnt

# 3. 写入报 Permission denied
#    检查容器运行 UID、NFS 目录属主、export 的 squash 选项三者是否自洽
id
ls -ld /data/nfs/k8s
cat /etc/exports

# 4. Pod 删不掉(Terminating 卡死)
kubectl get pod <pod> -o yaml | grep -A5 deletionGracePeriodSeconds
#    根因通常是 NFS 服务器不可达导致 umount 阻塞,见「注意」第 1 条

# 5. 删除 PVC 后目录仍在
ls /data/nfs/k8s/                  # 确认 onDelete / archiveOnDelete 的实际行为
```

### 注意

1. **默认的 `hard` 挂载 + NFS 服务器不可达 = 进程卡死在 D 状态,Pod 无法删除**。这是本方案最典型的故障:客户端会无限重试而不是报错,`kubectl delete pod` 会一直停在 `Terminating`,`umount` 也卡住。缓解手段是加 `soft` 与 `timeo`/`retrans`(接受 I/O 报错的风险),或使用 `hard` + `intr`。**核心业务不要放在单台 NFS 上**。
2. **`storage` 请求值完全不生效**。这个 provisioner 不实现任何配额,写 10Gi 还是 100Gi 拿到的都是同一个 NFS 上的一个目录,容量由服务器磁盘决定。写满时所有 PVC 一起报错。
3. **本项目不支持卷扩容**。虽然 Helm chart 默认可能生成 `allowVolumeExpansion: true` 的 StorageClass,但驱动并不实现扩容 RPC —— 这是极易踩的坑:改大 PVC 后状态会一直卡住。请在建 StorageClass 时显式写 `allowVolumeExpansion: false`。
4. **每个节点都必须安装 NFS 客户端工具**。挂载动作由 kubelet 在各节点执行,新扩容出来的节点如果镜像里没有 `nfs-common`/`nfs-utils`,该节点上的所有 NFS 卷都会挂载失败,而 provisioner 侧日志一切正常。
5. **`mountOptions` 必须与 NFS 服务器的实际版本匹配**。服务端只开了 NFSv3 却在客户端写 `nfsvers=4.1`,挂载会直接失败。跨版本混用的集群里,这一项必须逐节点核对 `nfsstat` 或 `rpcinfo -p` 的输出。
6. **NFS 服务器是彻头彻尾的单点**,没有副本、没有自愈。它宕机时所有挂载该服务器的 Pod 一起受影响,且因为硬挂载,连「优雅失败」都做不到。生产环境如果只能用 NFS,至少要配 DRBD/Heartbeat 或用商用 NAS 做 HA。
7. **`archiveOnDelete: true` 会让目录无限累积**。删除 PVC 只是把目录改名成 `archived-*`,不会释放空间。长期运行后 NFS 服务器会被历史归档撑满,必须有清理机制,否则终将演变成第 2 条的容量事故。
8. **权限问题几乎都出在 squash 选项与目录属主上**。`root_squash`(很多发行版默认)会把容器里的 root 映射成 `nobody`,导致写入被拒;`no_root_squash` 反过来又让容器内的 root 在 NFS 上拥有真实 root 权限。二者必须结合业务实际安全要求来选。
9. **NFS 不适合跑数据库**。SQLite 的锁语义、MySQL 的 `O_DIRECT` 与 fsync 行为在 NFS 上都可能出现数据损坏或性能坍塌。数据库请用块存储(`longhorn`、`rook` 或云盘)。
10. **provisioner 自身是单副本 Deployment**,它挂掉期间无法创建新 PV,但已挂载的卷不受影响。不要把它扩到多副本 —— 它本身不支持多实例并发,会导致子目录冲突。
11. **路径模板里的 PVC 名称可能包含非法字符**,`pathPattern` 用 `${.PVC.name}` 时要确保生成出来的目录名在 NFS 上合法。默认的「命名空间-名称」形式已经规避了大部分问题,自定义模板时容易引入。
12. **删除 PVC 后 PV 变成 `Released` 而不是消失**,是 `reclaimPolicy: Retain` 与 `onDelete: retain` 组合的预期行为。需要手工清理 PV 对象,否则 `kubectl get pv` 会越积越多。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `storageclass` — 定义 NFS 动态供给策略
- `pvc` — 触发子目录创建的申请对象
- `csi` — CSI 是当前存储接入的主流方式
- `local-path-provisioner` — 另一款同样轻量的本地目录供给器
- `longhorn` — 具备副本冗余的分布式块存储
- `rook` — 功能完整的分布式存储方案

### 参考链接

- [nfs-subdir-external-provisioner 仓库](https://github.com/kubernetes-sigs/nfs-subdir-external-provisioner)
- [Helm chart 说明](https://github.com/kubernetes-sigs/nfs-subdir-external-provisioner/tree/master/charts/nfs-subdir-external-provisioner)
- [StorageClass 参数说明](https://github.com/kubernetes-sigs/nfs-subdir-external-provisioner#storage-class)
- [Linux 内核 NFS 客户端参数](https://www.kernel.org/doc/html/latest/filesystems/nfs/nfs-param.html)
