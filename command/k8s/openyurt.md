openyurt
===

把既有Kubernetes集群改造成边缘架构,以YurtHub实现边缘自治

## 补充说明

**OpenYurt** 是阿里云开源的边缘计算框架,CNCF **孵化级(Incubating)**项目,最新版本 v1.7.0(2026-05-06)。

它与 KubeEdge 的最大区别是**设计出发点不同**:KubeEdge 是「为边缘重新实现一套控制面通信」,OpenYurt 则是「**对原生 Kubernetes 零侵入**」—— 它不修改 Kubernetes 的任何组件,而是把一个叫 **YurtHub** 的代理放到每个边缘节点上,接管节点组件与 apiserver 之间的流量,并在本地缓存 API 响应。

这意味着业务侧的 YAML 完全不用改,存量集群可以**原地改造**:先在已有集群上装控制面组件,再逐个把节点标记为边缘节点。对于「已经有一套跑得好好的 K8s,现在要往边缘延伸」的场景,这是最低摩擦的路径。

### 核心组件

```shell
YurtHub            边缘节点上的代理(静态 Pod),缓存 API 响应,断连时提供本地读
Yurt-Manager       云端 Deployment,汇集所有边缘相关控制器与准入 Webhook
Raven-Agent        云边、边边网络通信(L7 反向代理),取代早期的 Yurt-Tunnel
YurtIoTDock        每个 NodePool 一个实例,对接 EdgeX Foundry 设备
Node Resource Manager  节点资源管理(LVM、QuotaPath 等)
yurtadm            安装与运维命令行,负责 init / join / reset
```

旧文档里会出现 `YurtControllerManager`、`YurtAppManager`、`YurtTunnel` 这些名字 —— 它们的能力已被 **Yurt-Manager** 与 **Raven** 吸收,照着旧文档安装会找不到对应的组件。

### 与 KubeEdge 的差别

| 维度 | OpenYurt | KubeEdge |
| --- | --- | --- |
| 改造方式 | 零侵入,原地改造既有集群 | 需要单独的 CloudCore/EdgeCore 体系 |
| 边缘自治 | YurtHub 缓存 API 响应 | MetaManager + 本地 SQLite |
| 节点组件 | 保留原生 kubelet、kube-proxy | 用 Edged 取代 kubelet |
| 设备接入 | YurtIoTDock(EdgeX) | Device CRD + device mapper |
| 适用场景 | 存量集群延伸、单元化部署 | 全新边缘集群、设备密集场景 |

两者都支持「边缘断连自治」,但自治的**实现层不同**:OpenYurt 的自治在代理层(缓存读),KubeEdge 在元数据层(本地数据库)。选型时应主要看存量资产与团队技能,而不是功能清单。

### 安装

```shell
# 1. 添加 Helm 仓库
helm repo add openyurt https://openyurtio.github.io/openyurt-helm
helm repo update

# 2. 先装 Yurt-Manager(必须在节点 join 之前,因为它负责签发边缘节点证书)
helm upgrade --install yurt-manager -n kube-system openyurt/yurt-manager

# 3. 装 yurthub 相关的模板与 RBAC,kubernetesServerAddr 必须是真实 apiserver 地址
helm upgrade --install yurt-hub -n kube-system \
  --set kubernetesServerAddr=https://<apiserver>:6443 \
  openyurt/yurthub

# 4. 云边跨网段时安装 raven-agent
helm upgrade --install raven-agent -n kube-system openyurt/raven-agent

# 5. 检查
kubectl -n kube-system get pod | grep -E 'yurt-manager|raven'
kubectl get yss -n kube-system          # YurtStaticSet,由 yurthub chart 创建
```

### 把节点变成边缘节点

```shell
# 在边缘节点上下载 yurtadm
curl -LO https://github.com/openyurtio/openyurt/releases/download/v1.7.0/yurtadm-v1.7.0-linux-amd64.tar.gz
tar -xzf yurtadm-v1.7.0-linux-amd64.tar.gz
sudo install -m 0755 yurtadm /usr/local/bin/yurtadm

# 加入集群并标记为边缘节点
sudo yurtadm join <apiserver>:6443 \
  --token <bootstrap-token> \
  --discovery-token-ca-cert-hash sha256:<hash> \
  --node-name edge-node-01 \
  --node-type=edge

# 确认
kubectl get nodes -l openyurt.io/is-edge-worker=true
kubectl get nodepool
```

已有节点也可以原地转换,转换后节点上的 YurtHub 会接管 kubelet 与 kube-proxy 的请求。`yurtadm reset` 用于回退。

### YurtHub 与边缘自治

YurtHub 是 OpenYurt 的核心,它以**静态 Pod** 形式运行在边缘节点上:

```shell
监听端口(默认绑定 127.0.0.1)
  10261  HTTP 代理端口,转发到 apiserver
  10267  YurtHub Server(pprof、healthz、metrics、token)
  10268  HTTPS 代理端口,功能同 10261

本地缓存
  /etc/kubernetes/cache/     缓存的 API 响应(磁盘)
  /var/lib/YurtHub/          YurtHub 自身的根目录
```

工作机制要点:

```shell
1. NetWorkManager 写 iptables 规则,把原本发往 apiserver 的请求重定向到 YurtHub
2. HealthCheck 持续探测 apiserver 可达性,决定请求走云端还是走本地缓存
3. 连接正常时:请求转发到 apiserver,同时把响应写入本地缓存
4. 连接断开时:Get/List/Watch 由本地缓存应答;Create/Update/Delete 直接返回错误
5. 断连期间节点组件(含 kubelet)不会因为拿不到 apiserver 而驱逐 Pod,业务继续运行
```

最后一条是 OpenYurt 的关键价值:**「让客户端对断连无感」**。kubelet 拿不到云端数据时会认为节点失联,而 YurtHub 用缓存兜住了这些读请求,避免了大面积驱逐。

### 单元化:NodePool 与 YurtAppSet

```shell
apps.openyurt.io/v1alpha1   NodePool      节点池,按地域/机房/架构对节点分组
apps.openyurt.io/v1beta1    YurtAppSet    跨节点池的统一应用部署(1.5 起合并了旧的
                                          YurtAppDaemon 与 YurtAppOverrider)
apps.openyurt.io/v1alpha1   YurtStaticSet 静态 Pod 管理
```

节点通过标签归属节点池,`yurt-manager` 的 webhook 会自动补上类型标签:

```shell
kubectl label node edge-node-01 apps.openyurt.io/desired-nodepool=beijing
# 控制器随后写入 apps.openyurt.io/nodepool=beijing
# webhook 还会补 nodepool.openyurt.io/type=edge
```

YurtAppSet 用一份模板在多个节点池各生成一份工作负载,并支持按池打补丁(例如只让某个池用不同镜像):

```shell
apiVersion: apps.openyurt.io/v1beta1
kind: YurtAppSet
metadata:
  name: nginx
  namespace: default
spec:
  selector:
    matchLabels:
      app: nginx
  workloadTemplate:
    deploymentTemplate:
      metadata:
        labels:
          app: nginx
      spec:
        replicas: 1
        selector:
          matchLabels:
            app: nginx
        template:
          metadata:
            labels:
              app: nginx
          spec:
            containers:
              - name: nginx
                image: nginx:1.27
  topology:
    pools:
      - name: beijing
        replicas: 2
      - name: shanghai
        replicas: 1
```

### 流量拓扑

边缘节点跨地域时,Service 的流量不该绕到别的机房。OpenYurt 通过注解把 EndpointSlice 收敛到本节点池:

```shell
metadata:
  annotations:
    openyurt.io/topologyKeys: openyurt.io/nodepool
```

取值有三种:`kubernetes.io/hostname`(限制在本节点)、`kubernetes.io/zone` 与 `openyurt.io/nodepool`(限制在本节点池)。不加注解则不做任何限制。

CoreDNS 也应做同样处理,否则边缘 DNS 查询会打到云端:

```shell
kubectl annotate svc kube-dns -n kube-system \
  openyurt.io/topologyKeys='openyurt.io/nodepool'
```

### 注意

1. **YurtHub 只兜住读请求,断连时写操作无法完成**。Get/List/Watch 走本地缓存,Create/Update/Delete 会直接失败。因此断连期间不能扩容、不能改配置、不能新建资源 —— 自治保证的是「已有业务不掉」,不是「边缘能独立编排」。
2. **YurtHub 是静态 Pod,排障方式与普通 Pod 不同**。它由 kubelet 直接拉起,日志要用 `crictl` 或节点上的 systemd/journal 查看,`kubectl logs` 依赖它本身工作,循环依赖会让排查变得别扭。它还接管了 kubelet 的请求,一旦 YurtHub 挂了,该节点上所有需要访问 apiserver 的组件都会受影响。
3. **缓存会让 `kubectl get` 看到陈旧数据**。节点上残留的旧对象可能来自本地缓存,排障时如果发现「云端没有、节点上却有」,要想到缓存而不是先怀疑控制器。
4. **CoreDNS 必须做拓扑收敛**。默认情况下边缘节点的 DNS 解析会跨节点池打到云端 CoreDNS,断连时直接解析失败 —— 这是边缘集群里最容易被忽略的一处单点。
5. **旧组件名已被吸收**。`YurtControllerManager`、`YurtAppManager`、`YurtTunnel` 都已经不再是独立组件:前两者并入 **Yurt-Manager**,后者被 **Raven** 取代(raven-agent 提供 L7 反向代理)。照旧文档安装会找不到对应的 chart 与镜像。
6. **`YurtAppSet` 在 1.5 换了 API 版本**。旧的 `v1alpha1` 与 `UnitedDeployment`/`YurtAppDaemon`/`YurtAppOverrider` 已被合并,新写法是 `apps.openyurt.io/v1beta1` 的 `YurtAppSet`。旧清单需要迁移,不能直接套用。
7. **yurt-manager 必须先于节点 join 安装**。边缘节点加入时需要 yurt-manager 审批 CSR 并签发 YurtHub 的证书;顺序反了会让节点卡在等待证书的状态。
8. **`kubernetesServerAddr` 必须填真实可达的 apiserver 地址**。这个值会写进 YurtHub 的配置,填成 `127.0.0.1` 或集群内 Service 名会导致边缘节点(尤其是跨网段的节点池)永远连不上。
9. **节点池标签是单向的**。`apps.openyurt.io/desired-nodepool` 由你设置,`apps.openyurt.io/nodepool` 由控制器回写;手工改后者会被控制器覆盖,排查节点归属问题时看前者。
10. **Raven 需要所有节点 IP 不冲突**。它按节点 IP 做标识与转发,集群内如果存在重复 IP(常见于跨机房 NAT 场景)会出问题,部署前要确认地址规划。
11. **边缘自治只覆盖「已运行」的工作负载**。被驱逐、被删除或从未调度成功的 Pod 在断连期间不会重建。边缘关键业务应配合本地副本数、PDB 与更保守的驱逐策略一起设计。
12. **YurtHub 需要为节点组件让路**。它通过 iptables 重定向 apiserver 流量,与节点上其他同样改写网络规则的组件(如某些 CNI 的 hostNetwork 策略)可能冲突;同一节点不要混用两套边缘自治方案。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kubeadm` — 集群初始化与节点加入
- `helm` — 安装 OpenYurt 各组件的 chart
- `kubeedge` — 另一种边缘计算框架(全新边缘集群)
- `superedge` — 已停更的边缘框架,选型请避开
- `akri` — 边缘设备接入,可与 OpenYurt 组合
- `k3s` — 常作为边缘侧的轻量发行版
- `coredns` — 边缘 DNS 的拓扑收敛

### 参考链接

- [OpenYurt 官方文档](https://openyurt.io/docs/)
- [YurtHub 核心概念](https://openyurt.io/docs/core-concepts/yurthub/)
- [Yurt-Manager 核心概念](https://openyurt.io/docs/core-concepts/yurt-manager/)
- [Service Topology 使用指南](https://openyurt.io/docs/v1.6/user-manuals/network/service-topology/)
- [OpenYurt 手动安装](https://openyurt.io/docs/installation/manually-setup/)
- [OpenYurt GitHub 仓库](https://github.com/openyurtio/openyurt)
