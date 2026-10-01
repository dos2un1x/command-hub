virtual-kubelet
===

用一个伪装成节点的进程把Pod调度到Kubernetes之外的后端

## 补充说明

**维护状态核实(2026-09)**:Virtual Kubelet **没有被归档,但长期属于低活跃项目**,选型前请务必读完这一段。

```shell
时间线
  2024-01-19  v1.11.0       最后一个「旧周期」版本
  ——此后【近两年没有任何 release】——
  2026-01-27  v1.12.0       重新恢复发版
  2026-07-08  v1.13.0
  2026-09-07  v1.14.0       当前最新,依赖升级到 Kubernetes v1.36 / Go 1.26

外部评估
  Linux Foundation Insights 健康分 26/100(评级 Critical),窗口 2025-05 ~ 2026-05
  有合并权限的活跃维护者仅 2 人(bus factor 低),中位响应时间约 14 天
  2026 年的三个 release 内容以依赖升级与 CVE 修复为主,功能性改动很少

子项目与生态
  virtual-kubelet/node-cli   脚手架仓库已归档,不要在新 provider 里依赖它
  AWS Fargate provider       README 明确写着 "this provider is not currently supported"
  systemk / elotl-kip        长期无更新
  azure-aci provider         仍有维护
  社区 provider             多为个人或厂商单点维护,存活情况需逐个核实
```

**结论:可以把 Virtual Kubelet 用作理解「虚拟节点」模型的参考,也可以在已有项目里继续用;但**不建议把它作为新架构的核心依赖**,除非你准备承担自维护的成本。** 需要「把负载溢出到别的算力后端」时,优先评估宿主平台自己提供的托管方案(如 Azure 的 Virtual Nodes、各家的 Serverless 容器产品)。

### 它解决什么问题

Kubernetes 的调度单位是节点,而节点必须是「能跑 kubelet 的机器」。Virtual Kubelet 的思路是:**用软件冒充一个 kubelet**,注册一个假的 Node,把调度到这个节点上的 Pod 转交给别的后端去跑。

```shell
真实节点     kubelet → CRI → containerd → 容器
虚拟节点     virtual-kubelet → provider → 外部后端(ACI / Fargate / 边缘设备 / 自研平台)
```

**它不是联邦,也不是多集群方案**。官方 README 明确说明:Virtual Kubelet "is explicitly not intended to be an alternative to Kubernetes federation"。它只做一件事 —— 让一个节点背后不是本机容器运行时。

典型用途:

```shell
- 突发扩容:集群资源不足时把 Pod 溢出到云上的 Serverless 容器
- 接入异构算力:边缘设备、IoT 网关、HPC 集群
- 纳管非容器后端:把已有的 VM / 批处理平台包装成 k8s 节点
```

### 工作原理

Virtual Kubelet 进程对外呈现的是一个**标准的 Node**,内部由一个 provider 实现真正的动作:

```shell
1. 启动时用 kubeconfig 连上 apiserver,注册（或更新）一个 Node 对象
2. 持续 watch 绑定到该节点的 Pod
3. 收到 Pod 后调用 provider 的 CreatePod / UpdatePod / DeletePod
4. 把 Pod 状态、容器日志、指标回写给 apiserver

provider 接口的核心方法
  CreatePod / UpdatePod / DeletePod / GetPod / GetPodStatus
  GetContainerLogs / GetStatsSummary / GetPods
  NotifyPods（把状态变更推回给 node 层）
```

因为状态是**回写**的,所以 `kubectl get pods` 能看到真实情况,但一些依赖 kubelet 细节的能力天然受限:

```shell
有限或不支持
  exec / attach / port-forward（取决于 provider 是否实现）
  Service 的 kube-proxy 转发（虚拟节点上的 Pod IP 通常不在集群网段内）
  本地存储（emptyDir 之外的 hostPath 无意义）
  DaemonSet（每个节点一个,但虚拟节点不是真机）
```

### 部署形态

没有 `kubectl apply` 就能装好的「标准安装包」—— 每个 provider 都是一个独立的 Go 程序,自带部署清单。通用形态:

```shell
- 以 Deployment 运行（不是 DaemonSet,虚拟节点只需要一个实例）
- 用 ServiceAccount + RBAC 授权它读写 Node 与 Pod
- 启动参数大致如下
```

```shell
virtual-kubelet \
  --provider <provider-name> \
  --nodename virtual-kubelet \
  --node-ip 10.0.0.100 \
  --kubeconfig /etc/vk/kubeconfig \
  --taint key=virtual-kubelet.io/provider,value=<provider>,effect=NoSchedule
```

**污点(taint)几乎是必须的**。没有污点,调度器会把普通 Pod 也扔到虚拟节点上,而它可能完全不支持这些负载。标准做法是给虚拟节点打一个专属污点,只让显式声明 toleration 的 Pod 上去:

```shell
spec:
  nodeSelector:
    kubernetes.io/role: agent
    type: virtual-kubelet
  tolerations:
    - key: virtual-kubelet.io/provider
      operator: Exists
      effect: NoSchedule
```

### 所需的 RBAC

Virtual Kubelet 需要读写 Node 与 Pod,官方示例的最小权限大致如下:

```shell
apiVersion: v1
kind: ServiceAccount
metadata:
  name: virtual-kubelet
  namespace: kube-system

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: virtual-kubelet
rules:
  # 注册虚拟节点、上报状态、维护节点上的污点与标签
  - apiGroups: [""]
    resources: ["nodes"]
    verbs: ["create", "get", "list", "watch", "update", "patch", "delete"]
  - apiGroups: [""]
    resources: ["nodes/status"]
    verbs: ["update", "patch"]

  # 监听被调度到虚拟节点的 Pod,并回写状态
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch", "delete"]
  - apiGroups: [""]
    resources: ["pods/status"]
    verbs: ["update", "patch"]

  # 读取 Pod 关联的 ConfigMap / Secret（有些 provider 需要）
  - apiGroups: [""]
    resources: ["configmaps", "secrets", "services"]
    verbs: ["get", "list", "watch"]

  # 事件与容器日志
  - apiGroups: [""]
    resources: ["events"]
    verbs: ["create", "patch", "update"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get", "list"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: virtual-kubelet
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: virtual-kubelet
subjects:
  - kind: ServiceAccount
    name: virtual-kubelet
    namespace: kube-system
```

权限给多了没有意义但不致命,**给少了会表现为「节点注册成功但 Pod 状态永远不同步」** —— 这类症状要优先怀疑 `pods/status` 的权限。

### 自己写 provider

provider 本质上就是一个 Go 接口的实现,核心方法:

```shell
CreatePod(ctx, pod) error        后端创建负载
UpdatePod(ctx, pod) error        更新负载（如镜像变更）
DeletePod(ctx, pod) error        删除负载
GetPod(ctx, namespace, name)     查询当前状态
GetPodStatus(...)                上报状态给 node 层
GetContainerLogs(...)            实现 kubectl logs
GetStatsSummary()                上报指标
```

实践建议:

```shell
1. 用【异步】模型:CreatePod 只负责提交请求,真实状态通过 NotifyPods 回写
   同步阻塞会在后端慢时拖垮整个 node 循环

2. 状态回写要幂等并带重试
   apiserver 会冲突（resourceVersion 不匹配）,
   直接失败重试即可,不要自己维护复杂的状态机

3. 别依赖已归档的 node-cli
   直接参考主仓库里的 provider 示例与接口定义

4. 先把 exec / logs / port-forward 的取舍想清楚
   这三个能力在 provider 里是可选实现,
   但一旦业务用上,后续补实现的成本很高
```

### 一个真实的生产案例:AKS Virtual Nodes

Azure 的 AKS 曾长期以 Virtual Nodes 插件的形式提供基于 Virtual Kubelet 的 ACI 溢出能力。**该插件正在被下一代实现替换**:

```shell
旧:AKS 托管插件（基于 Virtual Kubelet）
   az aks enable-addons --addons virtual-node
   节点名：virtual-node-aci-linux
   调度标签：kubernetes.io/role: agent + azure.com/aci 容忍

新:Virtual Nodes on ACI（v2），改用 Helm 部署,不再是托管插件
   chart：virtualnodesOnAzureContainerInstances
   节点名：virtualnode-0
   调度标签：virtualization: virtualnode2
```

**迁移不是原地升级** —— 需要缩容负载、禁用旧插件、重新委派子网、装新 chart,整个过程有停机。这本身就是「把 Virtual Kubelet 作为长期基础设施」的现实成本示例。

另外 Azure 文档明确列出:基于 Virtual Kubelet 的 virtual nodes 插件**不支持**工作负载身份(Microsoft Entra Workload ID)。

### 注意

1. **项目活着但很虚弱**。2024-01 到 2026-01 有整整两年没有发版,恢复后的三个版本也以依赖升级为主。核心库本身稳定,但**周边 provider 的存活率很低**,选型时必须逐个核实你要用的那个 provider 最近一次提交时间。
2. **`node-cli` 脚手架已归档**。想自己写 provider 的话,不要再照着老教程 `go get github.com/virtual-kubelet/node-cli` 起步;直接用主仓库的 provider 接口与示例。
3. **AWS Fargate provider 官方标注不支持**。README 里写明 "this provider is not currently supported"。想在 EKS 上做 Fargate 溢出应该用 Fargate 原生的 profile 机制,而不是 Virtual Kubelet。
4. **虚拟节点上的 Pod 网络与集群网络是两套**。Pod IP 通常不属于集群 CNI 网段,`kube-proxy` 无法把 Service 流量转发过去。跨边界访问要走 Ingress / 外部 LB,direct Pod-to-Pod 通信一般不通 —— 这是架构级限制,不是配置问题。
5. **`exec` / `logs` / `port-forward` 取决于 provider**。这些能力要 provider 显式实现,没实现的 provider 上 `kubectl exec` 会直接报错。上线前一定要把这几个运维刚需逐个验证。
6. **不实现 DaemonSet 是常态**。节点级 agent 类负载(日志采集、监控、CNI)在虚拟节点上通常无法工作,选型时要确认缺失哪些。
7. **必须打污点,否则调度会失控**。不加污点的话调度器会把任意 Pod 调到虚拟节点;一旦 provider 不支持该负载,表现是 Pod 永久 Pending 或起不来,而事件信息往往很含糊。
8. **节点资源容量是「声明的」不是「探测的」**。虚拟节点的 `allocatable` 由 provider 人为上报,可能与后端真实容量不一致。上报过大 → Pod 调度上去后后端拒绝;上报过小 → 调度器不用它。这是一个需要按后端实际配额调参的地方。
9. **虚拟节点上的 Pod 不受 kubelet 的资源限制保护**。`resources.limits` 是否生效取决于 provider 与后端是否遵守,CPU/内存超用不会被本地 cgroup 拦住。
10. **升级 Kubernetes 版本要跟着升 Virtual Kubelet**。它通过 client-go 与 apiserver 通信,API 版本偏移过大时会直接失联。项目 2026 年才把依赖追到 Kubernetes 1.36,说明这个跟进并不及时 —— 集群升级前先确认对应版本支持情况。
11. **它解决不了「多集群联邦」**。跨集群调度、故障转移、跨集群服务发现这些需求要看 Karmada、OCM 之类的项目,不要指望 Virtual Kubelet。
12. **托管 方案正在取代自建**。AKS 的 Virtual Nodes 换代、各云厂商的 Serverless 容器能力,本质都是把这层复杂度收进平台侧。除非有明确的异构后端需求,否则优先用托管能力。

### 相关命令

- `kubelet` — Virtual Kubelet 模仿的对象,理解它才能理解虚拟节点的边界
- `kube-scheduler` — 决定 Pod 是否落到虚拟节点
- `affinity` — 用亲和性与容忍把 Pod 定向到虚拟节点
- `karmada` — 真正的多集群编排方案
- `knative` — 另一条「弹性到外部算力」的技术路线

### 参考链接

- [Virtual Kubelet 官方网站](https://virtual-kubelet.io/)
- [Virtual Kubelet GitHub 仓库](https://github.com/virtual-kubelet/virtual-kubelet)
- [Virtual Kubelet 发布记录](https://github.com/virtual-kubelet/virtual-kubelet/releases)
- [AKS Virtual Nodes 文档](https://learn.microsoft.com/en-us/azure/aks/virtual-nodes)
- [Virtual Kubelet 健康度( Linux Foundation Insights)](https://insights.linuxfoundation.org/project/virtualkubelet)
