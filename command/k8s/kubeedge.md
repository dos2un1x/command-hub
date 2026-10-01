kubeedge
===

CNCF毕业的边缘计算框架,把Kubernetes控制面延伸到边缘节点

## 补充说明

**KubeEdge** 是 CNCF 的**毕业级(Graduated)项目**(2024-10-15 宣布毕业,是首个从 CNCF 毕业的边缘计算项目),由华为在 2018 年开源,当前最新版本 v1.23.1(2026-07-15)。

它解决的问题很具体:**边缘节点网络不稳定、资源受限、数量庞大**,而原生 Kubernetes 的 kubelet 需要与控制面保持长连接、定期心跳,断网时节点会被判定为 NotReady 并触发驱逐,边缘业务直接停摆。

KubeEdge 的做法是在云侧和边侧各放一组组件,用一条 **WebSocket 长连接**取代 kubelet 与 apiserver 的通信,并在边缘节点上**本地缓存全部元数据**,让边缘在断连时仍能自治运行。

### 架构:CloudCore 与 EdgeCore

```shell
CloudCore(云端,以 Pod 形式跑在 K8s 集群里)
  CloudHub           WebSocket 服务端,与所有 EdgeHub 保持连接,负责云到边的消息下发
  EdgeController     扩展的控制器,管理边缘节点与 Pod 的元数据下发
  DeviceController   设备管理控制器,同步设备元数据与状态
  DynamicController  动态配置下发(与 ConfigMap/Secret 相关的增量同步)
  SyncController     配合 ObjectSync/ClusterObjectSync 保证边缘侧资源最终一致
  CloudStream        提供 kubectl logs/exec 的隧道能力
  TaskManager        节点任务(升级、镜像预拉取)的云端调度(默认关闭,需显式开启)

EdgeCore(边缘节点,以 systemd 服务或容器形式运行)
  EdgeHub             WebSocket 客户端,同步云端资源、上报节点与设备状态
  Edged               边缘节点上的容器管理组件,替代 kubelet 的角色
  MetaManager         Edged 与 EdgeHub 之间的消息处理与本地元数据缓存(SQLite)
  DeviceTwin          设备状态存储与云端同步
  EventBus            MQTT 客户端(通常对接 mosquitto)
  ServiceBus          允许云端组件访问边缘的 HTTP/REST 服务
```

注意 CloudCore 与 EdgeCore 是**两组组件的集合**,不是单个进程名。排障时要先确认问题在云侧还是边侧,再看具体是哪个子组件。

### 安装:keadm

`keadm` 是 KubeEdge 的安装工具,云侧 `init`、边侧 `join`:

```shell
# 云端:初始化 CloudCore(自 v1.11 起内部使用 Helm chart 部署)
keadm init --advertise-address="<CloudCore-公网IP>" \
  --kubeedge-version=v1.23.1 \
  --kube-config=/root/.kube/config

# 渲染清单而不实际安装(便于审计与 GitOps)
keadm manifest generate --advertise-address="<IP>" > cloudcore.yaml

# 云端:取出边缘节点加入所需的 token
keadm gettoken

# 边缘节点:加入集群(--cloudcore-ipport 必填)
keadm join --cloudcore-ipport="<CloudCore-IP>:10000" \
  --token=<上一步的 token> \
  --kubeedge-version=v1.23.1

# 重置
keadm reset --kube-config=$HOME/.kube/config   # 云端
keadm reset                                    # 边侧,停止 edgecore
```

`keadm` 不会替你安装 Kubernetes 或容器运行时 —— 边缘节点上的 containerd/docker 需要预先准备好。云边版本应保持一致。

### 端口与网络

```shell
10000/tcp   CloudHub 的 WebSocket 端口,边缘节点必须可达(最关键的端口)
10001/tcp   CloudHub 的 QUIC 端口(启用 QUIC 时)
10002/tcp   CloudCore 的 HTTPS 服务,边缘节点需要可达
10003/tcp   CloudStream 的 streamPort,用于 kubectl logs/exec 的隧道
10004/tcp   隧道数据端口(CloudCore 的隧道服务)
```

官方要求边缘节点至少能访问 CloudCore 的 **10000 与 10002**。这两个端口不通时,`keadm join` 会卡在等待 CSR 签发的阶段,现象是边缘节点一直不出现。

```shell
kubectl get nodes
kubectl -n kubeedge get pod
kubectl -n kubeedge logs deploy/cloudcore --tail=100
sudo systemctl status edgecore
sudo journalctl -u edgecore -f
```

### 边缘自治

这是 KubeEdge 最核心的能力,机制是 **MetaManager + 本地 SQLite**:

```shell
1. Edged 不直接访问 apiserver,而是通过 MetaManager 读写
2. MetaManager 把元数据写入本地 SQLite(/var/lib/kubeedge/edgecore.db)
3. 与云端的连接状态由 EdgeHub 通过 NodeConnection 消息通知 MetaManager
4. 断连时,读操作走本地缓存,已运行的 Pod 不受影响,继续运行
5. 恢复连接后按 resourceVersion 对账,做增量同步
```

**但要注意自治的边界**:

```shell
断连期间能做的    已有 Pod 继续运行;本地查询 Pod/ConfigMap 等元数据;设备数据继续采集
断连期间不能做的  创建新的 Pod(无法从云端拿到调度结果);更新 Deployment 副本数
                  被驱逐的 Pod 无法重建;kubectl logs/exec 完全不可用
```

换句话说,边缘自治保证的是「**已经跑起来的东西不掉**」,不是「边缘可以独立编排」。需要边缘侧独立决策的场景,应把决策逻辑放在边缘应用内部,或使用边缘侧的轻量编排方案。

### 设备接入:Device CRD

KubeEdge 通过 CRD 把设备建模成 Kubernetes 资源:

```shell
devices.kubeedge.io/v1beta1    Device       设备实例(指向一个 DeviceModel 与一个节点)
devices.kubeedge.io/v1beta1    DeviceModel  设备型号(属性、协议、访问方式)
apps.kubeedge.io/v1alpha1      EdgeApplication  边缘应用的分发与差异化配置
```

```shell
apiVersion: devices.kubeedge.io/v1beta1
kind: Device
metadata:
  name: sensor-01
  namespace: default
spec:
  deviceModelRef:
    name: sensor-model
  nodeName: edge-node-01
  protocol:
    protocolName: modbus
    configData:
      ip: 192.168.1.10
      port: 502
  properties:
    - name: temperature
      collectCycle: 10000
      reportCycle: 60000
      reportToCloud: true
```

**v1beta1 自 KubeEdge v1.15 起取代 v1alpha2,两者不兼容**,照旧文档写的 v1alpha2 清单无法直接使用。另外 Device CRD 只描述设备,**真正读写设备协议的 device mapper(modbus/bluetooth/opcua 等)需要单独部署**,不装 mapper 时 Device 对象的状态不会更新。

### 边缘节点运维:节点任务

大规模边缘节点不能靠人一台台 SSH,`operations.kubeedge.io` 组提供了两个批量任务 CRD:

```shell
operations.kubeedge.io/v1alpha1   NodeUpgradeJob  批量远程升级边缘节点(支持回滚)
operations.kubeedge.io/v1alpha1   ImagePrePullJob 批量预拉取镜像 —— 弱网场景的关键能力
```

```shell
apiVersion: operations.kubeedge.io/v1alpha1
kind: ImagePrePullJob
metadata:
  name: prepull-app
spec:
  imagePrePullTemplate:
    images:
      - registry.example.com/app:v1.2.3
    nodeNames:
      - edge-node-01
      - edge-node-02
    concurrency: 2
    failureTolerate: "0.3"
    timeoutSeconds: 180
    retryTimes: 1
```

`ImagePrePullJob` 的价值在于**把镜像拉取从「部署时」提前到「网络空闲时」**,避免弱网边缘节点在发布窗口里集体拉镜像失败。

### 注意

1. **CloudCore/EdgeCore 是组件集合,不是两个进程名**。排障时先分清云侧还是边侧,再定位到 CloudHub、EdgeController、EdgeHub、Edged、MetaManager 等具体组件,否则日志都不知道该去哪看。
2. **边缘节点断连时只能「维持」,不能「新建」**。已有 Pod 会继续运行(这是 MetaManager 本地缓存的功劳),但扩容、滚动更新、被驱逐后重建都不会发生。做容量规划时必须假设边缘在最坏情况下长期保持断连前的状态。
3. **断连期间云端看到的节点状态是陈旧的**。节点会因为没有心跳而被标记异常,但边缘上的业务是好的 —— 监控告警要能区分「真的挂了」和「只是断连」,否则每次网络抖动都会触发误报。
4. **`keadm init` 自 v1.11 起改用 Helm 部署 CloudCore**。老教程里的进程模式(`keadm beta init` 或更早的二进制启动方式)已经变化,对照旧文档操作会得到完全不同的部署形态。需要旧行为时用 `keadm deprecated init`。
5. **云边版本必须匹配**。CloudCore 与 EdgeCore 版本不一致时,WebSocket 协议与消息格式可能不兼容,表现为连接建立后立刻断开或资源同步不完整。
6. **端口 10000 与 10002 必须可达**。这是 `keadm join` 卡住最常见的原因:token 正确、命令无误,但节点就是不出现,实际是防火墙只放通了 6443。
7. **节点任务 CRD 在 v1.21 换了版本**。节点升级与镜像预拉取默认启用 `v1alpha2`,继续用 `v1alpha1` 需要显式开启 `disableNodeTaskV1alpha2` 特性门,且官方计划在 v1.23 之后移除 v1alpha1 相关代码 —— 照旧文档写的 `v1alpha1` 清单在新版本上会失效。
8. **节点任务模块默认关闭**。CloudCore 的 `taskManager` 与 EdgeCore 的 `modules.taskManager` 都需要显式开启(默认 false),不开时 `ImagePrePullJob`/`NodeUpgradeJob` 创建后一直不动,不报错也不执行。
9. **Device CRD 的版本坑**。v1beta1 自 v1.15 起取代 v1alpha2 且不兼容,大量中文教程仍停留在 v1alpha2;此外 udev/modbus 等协议需要额外部署对应 device mapper,只创建 Device 对象不会有任何数据。
10. **EdgeCore 重启可能产生重复 Pod 记录**。本地 SQLite(`/var/lib/kubeedge/edgecore.db`)保存的 Pod 引用在异常重启后可能与云端不一致,已知问题会导致同名 Pod 重复出现;此时需要清理本地库与孤儿 Pod,而不是在云端反复删除。
11. **`kubectl logs`/`exec` 走 CloudStream,不是直连**。它依赖 10003/10004 端口的隧道,链路比普通集群长得多,弱网下超时是常态;排障优先看边缘节点本地的 `journalctl -u edgecore` 与容器运行时日志。
12. **边缘场景必须考虑镜像预加载**。弱网或按流量计费的链路上,边缘发布失败大多是镜像拉取失败。用 `ImagePrePullJob` 提前拉取,并把镜像同步纳入发布流程,而不是等 Deployment 创建后干等。
13. **不是所有 Kubernetes 特性都在边缘可用**。`Edged` 只实现了 kubelet 的一个子集,本地临时存储、部分探针与资源管理行为存在差异;上线前应逐项验证业务真正依赖的特性,而不是假设「原生 API 一致就行为一致」。
14. **静态 Pod 与节点上的其他组件要单独管理**。边缘节点上通常还跑着 YurtHub 之类的同类组件(见 `openyurt`),两者同时接管 kubelet 的通信会造成难以定位的冲突,同一节点上不要混用两套边缘自治方案。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kubelet` — 边缘侧由 Edged 承担其职责
- `containerd` — 边缘节点的容器运行时
- `crictl` — 边缘节点上排查容器的命令行
- `openyurt` — 另一种边缘自治方案(改造既有集群)
- `superedge` — 已停更的边缘框架,选型时请避开
- `akri` — 边缘设备接入框架,可与 KubeEdge 组合
- `k3s` — 常用于边缘侧的轻量发行版

### 参考链接

- [KubeEdge 官方文档](https://kubeedge.io/docs/)
- [KubeEdge 架构:CloudHub](https://kubeedge.io/docs/architecture/cloud/cloudhub)
- [使用 keadm 部署](https://kubeedge.io/docs/setup/install-with-keadm)
- [Device CRD 文档](https://kubeedge.io/docs/concept/device/device_crds/)
- [KubeEdge GitHub 仓库](https://github.com/kubeedge/kubeedge)
- [KubeEdge 毕业公告(CNCF,2024-10-15)](https://www.cncf.io/announcements/2024/10/15/cloud-native-computing-foundation-announces-kubeedge-graduation/)
