kubescape
===

按NSA/CISA、MITRE等安全框架扫描Kubernetes集群与清单的合规工具

## 补充说明

**kubescape命令** 是 ARMO 开源、已进入 **CNCF Incubating**(2025-02-26 晋升,尚未毕业)的 Kubernetes 安全合规扫描工具。它的定位可以一句话说清:**把「你的集群符合哪套安全框架、差了哪几条」变成一份可执行的报告**。

它和 kube-bench 的根本区别在**检查的对象与依据**:

```shell
kube-bench   读节点的实际配置(进程参数、文件权限、kubelet 配置),依据 CIS Benchmark
kubescape    读集群里的 API 对象(工作负载、RBAC、网络策略……),依据 NSA/CISA、MITRE 等框架
```

kube-bench 要 root、要 `--pid=host`,查的是「机器配得对不对」;kubescape 用普通 kubeconfig 就能跑,查的是「你部署的东西安全不安全」。两者不重叠,**生产环境通常两个都要**。

扫描目标有三类:

```shell
framework      按框架扫,最常用(NSA、MITRE、ArmoBest 等)
control        按单条控制项扫
workload       只扫工作负载
```

框架与控制项的定义来自独立仓库 **kubescape/regolibrary**(用 Rego 编写),通过滚动发布标签 `v2` 分发。

在这批工具里的分工:

```shell
kube-bench     CIS 基线,面向节点与进程配置
kubescape      NSA/CISA、MITRE 框架合规 + 集群内 Operator —— 本页
kube-linter    清单 lint,不碰集群
kubesec        单份清单的安全评分
trivy          漏洞 + 配置 + 密钥 + RBAC
kube-score     可靠性与安全最佳实践评分
```

### 安装

```shell
# Linux / macOS 一行脚本
curl -s https://raw.githubusercontent.com/kubescape/kubescape/master/install.sh | /bin/bash

# Homebrew
brew install kubescape

# krew(作为 kubectl 插件,调用方式为 kubectl kubescape)
kubectl krew update && kubectl krew install kubescape

# 其他包管理器:Chocolatey、Scoop、Arch、Ubuntu PPA、Nix、openSUSE 均有
# 注意这些社区维护的包可能落后于最新 release
```

脚本安装会把二进制放到 **`~/.kubescape/`**,需要把这个目录加进 `PATH`。官方文档里另一处写的 `/.kubescape/bin` 与之矛盾,以故障排查页的 `~/.kubescape` 为准。

**安装 CLI 不需要 ARMO 账号**,账号只在用云端功能时才需要。

离线环境要预先下载规则与工件:

```shell
# 下载全部扫描工件
kubescape download artifacts --output path/to/dir
kubescape scan --use-artifacts-from path/to/dir

# 也可以只下载某个框架
kubescape download framework nsa --output /path/nsa.json
kubescape scan framework nsa --use-from /path/nsa.json
```

### 语法

```shell
kubescape scan framework <框架名> [目标] [flags]
```

**注意:`--frameworks` 不是 `scan` 的参数。** 框架是通过**位置参数**指定的,`kubescape scan framework nsa` 才是正确写法。`--frameworks` 只存在于 Operator 的触发命令 `kubescape operator scan configurations --frameworks` 上。这是查 kubescape 资料时最容易搞混的一点。

```shell
kubescape scan                   扫描主命令
kubescape scan framework nsa     按 NSA 框架扫描
kubescape scan control C-0016    只跑某条控制项
kubescape scan workload          只扫工作负载
kubescape scan image <镜像>      扫镜像
kubescape fix                    根据报告自动修复
kubescape patch                  生成补丁
kubescape list                   列出 frameworks / controls / controls-config / exceptions
kubescape download               下载 artifacts / framework
kubescape config                 管理配置(set / delete / view)
kubescape operator               触发集群内 Operator 的扫描或修复
kubescape vap                    管理 ValidatingAdmissionPolicy
kubescape version                查看版本
```

### 常用框架名

```shell
nsa                   NSA / CISA Kubernetes 加固指南(最先看的那个)
mitre                 MITRE ATT&CK for Containers
armobest              ARMO 的最佳实践集合(注意内部名是 ArmoBest,命令行写小写)
allcontrols           全部控制项
cis-v1.23-t1.0.1      CIS Kubernetes Benchmark v1.23
cis-eks-t1.8.0        CIS Amazon EKS
cis-aks-t1.8.0        CIS Azure AKS
cis-gke-v1.9.0        CIS Google GKE
soc2 / devopsbest / security / clusterscan / workloadscan / agentruntimehardening
```

框架名**大小写不敏感**(代码用 `strings.EqualFold` 比较)。默认的集群扫描用的是「security view」,即 `clusterscan + mitre + nsa` 的组合 —— 这与 Kubescape 3.0 之前「默认扫 NSA + MITRE」的行为不同,升级后要留意报告内容的变化。

### 常用操作

```shell
# 扫当前集群(最常用)
kubescape scan

# 指定框架扫集群
kubescape scan framework nsa
kubescape scan framework mitre --include-namespaces production

# 扫本地清单文件或目录
kubescape scan framework nsa /path/to/manifests
kubescape scan framework cis-v1.23-t1.0.1 ./deploy/

# 从标准输入扫
cat ./manifests/deployment.yaml | kubescape scan framework nsa -

# 只看高危
kubescape scan --severity-threshold high

# 按合规百分比设置门槛:低于 80% 就失败
kubescape scan framework nsa --compliance-threshold 80

# 多格式输出
kubescape scan --format json,html,junit --output result

# 列出可用框架与控制项
kubescape list frameworks
kubescape list controls
```

支持 16 种输出格式:

```shell
pretty-printer(默认)、json、junit、prometheus、pdf、html、sarif、
gitlab-sast、github-actions、yaml、csv、markdown、
cyclonedx-json、spdx-json、policyreport、exceptions
```

**SARIF 只支持文件 / 仓库扫描,不支持集群扫描** —— 这是官方文档明确的限制,想接代码扫描平台就要先 `kubescape scan` 扫文件而不是集群。`cyclonedx-json` / `spdx-json` 只在镜像扫描时可用。`csv` 在镜像扫描时会报错。

### 扫描结果上传:--submit

```shell
--submit             把结果提交到 Kubescape SaaS(默认关闭)
--account            账号 ID
--access-key         访问密钥
--keep-local         不把结果上报到已配置的后端
--omit-raw-resources 不上传原始资源内容
--hide               用确定性假名替换敏感名称
--encrypt            加密报告元数据,需 KUBESCAPE_MASTER_KEY
```

三个互斥关系必须记住:

```shell
--submit 与 --keep-local         不能同时用
--submit 与 --omit-raw-resources 不能同时用
```

`--submit` 是 no-opt 标志:单独写 `--submit` 等于 `--submit=true`,写 `--submit=false` 则显式关闭。要真正提交必须提供 `--account` 与 `--access-key`(或用 `KS_ACCOUNT` 环境变量 / 本地缓存配置)。

### 自动修复:fix

```shell
kubescape fix <报告文件> [flags]
```

行为按扫描目标分成两条路,这是理解 `fix` 的关键:

```shell
清单 / 仓库扫描   直接就地改写 YAML / JSON 文件(YAML 保留注释,只改动的行被重写)
集群扫描          不会写集群。补丁在内存里生成后打到 stdout,由你自己接管
```

参数:

```shell
--dry-run          只预览不落地
--no-confirm       跳过确认
--skip-user-values 跳过需要用户填值的改动(默认 true)
--output-dir       集群扫描时,把每个资源的补丁写成单独文件而不是打到 stdout
--include-controls 只修这些控制项
--skip-controls    跳过这些控制项(优先级高于 --include-controls)
```

Helm chart 只会给出建议、**不会被自动改写**(渲染后的资源路径无法映射回模板行)。`kind: List` 包装的资源也会被跳过。

### 集群内 Operator

CLI 是「跑一次」的模型,要持续扫描就部署 Operator:

```shell
helm repo add kubescape https://kubescape.github.io/helm-charts/
helm repo update

helm upgrade --install kubescape kubescape/kubescape-operator \
  -n kubescape --create-namespace \
  --set clusterName=`kubectl config current-context` \
  --set capabilities.continuousScan=enable
```

官方说明**只支持用 Helm 或 ArgoCD 安装这个 chart**。安装后 `kubescape` 命名空间内应有 `kubescape`、`kubevuln`、`operator`、`storage` 等 Pod。

Operator 的扫描结果写成 CRD,API 组是 **`spdx.softwarecomposition.kubescape.io/v1beta1`**:

```shell
VulnerabilityManifest / VulnerabilityManifestSummary
WorkloadConfigurationScan / WorkloadConfigurationScanSummary
ConfigurationScanSummary / VulnerabilitySummary
ContainerProfile / OpenVulnerabilityExchangeContainer
GeneratedNetworkPolicy / KnownServer
SBOMSyft / SBOMSyftFiltered / SeccompProfile / CollapseConfiguration
```

```shell
kubectl get crd vulnerabilitymanifests.spdx.softwarecomposition.kubescape.io
kubectl get workloadconfigurationscans -A
```

手动触发 Operator 扫描:

```shell
kubescape operator scan configurations --frameworks all
kubescape operator scan vulnerabilities
kubescape operator remediate annotate --kind Deployment \
  --target-namespace payments --name api --reason "C-0016"
```

### 注意

1. **`--fail-threshold` / `-t` 已经是隐藏的空操作**。它在源码里被标记为 deprecated 并隐藏,绑定到一个不参与任何判断的变量上,**写它不会报错,也不会产生任何效果**。它保留只是为了不让老脚本因为「未知参数」直接失败。从 Kubescape 2.x 迁移过来的 CI 门禁很可能已经静默失效,应改用 `--compliance-threshold`。
2. **新旧门槛语义相反,不是简单改名**。`--fail-threshold` 是 0-100 的风险分,**超过就失败**;`--compliance-threshold` 是合规百分比,**低于就失败**。直接替换数值会把门禁逻辑搞反。
3. **`--frameworks` 在 `scan` 上不存在**。框架是位置参数:`kubescape scan framework nsa`。把 `--frameworks nsa` 写进脚本会因未知参数报错。
4. **`--exclude-namespaces` 会连带关掉集群级对象的扫描**。参数帮助里明确写着排除命名空间时「does not scan cluster-scoped objects」。也就是说你排除一个命名空间,ClusterRole、ClusterRoleBinding、Namespace 这类对象也一起不扫了 —— 报告看起来干净了,但那是漏扫造成的假象。
5. **`--submit` 默认关闭,但一旦打开就要清楚后果**。它会把扫描结果发到 Kubescape SaaS,且需要账号。`--hide` 和 `--encrypt` 的存在本身就说明默认情况下资源元数据是会随报告一起走的。合规敏感的环境里,显式加上 `--keep-local` 更稳妥(注意它与 `--submit` 互斥)。
6. **`kubescape fix` 会就地改写你的清单文件**。清单扫描下它直接覆写源文件(YAML 会保留注释,但内容确实变了)。跑之前确保工作区是干净的,先 `--dry-run` 看一遍,再决定是否落地。**集群扫描不会写集群**,修复内容只打到 stdout,需要你自己 `kubectl apply -f -`。
7. **集群修复的覆盖面比想象的小得多**。扫描报告会把容器环境变量值、Secret 与 ConfigMap 的 `data` / `stringData` 全部涂成 `XXXXXX`,因此**带环境变量的工作负载、所有 Secret 和 ConfigMap 都无法自动修复**。官方直言这是「the main limitation of cluster fixes today」,一个满是问题的集群可能只产出寥寥几个补丁。被其他对象拥有的资源(如 ReplicaSet 拥有的 Pod)以及 RBAC、云相关的问题同样不支持修复。
8. **SARIF 不能用于集群扫描**。官方故障排查页写明 SARIF 只支持文件 / 仓库扫描。想让结果进代码扫描平台,必须改用 `kubescape scan framework <名字> <路径>` 扫清单文件。
9. **最小权限要单独配**。集群扫描需要对 Deployment、DaemonSet、StatefulSet、Job、CronJob、Pod、Service、ConfigMap、Secret、Role、RoleBinding、ClusterRole、ClusterRoleBinding、NetworkPolicy、ServiceAccount 有读权限。别直接用 `cluster-admin` 跑常规扫描。
10. **`--min-severity` / `--max-severity` 不影响退出码**。门槛计算始终基于**未过滤的完整报告**,过滤只改变你看到的内容。用过滤后的视图去推断门禁是否通过会得出错误结论。
11. **规则库是滚动发布,复现性要自己保证**。regolibrary 的 `v2` 标签 `published_at` 是 2024-03,但工件会被就地重传,`updated_at` 会变。需要可复现的合规报告时,用 `--controls-version <tag>` 锁定版本;注意该参数**不能包含 `/`**,而且在设置了 `--account` 时无效。
12. **离线下载不做校验和验证**。已知问题:下载工件后不验证 SHA-256。气隙环境请在可信网络中准备工件并自行核对。
13. **`--compliance-threshold` 默认是 0**,意味着默认情况下几乎不会因为合规度不足而失败。放进流水线必须显式给一个值。
14. **Operator 的部分命令没有超时**。已知问题:`operator scan` / `operator remediate` 在到 Operator Pod 的端口转发迟迟不 ready 时会**无限期挂住**,脚本里要自己加超时。

### 相关命令

- `kube-bench` — CIS 基线检查,与 kubescape 互补
- `kube-linter` — 清单 lint,不需要集群
- `kubesec` — 单份清单的安全评分
- `trivy-operator` — 集群内持续扫描(漏洞视角)
- `polaris` — 工作负载最佳实践体检与准入控制
- `kubectl` — Kubernetes集群管理工具

### 参考链接

- [Kubescape 官方文档](https://kubescape.io/docs/)
- [Kubescape CLI 参考](https://github.com/kubescape/kubescape/blob/master/docs/cli-reference.md)
- [Kubescape 框架与控制项说明](https://kubescape.io/docs/frameworks-and-controls/frameworks/)
- [Kubescape Operator 安装](https://kubescape.io/docs/install-operator/)
- [Kubescape GitHub 仓库](https://github.com/kubescape/kubescape)
- [regolibrary(规则与控制项源仓库)](https://github.com/kubescape/regolibrary)
