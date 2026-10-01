longhorn
===

Kubernetes轻量级分布式块存储,为每个卷提供多副本冗余与快照备份

## 补充说明

**Longhorn** 是 Rancher(SUSE)开源、现为 **CNCF 孵化项目**的云原生分布式块存储。它为每个卷在多个节点上保存若干份完整副本,再通过 iSCSI 把卷挂载给 Pod,同时提供快照、备份到对象存储、卷克隆、增量恢复、灾备等能力。

Longhorn 最大的特点是**不依赖任何外部存储系统** —— 它把节点本地磁盘当作资源池,靠 Kubernetes 本身的机制(CRD + DaemonSet + StatefulSet)拼出一个分布式块存储,部署形态极简,一个 Helm 命令即可完成。相比之下 Rook-Ceph 功能更强但运维复杂度高一个量级,Longhorn 更适合中小规模集群与边缘场景。

需要明确 Longhorn 的**定位边界**:它提供的是**块存储**(RWO),文件共享(RWX)是通过 `share-manager` 跑一个 NFSv4 服务端模拟出来的;它不是文件系统集群,也不是对象存储。海量小文件、需要数十个节点共享同一份数据的场景,Longhorn 并不合适。

当前版本线为 **1.12.x**(1.12.1 发布于 2026-08-14),支持 1.10 / 1.11 / 1.12 等多个维护分支,每个小版本提供 6 个月活跃支持 + 12 个月维护支持。

### 核心组件

```shell
longhorn-manager        DaemonSet,每个节点一个,负责卷的编排、副本调度与节点管理
longhorn-engine         实际读写数据的引擎(每个卷一个实例,跑在副本所在节点)
longhorn-instance-manager  管理引擎与副本进程的生命周期
longhorn-ui             前端界面(默认 8000 端口)
longhorn-driver-deployer 部署 CSI 驱动(node plugin 与 controller)
csi-attacher / csi-provisioner / csi-resizer / csi-snapshotter  CSI sidecar
share-manager             RWX 卷的实现者,为每个 RWX 卷起一个 NFSv4 服务端 Pod
backing-image-manager    管理从外部导入的镜像文件
```

### 环境要求

Longhorn 官方给出的最低 Kubernetes 版本是 **v1.25**,并对每个节点有一组依赖:

```shell
# V1 数据引擎(默认)—— 必须有 open-iscsi,且 iscsid 常驻运行
sudo apt-get install -y open-iscsi        # Debian / Ubuntu
sudo systemctl enable --now iscsid
sudo modprobe iscsi_tcp
sudo yum --setopt=tsflags=noscripts install -y iscsi-initiator-utils   # RHEL 系

# RWX 卷需要 NFSv4 客户端;加密卷需要 cryptsetup;设备映射需要 dmsetup
sudo apt-get install -y nfs-common cryptsetup dmsetup

# 驱动脚本还依赖这些基础工具
bash curl findmnt grep awk blkid lsblk
```

官方提供了预检工具,可以把上面这些一次性检查完:

```shell
longhornctl check preflight
longhornctl --kubeconfig ~/.kube/config --image longhornio/longhorn-cli:v1.12.1 install preflight
```

**V2 数据引擎**(基于 SPDK)要求高得多,当前仍处于预览阶段:内核 **6.7+**,内核模块 `vfio_pci`、`uio_pci_generic`、`nvme-tcp`,每节点预留 **2GiB 的 2MiB 大页**,磁盘必须是无文件系统的裸设备,每个 instance-manager 还要独占 CPU 核心(SPDK 轮询模式)。

### 安装

```shell
# 添加 Helm 仓库
helm repo add longhorn https://charts.longhorn.io
helm repo update

# 安装到 longhorn-system 命名空间
helm install longhorn longhorn/longhorn \
  --namespace longhorn-system \
  --create-namespace \
  --version 1.12.1

kubectl -n longhorn-system get pods -w       # 所有 Pod 应为 Running
```

常见定制项:

```shell
helm install longhorn longhorn/longhorn --namespace longhorn-system --create-namespace \
  --set defaultSettings.defaultReplicaCount=3 \
  --set persistence.defaultClass=true \
  --set csi.kubeletRootDir=/var/lib/kubelet
```

### 访问 UI

```shell
kubectl -n longhorn-system port-forward service/longhorn-frontend 8080:80
# 浏览器打开 http://localhost:8080
```

UI 里可以直观看到每个卷的副本分布、健康状态、快照链、备份目标与节点磁盘占用,是排查问题最快的手段。

### 存储类

安装后会自动创建一个名为 `longhorn` 的 StorageClass(`kubectl get storageclass longhorn -o yaml` 可以看到它的完整定义)。自定义一个多副本存储类:

```shell
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-3replicas
provisioner: driver.longhorn.io
allowVolumeExpansion: true
reclaimPolicy: Delete
volumeBindingMode: Immediate
parameters:
  numberOfReplicas: "3"              # 不能超过可用于调度的节点数
  staleReplicaTimeout: "30"          # 副本失联多久后重建(分钟)
  dataLocality: "disabled"           # disabled / best-effort / strict-local
  diskSelector: "ssd"                # 只落在打了此标签的磁盘上
  nodeSelector: "storage"            # 只落在打了此标签的节点上
  recurringJobSelector: '[{"name":"snapshot-daily","isGroup":false}]'
```

### 使用

```shell
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: app-data
spec:
  storageClassName: longhorn
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 20Gi
```

StatefulSet 用 `volumeClaimTemplates` 为每个副本自动生成独立的 PVC,把 `storageClassName` 换成 `longhorn` 即可,写法与 `pvc` 页完全一致,RWO 语义下副本数只能是 1。

### 快照与备份

Longhorn 的**快照**保存在集群内部(副本所在磁盘上),**备份**才会推到外部目标(对象存储或 NFS)。二者不是一回事,只有备份能跨集群恢复:

```shell
# 方式一:UI 里选中卷点击 Create Snapshot
# 方式二:直接创建 Snapshot CRD(Longhorn 1.9+ 支持)
cat <<'EOF' | kubectl apply -f -
apiVersion: longhorn.io/v1beta2
kind: Snapshot
metadata:
  name: app-data-snap-01
  namespace: longhorn-system
spec:
  volume: pvc-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  createSnapshot: true
EOF

kubectl -n longhorn-system get snapshots.longhorn.io
```

配置备份目标(在 UI 的 Setting → Backup Target 里填写,或直接改 Setting CR):

```shell
cat <<'EOF' | kubectl apply -f -
apiVersion: longhorn.io/v1beta2
kind: Setting
metadata:
  name: backup-target
  namespace: longhorn-system
value: "s3://my-longhorn-backup@us-east-1/"
EOF
# S3 密钥另由 backup-target-credential-secret 指定,需预先建好 Secret
```

用 `RecurringJob` 做定时快照与备份:

```shell
apiVersion: longhorn.io/v1beta2
kind: RecurringJob
metadata:
  name: snapshot-daily
  namespace: longhorn-system
spec:
  cron: "0 2 * * *"
  task: snapshot          # snapshot 或 backup
  groups: [default]
  retain: 7
  concurrency: 2
```

### 扩容与克隆

```shell
# 1. 确认 StorageClass 允许扩容
kubectl get storageclass longhorn -o jsonpath='{.allowVolumeExpansion}'

# 2. 直接改 PVC 的请求容量
kubectl patch pvc app-data -p '{"spec":{"resources":{"requests":{"storage":"40Gi"}}}}'

# 3. 观察状态,文件系统扩展通常需要重启 Pod 才完成
kubectl get pvc app-data -w
```

从已有卷克隆或从备份恢复(`fromBackup` 参数)也是常规操作,克隆出的新卷与源卷完全独立。

### 升级

```shell
# 1. 升级 chart(会同时拉取新的 engine image)
helm repo update
helm upgrade longhorn longhorn/longhorn --namespace longhorn-system --version 1.12.1

# 2. 控制每节点同时升级的引擎数量,默认 0 表示不自动升级
#    Setting → Concurrent Automatic Engine Upgrade Per Node Limit

# 3. 检查引擎镜像与卷的引擎版本
kubectl -n longhorn-system get engineimage
kubectl -n longhorn-system get volumes.longhorn.io
```

Longhorn 的卷不会自动使用新引擎镜像,需要显式触发引擎升级(或者在 Setting 里把并发上限调成大于 0,由控制器逐个滚动升级)。

### 卸载

```shell
# 必须先把删除确认开关打开,否则 chart 卸载会被拒绝
kubectl -n longhorn-system patch settings.longhorn.io deleting-confirmation-flag \
  --type merge -p '{"value":"true"}'

helm uninstall longhorn -n longhorn-system
kubectl delete namespace longhorn-system
```

残留数据在每节点的 `/var/lib/longhorn` 下,确认不再需要后手工清理。

### 排障

```shell
# 1. 卷一直 degraded —— 看副本分布,副本数是否超过可用节点数
kubectl -n longhorn-system get volumes.longhorn.io
kubectl -n longhorn-system get replicas.longhorn.io

# 2. Pod 卡在 ContainerCreating —— 多半是 iSCSI 没装好
systemctl status iscsid
lsmod | grep iscsi
kubectl -n longhorn-system logs daemonset/longhorn-manager --tail=100

# 3. 节点磁盘不可调度
kubectl -n longhorn-system get nodes.longhorn.io
kubectl -n longhorn-system get nodes.longhorn.io <node> -o yaml

# 4. RWX 卷挂载失败 —— share-manager Pod 是否起来(备份报错同理看 longhorn-manager)
kubectl -n longhorn-system get pods | grep share-manager
kubectl -n longhorn-system logs <share-manager-pod>
```

### 注意

1. **`numberOfReplicas` 不能超过可用于调度的节点数**。3 副本跑在 2 个节点上,副本会永远处于 `degraded`/`stopped` 状态,而且卷依然可以正常读写 —— 让人误以为一切正常,直到那台唯一持有完整数据副本的节点宕机。**3 副本至少需要 3 个节点**,想容忍 1 节点故障则至少要有 4 个节点,否则重建副本时无处可放。
2. **`open-iscsi` 必须安装且 `iscsid` 常驻运行,这是最经典的部署失败原因**。此外 **open-iscsi 2.1.12 存在已知不兼容**,官方建议使用 `<= 2.1.11` 或 `>= 2.1.13`。容器化发行版(Talos、Flatcar 等)需要在节点镜像层解决这个问题。
3. **RWX 卷靠 `share-manager` 模拟,本质是一个 NFS 服务端 Pod**,存在单点:该 Pod 所在节点故障时,所有挂载此 RWX 卷的 Pod 会一起中断。真需要多节点并发写文件,应评估 CephFS 这类原生共享文件系统。
4. **快照 ≠ 备份**。快照存在集群内的副本磁盘上,节点/集群整体损坏就一起没了;只有推到 Backup Target 的备份才能跨集群恢复。生产环境必须同时配置定时快照与定时备份。
5. **卸载前必须先打开 `deleting-confirmation-flag`**,否则 `helm uninstall` 会被 webhook 拒绝。这是刻意设计的防误删机制,不是故障。
6. **升级不是「升级 chart 就完事」**。引擎镜像需要另外触发升级,`Concurrent Automatic Engine Upgrade Per Node Limit` 默认值为 0(不自动升级)。忘记升级引擎不会立即出问题,但会一直停留在旧版本,失去新版本修复。
7. **`dataLocality: strict-local` 会显著降低可用性**。它把副本强绑到 Pod 所在节点以减少网络跳数,但该节点故障时卷将无法在其他节点启动。除非对延迟极度敏感且能接受这个代价,否则用默认的 `disabled`。
8. **V2 数据引擎与 V1 卷不互通,且要求内核 6.7+ 与大页内存**。开启 V2 前必须预留 HugePages 并重启 kubelet,否则 instance-manager 起不来;变更大页数量后同样必须重启 kubelet 或整机。
9. **每个节点的存储目录(`defaultDataPath`,默认 `/var/lib/longhorn`)所在磁盘有预留水位**。Longhorn 默认在可用空间低于一定百分比时停止在该磁盘调度新副本,磁盘写满时不会「优雅降级」,而是直接拒绝新卷。同理,`diskSelector`/`nodeSelector` 指向的标签若没有真正打上,卷会一直 `Pending` 且事件里几乎看不到有用信息。
10. **Longhorn 的存储类默认可能被设为集群默认类**(`persistence.defaultClass: true`)。集群里已有其他默认类时会造成两个默认类并存,Kubernetes 取最新创建的那个,行为难以预测。此外组件需要以 root 运行并挂载宿主机路径,与 PodSecurity 的 `restricted` 策略冲突,`longhorn-system` 命名空间需要显式豁免。
11. **节点 drain 时 Longhorn 卷的处理策略由 `node-drain-policy` 决定**,默认是 `block-for-eviction`,会让 `kubectl drain` 卡住不动。维护节点前先确认这个 Setting,必要时临时改为 `always-allow-eviction`。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `csi` — Longhorn 通过 CSI 驱动接入集群
- `storageclass` — 定义 Longhorn 的供给参数
- `pvc` — 向 Longhorn 申请存储
- `volume-snapshot` — 标准化的卷快照 API
- `openebs` — 另一套容器原生存储方案

### 参考链接

- [Longhorn 官方文档](https://longhorn.io/docs/)
- [Longhorn 安装要求](https://longhorn.io/docs/latest/deploy/install/)
- [Longhorn 使用 Helm 安装](https://longhorn.io/docs/latest/deploy/install/install-with-helm/)
- [Longhorn 快照与备份](https://longhorn.io/docs/latest/snapshots-and-backups/)
