csi
===

Kubernetes容器存储接口:让任意存储系统以标准插件方式接入集群

## 补充说明

**CSI(Container Storage Interface)** 是一套由 Kubernetes、Mesos、Docker 等社区共同制定的存储插件规范。它把「存储如何创建、挂载、扩容、打快照」从 Kubernetes 核心代码里剥离出来,变成一组独立的 gRPC 接口 —— 任何存储厂商只要实现这些 RPC,就能为集群提供卷的全生命周期管理,不必把代码合进 Kubernetes 主干。

在 CSI 出现之前,存储插件都是 in-tree 的:代码写在 `kubernetes/kubernetes` 仓库里,跟着 Kubernetes 的发版节奏走,一个驱动的 bug 要等下一个 Kubernetes 版本才能修。CSI 把这条链路彻底解开 —— 驱动可以独立发版、独立升级,厂商也不必再学 Kubernetes 的内部 API。

当前**所有主流存储都已 CSI 化**:云厂商云盘、Ceph、NFS、本地盘、对象存储网关无一例外。自 Kubernetes v1.31 起,曾内置的 in-tree 云存储插件(AWS EBS、Azure Disk/File、GCE PD、OpenStack Cinder、vSphere)与 Ceph RBD/CephFS 卷插件已被移除,新集群只能用 CSI 驱动。因此今天「给集群装存储」几乎等同于「装一个 CSI 驱动」。

本页讲的是 **CSI 这套机制本身**;具体某款驱动的部署运维请见 `longhorn`、`rook`、`ceph`、`openebs`、`nfs-provisioner` 等页。

### CSI 的两个角色

一个完整的 CSI 驱动由两部分组成,职责与部署形态都不同:

```shell
Controller 插件(控制面)  负责卷的创建/删除/挂载到节点/扩容/快照
                        通常以 Deployment 或 StatefulSet 部署,可多副本,不要求每节点一份
Node 插件(数据面)        负责把卷挂载进容器所在节点,并上报卷状态
                        必须以 DaemonSet 部署,每个节点都要有一份
```

Controller 插件可以只跑在部分节点上;Node 插件**必须覆盖所有可能运行 Pod 的节点**,少一个节点,该节点上的 Pod 就会卡在 `ContainerCreating`。

### 核心 sidecar 容器

CSI 驱动本身只实现 gRPC,真正与 Kubernetes API 打交道的是官方提供的一组 sidecar 容器。它们和驱动打包在**同一个 Pod** 里,通过共享的 unix socket 通信:

```shell
external-provisioner     监听 PVC,调用 CreateVolume/DeleteVolume,把结果写成 PV
external-attacher        监听 VolumeAttachment,调用 ControllerPublish/Unpublish
external-resizer         监听 PVC 扩容请求,调用 ControllerExpandVolume
external-snapshotter     监听 VolumeSnapshotContent,调用 CreateSnapshot/DeleteSnapshot
node-driver-registrar    把驱动注册到 kubelet 的 plugin registry,让 kubelet 认得它
livenessprobe            暴露 /healthz 供探针使用
```

sidecar 与驱动的 socket 路径由 `--csi-address` 指定,默认一般是 `/csi/csi.sock`(controller 侧)与 `/csi/csi.sock`(node 侧),由 emptyDir 卷在两个容器间共享。

### 卷的生命周期与调用链

一次 PVC 从创建到被 Pod 挂载,调用链大致是:

```shell
1. 用户创建 PVC
2. external-provisioner 发现未绑定的 PVC → 调用 CSI 的 CreateVolume
3. 创建 PV 对象(external-provisioner 直接写 API Server),PVC 变为 Bound
4. 创建 Pod,调度器选定节点
5. external-attacher 创建 VolumeAttachment → 调用 ControllerPublishVolume(挂到节点)
6. 节点上的 kubelet 调用 NodeStageVolume(格式化 + 挂到全局目录)
7. kubelet 调用 NodePublishVolume(从全局目录 bind mount 进容器)
```

卸载是逆过程。排查挂载类故障时,**先确定卡在第几步**,再去看对应的 sidecar 日志,而不是盲目看驱动日志。

### 常用查看命令

```shell
# 查看集群里已注册的 CSI 驱动
kubectl get csidrivers
kubectl get csidrivers -o wide

# 查看驱动详情,关注 attachRequired 与 podInfoOnMount
kubectl get csidriver ebs.csi.aws.com -o yaml

# 查看 CSI 相关的 Pod(DaemonSet 与 Deployment 两类都要看)
kubectl get pods -A | grep -i csi
kubectl get daemonset -A | grep -i csi
kubectl get statefulset -A | grep -i csi

# 查看卷挂载对象(卡在挂载时的第一现场)
kubectl get volumeattachment
kubectl describe volumeattachment <name>

# 查看节点的 CSI 插件是否注册成功
ls /var/lib/kubelet/plugins_registry/
ls /var/lib/kubelet/plugins/
```

### CSIDriver 对象

CSI 驱动部署时会创建(`kubectl apply`)或由 sidecar 自动注册一个集群级的 `CSIDriver` 对象,它是驱动与 kubelet 之间的契约:

```shell
apiVersion: storage.k8s.io/v1
kind: CSIDriver
metadata:
  name: csi.example.com          # 必须与驱动 GetPluginInfo 返回的名称完全一致
spec:
  attachRequired: true           # 为 true 时才会走 ControllerPublishVolume 流程
  podInfoOnMount: false          # 为 true 时把 Pod 信息透传给 NodePublishVolume
  fsGroupPolicy: File            # File / ReadWriteOnceWithFSType / None
  volumeLifecycleModes:
    - Persistent                 # 支持普通 PV/PVC 用法
    - Ephemeral                  # 支持 Pod 内联临时卷
  storageCapacity: false         # 是否上报容量信息给调度器
```

`attachRequired: false` 适用于不需要「先挂到节点再挂进容器」两步的存储(典型是 NFS、CephFS 这类网络文件系统),这类驱动会少一个 external-attacher 与一堆 VolumeAttachment;而块设备类云盘必须为 `true`。

### Node 插件的 Deployment 要点

Node 插件是 CSI 驱动最容易部署出问题的地方,一段典型的 DaemonSet 片段:

```shell
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: csi-example-node
spec:
  selector:
    matchLabels:
      app: csi-example-node
  template:
    spec:
      hostNetwork: true                          # 很多驱动需要
      tolerations:                               # 必须容忍所有污点,否则节点上的 Pod 挂不上卷
        - operator: Exists
      containers:
        - name: node-driver-registrar
          image: registry.k8s.io/sig-storage/csi-node-driver-registrar:v2.18.0
          args:
            - --csi-address=/csi/csi.sock
            - --kubelet-registration-path=/var/lib/kubelet/plugins/csi.example.com/csi.sock
          volumeMounts:
            - name: plugin-dir
              mountPath: /csi
            - name: registration-dir
              mountPath: /registration
        - name: csi-example
          image: example/csi-driver:1.0.0
          securityContext:
            privileged: true                     # 多数驱动需要
          volumeMounts:
            - name: plugin-dir
              mountPath: /csi
            - name: pods-mount-dir
              mountPath: /var/lib/kubelet/pods
              mountPropagation: Bidirectional    # 关键:必须双向传播
            - name: device-dir
              mountPath: /dev
      volumes:
        - name: plugin-dir
          hostPath:
            path: /var/lib/kubelet/plugins/csi.example.com
            type: DirectoryOrCreate
        - name: registration-dir
          hostPath:
            path: /var/lib/kubelet/plugins_registry
            type: Directory
        - name: pods-mount-dir
          hostPath:
            path: /var/lib/kubelet/pods
            type: Directory
        - name: device-dir
          hostPath:
            path: /dev
```

`mountPropagation: Bidirectional` 少写会导致容器里挂载的卷无法被 kubelet 感知,表现为 Pod 一直 `ContainerCreating` 但驱动日志毫无异常。

### CSI 内联临时卷

除了 PV/PVC,CSI 还支持在 Pod 里直接声明一个用完即弃的卷,不经过 PVC:

```shell
apiVersion: v1
kind: Pod
metadata:
  name: csi-inline-demo
spec:
  containers:
    - name: app
      image: nginx:1.27
      volumeMounts:
        - name: scratch
          mountPath: /scratch
  volumes:
    - name: scratch
      csi:
        driver: inline.storage.example.com      # 驱动的 CSIDriver 必须声明 Ephemeral 模式
        fsType: ext4
        volumeAttributes:
          size: 1Gi
```

内联卷随 Pod 创建与销毁,不参与调度器的存储拓扑决策,适合缓存、临时中间结果这类场景。

### in-tree 到 CSI 的迁移

老集群升级时会遇到 in-tree 卷类型(PV 里写的是 `awsElasticBlockStore`、`rbd`、`cephfs` 等)。Kubernetes 提供了 CSI 迁移(CSI Migration)机制,用 `CSIMigration*` 特性门控把 in-tree 的 API 调用翻译成 CSI 调用:

```shell
# 迁移进度(GA 时间线)
Core CSI Migration        v1.25 GA
AWS EBS CSI Migration     v1.25 GA
GCE PD CSI Migration      v1.25 GA
Azure Disk CSI Migration  v1.24 GA
Azure File CSI Migration  v1.26 GA
vSphere CSI Migration     v1.26 GA
Cinder CSI Migration      v1.24 GA
```

Ceph 的 `rbd` 与 `cephfs` 两类 in-tree 卷在 v1.28 被废弃、v1.31 与插件一起移除,**且没有提供 CSI 迁移**,必须手工改写到 ceph-csi。云厂商的 in-tree 插件同样在 v1.31 移除,存量 PV 仍能通过翻译层工作,但新建卷必须走 CSI StorageClass。

### 排障

```shell
# 1. Pod 卡在 ContainerCreating,先看事件里的挂载报错
kubectl describe pod <pod> | tail -30

# 2. 挂载链条的第一现场是 VolumeAttachment
kubectl get volumeattachment | grep -i <pv-name>
kubectl describe volumeattachment <name>

# 3. Controller 侧 sidecar 日志(provision/attach/扩容/快照都看这里)
kubectl -n <driver-ns> logs deploy/csi-example-controller -c csi-provisioner --tail=100
kubectl -n <driver-ns> logs deploy/csi-example-controller -c csi-attacher --tail=100

# 4. Node 侧日志
kubectl -n <driver-ns> logs daemonset/csi-example-node -c csi-example --tail=100

# 5. 确认驱动是否注册到某个节点
kubectl get csinode
kubectl get csinode <node> -o yaml

# 6. 节点上的 kubelet 日志(挂载失败往往在这里有原文)
journalctl -u kubelet -n 100 --no-pager | grep -i csi
```

### 注意

1. **CSI 驱动不是单个容器,而是「驱动 + 一组 sidecar」的 Pod**。排查时先判断问题属于哪个 sidecar 的职责:创建卷看 external-provisioner,挂载看 external-attacher 与 node 插件,扩容看 external-resizer,快照看 external-snapshotter。看错容器会白费很多时间。
2. **Node 插件必须以 DaemonSet 覆盖所有工作节点,并且容忍所有污点**。DaemonSet 忘了加 `tolerations: operator: Exists`,新扩容出来的节点(带 `node.kubernetes.io/not-ready` 等污点)就不会有 node 插件,该节点上所有带卷的 Pod 全部卡住。
3. **`mountPropagation: Bidirectional` 是 node 插件的隐形刚需**。缺失时驱动看着一切正常,但集群就是挂不上卷;同时它要求宿主机挂载点所在文件系统支持挂载传播(overlayfs 根目录的部分发行版需要额外处理)。
4. **sidecar 版本与 Kubernetes 版本存在兼容矩阵,不能随意升级**。官方每个 sidecar 仓库的 README 都附有「Compatibility」表格,列明各版本支持的 Kubernetes 最小/最大版本。升级集群前必须逐项核对,否则会出现 sidecar 启动即崩溃或静默不工作的情形。
5. **升级 CSI 驱动必须控制并发,不能让全部 node 插件同时重启**。node 插件重启期间该节点无法挂载/卸载卷,正在运行的 Pod 可能被误判为卷异常。生产环境应通过 DaemonSet 的 `updateStrategy.rollingUpdate.maxUnavailable: 1` 逐个滚动。
6. **`CSIDriver` 对象的 `name` 必须与驱动 `GetPluginInfo` 返回的名字逐字符一致**。不一致时 kubelet 认不到驱动,而 `kubectl get csidrivers` 里那个错误的条目看起来毫无异常,极难发现。
7. **`attachRequired: false` 与 `true` 决定了整条挂载链路**,写错会导致 VolumeAttachment 永远不被创建或永远不被清理。文件系统类存储(NFS/CephFS)通常应为 `false`,块设备类应为 `true`。
8. **残留的 VolumeAttachment 会阻塞卷被重新挂载**。节点异常下线后,VolumeAttachment 可能停留在 `attached: true`,新 Pod 无法挂载同一块云盘。确认旧节点确实失联后,才可手工删除该对象。
9. **CSI 驱动几乎都需要 `privileged: true` 与宿主机路径挂载**,这与 PodSecurity 的 `baseline`/`restricted` 策略直接冲突。启用强制 PodSecurity 前必须为驱动命名空间打上 `pod-security.kubernetes.io/enforce: privileged` 标签,否则驱动无法部署。
10. **存储容量不隔离,CSI 的 `storageCapacity` 也常被忽略**。即使驱动上报容量,调度器也只是参考;底层存储池写满时,所有 PVC 会同时开始报错,而不是优雅地拒绝新申请。
11. **`kubectl get csidrivers` 里出现同名条目不代表驱动真的在跑**。CSIDriver 是静态对象,驱动 Pod 挂了它依然存在,必须结合 Pod 状态与 `csinode` 一起判断。
12. **卸载 CSI 驱动前必须先处理完所有 PVC 与 VolumeAttachment**。直接删 DaemonSet 会让节点上已挂载的卷无法正常卸载,后续该节点上的 Pod 会持续报挂载冲突。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `storageclass` — 声明使用哪个 CSI 驱动供给存储
- `pvc` — 触发 CSI 供给与挂载的申请对象
- `pv` — CSI 驱动创建出的持久卷
- `volume-snapshot` — 基于 CSI 的卷快照扩展 API

### 参考链接

- [CSI 规范与文档](https://kubernetes-csi.github.io/docs/)
- [Kubernetes 中的 CSI 卷](https://kubernetes.io/docs/concepts/storage/volumes/#csi)
- [CSI 驱动列表](https://kubernetes-csi.github.io/docs/drivers.html)
- [sidecar 兼容性矩阵](https://kubernetes-csi.github.io/docs/sidecar-containers.html)
- [CSI 迁移说明](https://kubernetes.io/docs/concepts/storage/volumes/#csi-migration)
