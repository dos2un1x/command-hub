vcluster
===

在宿主集群的命名空间里跑一套完整的 Kubernetes 控制面,给租户一个「自己的集群」

## 补充说明

**vcluster** 由 Loft Labs 开源(Apache-2.0),当前最新版本为 **v0.37.1(2026-09-14)**,项目活跃。它的核心思路是:**在每个租户的命名空间里运行一个轻量的 Kubernetes 控制面(默认是 k3s 发行版)**,租户拿到的 kubeconfig 指向这个虚拟控制面,可以自己建 CRD、自己管 RBAC、自己装 Operator,而**工作负载最终仍然跑在宿主集群的节点上**。

它常被拿来与「命名空间 + RBAC + ResourceQuota」比较,差别在于 API 层面:

```shell
方案             独立 API Server   独立 CRD   独立 RBAC   独立集群级资源   计算隔离
命名空间多租户    否                否         部分        否               无
vcluster         是                是         是          是(虚拟集群内可见) 无
独立集群         是                是         是          是               有
```

也就是说,vcluster 把**API 层面的隔离**做到了接近独立集群的程度,但**没有增加计算与内核层面的隔离**。这个边界必须讲清楚,否则容易高估它的安全性。

> Loft Labs 另有商业产品 vCluster Platform(多集群管理、SSO、策略),开源 chart 与它是两回事,本文只讲开源部分。

### 安装与创建

CLI 负责创建、连接与切换上下文,底层是 Helm:

```shell
# 安装 CLI(macOS 示例)
brew install loft-sh/tap/vcluster
vcluster version

# 创建一个虚拟集群(会自动创建命名空间并连接进去)
vcluster create my-vcluster --namespace team-a

# 创建的等价 Helm 方式
helm repo add loft-sh https://charts.loft.sh
helm repo update
helm install my-vcluster loft-sh/vcluster --namespace team-a --create-namespace
```

常用子命令:

```shell
vcluster create <name>       创建虚拟集群(--connect 默认 true,创建后自动连接)
vcluster connect <name>      切换到虚拟集群的 kube context(vcluster_<name>)
vcluster disconnect          切回宿主集群 context
vcluster list                列出当前 kubeconfig 里可见的虚拟集群
vcluster delete <name>       删除虚拟集群
```

创建后可用的关键 flag:

```shell
--namespace <ns>             宿主集群中的命名空间
--distro k3s|k0s|k8s         虚拟控制面的发行版,默认 k3s
--chart-name / --chart-repo  指定 chart 名称与仓库
--chart-version              锁定 chart 版本(生产环境建议显式锁定)
-f values.yaml               传入自定义 values
--expose                     为虚拟控制面创建 LoadBalancer 以暴露端点
--isolate                    让工作负载调度与宿主隔离(配合节点选择器)
```

### 架构

```shell
控制面 Pod              每个 vcluster 一个 StatefulSet,里面跑 API Server、控制器、syncer
backingStore            默认 sqlite 存在容器内,可换成外置 etcd(生产建议)
syncer                  常驻进程,负责把资源在虚拟集群与宿主命名空间之间双向同步
CoreDNS                 每个虚拟集群自带一套 DNS,解析的是虚拟集群内的服务名
```

虚拟集群的 API Server 是**真正独立的**(k3s 嵌入的 apiserver),因此:

```shell
kubectl get crd            在虚拟集群里能看到/创建自己的 CRD
kubectl get clusterrole    虚拟集群内的集群级资源只存在于虚拟集群
kubectl get nodes          会看到虚拟节点(除非开启 private nodes)
```

### 同步策略:决定哪些资源是「真的」

这是 vcluster 最需要先搞清楚的一节。虚拟集群里创建的多数资源**不是自动落到宿主集群的**,要由 syncer 按配置同步。

默认**开启**的同步(`sync.toHost`,虚拟 → 宿主):

```shell
services               虚拟集群的 Service 会在宿主命名空间创建对应资源
endpoints / endpointSlices
persistentVolumeClaims  PVC 落到宿主,由宿主 StorageClass 供给
configMaps             all: false,只同步被挂载用到的那部分
secrets                all: false,同上
pods                   核心:Pod 被同步到宿主命名空间并真正调度到宿主节点
```

默认**关闭**的同步(`sync.toHost`,需要显式打开):

```shell
ingresses              虚拟集群里的 Ingress 默认不会在宿主生效
gatewayApi             HTTPRoute / Gateway / TLSRoute 等
networkPolicies        虚拟集群里写的 NetworkPolicy 默认不生效
serviceAccounts
storageClasses
persistentVolumes
podDisruptionBudgets
priorityClasses
namespaces
volumeSnapshots / volumeSnapshotContents
resourceClaims / resourceClaimTemplates
```

宿主 → 虚拟(`sync.fromHost`)的默认值:

```shell
events: true
storageClasses / csiDrivers / csiNodes / csiStorageCapacities: auto
   (开启虚拟调度器时自动启用)
nodes / secrets / configMaps / ingressClasses / gatewayClasses /
runtimeClasses / priorityClasses: false
```

自定义资源(CRD 的实例)也**不在默认同步范围内**,需要逐条声明:

```shell
sync:
  toHost:
    customResources:
      certificates.cert-manager.io:
        enabled: true
      certificaterequests.cert-manager.io/v1:   # 可指定版本,不写则用 storage version
        enabled: true
```

关于自定义资源同步的硬约束:

```shell
1. 对应的 CRD 必须已经存在于宿主集群,vcluster 会把它复制进虚拟集群
2. 只支持命名空间级资源,集群级资源不支持
3. 同一个 CRD 只能指定一个版本,写多个会导致虚拟集群启动失败
4. 开关的生效时机是控制面重启/滚动,不是热生效
5. 同一个资源类型不能同时配置 toHost 与 fromHost
```

### 隔离与 Standalone 模式

vcluster 有几种部署形态:

```shell
共享节点(默认)     Pod 调度到宿主集群的共享节点上,隔离靠 API 层
privateNodes       为租户准备专属节点(vcluster 会模拟节点对象),计算层也隔离
Standalone         不需要宿主集群,直接把控制面部署在裸机/虚拟机上(自 v0.29 起)
```

Standalone 的最小配置:

```shell
controlPlane:
  standalone:
    enabled: true
    joinNode:
      enabled: true
privateNodes:
  enabled: true
```

共享节点形态下的隔离边界,可以用一句话概括:**虚拟化的是 API,不是内核**。

### 注意

1. **vcluster 里的 Pod 实际跑在宿主集群的节点上**。syncer 把 Pod 对象同步到宿主命名空间后,由宿主的 kubelet 拉起容器,因此共享内核、共享 kubelet、共享 conntrack。它与宿主上的普通 Pod 是同一种东西,不要把它当成安全边界。
2. **CRD 默认不同步**。这是新手最常见的一类困惑:在虚拟集群里装了 Operator、建了 CRD 和自定义资源,宿主集群上完全看不到,重启/迁移虚拟集群时这些资源也不会跟着走。要让它们在宿主落地必须显式配置 `sync.toHost.customResources`。
3. **`networkPolicies` 默认不同步,意味着虚拟集群里写的 NetworkPolicy 默认不生效**。租户以为已经做了隔离,实际上没有。需要网络隔离时要么打开同步,要么在宿主侧统一施加策略。
4. **Ingress、ServiceAccount、StorageClass 默认也不同步**。Ingress 不通会表现为「域名访问不了」,ServiceAccount 不通会影响依赖 SA 的工作负载,PVC 则必须依赖宿主已有的 StorageClass。
5. **自定义资源同步只支持命名空间级资源**,且同一 CRD 只能选一个版本,写多个版本会让虚拟集群直接起不来。跨版本升级 CRD 时要特别小心。
6. **旧的 `vcluster-generic-crd-sync-plugin` 插件已废弃**,功能已内置到 `fromHost.customResources` / `toHost.customResources`,新部署不要再引入这个插件。
7. **NodePort 与 hostPath 依然是宿主集群级别的风险**。它们作用在宿主节点上,不因为「Pod 在虚拟集群里」而改变;多租户场景要配合 Pod Security Admission 或准入策略禁用。
8. **`vcluster connect` 会切换 kube context**,忘记 `vcluster disconnect` 就继续敲 `kubectl delete` 是真实事故来源。习惯用 `kubectl config current-context` 确认一下。
9. **每个虚拟集群都要吃一份控制面开销**。API Server + 控制器 + syncer 都是常驻进程,几十个虚拟集群的宿主集群内存压力不可忽略,规划时要按「每个虚拟集群 ≈ 一个小型控制面」来估算。
10. **backingStore 默认是容器内 sqlite**,生产建议换成外置 etcd,否则控制面 Pod 重建会牵涉数据持久性。
11. **CLI、chart 与虚拟集群内的发行版是三条版本线**。升级时把 CLI 与 chart 版本对齐,并注意虚拟集群的 Kubernetes 版本由 `--distro` 决定,与宿主版本无关。
12. **vCluster Platform(v4.x)是商业产品**。开源 chart 不包含 SSO、多集群管理、策略等能力,评估方案时不要把平台功能算进开源版本。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `namespace` — vcluster 的宿主载体,理解命名空间边界是前提
- `k3s` — vcluster 默认的控制面发行版
- `k0s` — 可选的另一种控制面发行版
- `helm` — vcluster 底层由 Helm 部署,values 即 chart values
- `capsule` — 命名空间级多租户方案,与 vcluster 常被比较
- `multi-tenancy` — 多租户隔离的整体取舍

### 参考链接

- [vCluster 官方文档](https://www.vcluster.com/docs)
- [vcluster create 命令参考](https://www.vcluster.com/docs/vcluster/0.34.0/cli/vcluster_create)
- [同步自定义资源(CRD 同步)](https://www.vcluster.com/docs/vcluster/0.36.0/configure/vcluster-yaml/sync/to-host/advanced/custom-resources)
- [vcluster Helm chart 源码与 values](https://github.com/loft-sh/vcluster/tree/main/chart)
- [vcluster GitHub 仓库](https://github.com/loft-sh/vcluster)
