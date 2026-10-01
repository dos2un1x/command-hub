multi-tenancy
===

在同一套 Kubernetes 上安全地跑多个租户:隔离维度、软硬租户的取舍与方案选型

## 补充说明

**多租户(Multi-Tenancy)** 指的是一套基础设施被多个互相独立的「租户」共享 —— 租户可以是团队、部门、业务线,也可以是对外客户。Kubernetes 本身只提供了**命名空间**这一种划分原语,它隔离的是名字、权限与配额,**不是计算与内核**。绝大多数多租户事故都源于把「命名空间」当成了「安全边界」。

讨论多租户时,先要回答一个问题:**租户之间互相信任吗?**

```shell
软多租户(soft multi-tenancy)
  同一组织内的团队,彼此不设防,主要防止误操作与资源争抢
  隔离目标是「不互相干扰」,而不是「不能互相攻击」
  命名空间 + RBAC + ResourceQuota + NetworkPolicy 通常就够了

硬多租户(hard multi-tenancy)
  租户之间互不信任,甚至是对外客户 / 受监管业务
  隔离目标包含「不能越界访问、不能提权、不能拒绝服务」
  需要内核级或节点级的隔离:虚拟集群、独立节点池、独立集群
```

**选错的代价是单向的**:把硬租户放进软隔离里,任何一次提权都会横向扩散;反过来把软租户按硬隔离做,则是在为一个不存在的问题付出运维成本。

### 隔离的维度

多租户不是一个开关,而是一组维度。规划时要逐条明确「靠什么隔离、边界在哪」:

```shell
维度          可用的手段                                    边界在哪
API 与对象    命名空间 / RBAC / 准入策略                    集群级资源是天然的越界口
网络          NetworkPolicy / CNI 能力 / 服务网格            默认同集群 Pod 互通
计算          资源配额 / LimitRange / 优先级 / 节点选择器      共享内核,CPU 是软配额
存储          StorageClass / PVC 准入 / 卷权限                hostPath 与本地卷是逃逸口
调度          nodeSelector / taint / topologySpread         节点共享时无法完全隔离
运行时        Pod Security Admission / seccomp / AppArmor   不直接作用于工作负载对象
可观测性      日志与指标的租户归属                          共享组件会串数据
成本          配额、计量、账单归属                           共享集群的摊销方式
```

### 三个层次的方案

```shell
方案            隔离强度   成本     租户能做什么                     典型实现
命名空间         弱        最低     在给定命名空间内自助              RBAC + Quota + PSA + NetworkPolicy
虚拟集群         中        中       有独立 API Server 与 CRD          vcluster
独立集群         强        最高     完全自主的集群                    Cluster API / vcluster standalone
```

**命名空间级**:最轻,适合内部团队。租户只能看到自己的命名空间,不能创建 CRD、不能创建集群级资源(除非显式授权)。缺点是无法限制内核层面的行为 —— 哪怕 PSA 开到 restricted,租户与宿主仍然共享 kubelet、内核与 conntrack。

**虚拟集群级**:每个租户拿到一套独立的控制面(自己的 API Server、CRD、RBAC),但工作负载仍跑在共享节点上。收益主要在 API 层:租户可以自由安装 Operator、定义 CRD,不会污染其他租户。代价是每个虚拟集群都有一份控制面开销。

**独立集群级**:隔离最彻底,代价是集群数量带来的运维、升级、成本与网络复杂度。通常只在硬多租户或合规要求下才值得。

三者的关键分界不在「租户能看到什么」,而在**「租户能对宿主节点做什么」**。前两者都不解决这个问题,只有独立节点池或独立集群才解决。

### 命名空间级的落地组合

单靠命名空间什么也隔离不了,真正起作用的是这一组东西的叠加:

```shell
1. RBAC          限定租户能操作哪些资源;禁止 cluster-admin 类绑定
2. ResourceQuota 限定命名空间的总量与对象数量
3. LimitRange    给出默认 requests/limits,否则配额生效后 Pod 会被拒绝
4. PSA           限制 privileged / hostPath / hostNetwork 等危险能力
5. NetworkPolicy 默认拒绝 + 显式放行,网络隔离必须自己做
6. 准入策略       Kyverno / Gatekeeper 补足 PSA 与 RBAC 覆盖不到的部分
```

典型的最小隔离清单:

```shell
apiVersion: v1
kind: ResourceQuota
metadata:
  name: tenant-a
  namespace: tenant-a
spec:
  hard:
    requests.cpu: "20"
    requests.memory: 40Gi
    limits.cpu: "40"
    limits.memory: 80Gi
    pods: "50"
    services.nodeports: "0"        # 禁止 NodePort,见「注意」
    persistentvolumeclaims: "10"
```

```shell
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny
  namespace: tenant-a
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
```

命名空间上还需要打上安全级别标签(PSA 的开关):

```shell
apiVersion: v1
kind: Namespace
metadata:
  name: tenant-a
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/warn: restricted
```

### 硬多租户的加强手段

当租户之间互不信任时,上面这套「命名空间组合拳」不够,需要往内核与节点层加码:

```shell
手段                做法                                        解决的威胁
独立节点池          给租户专属节点,打 taint,用 toleration 调度     避免共享 kubelet 与内核
运行时沙箱          用 gVisor / Kata Containers 作为 RuntimeClass 降低容器逃逸影响面
网络加密            集群内 mTLS(服务网格)或 WireGuard/IPsec      防同节点抓包
镜像与供应链        私有仓库、镜像签名校验、准入校验镜像来源        防投毒与横向拉取
审计与阻断          审计日志 + 准入策略 + 运行时检测(Falco)       事后追溯与实时告警
```

专属节点池的落地方式很简单,关键是**默认不让别人的 Pod 落上去**:

```shell
kubectl taint nodes tenant-a-node-1 dedicated=tenant-a:NoSchedule

# 租户侧要有对应的 toleration 才能调度
spec:
  tolerations:
    - key: dedicated
      operator: Equal
      value: tenant-a
      effect: NoSchedule
```

要注意 taint 只能防「误调度」,不能防「恶意调度」—— 只要租户有权创建带 toleration 的 Pod,它就能落到任何没有更强制约的节点上。真正的边界仍然要靠 RBAC 与准入策略把 toleration、nodeSelector 一并约束住。

一个粗糙但有效的判断标准:

```shell
如果租户之间出事时你会「报警并追责」        → 软多租户足够
如果租户之间出事时你会「上法庭或赔钱」      → 必须上硬隔离
```

### 决策清单

选型前逐条回答,大部分争论会在这里收敛:

```shell
1. 租户互相信任吗?不信任 → 排除纯命名空间方案
2. 租户需要自己的 CRD / Operator 吗?需要 → 考虑虚拟集群
3. 有合规或数据驻留要求吗?有 → 评估独立集群或独立节点池
4. 租户数量与增长率是多少?几十个还是几百个?虚拟集群的控制面开销要算进来
5. 谁负责租户集群的升级与排障?多租户会把运维复杂度乘以租户数
6. 租户需要 GPU / 大内存等特殊资源吗?需要 → 节点池与调度策略要提前设计
7. 出问题时如何界定责任边界?审计日志与租户标签必须在第一天就位
```

### 常见方案速查

```shell
Capsule            命名空间级;Tenant CRD 绑定一组命名空间与配额、权限、策略
vcluster           虚拟集群;每个租户一套控制面,Pod 仍跑在宿主节点
Karmada            多集群编排;管应用分发,不管单集群内的租户隔离
Submariner/Skupper 多集群网络;与「单集群内的多租户」是两个问题
Kyverno/Gatekeeper 准入策略;补足 PSA/RBAC 覆盖不到的控制点
```

选型时注意区分:**多租户**问的是「一群互不信任的人怎么共用一套设施」,**多集群**问的是「应用怎么分布到多个集群上」。两者经常同时出现,但解决的问题完全不同。

### 注意

1. **命名空间不是安全边界**。这是多租户话题里最重要的一句话:同一集群内的 Pod 默认共享 kubelet、内核、conntrack、容器运行时与节点资源。即使 RBAC 与配额都配对了,一次内核漏洞利用或一次特权容器创建就能跨租户逃逸。硬多租户必须叠加节点级隔离。

2. **NodePort 是最容易被忽略的横向通道**。租户创建一个 NodePort Service 就会占用宿主节点上的端口:既可能挤掉别人的端口,也可能把自己的服务暴露到集群外。上面的配额里写 `services.nodeports: "0"` 只是最直接的封堵方式,更彻底的做法是用准入策略禁止。

3. **hostPath 直接等于节点文件系统访问**。租户 Pod 挂载 `/`、`/var/run/docker.sock`、`/var/lib/kubelet` 都能拿到宿主控制权。必须靠 PSA 与准入策略禁止,配额拦不住。

4. **PSA 的 `enforce` 不作用于 Deployment 等工作负载对象**。这是官方明确记录的边界:Pod Security Admission 的强制只在实际创建 Pod 时生效,对 Deployment/StatefulSet 之类对象只有 `audit` 与 `warn` 会触发。也就是说,**租户可以成功创建一个违规的 Deployment**,问题要等到 Pod 真正被创建时才暴露。用 `kubectl get events` 或准入策略补上这个缺口。

5. **NetworkPolicy 是否生效取决于 CNI**。Calico、Cilium 原生支持;Flannel 默认不支持(需要额外部署 kube-network-policies 之类的组件)。**写了 NetworkPolicy 不等于有隔离**,部署后一定要做一次真实的连通性测试。

6. **ResourceQuota 生效后,新建 Pod 必须显式声明 requests/limits**。没有配套的 LimitRange 时,租户侧会大面积出现 `must specify limits.cpu` 类错误。这两者要成对部署。

7. **配额不限制「跨命名空间的租户总量」**。按命名空间配的配额,租户多建几个命名空间就能绕过。有总量要求时要么限制命名空间数量,要么用支持租户级配额的方案(Capsule 的 ResourcePool / GlobalResourceQuota 属于这一类)。

8. **集群级资源是越界的天然通道**。CustomResourceDefinition、ClusterRole、ValidatingWebhookConfiguration、StorageClass 都是集群级的;只要租户拿到了其中一个的写权限,就等价于拿到了影响整个集群的能力。审计 RBAC 时要把集群级资源单独列一份清单。

9. **虚拟集群里的 CRD 默认不同步到宿主**。以 vcluster 为例,租户在虚拟集群里安装的 Operator 与 CRD 默认只存在于虚拟集群内。这既是隔离的优点(不污染宿主),也是运维的坑:迁移或重建虚拟集群时这些定义不会自动跟着走。

10. **ServiceAccount token 是跨命名空间的凭证**。给租户集群级权限很容易通过「在别处创建 ServiceAccount、把 token 交给租户」的方式绕过命名空间边界;反之,租户的 token 泄漏也可能被用于横向访问。要定期轮换并审计。

11. **共享组件会泄漏信息**。同一个 Ingress Controller、同一个镜像仓库凭证、同一个日志采集器、同一个 GPU 设备插件,都可能把一个租户的数据带到另一个租户可见的地方。多租户场景下要逐条确认共享组件的租户归属与访问控制。

12. **审计与计费的归属要提前设计**。等出事之后再想「这个 Pod 是谁的」往往已经晚了。给命名空间打统一的租户标签、在审计日志里保留租户维度、在监控里按租户聚合,这三件事必须在集群投入使用前就做好。

13. **升级与准入策略的耦合要留意**。PodSecurityPolicy 已在 v1.25 移除,替代品是 PSA;Kyverno 等策略引擎也在演进(旧类型正在被 CEL 策略取代)。多租户的隔离强度直接依赖于这些准入机制,**升级集群前先确认准入策略仍然生效**。

### 相关命令

- `namespace` — 最基础的租户划分单元
- `rbac` — 租户权限的实际落地方式
- `resource-quota` — 命名空间级配额
- `limitrange` — 与配额配套的默认值与上下限
- `pod-security-admission` — 运行时约束的主要手段
- `networkpolicy` — 租户之间的网络隔离
- `capsule` — 命名空间级多租户框架
- `vcluster` — 虚拟集群方案
- `kyverno` — 准入策略,补足 PSA 与 RBAC

### 参考链接

- [Kubernetes 多租户官方文档](https://kubernetes.io/docs/concepts/security/multi-tenancy/)
- [命名空间隔离与共享集群](https://kubernetes.io/docs/concepts/overview/working-with-objects/namespaces/)
- [Pod Security Admission](https://kubernetes.io/docs/concepts/security/pod-security-admission/)
- [CNCF 多租户白皮书](https://github.com/cncf/tag-security/blob/main/community/resources/multi-tenancy-whitepaper/multi-tenancy-whitepaper.md)
- [Kubernetes 安全清单:多租户](https://kubernetes.io/docs/concepts/security/security-checklist/)
