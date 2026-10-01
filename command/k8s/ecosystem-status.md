ecosystem-status
===

Kubernetes生态中已退役、已归档与发生重大变更的项目汇总

## 补充说明

**这份清单回答一个具体问题:我准备用的那个项目,现在还活着吗?**

Kubernetes 生态迭代很快,大量教程与博客仍在推荐已经归档、停服甚至被移除的项目。按那些教程操作,轻则浪费时间,重则把已经没有安全补丁的组件装进生产集群。

本页汇总本站各页面在核查中确认的**状态变化**,按「已退役」「重大变更」「已毕业」三类组织。每一条都注明了时间点与替代方案。

### 已退役 / 已归档

这些项目**不要在新项目中使用**。仓库可能仍可访问、镜像仍可拉取,但不再有功能更新与安全补丁。

```shell
# ingress-nginx —— 2025-11-11 由 Kubernetes SIG Network 宣布退役
# 此后不再发布版本、修 bug 或打安全补丁(2026-03 后完全停止)
# 已有部署不受影响,镜像与 chart 仍可下载
# 替代:Gateway API,或 Traefik / Contour / Higress 等仍在维护的 Ingress 实现

# promtail —— 2026-03-02 EOL
# 官方明确指向 Grafana Alloy 作为替代
# 注意:很多 Loki 教程仍在用它,新部署应直接用 Alloy

# kaniko —— 2025-06-03 被 Google 归档为只读
# gcr.io/kaniko-project 镜像自归档起冻结,不再修 CVE
# 替代:Buildah、BuildKit,或社区 fork
#   chainguard-forks/kaniko(Chainguard EmeritOSS 计划,仅维护不加功能)
#   osscontainertools/kaniko(社区分支,长期单一维护人)

# MinIO —— 2026-02-12 仓库归档只读
# 时间线:2025-05 控制台移出社区版 → 2025-10 停发 Docker 镜像与二进制
#         → 2025-12-03 进入维护模式 → 2026-02-12 归档
# 替代:Ceph RGW、Garage、SeaweedFS、RustFS
# 最后一个社区版 release:RELEASE.2025-10-15T17-29-55Z

# kubeval —— 已停止维护,最后版本 v0.16.1(2021-03-30)
# 注意:仓库并未归档(仍可 clone/fork),只是被弃养
# 原仓库 README 首行即写明推荐改用 kubeconform
# 实测其默认 schema 源 https://kubernetesjsonschema.dev 已失效
#(域名 TLS 证书已不属于该站,请求全部失败)—— 这是今天用 kubeval 的第一道坎

# datree —— 2023 年 7 月商业公司关闭,仓库标记为 Public archive
# 最后版本 v1.9.19(2023-07-23),不再接受任何变更(含安全补丁)
# 替代:kubeconform、Kyverno、Conftest

# kube-hunter —— 已停止开发
# 官方 README 明确推荐改用 Trivy
# 最后小版本 0.6.8(2022-05),仓库最后推送约 2024-03

# chaosctl —— chaos-mesh 的配套 CLI,仓库已不存在(404)
# 排障改用 Chaos Dashboard 与控制器日志

# Grafana Agent —— 2025-11-01 EOL,替代品为 Grafana Alloy
# 注意:与之相关的 Pyroscope、Loki 等组件本身仍在维护,
#      别把「Grafana Agent 退役」误解成这些组件也停了

# superedge —— 事实停更(仓库未归档,CNCF 项目页仍列为 Sandbox)
#   main 分支最后提交 2024-02-20,最后 release v0.9.0(2023-04-20),只支持 k8s 1.22
#   这是「未归档 ≠ 在维护」的典型案例
#   替代:KubeEdge、OpenYurt、K3s、Akri

# kubeaudit —— 2024-10-30 被 Shopify 归档
#   最新版 v0.22.2(2024-08-21);每次运行都会往 stderr 打废弃提示
#   官方 README 推荐改用 kube-bench
#   替代:kube-linter、kubescape、trivy config

# kfctl —— 已归档(最后推送 2023-08)
#   同批归档的还有 pytorch-operator、mxnet-operator、xgboost-operator、kfserving-lts
#   注:kfctl 归档不代表 Kubeflow 项目本身停更(见下方"已毕业")

# ksniff —— 事实停更(仓库未归档,但已近 4 年无更新)
#   最后 release v1.6.2(2022-02-14),最后提交 2022-08-05
#   README 自述「isn't production ready」,不建议用于生产负载
#   替代:kubectl debug 临时容器、nsenter 进节点、cilium-dbg monitor

# spotahome/redis-operator —— 2026-06-11 归档只读
# 最后稳定版停在 2022-12-28,且只支持 Sentinel,完全没有 Cluster 模式
# 替代:OpsTree(OT-CONTAINER-KIT)redis-operator(redis.redis.opstreelabs.in)

# oracle/mysql-operator —— 旧仓库已归档
# 现由 github.com/mysql/mysql-operator 维护(InnoDBCluster / mysql.oracle.com/v2)
# 另外注意还有一个同名项目 Bitpoke(MysqlCluster,mysql.presslabs.org),
# 最后版本停在 2023-05 —— 选型前务必确认是哪一个
```

**部分废弃的组件:**

```shell
# OpenEBS 的 cStor 与 Jiva 引擎 —— 2024-04 废弃
# 已迁入 openebs-archive,当前主线是 Mayastor / Local PV
# 若用 OpenEBS,请勿选择 cStor / Jiva StorageClass

# nfs-subdir-external-provisioner —— kubernetes-sigs 托管的轻度维护项目
# 镜像长期停留在 v4.0.2,可用但不要期待新特性

# nfs-provisioner 类方案普遍如此:能用,但活跃度低

# loki-stack chart —— 已废弃,不再接收更新与支持
# 改用 loki chart(注意 2026-01 起迁至 grafana-community/helm-charts)

# Halyard(Spinnaker 的部署工具)—— 已废弃
# 现行走 kustomize 原生部署

# OLM v0 —— 处于维护模式(未归档,但无新功能;v0.46.0 / 2026-07-23)
# OLM v1(operator-controller + catalogd)是活跃线,但只覆盖 v0 的子集,
# 且两代之间没有官方迁移方案
```

### 已移除的 API 与特性

```shell
# PodSecurityPolicy(PSP)
#   v1.21 弃用 → v1.25 移除
#   替代:Pod Security Admission(PSA),v1.23 beta 默认启用、v1.25 GA
#   注意 PSA 的 enforce 不作用于 Deployment 等工作负载对象(只有 audit/warn 会)

# 容器运行时 dockershim
#   v1.24 移除,改用 CRI 接口(containerd / CRI-O)

# kube-rbac-proxy
#   镜像已退役,新项目不要再引入

# --cloud-provider 参数
#   1.29 起 DisableCloudProviders / DisableKubeletCloudCredentialProviders 默认 true
#   → 1.31 从核心组件永久移除 → 1.33 kube-apiserver 的 --cloud-provider 参数被移除
#   kubelet 与 kube-controller-manager 仅接受 external 或空串

# cgroup v1
#   Kubernetes 1.35 起废弃,且 kubelet 默认拒绝在 v1 节点启动
#   需显式设 failCgroupV1: false 才能继续用(不推荐)
#   注意 cgroup driver 与运行时必须一致,否则 kubelet 起不来
```

### 发生重大变更(项目仍活跃)

**这类最危险** —— 项目活着,但用法变了。照着旧教程做往往不报错,只是不生效。

```shell
# containerd 2.x 配置格式
#   1.x 的 [plugins."io.containerd.grpc.v1.cri"] 已过时
#   2.x 用 version = 3,CRI 插件拆为 io.containerd.cri.v1.runtime 与 .v1.images
#   pause 镜像键由 sandbox_image 变为 pinned_images.sandbox
#   静默失效坑:旧插件 ID 贴进 v3 配置不报错也不生效

# distribution(registry)3.x
#   配置路径由 /etc/docker/registry/config.yml 改为 /etc/distribution/config.yml

# cert-manager
#   installCRDs 自 1.15 弃用 → 改用 --set crds.enabled=true
#   建议同时设 crds.keep=true,防止卸载 release 时连带删除 CRD

# Kyverno 1.19 起弃用 kyverno.io 的 ClusterPolicy / Policy
#   替代品是 policies.kyverno.io 的 CEL 策略,计划 1.20(约 2026-11)移除旧类型

# Tekton 安装地址迁移
#   storage.googleapis.com/tekton-releases → infra.tekton.dev
#   注意 Triggers 的官方文档仍指向旧地址,两处不一致

# Grafana / Loki Helm charts —— 2026-01 迁至 grafana-community/helm-charts
#   新版默认镜像是 -distroless 变体(无 shell)
#   插件改用 GF_PLUGINS_PREINSTALL_SYNC,GF_INSTALL_PLUGINS 已废弃

# Sealed Secrets Helm 仓库已从 bitnami-labs.github.io 迁至 bitnami.github.io

# Argo CD 安装需带 --server-side --force-conflicts
#   原因是 CRD 体积超过客户端 262144 字节注解上限

# Flux CRD 已升到 v1(source/kustomize/image 组)
#   Helm 相关为 helm.toolkit.fluxcd.io/v2,旧教程的 v1beta2 已过时

# Vault —— 2023-08 起改用 BSL 1.1 许可,HashiCorp 于 2025-02 被 IBM 收购
#   主版本已从 1.21 跳到 2.0;HCP Vault Secrets(SaaS)2026-07-01 EOL
#   需要 MPL 许可的替代品可看 OpenBao

# kube-proxy 的 IPVS 模式 —— 已废弃(KEP-5495)
#   1.35 开始警告 → 1.37 引入 KubeProxyIPVS 门控(默认 true)
#   → 1.40 门控默认 false,不显式开启则 kube-proxy 直接报错退出
#   → 1.43 移除相关代码 → 1.46 移除门控
#   新集群请用 nftables(或 iptables)模式
#   注意 IPVS 内核特性本身健在,废弃的是 kube-proxy 的这个实现模式

# MetalLB 的 Helm 默认 BGP 后端已是 FRR-K8s(不是 FRR,也不是 native)
#   传统 FRR 后端官方标注 deprecated
#   指标前缀随之从 metallb_ 变为 frrk8s_
#   BGPPeer 当前为 v1beta2(v1beta1 已废弃)
#   L2 模式必须存在 L2Advertisement 对象(旧配置模型只需地址池)

# Cilium 的 BGP v2 CRD 为 CiliumBGPClusterConfig / CiliumBGPPeerConfig /
#   CiliumBGPAdvertisement(cilium.io/v2)
#   CiliumBGPPeeringPolicy 已在 1.19 移除
#   Agent 内命令自 1.16 起由 cilium 改名为 cilium-dbg

# Flannel 并非"完全无法做策略"
#   Helm 值 netpol.enabled(v0.25.5 起)可附带部署 kube-network-policies

# Capsule —— 仓库与文档已迁移组织
#   clastix/capsule → projectcapsule/capsule
#   文档与 chart 迁到 projectcapsule.dev / projectcapsule.github.io/charts
#   旧安装命令已失效;租户标签正从 capsule.clastix.io/tenant 迁往 projectcapsule.dev/tenant
#   networkPolicies 字段已弃用,改为 Tenant Replications
#   另注意:它只支持最新一个 Kubernetes minor 版本,不是"支持若干版本"

# Skupper v1 → v2 命令不兼容
#   v1 的 skupper init / skupper expose
#   → v2 改为 skupper site create / skupper connector create

# Velero 仓库迁移:vmware-tanzu/velero → velero-io/velero
#   (由 Broadcom 捐赠给 CNCF Sandbox,KubeCon EU 2026 / 2026-03 宣布)
#   同时注意:Restic 上传器已彻底移除 —— 1.15 弃用 → 1.17/1.18 禁止备份
#   → 1.19 起备份与恢复均不可用,Kopia 是唯一 uploader

# KServe 已脱离 Kubeflow,改隶 CNCF(2025-09 进入,incubating)
#   且 ModelMesh 已停止开发并从 KServe 移除(PR #4243,2025-02-16),
#   相关五个仓库已全部归档,官方没有提供替代品

# Kubeflow Pipelines 默认对象存储自 2.15.0 起由 MinIO 改为 SeaweedFS
#   (因 MinIO 已归档);但产物路径仍写作 minio:// 前缀

# Rancher 2.14 起移除内置 CAPI(rancher-provisioning-capi)
#   统一由 Rancher Turtles 承接

# containerd 2.0 移除了 containerd.service 的 LimitNOFILE=infinity
#   后果:容器内 nofile 变成 soft 1024 / hard 524288
#   这是「升级 containerd 后突然报 too many open files」的真实根因
#   注意 Kubernetes 没有任何 ulimit API(securityContext 无 ulimits 字段,写了会被拒)

# MicroK8s 1.36 移除了 dashboard 插件与 microk8s dashboard-proxy
#   ingress 插件自 1.35 起改用 Traefik
```

### 已毕业 / 已晋升(生态成熟度信号)

判断一个项目是否值得投入,CNCF 的成熟度分级是一个参考:

```shell
# Karmada —— 2026-09-07 从 CNCF 毕业(多集群编排)
# Kubeflow —— 2026-08 从 CNCF 毕业(ML 平台)
#   注意:kubeflow/manifests 已改名为 kubeflow/community-distribution,版本改 CalVer
#   另注意 kfctl 已归档(见上方"已退役"),但项目本身没停
# Kyverno —— 2026-03-24 从 CNCF 毕业(策略引擎)
# Dragonfly —— 2025-10-28 从 CNCF 毕业(镜像分发)
# Rook —— CNCF Graduated(2020-10-07)
# Confidential Containers —— 2026-07-22 由 Sandbox 晋升 Incubating
# Metal3 —— 2025-08-27 晋升 CNCF Incubating(裸金属管理)
# SPIFFE/SPIRE —— 2022-09-20 从 CNCF 毕业(工作负载身份)
# KubeVirt —— CNCF Incubating(2022-04 起),2026 仍在推进毕业
# Longhorn —— CNCF Incubating
# Submariner —— 2021-04-28 进入 Sandbox,至今未晋升
# Pixie —— CNCF Sandbox(New Relic 维护)
# Capsule —— CNCF Sandbox
# k0s —— 已捐入 CNCF Sandbox(仍由 Mirantis 主导)
```

### 如何自查一个项目是否还在维护

```shell
# 1. 看仓库首页有没有归档标记或维护状态说明
#    归档仓库会在标题下方显示 "Public archive"

# 2. 看最后一次发布的时间,而非最后一次提交
#    长期没有 release 但仍有提交,通常意味着维护力度下降

# 3. 看 README 顶部有没有指向替代品的说明
#    这是项目主动承认退役的信号(如 kubeval、kube-hunter)

# 4. 用 pluto 检查清单里的废弃 apiVersion
pluto detect-files -d ./manifests

# 5. 用 kubeconform 校验清单对目标 k8s 版本的 schema 兼容性
kubeconform -kubernetes-version 1.31.0 ./manifests
```

### 注意

1. **"还能下载"不等于"还在维护"**。归档项目的镜像往往仍可拉取,但不再有安全补丁 —— 这是最容易被忽略的风险点。
2. **弃用(DEPRECATED)与移除(REMOVED)是两回事**。弃用只是警告,移除才真正不可用。pluto 这类工具会区分两者。
3. **本页的状态会过时**。所有时间点都标注了,请以各项目官方仓库的当前状态为准。
4. **不要因为项目退役就急着迁移**。已有部署通常可以继续运行,先评估安全补丁缺失带来的实际风险,再排优先级。
5. **注意同名项目**。如 `postgres-operator` 有 Crunchy Data、Zalando、StackGres 等多个同名项目,`mysql-operator` 同理,查资料时先确认是哪一个。
6. **本文其余页面的「注意」小节里也记录了各项目的具体坑点**,遇到具体组件时建议对照阅读。

### 相关命令

- `kube-bench` — CIS 安全基线检查
- `kubeconform` — 清单 schema 校验
- `pluto` — 废弃 apiVersion 检测
- `trivy` — 镜像与集群漏洞扫描
- `kubeadm` — 集群版本升级

### 参考链接

- [Kubernetes 弃用 API 迁移指南](https://kubernetes.io/docs/reference/using-api/deprecation-guide/)
- [Kubernetes 已移除的 API 列表](https://kubernetes.io/docs/reference/using-api/deprecation-guide/#removed-apis)
- [CNCF 项目成熟度分级](https://www.cncf.io/projects/)
- [endoflife.date —— 各类开源项目生命周期查询](https://endoflife.date/kubernetes)
