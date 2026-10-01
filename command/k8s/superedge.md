superedge
===

已实质停止维护的边缘容器管理框架,原腾讯云牵头,选型请改用其他方案

## 补充说明

> **停更提示:SuperEdge 实质已停止维护,不要用于新项目。**
>
> - **最后一个 release:v0.9.0,2023-04-20**(支持 Kubernetes 1.22.6)
> - **最后一次代码提交:2024-02-20**(`main` 分支,commit `a979e05`)
> - GitHub 仓库**尚未打归档标记**(页面仍显示 Public),CNCF 页面也仍列为 Sandbox 项目 —— 但从 2024 年初起已无任何功能更新与安全补丁,停更时间超过两年
> - **替代方案**:全新边缘集群选 `kubeedge`(CNCF 毕业)或 `k3s` + 集中式编排;改造存量集群选 `openyurt`(CNCF 孵化);边缘设备接入选 `akri`
>
> 判定依据与自查方法见本站 `ecosystem-status` 页。

**SuperEdge** 是 2020 年 12 月由腾讯云牵头(联合 Intel、VMware、虎牙、寒武纪、美团等)发起的边缘容器管理系统,2021-09-14 成为 CNCF Sandbox 项目,设计目标是把跨地域的边缘资源当作**一个** Kubernetes 集群来管理。

它当年的定位很清晰,也解决了一批真实问题:**云边弱网时节点被误判为故障而驱逐 Pod**。为此它做了分布式健康检查 —— 由同区域的边缘节点互相探测投票,而不是只依赖云端心跳。这个思路至今仍有参考价值。

本页的作用有两个:一是**记录停更事实**,避免有人照旧教程把它装进生产;二是**保留设计要点**,这些思路在 KubeEdge 与 OpenYurt 里以另一种形式延续着。

### 现状核实(可自行复查)

```shell
# 1. 最后一次提交时间(仓库首页右侧 Commits 区域)
#    https://github.com/superedge/superedge/commits/main

# 2. 最后一次发布(注意 release 列表更新于 2023 年)
#    https://github.com/superedge/superedge/releases

# 3. CNCF 项目页面的健康度数据
#    https://www.cncf.io/projects/superedge/
#    贡献者数量与提交活跃度均处于持续下降状态
```

「未归档」和「在维护」是两件事:CNCF Sandbox 项目的归档需要走正式流程,而维护者往往在停止投入后并不会主动去归档仓库。**判断标准应看最后一次提交与发布的时间,而不是有没有 archive 标记。**

### 设计要点(仍值得了解)

```shell
云端组件
  tunnel-cloud              云边隧道的云端侧,与 tunnel-edge 保持持久连接
                            支持 TCP/HTTP/HTTPS 反向代理,让云端能访问 NAT 后的边缘节点
  application-grid controller  管理 DeploymentGrid / StatefulSetGrid / ServiceGrid 三类 CRD
  edge-health admission     把边缘侧的健康检查结果喂给 Kubernetes 控制器,避免误驱逐
  site-manager              管理 NodeUnit / NodeGroup,并提供 Kins(离线部署轻量 K3s)

边端组件
  lite-apiserver            轻量 apiserver 代理与缓存,边缘自治的核心
                            断网时用本地缓存应答,节点重启后业务容器仍能恢复
  tunnel-edge               主动连接 tunnel-cloud,接收云端请求并转发给本机 kubelet
  edge-health               同一边缘区域内的节点互相探测与投票
  application-grid wrapper  为同一 ServiceGrid 内的服务提供独立网络空间,流量闭环
```

其中 **lite-apiserver 的思路**(在边缘侧做一层带缓存的 apiserver 代理)与今天 OpenYurt 的 YurtHub 几乎一致;**edge-health 的分布式健康检查**则对应 KubeEdge 用 MetaManager 维持本地状态、避免云端误判的做法。理解这一段历史,有助于看懂后续框架为什么这样设计。

### 四大能力与今天的对应

| 能力 | SuperEdge 的实现 | 今天的对应方案 |
| --- | --- | --- |
| 边缘自治 | lite-apiserver 缓存代理 | OpenYurt YurtHub / KubeEdge MetaManager |
| 云边协同 | tunnel-cloud + tunnel-edge | KubeEdge CloudHub/EdgeHub(Raven 于 OpenYurt) |
| 海量站点管理 | NodeUnit + ServiceGrid 单元化 | OpenYurt NodePool + YurtAppSet |
| 分布式健康检查 | edge-health 互探投票 | 各框架自带的节点状态维持机制 |

### 安装方式(历史记录,不再推荐)

```shell
# edgeadm 是 SuperEdge 的安装工具,一键部署边缘集群
# 注意:以下命令在今天的 Kubernetes 版本上大概率无法直接使用

edgeadm init --kubernetes-version=1.22.6 \
  --apiserver-advertise-address=<ip> \
  --image-repository <registry> \
  --enable-lite-apiserver

# 边缘节点加入
edgeadm join <master-ip>:6443 --token <token> \
  --discovery-token-ca-cert-hash sha256:<hash>

# 回退
edgeadm reset
```

`edgeadm` 深度依赖 `kubeadm` 的内部实现与特定 Kubernetes 版本。Kubernetes 1.22 之后 kubeadm 的配置结构、证书流程、容器运行时接口都发生过变化,`edgeadm init` 在新版本上失败几乎是必然的 —— 这也是停更项目最直接的代价:**它不是「能用但不更新」,而是「随上游演进逐渐不能用」**。

### 迁移路径

存量 SuperEdge 集群的收尾建议按以下顺序:

```shell
1. 冻结版本    停止升级现有集群,记录当前 Kubernetes 与 SuperEdge 版本清单
2. 盘点依赖    梳理哪些能力在被真实使用(自治?隧道?单元化?)
               多数集群实际只用到其中 1-2 项,迁移量比想象的小
3. 能力映射    按上表把用到的能力映射到 KubeEdge / OpenYurt 的对应组件
4. 先迁 K8s    把底层 Kubernetes 升到受支持版本,再谈换边缘框架
5. 灰度切换    先迁一个边缘站点,验证自治与网络能力,再批量推进
6. 清理        移除 lite-apiserver 与 tunnel 相关静态 Pod 与 iptables 规则
```

第 6 步容易被遗漏:这类组件会改写节点上的网络规则并常驻静态 Pod,只删云端组件不清理节点,会留下难以定位的流量劫持问题。

### 为什么会停更

SuperEdge 的问题不在设计,而在**定位**:

```shell
1. 它要解决的「边缘自治」与「云边弱网」,后来被 KubeEdge 以更彻底的架构覆盖
2. 它要解决的「多站点单元化」,后来被 OpenYurt 的 NodePool + YurtAppSet 覆盖
3. 它要求在节点上常驻 lite-apiserver 与 tunnel-edge,运维面比「装一个 YurtHub」更重
4. 上游 Kubernetes 的演进(CRI、kubeadm 配置结构、EndpointSlice)持续产生适配成本,
   而没有足够的维护者跟上
```

这不是个例:**边缘框架是典型的「少数派胜出」领域**。CNCF 在边缘计算方向上最终由 KubeEdge(Graduated)与 OpenYurt(Incubating)占据主要位置,同期出现的其他方案声量普遍下降。选型时应优先看社区规模与 CNCF 成熟度,而不是功能对比表的行数 —— 功能表上多出来的那几行,两年后可能没人维护。

需要说明的是,SuperEdge 源自腾讯云 TKE Edge 这条**商业产品线**,开源项目停更不等于商业产品停更 —— 但对开源选型来说这没有意义,你依赖的是开源仓库,不是某家厂商的商业支持。

### 存量集群的自查清单

如果你的集群还在跑 SuperEdge,先回答这几个问题:

```shell
[ ] 当前 Kubernetes 版本是多少?是否还在上游支持范围内?
[ ] 有没有依赖 lite-apiserver 做过自定义(缓存路径、端口、启动参数)?
[ ] tunnel-cloud/tunnel-edge 是否在承担云端访问边缘 kubelet 的职责?
[ ] 有没有在用 DeploymentGrid/StatefulSetGrid/ServiceGrid 这些 CRD?
[ ] 有没有用 site-manager 的 Kins 在边缘部署 K3s?
[ ] 节点上的静态 Pod 清单里有哪些 SuperEdge 组件?
[ ] edge-health 的互探机制是否还在正常工作?
```

前三项的答案决定了迁移量:如果只是「装了但没深度使用」,迁移可能只是清理组件;如果大量业务依赖 ServiceGrid 的流量闭环,就需要逐站点改造。**先量化依赖,再谈迁移排期**,不要一上来就选替代方案。

### 注意

1. **「未归档」不代表「还在维护」**。SuperEdge 仓库至今没有 archive 标记,CNCF 页面也仍显示 Sandbox,但最后提交停在 2024-02-20、最后 release 停在 2023-04。判断项目是否可用,要看最后一次提交与发布的时间。
2. **停更的代价是「随上游失效」而非「立刻不能用」**。已运行的集群可以继续跑,但它支持的 Kubernetes 版本(1.22.6)已经落后于当前版本多个大版本,既无法升级底层,也拿不到任何 CVE 修复。
3. **镜像仍可拉取,安全补丁不会有**。「还能下载」是最容易让人放松警惕的信号;容器镜像里的基础镜像与依赖漏洞不会被修复。
4. **lite-apiserver 与 YurtHub 不能混用**。两者都通过改写节点网络规则接管发往 apiserver 的流量,同一节点上同时存在会造成请求被反复劫持,排查成本极高。
5. **迁移不是换组件,而是换架构**。lite-apiserver 与 YurtHub/MetaManager 的自治粒度、缓存对象、失效行为都不同,边缘侧的自定义脚本(依赖本地缓存路径或端口)需要一并改造。
6. **`site-manager` 的 Kins 能力没有直接替代**。它用于在边缘离线环境部署轻量 K3s 集群,类似需求今天通常用 `k3s` 加自动化工具自行拼装,迁移前要确认这个能力是否真的在用。
7. **`DeploymentGrid`/`ServiceGrid` 这类 CRD 需要重写**。OpenYurt 的对应抽象是 `NodePool` + `YurtAppSet`,字段与语义都不相同,不能直接转换 YAML。
8. **先升 Kubernetes 还是先换框架,要想清楚顺序**。两者同时进行会让故障归因变得不可能;建议先把底层升到目标版本(此时 SuperEdge 组件可能已经失效,需接受自治能力暂时缺失),再引入新的边缘框架。
9. **文档与教程仍在流传**。大量中文博客与腾讯云社区文章仍把 SuperEdge 描述为活跃项目,引用时请核对发布时间,2023 年之后的文章基本都是在复述旧内容。
10. **「商业产品还在」不能作为留下它的理由**。商业产品线会持续投入,但你依赖的是开源仓库里的代码、镜像与 chart,前者不会为后者打补丁。评估时要看仓库本身的状态。
11. **隧道组件的安全面要单独评估**。tunnel-cloud 让云端能反向访问边缘节点的 kubelet,这条链路一旦凭据泄露,等于边缘节点被完全控制;停更意味着这条链路不会再有安全加固。存量环境至少要在网络层限制其可达范围。
12. **迁移期间不要急着删除原组件**。新旧方案并行一段时间,用观察结果确认业务无感知后再清理;边缘站点往往分布广、排障成本高,回滚窗口要留足。

### 如何判断一个边缘项目是否值得投入

SuperEdge 的经历给出一份通用的检查清单,适用于任何边缘/基础设施开源项目:

```shell
[ ] 最后一次 release 距今多久?   超过 12 个月就要警惕,超过 24 个月基本可判死刑
[ ] release 节奏是否规律?        停更前往往先出现「发布间隔越来越长」
[ ] CNCF 成熟度如何?             Graduated / Incubating / Sandbox 差距很大
[ ] 贡献者是否来自多家公司?      单一厂商主导的项目,厂商转向即停更
[ ] 支持的 Kubernetes 版本跨度?  只支持两三个旧版本说明适配工作已经停了
[ ] issue 与 PR 的响应时间?      看最近三个月的实际响应,而不是总数量
[ ] 仓库是否归档?                —— 未归档不代表在维护,反之才成立
```

本站 `ecosystem-status` 页维护了一份已停更项目的清单,选型前建议先对照一遍。

### 相关命令

- `kubeedge` — 替代方案之一,CNCF 毕业的边缘计算框架
- `openyurt` — 替代方案之一,面向存量集群的零侵入改造
- `akri` — 边缘设备接入框架
- `k3s` — 边缘侧轻量发行版
- `kubectl` — Kubernetes集群管理工具
- `etcd` — 集群数据存储与备份

### 参考链接

- [SuperEdge GitHub 仓库(最后提交 2024-02-20)](https://github.com/superedge/superedge)
- [SuperEdge Releases(最后版本 v0.9.0,2023-04-20)](https://github.com/superedge/superedge/releases)
- [CNCF 项目页:SuperEdge](https://www.cncf.io/projects/superedge/)
- [SuperEdge 官方站点(内容停留在 v0.9.0)](https://superedge.io/)
- [KubeEdge 官方文档](https://kubeedge.io/docs/)
- [OpenYurt 官方文档](https://openyurt.io/docs/)
