cloud-provider
===

Kubernetes的云厂商集成模型,从内置驱动到外置Cloud Controller Manager

## 补充说明

**cloud-provider** 指的是 Kubernetes 与云平台之间的那一层适配:节点要有区域/机型信息、LoadBalancer 类型的 Service 要真的开出一个云负载均衡、跨节点 Pod 流量要走云路由。这些能力曾经**内置在 Kubernetes 核心里**(in-tree),现在则全部外置为 **Cloud Controller Manager(CCM)**。

这是一次跨度数年的大迁移,代号 **KEP-2395**,官方称之为「Kubernetes 历史上最大规模的迁移」——删掉了约 150 万行代码,核心组件二进制体积缩小约 40%。理解这段历史,才能读懂今天各种「节点一直不 Ready」「LoadBalancer 一直 Pending」的报错。

### 迁移时间线(必读)

```shell
1.26   内置 OpenStack 驱动移除
1.27   内置 AWS 驱动移除
1.29   DisableCloudProviders 与 DisableKubeletCloudCredentialProviders
       两个特性门控默认值改为 true —— 内置驱动【默认全部失效】
       需要显式把它们设回 false 才能继续用旧的内置驱动（临时兜底）
1.31   内置云驱动从核心组件中【永久禁用并移除】
       此后只有 external 一种模式
1.33   DisableCloudProviders / DisableKubeletCloudCredentialProviders
       两个已 GA 的特性门控被删除
       kube-apiserver 的 --cloud-provider 参数被移除,传入会直接启动失败
```

配套撤离的还有三个子系统:

```shell
Cloud Controller Manager   KEP-2392  替代 kube-controller-manager 与 kubelet 里的云逻辑
API Server Network Proxy   KEP-1281  替代 apiserver 到节点的 SSH 隧道
kubelet 凭据提供者插件      KEP-2133  替代 kubelet 内置的 ECR/GCR/ACR 镜像拉取凭据获取
CSI 迁移                   KEP-625   替代内置的云盘卷插件
```

**今天的现实是:`--cloud-provider` 只接受空字符串或 `external`。** 传 `aws`、`gce`、`azure` 这类值在 kubelet 与 kube-controller-manager 上都是非法的。

### Cloud Controller Manager

CCM 是与 kube-controller-manager 平行的独立二进制,由云厂商各自维护和发布。它可以包含四种控制器:

```shell
cloud-node             节点控制器
                       为新节点填上云侧信息（区域、机型、内网/外网 IP）
                       校验节点在云上是否还存在,不存在就删除 Node 对象
                       初始化完成后【移除初始化污点】

cloud-node-lifecycle   节点生命周期控制器
                       按云侧状态决定是否驱逐 / 删除节点

service                Service 控制器
                       为 type=LoadBalancer 的 Service 创建云负载均衡
                       同步 status.loadBalancer.ingress

route                  路由控制器
                       配置跨节点 Pod 流量的云路由
                       或分配 Pod 网段
```

CCM 自身的运行要求:

```shell
- 与云 API 的认证（AK/SK、IAM 角色、托管身份……）
- 与 kube-apiserver 的 RBAC 授权
- 高可用:默认开启 leader election,多副本只有一个在工作
- 通常以 Deployment 形式跑在 kube-system 里
```

所需的 RBAC 权限大致是:

```shell
Node 资源的完全读写（节点控制器）
Node 的只读（路由控制器）
Service 的 list/get/watch + services/status 的 patch/update
Events 的 create/patch/update
ServiceAccount 的 create
```

### 初始化污点

这是 CCM 缺席时最典型的症状来源。任何设置了 `--cloud-provider=external` 的组件,在节点初始化时都会加上这个污点:

```shell
node.cloudprovider.kubernetes.io/uninitialized:NoSchedule
```

含义是「这个节点还需要外部控制器做第二次初始化」,在此期间**不会被调度任何工作负载**。移除它的正是 CCM 的节点控制器。

```shell
# 查看节点上的污点
kubectl describe node <node-name> | grep -A5 Taints
kubectl get node <node-name> -o jsonpath='{.spec.taints}'

# 典型症状:新节点永远 Pending 不了 Pod,describe 里看到上面这个污点
```

CCM 自己也必须容忍这个污点,否则它无法在自己初始化的节点上运行:

```shell
tolerations:
  - key: node.cloudprovider.kubernetes.io/uninitialized
    value: "true"
    effect: NoSchedule
```

### 语法与配置

kubelet 与 kube-controller-manager 侧:

```shell
--cloud-provider=external     只有这个值有意义（空字符串表示不用云集成）
--cloud-config=<path>         云厂商配置文件路径（部分 CCM 仍需要）
```

**kube-apiserver 侧已无此参数**:1.31 起不再生效,1.33 起彻底移除,继续传会直接让 apiserver 启动失败。

以 kubeadm 集群为例,给 kubelet 追加参数走 systemd drop-in:

```shell
sudo vi /etc/systemd/system/kubelet.service.d/10-kubeadm.conf
```

```shell
Environment="KUBELET_EXTRA_ARGS=--cloud-provider=external"
```

```shell
sudo systemctl daemon-reload
sudo systemctl restart kubelet
```

`cloud.conf`(以 OpenStack 为例)形如:

```shell
[Global]
auth-url    = https://keystone.example.com:5000/v3
username    = kubernetes
password    = <password>
tenant-name = my-project
region      = RegionOne

[LoadBalancer]
subnet-id = <subnet-uuid>
```

AWS 的 CCM 则习惯用 `--cloud-config` 指向一个只含 `[global]` 段的配置,认证走节点 IAM 角色或 IRSA。

### cloud-provider-aws

`kubernetes/cloud-provider-aws` 是 AWS 的官方外置实现,主要产出 **aws-cloud-controller-manager**:

```shell
- 负责 ELB/NLB 的创建与回收
- 负责节点初始化与 region/zone 标签
- 通常以 DaemonSet 或 Deployment 部署在 kube-system
- 需要节点角色具备 ELB、EC2 描述等权限
- 在 EKS 上该组件由托管控制平面提供,自建集群才需要自己部署
```

配置与部署方式见其仓库的 Helm chart,常用参数:

```shell
--cloud-provider=aws
--cloud-config=/etc/kubernetes/cloud-config
--use-service-account-credentials=true
--leader-elect=true
```

### 排障

```shell
# 1. 节点是否被初始化
kubectl get node <node-name> -o jsonpath='{.spec.taints}'
# 还带着 node.cloudprovider.kubernetes.io/uninitialized → CCM 没工作

# 2. CCM 是否在跑
kubectl get pods -n kube-system | grep cloud-controller-manager
kubectl logs -n kube-system <ccm-pod> -f

# 3. Service 是否拿到 LB
kubectl get svc <name> -o yaml | grep -A10 "status:"
kubectl describe svc <name> | grep -A10 Events

# 4. 节点上的云标签是否写上了
kubectl get node <node-name> --show-labels | tr ',' '\n' | grep -i "topology\|instance-type\|zone"
```

### 注意

1. **1.29 之后内置驱动默认失效**。很多老教程里让 kubelet 写 `--cloud-provider=aws`、kube-controller-manager 写 `--cloud-provider=azure` 的做法,在 1.29+ 会直接报错退出。**只有 `external` 是合法值**,而且必须真的部署了对应的 CCM。
2. **CCM 挂了,新节点会永远不可调度**。初始化污点只能由 CCM 移除,没有 CCM 就没有第二次初始化。这是升级/迁移期间最常见的「集群看起来正常但新节点全废」的原因。
3. **apiserver 的 `--cloud-provider` 参数已被移除**。1.33 起传入该参数会让 kube-apiserver 直接启动失败(unknown flag)。从旧版本升级时,要先清理启动脚本、systemd 单元与静态 Pod 清单里的这个参数。
4. **CCM 不实现卷控制器**。存储能力已全部交给 CSI 驱动。指望 CCM 处理 PVC 挂载是概念错位 —— 那是 CSI 的职责。
5. **CCM 集中了几乎所有云 API 调用**。这意味着它会撞上云厂商的 API 限流,大集群尤其明显。调优手段包括增加副本、调大 client 侧的 QPS/Burst、减少不必要的同步。
6. **两个已 GA 的特性门控已被删除**。`DisableCloudProviders` 与 `DisableKubeletCloudCredentialProviders` 在 1.33 被移除,旧清单里写 `--feature-gates=DisableCloudProviders=false` 会直接报「无法识别的特性门控」。
7. **kubelet 的镜像凭据不再走内置逻辑**。ECR/GCR/ACR 的凭据改由 **kubelet 凭据提供者插件**(`--image-credential-provider-config` 与 `--image-credential-provider-bin-dir`)获取。老参数如 `--azure-container-registry-config` 已废弃。
8. **CCM 一定要配 tolerations**。节点还带初始化污点时,没有容忍的 CCM 副本无法调度到该节点上 —— 出现「CCM 明明部署了但就是不动」的死锁。
9. **迁移到 external CCM 需要停机窗口吗**。多数情况下可以滚动完成,但顺序很重要:先部署并确认 CCM 就绪,再给 kubelet 加 `--cloud-provider=external`,最后逐节点重启。顺序反过来会出现节点暂时无法初始化。
10. **`cloud-provider: external` 必须配到所有节点**。包括控制平面节点。漏配的节点不会走云初始化,cluster-autoscaler 之类的组件会因节点缺少云侧标识而无法正确匹配实例,表现为伸缩行为异常。
11. **自建集群与托管集群的边界**。EKS/GKE/AKS 的控制平面由云厂商托管,CCM 通常已内置;只有当你在云主机上自建集群、或用 Cluster API 自管节点时,才需要自己部署 CCM。
12. **`external` 不是「更高级的内置驱动」**。它意味着「我不用内置逻辑了,请外部组件接手」。设了这个值却没部署 CCM,比不设更糟 —— 节点会带着污点永远起不来。

### 相关命令

- `kubelet` — 需要 `--cloud-provider=external` 交由 CCM 初始化
- `kube-apiserver` — 其 cloud-provider 参数已于 1.33 移除
- `csi` — 取代内置云盘插件的存储接口
- `crictl` — 排查 CCM 容器
- `kubeadm` — 自建集群的引导与参数下发

### 参考链接

- [Cloud Controller Manager 概念](https://kubernetes.io/docs/concepts/architecture/cloud-controller/)
- [Cloud Controller Manager 管理](https://kubernetes.io/docs/tasks/administer-cluster/running-cloud-controller/)
- [完成 Kubernetes 史上最大规模迁移](https://kubernetes.io/blog/2024/05/20/completing-cloud-provider-migration/)
- [KEP-2395:移除内置云厂商代码](https://kep.k8s.io/2395)
- [cloud-provider-aws](https://github.com/kubernetes/cloud-provider-aws)
- [kubelet 凭据提供者](https://kubernetes.io/docs/tasks/administer-cluster/kubelet-credential-provider/)
