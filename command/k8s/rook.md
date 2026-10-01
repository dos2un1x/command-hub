rook
===

以Operator方式在Kubernetes上编排部署Ceph存储集群

## 补充说明

**Rook** 是 **CNCF 毕业项目**(2020-10-07 毕业,是第一个达到该级别的存储项目),定位是「存储的 Operator 框架」。它把 Ceph 这类复杂分布式存储的部署、扩容、升级、故障自愈全部收敛成一组 Kubernetes CRD —— 管理员不再需要 SSH 到每台机器上敲 `ceph` 命令,而是 `kubectl apply` 一份 `CephCluster` 清单,由 Rook Operator 负责把 MON、MGR、OSD、MDS、RGW 一个个跑起来。

Rook 的本体是 Operator,**它自己不提供存储能力**,真正干活的是 Ceph。所以 Rook 页与 `ceph` 页是配套的:本页讲怎么在 Kubernetes 里把 Ceph 编排起来,`ceph` 页讲 Ceph 本身的原理与运维命令。

一次 `CephCluster` 部署完成后,Rook 还会顺手把 **ceph-csi** 驱动(controller 插件 + 各节点的 node 插件)与所需的 Secret 一并装好,你只需要写 StorageClass 就能给业务供存储。Rook 同时支持块(RBD)、文件(CephFS)、对象(RGW)三种形态。

当前版本线:Rook **v1.20.x**(2026-09 最新为 v1.20.7),v1.20 系列配套 **Ceph v20.2.4(Tentacle)**,v1.19 系列配套 Ceph v19.2.6(Squid);官方支持 Kubernetes v1.31–v1.36。

### 核心组件

```shell
rook-ceph-operator   Deployment,监听 CRD 并驱动一切部署动作,整个方案的大脑
mon                  Monitor,维护集群地图与仲裁,必须为奇数个,生产至少 3 个
mgr                  Manager,提供指标、Dashboard、编排模块,建议 2 个做 HA
osd                  Object Storage Daemon,真正存数据的地方,每个裸盘一个 OSD
mds                  Metadata Server,只有 CephFS 文件存储才需要
rgw                  RADOS Gateway,提供 S3/Swift 对象接口
rook-ceph-tools      排障用的工具箱 Pod,内含全套 ceph 命令
```

### 环境要求

```shell
# 1. 至少 3 个节点(生产),每节点至少一块未格式化、未挂载的裸盘
lsblk -f                      # 确认目标磁盘没有文件系统、没有挂载点

# 2. OSD 依赖 LVM,每个节点都要装(Debian/Ubuntu;RHEL 系用 yum install lvm2)
sudo apt-get install -y lvm2

# 3. CSI 用 krbd 挂块设备;CephFS 内核客户端还需要 ceph 模块
sudo modprobe rbd && lsmod | grep rbd

# 4. 时间同步,时钟漂移会让 MON 直接拒绝工作
sudo systemctl enable --now chronyd

# 5. 放行 6789 / 3300(MON)、6800-7300(OSD)、8443(Dashboard)、9283(MGR 指标)
```

内存估算:Ceph 官方建议每块 OSD 至少 **4GB**(对应 `osd_memory_target` 默认的 4GiB),再按每 1TB 存储追加约 1GB 估算。内存不足会直接触发 OSD 被 OOM Killer 杀掉,表现为集群反复 `HEALTH_WARN`。

### 安装 Rook Operator

```shell
helm repo add rook-release https://charts.rook.io/release && helm repo update

helm install --create-namespace --namespace rook-ceph rook-ceph rook-release/rook-ceph

kubectl -n rook-ceph get pods -l app=rook-ceph-operator     # operator 是否就绪
kubectl -n rook-ceph logs deploy/rook-ceph-operator --tail=50
```

### 部署 Ceph 集群

```shell
apiVersion: ceph.rook.io/v1
kind: CephCluster
metadata:
  name: rook-ceph
  namespace: rook-ceph
spec:
  cephVersion:
    image: quay.io/ceph/ceph:v20.2.4
  dataDirHostPath: /var/lib/rook          # 存放 MON 数据与配置,必须持久
  mon:
    count: 3
    allowMultiplePerNode: false           # 单机测试时才设为 true
  mgr:
    count: 2
    modules: [{ name: pg_autoscaler, enabled: true }]
  dashboard: { enabled: true, ssl: false }
  storage:
    useAllNodes: true
    useAllDevices: false                  # 强烈建议:不要真的用「所有设备」
    deviceFilter: "^sd[b-z]$"             # 用正则圈定数据盘
    config:
      osdsPerDevice: "1"
  resources:
    osd:
      requests: { cpu: "2", memory: "4Gi" }
```

用 Helm 一次装好 operator 与集群:`helm install --create-namespace --namespace rook-ceph rook-ceph-cluster rook-release/rook-ceph-cluster --set operatorNamespace=rook-ceph`。

观察部署进度:

```shell
kubectl -n rook-ceph get cephcluster rook-ceph -o jsonpath='{.status.ceph.health}'
kubectl -n rook-ceph get pods -o wide | grep -E "osd|mon|mgr|mds|rgw"
```

### 工具箱

```shell
# 部署工具箱 Pod(只需一次)
kubectl apply -f https://raw.githubusercontent.com/rook/rook/master/deploy/examples/toolbox.yaml

# 进入工具箱,后续所有 ceph 原生命令都在这里执行
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- bash
ceph status && ceph health detail && ceph osd tree && ceph osd df
```

### 块存储(RBD)

```shell
apiVersion: ceph.rook.io/v1
kind: CephBlockPool
metadata:
  name: replicapool
  namespace: rook-ceph
spec:
  failureDomain: host                     # 副本分布到不同主机
  replicated: { size: 3, requireSafeReplicaSize: true }
```

```shell
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: rook-ceph-block
provisioner: rook-ceph.rbd.csi.ceph.com
parameters:
  clusterID: rook-ceph
  pool: replicapool
  imageFormat: "2"
  imageFeatures: layering
  csi.storage.k8s.io/provisioner-secret-name: rook-csi-rbd-provisioner
  csi.storage.k8s.io/provisioner-secret-namespace: rook-ceph
  csi.storage.k8s.io/node-stage-secret-name: rook-csi-rbd-node
  csi.storage.k8s.io/node-stage-secret-namespace: rook-ceph
  csi.storage.k8s.io/fstype: ext4
reclaimPolicy: Delete
allowVolumeExpansion: true
```

### 文件存储(CephFS)

```shell
apiVersion: ceph.rook.io/v1
kind: CephFilesystem
metadata:
  name: myfs
  namespace: rook-ceph
spec:
  metadataPool:
    replicated: { size: 3 }
  dataPools:
    - name: replicated
      replicated: { size: 3 }
  preserveFilesystemOnDelete: true        # 删除 CR 时保留数据
  metadataServer:
    activeCount: 1
    activeStandby: true                   # 需要备用 MDS 才能做 HA
```

对应的 StorageClass 使用 `rook-ceph.cephfs.csi.ceph.com`,并额外支持 `ReadWriteMany` —— 这是需要多 Pod 共享同一份文件的场景最常用的方案。

### 对象存储(RGW)

```shell
apiVersion: ceph.rook.io/v1
kind: CephObjectStore
metadata:
  name: my-store
  namespace: rook-ceph
spec:
  metadataPool:
    replicated: { size: 3 }
  dataPool:
    erasureCoded: { dataChunks: 2, codingChunks: 1 }
  preservePoolsOnDelete: true
  gateway:
    port: 80
    instances: 2
```

创建后 Rook 会生成 `rook-ceph-rgw-my-store` Service 与对应 Secret,之后用 `ObjectBucketClaim` 即可为应用自动创建桶与凭据。

### 扩容 OSD

```shell
lsblk -f                              # 1. 接入新盘,确认是裸设备

sudo sgdisk --zap-all /dev/sdb        # 2. 老盘有残留时先彻底清理
sudo wipefs -a /dev/sdb

kubectl -n rook-ceph edit cephcluster rook-ceph   # 3. 纳入新节点/新盘

kubectl -n rook-ceph get pods | grep osd          # 4. 观察新 OSD 上线
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph osd tree
```

### 升级

Rook 与 Ceph 的升级是**两个独立步骤**,顺序不能颠倒:

```shell
# 1. 先升 Rook Operator 本身
helm repo update && helm upgrade --namespace rook-ceph rook-ceph rook-release/rook-ceph --version 1.20.7
kubectl -n rook-ceph get pods -l app=rook-ceph-operator

# 2. 确认 operator 就绪后,再改 CephCluster 里的镜像版本
kubectl -n rook-ceph patch cephcluster rook-ceph --type merge \
  -p '{"spec":{"cephVersion":{"image":"quay.io/ceph/ceph:v20.2.4"}}}'

# 3. 观察守护进程逐个滚动升级
kubectl -n rook-ceph get pods -w
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph versions
```

### 卸载

```shell
kubectl get pvc -A | grep rook-ceph                  # 1. 确认数据不再需要
kubectl -n rook-ceph delete cephcluster rook-ceph    # 2. 默认保留 /var/lib/rook 与磁盘数据

# 3. 删除 CRD 与命名空间
kubectl delete -f https://raw.githubusercontent.com/rook/rook/master/deploy/examples/crds.yaml
helm uninstall -n rook-ceph rook-ceph && kubectl delete namespace rook-ceph

# 4. 每个节点上清理残留(危险,确认后再执行)
sudo rm -rf /var/lib/rook
sudo sgdisk --zap-all /dev/sdb && sudo ceph-volume lvm zap /dev/sdb --destroy
```

### 排障

```shell
kubectl -n rook-ceph exec -it deploy/rook-ceph-tools -- ceph health detail   # 1. 不健康的具体项

kubectl -n rook-ceph get pods | grep osd                                    # 2. OSD 起不来
kubectl -n rook-ceph logs <osd-pod> --tail=200

kubectl -n rook-ceph get pod -l app=rook-ceph-osd-prepare                   # 3. OSD 准备阶段失败
kubectl -n rook-ceph logs <osd-prepare-pod>

ceph pg stat && ceph pg dump_stuck                                          # 4. PG 卡住

kubectl -n rook-ceph logs deploy/csi-rbdplugin-provisioner -c csi-provisioner --tail=100   # 5. 挂载失败
kubectl -n rook-ceph logs deploy/rook-ceph-operator --tail=200              # 6. 编排决策
```

### 注意

1. **OSD 所在磁盘必须没有文件系统、没有分区、没有 LVM 残留**。这是 OSD 准备失败的头号原因。二手盘、重装过的盘尤其容易踩:必须 `sgdisk --zap-all` + `wipefs -a`,必要时用 `ceph-volume lvm zap` 清掉残留的 LVM 标签,否则 OSD 会反复重启。
2. **`useAllDevices: true` 非常危险**。它会试图把节点上所有块设备都变成 OSD —— 包括系统盘。务必用 `useAllDevices: false` 加 `deviceFilter` 正则圈定范围,并在上线前用 `lsblk` 逐一确认。
3. **PG 数量必须与 OSD 数量匹配**。每个 OSD 承载的 PG 数建议在 **100 左右**:太少会出现 `too few PGs per OSD` 告警且性能上不去,太多则每个 OSD 的内存与 CPU 开销暴涨。开启 `pg_autoscaler` 让 Ceph 自动调优,但**扩容 OSD 后要给重平衡留出时间**,期间性能会明显下降。
4. **故障域(`failureDomain`)决定能扛住什么级别的故障**。默认 `host` 表示三副本分布在三台主机上,能扛单机故障;若三块 OSD 在同一台机器而故障域设成 `osd`,那台机器一挂数据就全没了。故障域**在池创建后无法修改**,建池前必须想清楚。
5. **MON 数量必须是奇数,生产至少 3 个**。2 个 MON 的仲裁能力比 1 个还差 —— 挂掉任意一个整个集群就不可写。测试环境可以用 1 个,但从 1 个扩到 3 个并非无缝操作,不如一开始就规划好。
6. **Rook 与 Ceph 必须分别升级,且顺序是先 Rook 后 Ceph**。Rook 的每个版本都对应一组明确支持的 Ceph 版本,跨版本升级前必须查兼容矩阵;同时**升级大版本不能跳跃**,Ceph 的规则是先升到中间版本再升目标版本。
7. **卸载 Rook 默认不会删除磁盘上的数据**,这既是保护也是坑:残留的 LVM 与 BlueStore 数据会让下次部署在同一批盘上失败。反之如果误删了 CRD 与 `/var/lib/rook`,MON 的集群地图也会一起丢失,数据将无法再被识别。
8. **内存不足会让 OSD 被 OOM Killer 杀死**,而不是给出「内存不够」的清晰报错,表现是 OSD 反复重启、集群反复告警。每块 OSD 按 4GB 起步估算,并给 OSD Pod 设置 `resources.requests.memory`,让调度器参与判断。
9. **`size: 1` 的池等于没有冗余**,`requireSafeReplicaSize: true` 就是为了拦住它。单节点测试集群不得不这么做时,必须清楚这只是「能跑」,不是「能用」。
10. **CSI 的 Secret 由 Rook 自动创建,但名字是固定约定**(如 `rook-csi-rbd-provisioner`、`rook-csi-rbd-node`)。自建 StorageClass 时把 Secret 名字写错,PV 会一直 Pending 且事件提示含糊,先核对 Secret 是否真的存在。
11. **`dataDirHostPath`(`/var/lib/rook`)所在分区必须有足够空间与持久性**。它存放 MON 数据与集群配置,是宿主机路径而非 PVC,节点重建导致它丢失,集群就可能无法恢复。
12. **所有节点必须时间同步**。MON 之间时钟漂移超过阈值会直接拒绝服务,且报错往往指向「认证失败」这类误导性信息,排查时容易走弯路。
13. **单节点测试必须显式设置 `allowMultiplePerNode: true`**,否则 MON 会一直 Pending。但这只是让集群「起得来」,没有任何高可用可言。
14. **Rook 部署的 Dashboard 默认无密码且走 HTTP**。暴露到集群外之前必须启用 `ssl` 并配置认证,否则等同于把整个存储集群的管理界面公开。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `ceph` — Rook 编排的底层分布式存储系统
- `csi` — Rook 通过 CSI 驱动向集群供存储
- `storageclass` — 定义 RBD/CephFS 的供给参数
- `longhorn` — 更轻量的分布式块存储方案
- `openebs` — 另一套容器原生存储方案

### 参考链接

- [Rook 官方文档](https://rook.io/docs/rook/latest/)
- [Rook Ceph 快速开始](https://rook.io/docs/rook/latest/Getting-Started/quickstart/)
- [Rook 存储配置(块/文件/对象)](https://rook.io/docs/rook/latest/Storage-Configuration/)
- [Rook 升级指南](https://rook.io/docs/rook/latest/Upgrade/ceph-upgrade/)
