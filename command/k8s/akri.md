akri
===

把边缘设备(udev/ONVIF/OPC UA)发现并暴露成Kubernetes原生资源的框架

## 补充说明

**Akri** 是 CNCF **Sandbox** 项目,微软主导,自我定位是「A Kubernetes Resource Interface for the Edge」。它解决的问题是:**边缘设备(USB 摄像头、IP 摄像机、PLC、传感器)不是 Kubernetes 资源**,业务 Pod 想用它们只能靠 hostPath、特权容器或写死 IP,既不可移植也无法共享。

Akri 的做法是把设备发现与使用**声明化**:你写一个 `Configuration` 说明「我要找什么样的设备」,Akri 自动发现设备、为每个设备创建一个 `Instance` 对象,并按需为它拉起一个 broker Pod;业务 Pod 则像申请 CPU 一样申请设备资源。

当前版本 **v0.14.0(2026-09-01)**,项目仍在维护。但要注意它的发布节奏偏慢:上一个正式版本 v0.13.8 发布于 2024-11-20,中间近两年没有正式发布,而 v0.14.0 是一次大规模的依赖与基线更新,带来了**硬性破坏性变更**,升级前必须确认集群版本(见下文)。

### 要澄清的一点:没有 MQTT

很多介绍把 Akri 描述成「接入 MQTT/ONVIF/OPC UA 的框架」,这是不准确的。**Akri 内置的 Discovery Handler 只有四个**:

```shell
udev        发现节点上本地连接的硬件(USB 摄像头、串口设备等)
ONVIF       发现网络中的 IP 摄像机(ONVIF 协议)
OPC UA      发现工业自动化服务端 / Local Discovery Server
debugEcho   调试用的假设备,用于验证链路,不做真实发现
```

**没有内置的 MQTT Discovery Handler。** MQTT 在边缘场景里通常出现在**数据上报**环节(设备 → 边缘应用 → 云端),而不是**设备发现**环节 —— 例如 KubeEdge 的 EventBus 用 MQTT 对接 mosquitto。要接入 MQTT 设备,需要按 Akri 的 Discovery Handler 接口自己实现一个(官方提供 Rust 模板 `project-akri/akri-discovery-handler-template`)。

### 工作原理

```shell
Discovery Handler   按协议发现设备,通过 Unix socket(默认 /var/lib/akri/agent-registration.sock)
                    向 Agent 注册,实现 gRPC 的 DiscoveryHandler 服务
Akri Agent          以 DaemonSet 运行在带设备的节点上,调用 Discovery Handler 做发现
                    为每个发现的设备创建 Instance 自定义资源
Akri Controller     监听 Instance,按 Configuration 中的模板部署 Broker Pod
Broker              每个设备(或每组设备)一个 Pod,业务通过它使用设备
                    例如摄像机 broker 负责拉流并对外提供视频接口
```

数据流是:`Configuration`(你要什么)→ Agent 发现 → `Instance`(发现了什么)→ Controller 创建 Broker → 业务 Pod 申请设备资源并使用。

### 两个 CRD:Configuration 与 Instance

CRD 的组/版本是 **`akri.sh/v0`**,Kind 是 **`Configuration`** 与 **`Instance`**:

```shell
# 注意:Kind 是 Configuration / Instance,
# 文档里的「Akri Configuration」「Akri Instance」是叙述用词,不是 Kind 名
kubectl get configurations.akri.sh -A
kubectl get instances.akri.sh -A
```

`Instance` 由 Agent 自动创建与维护,**业务方不应手工编辑它**;它的 `deviceUsage` 字段记录设备的占用槽位,是多个 Pod 共享同一设备时的协调依据。

### 一个完整的 Configuration 示例

```shell
apiVersion: akri.sh/v0
kind: Configuration
metadata:
  name: akri-udev-video
spec:
  discoveryHandler:
    name: udev
    discoveryDetails: |+
      udevRules:
      - KERNEL=="video[0-9]*"
  brokerPodSpec:
    containers:
      - name: akri-udev-video-broker
        # 占位镜像;实际部署换成协议对应的 broker
        # 注意:v0.14.0 起样例 broker 迁至 project-akri/examples,
        # 旧的 ghcr.io/project-akri/akri/<sample>:latest-dev 引用不再可解析
        image: nginx
        resources:
          requests:
            "{{PLACEHOLDER}}": "1"
        securityContext:
          privileged: true
  instanceServiceSpec:
    type: ClusterIP
    ports:
      - name: video
        port: 80
        targetPort: 8080
  capacity: 1
```

`discoveryDetails` 的内容由各个 Discovery Handler 自己定义(udev 收的是 udev 规则,ONVIF 收的是探测网段等),写错不会报错,只会「什么都没发现」。

### 安装

```shell
helm repo add akri-helm-charts https://project-akri.github.io/akri/
helm repo update

# 最小安装(仅控制器与 Agent)
helm install akri akri-helm-charts/akri

# 同时启用 udev 的发现与配置,并指定 broker 镜像
helm install akri akri-helm-charts/akri \
  --set udev.discovery.enabled=true \
  --set udev.configuration.enabled=true \
  --set udev.configuration.discoveryDetails.udevRules[0]='KERNEL=="video[0-9]*", ENV{ID_V4L_CAPABILITIES}==":capture:"' \
  --set udev.configuration.brokerPod.image.repository=nginx

# Agent 镜像中内置 udev/OPC UA/ONVIF 三个 handler,简化部署
helm install akri akri-helm-charts/akri --set agent.full=true

# 升级
helm upgrade akri akri-helm-charts/akri --set udev.discovery.enabled=true

# 卸载(注意 CRD 需要手动删除)
helm delete akri
kubectl delete crd instances.akri.sh
kubectl delete crd configurations.akri.sh
```

### 资源请求与设备共享

业务 Pod 像申请扩展资源一样申请设备:

```shell
resources:
  limits:
    akri.sh/akri-udev-video: "1"     # 按 Configuration 名申请,由 Agent 分配具体设备
```

两种粒度:

```shell
实例级资源   名字形如 <configuration-name>-<instance-id>,直接锁定某个具体设备
配置级资源   名字就是 akri.sh/<configuration-name>,Agent 自行挑选空闲设备
```

`capacity` 决定一个设备能被多少个节点/负载同时使用。摄像机这类独占设备设为 1;串口之类的可共享设备可以调大,但要在 broker 里自行处理并发。

### 与 KubeEdge、OpenYurt 的关系

三者不是竞品:

```shell
KubeEdge / OpenYurt   解决「边缘节点如何被 Kubernetes 管理」—— 计算与网络的延伸
Akri                  解决「边缘设备如何被 Kubernetes 使用」—— 设备与协议的接入
```

实际部署中常见组合是:边缘侧用 `kubeedge` 或 `openyurt` 管理节点,节点上跑 Akri 把摄像头、PLC 暴露给业务 Pod。Akri 自己只要求一个能跑 DaemonSet 与 CRD 的 Kubernetes 集群。

### 与 DRA 的关系(需要留意的方向性变化)

Akri 复用的是 Kubernetes 的**设备插件(Device Plugin)**机制 —— 通过 `akri.sh/<configuration>` 这种扩展资源名申请设备。而 Kubernetes 从 **1.34 起把 DRA(Dynamic Resource Allocation)推到了 GA**,并在 1.35 之后锁定特性门控,它被普遍视为设备插件机制在**高级设备分配场景**的长期方向。

```shell
设备插件(Device Plugin)  只支持整数计数的扩展资源,表达能力有限
                         仍是稳定机制,官方未宣布废弃
DRA(resource.k8s.io/v1)  支持设备属性、容量、共享、按条件筛选
                         Akri 社区已有与 DRA 结合的探索(KubeCon EU 2024 有专门分享)

同一节点上,DRA 驱动与设备插件不能同时管理同一类设备 —— 会导致静默的超分
```

对 Akri 的选型意味着两点:短期内设备插件机制仍然可用,Akri 现有写法不会立刻过时;但中长期要关注 Akri 是否跟随 DRA 演进,尤其是在需要「按属性筛选设备」「多容器共享同一设备配额」这类需求的场景。

### 注意

1. **Akri 没有 MQTT Discovery Handler**。内置的只有 udev、ONVIF、OPC UA 与调试用的 debugEcho。需要 MQTT 设备接入时必须自己实现 Discovery Handler(gRPC 接口 + 注册到 Agent 的 Unix socket),不要按「装个 Akri 就能接 MQTT」来排期。
2. **v0.14.0 把 Kubernetes 基线从 1.16 提到了 1.33**。这是本版本最硬的破坏性变更:`k8s-openapi` 固定到 `v1_33`,镜像在低于 1.33 的集群上无法正常工作。老边缘集群(常见 1.22-1.28)要么先升集群,要么停留在 v0.13.8。
3. **CRD 的 Kind 是 `Configuration`,不是 `AkriConfiguration`**。网上不少文章写成 `kind: AkriConfiguration` / `kind: AkriInstance`,照着写会被 apiserver 拒绝。正确写法是 `apiVersion: akri.sh/v0` 配 `kind: Configuration` 或 `kind: Instance`。
4. **`Instance` 由 Agent 创建,不要手工改**。它的 `deviceUsage` 是设备共享的协调状态,手工编辑会与 Agent 的期望状态冲突,导致设备「显示被占用但实际没人用」。
5. **`discoveryDetails` 写错不会报错**。它是交给 Discovery Handler 自行解析的字符串,格式错误时表现为「Configuration 状态健康、但一个 Instance 都没有」,排障要看 Agent 与对应 handler 的日志。
6. **每个设备一个 broker Pod,资源开销要算清**。上百个设备意味着上百个 Pod 与其 sidecar 的开销;对采集类设备应考虑用配置级资源 + 单个 broker 管多设备,而不是一设备一 Pod。
7. **udev handler 需要 hostPath 与特权**。它要读节点的设备节点并挂载进 broker,`securityContext.privileged: true` 与宿主机路径挂载是必需的;这在受限的 Pod Security 策略下会直接被拦。
8. **v0.14.0 之后样例镜像换了位置**。官方样例 broker/app 仓库迁到 `project-akri/examples`,原先固定的 `ghcr.io/project-akri/akri/<sample>:latest-dev` 引用不再可解析,照旧文档拉镜像会 ImagePullBackOff。
9. **`helm delete` 不会删除 CRD**。`instances.akri.sh` 与 `configurations.akri.sh` 需要手动清理,否则重新安装时会带着旧的设备记录;彻底卸载后残留的 Instance 对象还会让新装的 Agent 误以为设备已被占用。
10. **OPC UA handler 依赖的 Rust crate 有已知安全问题**。v0.14.0 的发布说明中,`opcua` 0.12 冻结版本带来若干未清除的 RUSTSEC 告警,官方计划迁移到 `async-opcua`。用 OPC UA 的场景应关注这一进度,或把 OPC UA 的接入放在隔离的网络段内。
11. **Agent 是 DaemonSet,只会跑在带设备的节点上**。设备节点通常需要打标签让 Agent 调度过去;如果 Agent 不在该节点上运行,该节点的设备永远不会被发现,而 Configuration 不会给出任何错误提示。
12. **设备发现的时效性依赖 handler 的实现**。udev 的发现是事件驱动的(插拔即时),ONVIF/OPC UA 则多为周期性探测,新设备上线到 `Instance` 出现之间会有延迟;把它当作「实时」的能力来设计业务流程会踩坑。
13. **不要在同一节点上让 DRA 驱动与设备插件管理同一类设备**。Kubernetes 1.34 起 DRA 已经 GA,社区的迁移做法是用污点把两类工作负载分开、逐步切换。同时存在会造成设备被重复分配而无人察觉,表现为「两个 Pod 都认为自己独占了同一块设备」。Akri 走的是设备插件路线,引入 DRA 驱动时要先做节点级隔离。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `helm` — 安装 Akri 的 chart
- `kubeedge` — 边缘节点管理,可与 Akri 组合
- `openyurt` — 存量集群的边缘改造,可与 Akri 组合
- `k3s` — 边缘侧轻量发行版
- `crictl` — 排查 broker 容器
- `multus` — 多网卡场景下常与设备接入配合
- `device-plugin` — Akri 复用的 Kubernetes 设备插件机制

### 参考链接

- [Akri 官方文档](https://docs.akri.sh/)
- [Akri 快速开始与 Helm 安装](https://docs.akri.sh/user-guide/getting-started)
- [udev Discovery Handler](https://docs.akri.sh/discovery-handlers/udev)
- [ONVIF Discovery Handler](https://docs.akri.sh/discovery-handlers/onvif)
- [OPC UA Discovery Handler](https://docs.akri.sh/discovery-handlers/opc-ua)
- [Akri v0.14.0 发布说明(Kubernetes 基线提升至 1.33)](https://github.com/project-akri/akri/releases/tag/v0.14.0)
- [Akri GitHub 仓库](https://github.com/project-akri/akri)
- [Kubernetes 官方文档:动态资源分配(DRA)](https://kubernetes.io/docs/concepts/scheduling-eviction/dynamic-resource-allocation/)
- [Kubernetes 官方文档:设备插件](https://kubernetes.io/docs/concepts/extend-kubernetes/compute-storage-net/device-plugins/)
