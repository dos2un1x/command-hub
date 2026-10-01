trivy-operator
===

在集群内持续扫描工作负载并把结果写成CRD的Kubernetes Operator

## 补充说明

**trivy-operator** 是 Aqua 开源的集群内安全扫描 Operator,把 Trivy 的扫描能力从「手工跑一次」变成**持续自动执行**,并把每一次结果固化成 Kubernetes 对象。

理解它只要抓住一句话:**`trivy k8s` 是 CLI 的即时扫描,trivy-operator 是把同一套扫描搬进集群、由控制器按需触发、结果落到 CRD 里**。

两者的分工:

```shell
trivy k8s            命令行即时扫描,人盯着看,结果在终端里
trivy-operator       常驻控制器,持续扫描,结果成为可查询、可告警、可归档的 API 对象
```

在这批工具里的分工:

```shell
kube-bench          CIS 基线,节点与进程配置
kubescape          框架合规(NSA/CISA、MITRE),也有集群内 Operator
kube-linter        清单 lint,纯客户端
trivy              命令行漏洞与配置扫描
trivy-operator     集群内持续扫描,结果写成 CRD —— 本页
```

历史沿革需要知道:这个项目的前身是 **Starboard**(Aqua 2022-05 宣布停掉 Starboard 并并入 Trivy 家族)。当时的 starboard-operator 更名成了 Trivy Operator,Starboard CLI 则演变为今天的 `trivy k8s`。老仓库 `aquasecurity/starboard` 未归档,但描述里写着「Superseded by trivy-operator」。

**文档地址是个坑:官方文档在 `aquasecurity.github.io/trivy-operator/`,不在 `trivy.dev` 上。** `trivy.dev/latest/docs/operator/` 会 404 —— trivy.dev 的文档侧栏里根本没有 Operator 章节。查资料时直接去前者。

当前状态:**活跃维护**,最新版本 **v0.34.0(2026-08-24)**,基本按月发布。README 声明项目仍处于 incubating 阶段,「some APIs and Custom Resource Definitions may change」,没有跨版本稳定性承诺。

### 安装

```shell
# Helm(先加仓库)
helm repo add aqua https://aquasecurity.github.io/helm-charts/
helm repo update
helm install trivy-operator aqua/trivy-operator \
  --namespace trivy-system --create-namespace

# Helm OCI(需要 Helm >= 3.8.0)
helm install trivy-operator oci://ghcr.io/aquasecurity/helm-charts/trivy-operator \
  --namespace trivy-system --create-namespace

# 静态 YAML
kubectl apply -f https://raw.githubusercontent.com/aquasecurity/trivy-operator/<TAG>/deploy/static/trivy-operator.yaml
```

```shell
# 确认部署成功
kubectl get deployment -n trivy-system
```

几个必须知道的默认值:

```shell
命名空间        trivy-system(静态 YAML 会创建它)
扫描范围        除 kube-system 与 trivy-system 之外的所有命名空间
```

**卸载静态 YAML 会连带删除所有已生成的安全报告以及 CRD。** 卸载前先把要留的报告导出。

### 语法

trivy-operator 没有 CLI,所有操作通过 `kubectl` 与 `helm` 完成。

```shell
# 查看各类报告
kubectl get vulnerabilityreports,configauditreports,exposedsecretreports -A
kubectl get rbacassessmentreports,infraassessmentreports,sbomreports -A
kubectl get clustercompliancereports
kubectl get clustervulnerabilityreports,clustersbomreports

# 看某一份报告的详情
kubectl get vulnerabilityreport -n default -o yaml
kubectl describe configauditreport -n default <名称>
```

CRD 的短名:`vulns` / `vuln`、`configaudit` / `configaudits`、`exposedsecret` / `exposedsecrets` 等。

### CRD 一览

API 组与版本是 **`aquasecurity.github.io/v1alpha1`**。实际随 chart 发布的 CRD 共 12 个:

```shell
命名空间级
  VulnerabilityReport     工作负载镜像的 CVE 结果
  ConfigAuditReport       工作负载/资源配置审计
  ExposedSecretReport     镜像里暴露的密钥
  RbacAssessmentReport    Role / RoleBinding 的 RBAC 评估
  InfraAssessmentReport   基础设施类资源评估
  SbomReport              软件物料清单

集群级(Cluster 前缀)
  ClusterVulnerabilityReport    控制平面与节点组件的 CVE
  ClusterConfigAuditReport
  ClusterRbacAssessmentReport
  ClusterInfraAssessmentReport
  ClusterSbomReport
  ClusterComplianceReport       按合规框架汇总的结果
```

**注意官方文档的 CRD 表格并不完整**:它漏掉了 `ClusterComplianceReport`、`ClusterVulnerabilityReport`、`ClusterSbomReport`、`ClusterConfigAuditReport` 四个(它们确实随 chart 发布),还把 `exposedsecretreports` 拼成了 `exposedsecretsreports`。**以仓库的 `deploy/helm/crds/` 目录为准。** `ClusterComplianceDetailReport` 有文档页但没有 CRD 文件,属于旧版遗留,已被 `ClusterComplianceReport` 取代。

### 聚合报告是怎么来的

这里要纠正一个常见误解:**不存在一个叫「聚合报告开关」的 Helm 值。** 聚合是通过 Cluster 前缀的 CRD 实现的,而它们的触发条件各不相同:

```shell
ClusterVulnerabilityReport   由 ClusterSbomReport 派生(ownerReferences 指向它)
                             要求 operator.sbomGenerationEnabled 为 true(默认 true)
                             values.yaml 原文:required for enabling ClusterVulnerabilityReports
                             注意:它只支持原生 Kubernetes / RKE2,托管云厂商的集群不适用

ClusterComplianceReport      由 compliance.* 一组值控制,见下
```

`ClusterSbomReport` 体积可观,是 etcd 存储的主要压力来源。下游不少封装发行版会主动把 `operator.sbomGenerationEnabled` 设为 `false`,除非确实有人消费 `ClusterVulnerabilityReport`。

### 合规报告

```shell
compliance.specs       要生成哪些合规报告
compliance.cron        重新生成的周期,默认 0 */6 * * *(每 6 小时)
compliance.reportType  summary 或 all
compliance.failEntriesLimit  逐条明细的数量上限,默认 10
```

Helm 默认创建的合规规格是:

```shell
k8s-cis-1.23
k8s-nsa-1.0
k8s-pss-baseline-0.1
k8s-pss-restricted-0.1
```

values.yaml 里还注释着 `eks-cis-1.4` 与 `rke2-cis-1.24` 可供开启。

**注意裸名字 `nsa` / `cis` 与 CR 的实际名字不是一回事。** 文档的「内建报告」表里写的是 `nsa`、`cis`,而 Helm 真正创建出来的对象名是 `k8s-nsa-1.0`、`k8s-cis-1.23`。`pss-baseline` / `pss-restricted` 同理,实际是带版本号的 `k8s-pss-baseline-0.1` / `k8s-pss-restricted-0.1`。

```shell
kubectl get clustercompliancereports
kubectl get clustercompliancereport k8s-nsa-1.0 -o yaml
```

### 关键 Helm 值

```shell
# 扫描器开关(默认全开)
operator.vulnerabilityScannerEnabled / configAuditScannerEnabled
operator.rbacAssessmentScannerEnabled / infraAssessmentScannerEnabled
operator.exposedSecretScannerEnabled / clusterComplianceEnabled

# 扫描范围
operator.targetNamespaces        默认空 = 全部
operator.excludeNamespaces
operator.targetWorkloads         默认 pod,replicaset,replicationcontroller,
                                 statefulset,daemonset,cronjob,job

# 调度与并发
operator.scanJobTimeout          默认 5m
operator.scanJobsConcurrentLimit 默认 10 —— 注意名字,不是 concurrentScanJobsLimit
operator.scanJobsRetryDelay      默认 30s
operator.scanNodeCollectorLimit  默认 1

# Trivy 自身
trivy.severity           默认 UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL
trivy.ignoreUnfixed      默认 false
trivy.timeout            默认 5m0s
trivy.mode               Standalone 或 ClientServer
trivy.resources          requests 100m/100M,limits 500m/500M
trivy.image.*            默认 mirror.gcr.io / aquasec/trivy / 0.74.0

# 报告生命周期
operator.scannerReportTTL        默认 24h —— 报告 24 小时后被删除!
operator.scanJobTTL              默认空 = 不清理
alternateReportStorage.enabled   默认 false;true 则报告写 PVC 而不是 CRD

# 压缩扫描 Job 日志(注意作用域不是 operator.*)
trivyOperator.scanJobCompressLogs  默认 true
```

`operator.scanJobCompressLogs` 这个名字在旧资料里很常见,但在 chart 0.36.0 里 **它已经不在 `operator.` 下面了**,正确路径是 `trivyOperator.scanJobCompressLogs`。`operator.concurrentScanJobsLimit` 同样是错的,应为 `operator.scanJobsConcurrentLimit`。

### 报告的存储与生命周期

```shell
默认    报告作为 CRD 存在 etcd 里,数量 = 工作负载数 × 扫描次数
        所以在大集群上对象数量会持续增长,是 etcd 容量的真实压力来源

TTL     operator.scannerReportTTL 默认 24h,会给报告打上注解
        trivy-operator.aquasecurity.github.io/report-ttl
        控制器据此重新排队并在过期后清除,启动时也会扫一遍
        单份报告可以改这个注解来覆盖全局值

替代存储 alternateReportStorage.enabled=true 把报告写到 PVC 上的 JSON 文件
```

控制器还利用 Kubernetes 的垃圾回收机制做失效与重扫:删除一个 ReplicaSet 会连带删除它的 `VulnerabilityReport`;删除被 ReplicaSet 拥有的报告会触发重扫并重建。配置变更同样会触发重扫 —— 插件配置 ConfigMap 的内容被哈希后以 `plugin-config-hash` 标签写在 `ConfigAuditReport` 上,哈希对不上就删除旧报告重新扫描。

### 私有仓库与离线环境

```shell
# 扫描工作负载镜像时用到的拉取凭据
operator.privateRegistryScanSecretsNames   形如 namespace: "secret1,secret2"
operator.accessGlobalSecretsAndServiceAccount  默认 true

# Trivy 镜像自身 / 漏洞库
trivy.image.registry / repository / tag / imagePullSecret
trivy.dbRegistry / trivy.dbRepository        默认 mirror.gcr.io / aquasec/trivy-db
trivy.javaDbRegistry / trivy.javaDbRepository
trivy.registry.mirror
```

**已知限制:operator 不支持同时使用多个仓库的不同凭据。** 需要认证时,`trivy-db` 与 `trivy-java-db` 必须来自同一个仓库,认证用的是 `trivy.dbRepository` 上配的那个。

气隙环境还需要 `trivy.offlineScan: true`(禁止一切出站 HTTP 请求)、`trivy.useEmbeddedRegoPolicies: true`(用镜像内嵌的 Rego 策略,默认开启,与 `trivy.useBuiltinRegoPolicies` 互斥)、`trivy.clientServerSkipUpdate: true` 与 `trivy.skipJavaDBUpdate: true`,以及按需设置 `operator.httpProxy` / `trivy.httpProxy` / `httpsProxy` / `noProxy`。

配置除了走 Helm values,还可以落到 ConfigMap/Secret 里:`trivy-operator-trivy-config` 是主配置(配套同名 Secret 放 token)。用 `operator.valuesFromConfigMap` / `trivy.valuesFromConfigMap`(以及 `valuesFromSecret`)能让它们**覆盖** Helm 值。

### 指标

Operator 通过 Service 暴露 `/metrics`,可与 Prometheus 对接:

```shell
trivy_image_vulnerabilities     VulnerabilityReport 中各状态的计数
trivy_resource_configaudits     ConfigAuditReport 的检查计数
trivy_resource_infraassessments InfraAssessmentReport 的检查计数
trivy_role_rbacassessments      RbacAssessmentReport 的检查计数
trivy_image_exposedsecrets      ExposedSecretReport 的检查计数
trivy_cluster_compliance        合规状态,带 description / status / title 标签
```

还有一批逐条明细的指标(`trivy_configaudits_info`、`trivy_vulnerability_id` 等)默认关闭,因为**它们会显著放大指标基数**。需要时通过 `metricsConfigAuditInfo`、`metricsVulnIdEnabled` 等开关打开。

给报告指标加业务标签:设 `trivyOperator.reportResourceLabels: "owner,app"` 后,指标上会出现 `k8s_label_owner="platform"` 这类标签;前缀由 `trivyOperator.metricsResourceLabelsPrefix` 控制,默认 `k8s_label_`。

### 注意

1. **文档地址不是 trivy.dev**。`trivy.dev/latest/docs/operator/` 直接 404,官方文档在 `aquasecurity.github.io/trivy-operator/`。同样地,`aquasecurity.github.io/trivy-operator/latest/docs/settings/` 也 404,设置项以仓库里的 `docs/settings.md` 为准。
2. **报告默认 24 小时后被删除**。`operator.scannerReportTTL` 默认 `24h`。很多人装完隔天回来发现报告全没了,以为出了故障 —— 这是设计行为。要做长期趋势分析,要么调大这个值,要么开 `alternateReportStorage`,要么把指标接进 Prometheus。
3. **不存在名为 aggregatedReports 的 Helm 值**。聚合报告的能力通过 Cluster 前缀 CRD 实现,是否产出取决于 `operator.sbomGenerationEnabled` 等具体开关,不要去 values.yaml 里找一个不存在的总开关。
4. **两个 Helm 值名字与旧资料不符**。`operator.concurrentScanJobsLimit` 的正确名字是 **`operator.scanJobsConcurrentLimit`**;`operator.scanJobCompressLogs` 的正确路径是 **`trivyOperator.scanJobCompressLogs`**。照旧文章写会被 Helm 静默忽略(不报错,但也不生效)。
5. **扫描 Job 会真实消耗集群资源**。每个工作负载一次扫描就是一个跑 Trivy 镜像的 Job,默认 requests 100m CPU / 100M 内存,limits 500m / 500M。大集群上这是可观的开销,应该调 `operator.scanJobsConcurrentLimit`(默认 10)和 `trivy.resources`。
6. **`trivy.severity` 默认什么级别都报**。默认值是 `UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL`,开箱即用的输出会很吵。生产上通常收敛到 `HIGH,CRITICAL`。
7. **扫描 Job 本身不是特权容器**。默认带 `allowPrivilegeEscalation: false`、`drop: ALL`、`readOnlyRootFilesystem: true`,是不折不扣的加固配置。**但把 `trivy.command` 改成 `filesystem` 或 `rootfs` 时它必须以 root 运行**(values.yaml 里明确写了 `runAsUser: 0`)。所以「这个 Operator 需要特权」的说法只在特定模式下成立。
8. **真正需要特权的是 node-collector**。它通过 hostPath 挂载 `/var/lib/etcd`、`/var/lib/kubelet`、`/etc/kubernetes`、`/etc/cni/net.d/`、`/etc/systemd`、`/lib/systemd/` 等路径来读节点组件信息,在严格启用 Pod Security Admission 的命名空间里会直接起不来。可用 `nodeCollector.excludeNodes` 跳过节点,用 `operator.scanNodeCollectorLimit`(默认 1)限制并发。
9. **`ClusterVulnerabilityReport` 在托管 Kubernetes 上不工作**。它只支持原生 Kubernetes 与 RKE2;EKS、GKE、AKS 这类托管集群拿不到有意义的结果。
10. **`ClusterSbomReport` 会显著撑大 etcd**。SBOM 对象很大,而它又是 `ClusterVulnerabilityReport` 的前置条件。不需要节点组件漏洞视图时,把 `operator.sbomGenerationEnabled` 关掉能省下大量存储。
11. **chart 版本与 app 版本不是一个号**。chart 0.36.0 对应的 appVersion 是 0.34.0。`helm install --version` 填的是 **chart** 版本,别把两个数字搞混。
12. **CRD 仍可能变化**。README 明确说项目处于 incubating,API 与 CRD 会变。升级 Operator 前先看 release notes 里有没有 CRD 变更,必要时手工 `kubectl apply` 新的 CRD。
13. **私有仓库凭据只能配一套**。需要认证时 `trivy-db` 与 `trivy-java-db` 必须来自同一仓库,不支持给不同仓库配不同凭据。
14. **和 `trivy k8s` 的结果不会完全一致**。CLI 扫描有 node-collector 与其他采集路径,Operator 的采集范围由 `targetWorkloads`、`targetNamespaces` 等值决定。两边的数字对不上时,先核对扫描范围而不是怀疑哪边算错了。

### 相关命令

- `trivy` — 命令行扫描,与 Operator 共用同一套引擎
- `kubescape` — 框架合规扫描,也有集群内 Operator
- `kube-bench` — CIS 基线,面向节点
- `kube-linter` — 清单 lint,纯客户端
- `popeye` — 集群现状只读体检
- `kubectl` — Kubernetes集群管理工具

### 参考链接

- [trivy-operator 官方文档](https://aquasecurity.github.io/trivy-operator/latest/)
- [trivy-operator CRD 说明](https://aquasecurity.github.io/trivy-operator/latest/docs/crds/)
- [trivy-operator 设置项](https://github.com/aquasecurity/trivy-operator/blob/main/docs/settings.md)
- [trivy-operator 指标](https://github.com/aquasecurity/trivy-operator/blob/main/docs/tutorials/integrations/metrics.md)
- [trivy-operator GitHub 仓库](https://github.com/aquasecurity/trivy-operator)
- [Starboard 并入 Trivy 的公告](https://github.com/aquasecurity/starboard/discussions/1173)
