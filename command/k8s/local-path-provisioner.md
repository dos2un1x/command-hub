local-path-provisioner
===

用节点本地目录动态供给PV的轻量级provisioner,数据不跨节点迁移

## 补充说明

**local-path-provisioner** 是 Rancher 开源的极简 provisioner。它的全部工作只有一件事:当 PVC 出现时,在**Pod 被调度到的那个节点**上创建一个目录,并为这个目录生成一个 PV。没有副本、没有网络、没有额外守护进程 —— 它就是「把 hostPath 用动态供给的方式包装了一遍」。

它是 **k3s 的内置默认存储类**,也是单节点集群、边缘设备、本地开发环境里最省事的选择:不需要任何存储基础设施,装上就能跑有状态应用。

但它有一个**必须牢记的代价:数据存在节点本地,不会跟着 Pod 走**。节点故障、节点重建、磁盘损坏,数据就没了。它提供的是「持久化」,不是「可靠性」—— 这两件事经常被混为一谈。任何不能丢的数据都不应该放在这里,应改用 `longhorn`、`rook`、`openebs` 或云盘 CSI。

项目由 Rancher(SUSE)持续维护,随 k3s 发版一起更新,当前版本线为 v0.0.3x。

### 工作原理

```shell
1. 用户创建 PVC(storageClassName: local-path)
2. StorageClass 是 WaitForFirstConsumer,PV 暂不创建,PVC 显示 Pending
3. Pod 被调度到节点 A,调度器选定节点后开始供给
4. provisioner 在节点 A 的配置目录下创建子目录
   路径形如 <basePath>/<namespace>_<pvcName>_<pvName>
5. 生成 PV,带 nodeAffinity 指向节点 A,Pod 随即绑定成功
6. 删除 PVC 时,provisioner 起一个 helper Pod 挂载宿主机路径去清理目录
```

`WaitForFirstConsumer` 在这里不是可选优化而是**必需**的:只有先确定 Pod 落在哪个节点,才知道该在哪儿建目录。

### 数据存放路径

```shell
独立安装(默认配置)     /opt/local-path-provisioner
k3s 内置              /var/lib/rancher/k3s/storage
RKE2 内置             /var/lib/rancher/rke2/server/storage
```

这些路径下每个 PV 一个子目录,可以直接进去查看和备份。**做节点备份时务必把这个目录纳入范围**,否则备份的是空壳。

### 安装

```shell
# 方式一:官方清单(推荐,版本号请按需替换)
kubectl apply -f https://raw.githubusercontent.com/rancher/local-path-provisioner/v0.0.36/deploy/local-path-storage.yaml

# 确认
kubectl -n local-path-storage get pods
kubectl get storageclass local-path

# 方式二:k3s 用户无需安装,已内置
kubectl get storageclass
# NAME                   PROVISIONER             AGE
# local-path (default)   rancher.io/local-path   5m
```

把 `local-path` 设为默认存储类:

```shell
kubectl patch storageclass local-path \
  -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'

# 集群里只应有一个默认类,先把旧的取消
kubectl patch storageclass <old-default> \
  -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}'
```

### 配置

核心配置在 ConfigMap `local-path-config` 里,`config.json` 决定每个节点能用哪些目录:

```shell
apiVersion: v1
kind: ConfigMap
metadata:
  name: local-path-config
  namespace: local-path-storage
data:
  config.json: |-
    {
      "nodePathMap": [
        {
          "node": "DEFAULT_PATH_FOR_NON_LISTED_NODES",
          "paths": ["/opt/local-path-provisioner"]
        },
        {
          "node": "node-with-ssd",
          "paths": ["/mnt/ssd/local-path-provisioner"]
        },
        {
          "node": "node-without-storage",
          "paths": []
        }
      ]
    }
```

```shell
DEFAULT_PATH_FOR_NON_LISTED_NODES   未单独列出的节点所用的路径
指定节点名                           该节点专用的路径列表
paths: []                          该节点禁用,不会在其上创建任何卷
```

**同一节点配置多个路径时,provisioner 会选择剩余空间最大的那个**,这天然实现了「SSD 优先」之类的效果。

ConfigMap 里还有 `setup`、`teardown` 与 `helperPod.yaml` 三段脚本,分别用于创建目录、清理目录与定义 helper Pod 的形态。修改后**必须重启 provisioner Deployment 才生效**:

```shell
kubectl -n local-path-storage rollout restart deployment local-path-provisioner
```

### StorageClass

```shell
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: local-path
  annotations:
    storageclass.kubernetes.io/is-default-class: "true"
provisioner: rancher.io/local-path
volumeBindingMode: WaitForFirstConsumer      # 必须,不可改为 Immediate
reclaimPolicy: Delete
allowVolumeExpansion: false                  # 本地目录不支持扩容
```

### 使用

```shell
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: app-data
spec:
  storageClassName: local-path
  accessModes:
    - ReadWriteOnce                  # 只支持 RWO,本地目录无法多节点共享
  resources:
    requests:
      storage: 5Gi                   # 仅作记录,不实施配额
```

StatefulSet 场景:

```shell
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: redis
spec:
  serviceName: redis-headless
  replicas: 1
  selector:
    matchLabels:
      app: redis
  template:
    metadata:
      labels:
        app: redis
    spec:
      containers:
        - name: redis
          image: redis:7.4
          volumeMounts:
            - name: data
              mountPath: /data
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        storageClassName: local-path
        accessModes:
          - ReadWriteOnce
        resources:
          requests:
            storage: 10Gi
```

### 数据备份与迁移

因为没有副本,备份只能靠外部手段:

```shell
# 1. 找到 PV 对应的节点与目录
kubectl get pv <pv-name> -o yaml | grep -A5 nodeAffinity
kubectl get pvc app-data -o jsonpath='{.spec.volumeName}'

# 2. 登录该节点,直接打包目录
sudo ls -l /opt/local-path-provisioner/
sudo tar czf /tmp/app-data.tar.gz -C /opt/local-path-provisioner/<namespace>_<pvc>_<pv> .

# 3. 迁移到新集群:先建好同名同命名空间的 PVC,再解包到对应目录
```

跨节点迁移 Pod 时必须手工搬数据 —— provisioner 不会替你搬。

### 排障

```shell
# 1. PVC 一直 Pending —— WaitForFirstConsumer 下这是正常的,先看有没有 Pod 用它
kubectl get pvc app-data
kubectl describe pod <pod> | grep -A5 Events

# 2. provisioner 是否在跑
kubectl -n local-path-storage get pods
kubectl -n local-path-storage logs deploy/local-path-provisioner --tail=100

# 3. 查看实际落盘路径
kubectl get pv <pv-name> -o jsonpath='{.spec.hostPath.path}'

# 4. 删除后目录仍在 —— helper Pod 没起来
kubectl -n local-path-storage get pods
kubectl get events -A --field-selector reason=FailedCreate

# 5. 节点磁盘写满
df -h /opt/local-path-provisioner
#    节点会进入 DiskPressure,Pod 被驱逐
```

### 注意

1. **数据完全不随 Pod 迁移,节点故障即数据丢失**。这是本方案唯一的、也是最致命的限制。`WaitForFirstConsumer` 保证的是「Pod 会被调度回有数据的那个节点」,前提是**那个节点还在**;节点丢失、重装、磁盘损坏,数据就没了,没有任何恢复途径。
2. **没有副本,没有任何冗余**。单副本意味着磁盘坏道、误删、文件系统损坏都会直接变成业务中断。放进来的数据必须是可以承受丢失的。
3. **只支持 `ReadWriteOnce`,写 `ReadWriteMany` 会一直 Pending**。本地目录无法被多节点同时挂载,这是物理限制而非配置问题。需要共享文件请改用 NFS 或 CephFS 方案。
4. **`volumeBindingMode` 必须保持 `WaitForFirstConsumer`**。改成 `Immediate` 会让 PV 在 Pod 调度之前就被创建,而创建时只能随机挑一个节点 —— Pod 随后被调度到别的节点时无法挂载,卷直接不可用。
5. **helper Pod 需要访问宿主机路径,与 PodSecurity 的 `baseline`/`restricted` 策略冲突**。启用强制 PodSecurity 的集群里,`local-path-storage` 命名空间必须显式豁免(`pod-security.kubernetes.io/enforce: privileged`),否则删除 PVC 时目录清理会静默失败,残留数据。
6. **修改 `local-path-config` 后必须重启 provisioner**,ConfigMap 不会热加载。这是配置不生效最常见的原因。
7. **`storage` 请求值不实施配额**。写 1Gi 还是 100Gi,拿到的都是节点磁盘上的一个普通目录,写满节点磁盘为止 —— 而节点磁盘满会触发 `DiskPressure`,把该节点上**所有** Pod 一起驱逐,影响范围远超这个卷本身。
8. **PV 带 `nodeAffinity`,节点名变更会让卷彻底无法挂载**。重装节点、改主机名、云上重建实例之后,旧 PV 的 nodeAffinity 指向一个不存在的节点,Pod 会永远 Pending。此时只能手工编辑 PV 的 nodeAffinity(数据还得在新节点上另行恢复)。
9. **k3s 中 `local-path` 默认就是集群默认存储类**,任何不写 `storageClassName` 的 PVC 都会落到节点本地。迁移到生产集群时,如果忘了改默认类,数据会无声地落在本地盘上。
10. **删除 PVC 时目录清理依赖 helper Pod 成功运行**。helper Pod 因为镜像拉取失败、资源不足或安全策略起不来时,PVC 会被删除而目录留在节点上,日积月累占满磁盘,且没有任何告警。
11. **不要把有状态生产数据放在这里**。它在设计定位上就是「开发/测试/边缘」级别的方案,与 `hostpath` 的危险程度接近,只是多了一层动态供给的便利。生产请用带副本的分布式存储或云盘 CSI。
12. **多路径配置下 provisioner 按剩余空间挑选目录**,但只统计配置中列出的路径。如果某个路径所在的挂载点被卸载了,provisioner 仍可能选中它,导致写入落到根分区上。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `storageclass` — 定义本地目录供给策略
- `pvc` — 触发本地目录创建
- `hostpath` — 手动挂载宿主机目录的原生方式
- `nfs-provisioner` — 支持多节点共享的轻量供给器
- `longhorn` — 具备副本冗余的分布式块存储
- `openebs` — 提供带副本的容器原生存储

### 参考链接

- [local-path-provisioner 仓库](https://github.com/rancher/local-path-provisioner)
- [官方部署清单](https://raw.githubusercontent.com/rancher/local-path-provisioner/master/deploy/local-path-storage.yaml)
- [配置说明](https://github.com/rancher/local-path-provisioner/blob/master/README.md#configuration)
- [k3s 存储文档](https://docs.k3s.io/storage)
