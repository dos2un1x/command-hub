trivy
===

容器镜像与Kubernetes集群的漏洞、配置与密钥扫描工具

## 补充说明

**Trivy** 是 Aqua Security 开源的通用安全扫描器,一个二进制覆盖七类目标:**容器镜像、文件系统、Git 仓库、Kubernetes 集群、IaC 配置、SBOM、云环境**。它也是 **kube-hunter 停止开发后官方指定的替代工具**,用于 Kubernetes 配置扫描与 KBOM 漏洞扫描。

四个扫描器(`--scanners`)可以单独或组合启用:

| 扫描器 | 检查内容 |
| --- | --- |
| `vuln` | 已知 CVE,来自 Trivy 漏洞库 |
| `misconfig` | 配置错误(IaC 与 Kubernetes 清单),内置 K8s 检查项编号形如 `KSV001` |
| `secret` | 硬编码的密钥、Token、私钥 |
| `rbac` | RBAC 权限过宽问题 |

Trivy 的核心思路是**左移 + 右看**:镜像构建时用 `trivy image` 卡在流水线里,集群运行时用 `trivy k8s` 做整体基线体检,两者共用同一套漏洞库与检查规则,结论可以互相对照。

### 安装

```shell
# 官方安装脚本(自动识别系统架构)
curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | \
  sh -s -- -b /usr/local/bin

# macOS
brew install trivy

# 容器方式(无需安装)
docker run --rm aquasec/trivy:latest image nginx:latest

# 验证
trivy --version
```

首次运行会下载漏洞库与检查规则(数百 MB),国内环境可配置镜像源:

```shell
export TRIVY_DB_REPOSITORY=ghcr.io/aquasecurity/trivy-db
export TRIVY_JAVA_DB_REPOSITORY=ghcr.io/aquasecurity/trivy-java-db
```

### 语法

```shell
trivy <目标类型> [flags] <目标>
```

```shell
trivy image <镜像>        扫描容器镜像
trivy fs <路径>           扫描本地文件系统
trivy repo <仓库地址>     扫描远程 Git 仓库
trivy rootfs <路径>       扫描已解压的根文件系统
trivy config <路径>       扫描 IaC 配置(含 Kubernetes 清单)
trivy k8s <上下文>        扫描 Kubernetes 集群
trivy sbom <文件>         扫描 SBOM 文件
trivy server              以服务端模式运行,供其他客户端复用缓存
trivy plugin              管理插件
```

### 通用参数

```shell
--scanners            启用的扫描器:vuln,misconfig,secret,rbac
--severity            按严重级别过滤:UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL
--exit-code           发现问题时返回的退出码,默认 0
--ignore-unfixed      忽略官方尚无修复版本的 CVE
--format / -f         输出格式:table(默认)、json、sarif、cyclonedx、template
--output / -o         结果写入文件
--ignorefile          忽略规则文件,默认 .trivyignore
--skip-dirs           跳过目录
--skip-files          跳过文件
--cache-dir           缓存目录
--offline-scan        离线扫描,不联网更新库
--download-db-only    只下载漏洞库不扫描
--config              指定 trivy.yaml 配置文件
```

### 镜像扫描

```shell
# 基本用法
trivy image nginx:1.27

# 按 digest 扫描:tag 可变,digest 才是不可变标识
trivy image registry.example.com/app@sha256:xxxx

# 只看高危与严重
trivy image --severity HIGH,CRITICAL nginx:1.27

# 同时扫漏洞、密钥、配置
trivy image --scanners vuln,secret,misconfig nginx:1.27

# 输出 SARIF 供代码扫描平台归档
trivy image --format sarif --output result.sarif nginx:1.27

# 生成 CycloneDX 格式的 SBOM,可交给 cosign 做证明
trivy image --format cyclonedx --output sbom.cdx.json nginx:1.27
```

### 文件系统与仓库扫描

```shell
# 扫描当前目录的依赖与密钥
trivy fs --scanners vuln,secret .

# 有严重问题即返回非零退出码,可直接用于流水线
trivy fs --severity CRITICAL --exit-code 1 .

# 扫描远程仓库(无需克隆)
trivy repo https://github.com/example/app
```

### 配置与 IaC 扫描

```shell
# 扫描单个 Kubernetes 清单
trivy config deployment.yaml

# 扫描整个清单目录
trivy config ./k8s-manifests/

# 只看高危配置问题
trivy config --severity HIGH,CRITICAL ./k8s-manifests/

# 同时输出通过项,便于做加固覆盖度统计
trivy config --include-non-failures ./k8s-manifests/

# 扫描 Terraform / CloudFormation
trivy config ./terraform/
```

Kubernetes 清单的常见检查项:

```shell
KSV001   allowPrivilegeEscalation 应为 false
KSV003   默认能力未丢弃,应 capabilities.drop: ["ALL"]
KSV012   应设置 runAsNonRoot: true
KSV014   根文件系统应为只读
KSV021   不应使用 hostPath 卷
```

### Kubernetes 集群扫描

`trivy k8s` 在官方文档中标记为 **EXPERIMENTAL**,参数可能不带兼容期直接调整。它默认使用当前 kubeconfig 上下文。

```shell
# 摘要视图:默认输出方式,适合看整体态势
trivy k8s --report summary cluster

# 全量视图:逐资源列出,信息量大
trivy k8s --report all cluster

# 指定 kubeconfig 文件
trivy k8s --kubeconfig ~/.kube/config-prod --report summary cluster

# 只扫某个命名空间 / 排除系统命名空间
trivy k8s --include-namespaces production --report summary cluster
trivy k8s --exclude-namespaces kube-system,kube-public --report summary cluster

# 只扫配置问题(不下载漏洞库,速度快很多)
trivy k8s --scanners=misconfig --report summary cluster

# 只看严重与高危
trivy k8s --severity CRITICAL,HIGH --report all cluster

# 不运行 node-collector(无节点相关权限时使用)
trivy k8s --disable-node-collector --report summary cluster

# 节点带污点时给 node-collector 指定容忍
trivy k8s --tolerations "key1=value1:NoExecute" --report summary cluster
```

### 合规报告

用 `--compliance` 直接按现成标准出报告:

```shell
trivy k8s --compliance=k8s-cis-1.23 --report all cluster
trivy k8s --compliance=k8s-nsa-1.0 --report summary cluster
trivy k8s --compliance=k8s-pss-baseline-0.1 --report summary cluster
```

内置配置档:

```shell
k8s-nsa-1.0              NSA / CISA Kubernetes 加固指南 v1.0
k8s-cis-1.23             CIS Kubernetes Benchmark v1.23
eks-cis-1.4              CIS Amazon EKS Benchmark v1.4
rke2-cis-1.24            CIS RKE2 Benchmark v1.24
k8s-pss-baseline-0.1     Pod Security Standards,Baseline
k8s-pss-restricted-0.1   Pod Security Standards,Restricted
```

`k8s-pss-*` 两档与 `pod-security-admission` 的基线完全对应,适合在上线前评估「切到 restricted 会打掉哪些工作负载」。

### 结果过滤与忽略

```shell
# 用 .trivyignore 忽略已知可接受的问题(每行一个 ID)
cat > .trivyignore <<'EOF'
# 该 CVE 影响的功能未启用,已评估接受
CVE-2024-12345
# 业务必须保留的能力,已通过其他手段缓解
KSV003
EOF

# 忽略指定文件或目录
trivy fs --skip-files "./config/dev-secrets.yaml" --skip-dirs ./examples .

# 用 trivy.yaml 固化常用参数,免去每次敲长命令
# severity: [HIGH, CRITICAL]
# scanners: [vuln, misconfig, secret]
# exit-code: 1
```

### CI 集成

```shell
# GitHub Actions 使用官方 Action:
#   - uses: aquasecurity/trivy-action@master
#     with:
#       image-ref: registry.example.com/app:${{ github.sha }}
#       format: sarif
#       severity: CRITICAL,HIGH
#       exit-code: '1'
```

流水线中必须显式加上 `--exit-code 1`,否则扫出问题也算成功。

### 持续扫描:Trivy Operator

CLI 是「跑一次」的模型,需要持续监控则部署 Operator,它把结果写成 CRD:

```shell
helm repo add aqua https://aquasecurity.github.io/helm-charts/
helm install trivy-operator aqua/trivy-operator \
  -n trivy-system --create-namespace

# 查看扫描结果
kubectl get vulnerabilityreports,configauditreports -A
kubectl get exposedsecretreports,rbacassessmentreports -A
```

### 扫描所需权限

扫描集群所需的权限:`trivy k8s` 需要对 core、apps、batch、networking.k8s.io、rbac.authorization.k8s.io 各组资源有 `list` 权限;启用 node-collector(默认开启)时还需要 `nodes/proxy` 与 `pods/log` 的 `get`、`events` 的 `watch`、`jobs`/`cronjobs` 的 `list`/`get`,以及 `jobs` 的 `create`/`delete`/`watch` 和 `namespaces` 的 `create`。最小权限做法是为它单独建一个 ServiceAccount 与 ClusterRole,而不是直接用 `cluster-admin`。

### 注意

1. **`--exit-code` 默认是 0**。即使扫出 CRITICAL 漏洞,命令依然返回成功,放进流水线必须显式写 `--exit-code 1`,否则门禁形同虚设。
2. **`trivy k8s` 是 EXPERIMENTAL**。官方明确说明参数可能不保留向后兼容,升级 Trivy 版本前应先在测试环境验证命令是否仍然可用,不要在自动化脚本里写死过于复杂的参数组合。
3. **扫集群不等于扫镜像**。`trivy k8s` 会分别扫描**镜像内容**与**资源清单**;KBOM 漏洞匹配目前对原生 Kubernetes 发行版有效,对云厂商的变体发行版效果不佳,托管集群的结果需要打折看待。
4. **node-collector 需要额外权限且会在节点上起 Job**。权限不足时会静默降级,导致节点相关的配置问题整块缺失。拿不到这些权限时应显式加 `--disable-node-collector`,避免误以为「节点没问题」。
5. **`--include-*` 与 `--exclude-*` 互斥**。`--include-kinds` 与 `--exclude-kinds`、`--include-namespaces` 与 `--exclude-namespaces` 都不能同时给,同时写会报错。
6. **命名空间排除有已知限制**。官方文档说明,要排除特定命名空间需要给出完整名单,目前排除逻辑只对集群级角色类资源生效,别指望它能把某个命名空间的全部结果都过滤干净。
7. **漏洞库需要联网更新,离线环境要预先准备**。首次运行会拉取数百 MB 数据;气隙环境应在一台联网机器上执行 `trivy image --download-db-only`,把 `--cache-dir` 目录整体拷贝进去,再用 `--offline-scan` 运行,否则会因下载失败而扫出空结果。
8. **按 tag 扫描的结果不可复现**。`nginx:latest` 每次可能指向不同镜像,合规报告应一律按 **digest** 扫描并记录 digest。
9. **`.trivyignore` 是技术债的温床**。忽略条目应带原因与到期时间,并纳入评审;长期无人清理的忽略列表会让人误判集群的真实风险。
10. **密钥扫描结果需要立即轮换而非仅删除**。`secret` 扫描器只告诉你「仓库里有密钥」,一旦提交过就必须视为已泄露 —— 删掉文件不等于失效,要先去对应平台轮换凭据。
11. **误报要区分对待**。`misconfig` 的许多检查项与业务架构冲突(例如某些监控组件必须挂 `hostPath`),评估时应结合 `pod-security-admission` 的豁免机制给出有记录的例外,而不是直接关掉整条规则。
12. **版本迭代快,以本地实际输出为准**。命令与参数在 v0.5x 到 v0.7x 之间调整过多次,撰写脚本前先跑 `trivy <子命令> --help` 核对当前版本的参数名与默认值。

### 相关命令

- `kube-bench` — CIS 基线检查,与 Trivy 的合规报告互为补充
- `kube-hunter` — 已停用的暴露面扫描工具,官方推荐由 Trivy 替代
- `cosign` — 镜像签名与验签,与 Trivy 组成供应链上下游
- `pod-security-admission` — Trivy 的 pss 合规档位对应的实际执行机制
- `kubectl` — Kubernetes集群管理工具

### 参考链接

- [Trivy 官方文档](https://trivy.dev/latest/docs/)
- [Trivy Kubernetes 集群扫描](https://trivy.dev/latest/docs/target/kubernetes/)
- [trivy kubernetes 命令参数参考](https://trivy.dev/latest/docs/references/configuration/cli/trivy_kubernetes/)
- [Trivy 配置扫描(IaC)](https://trivy.dev/latest/docs/scanner/misconfiguration/)
- [Trivy Operator](https://trivy.dev/latest/docs/operator/)
