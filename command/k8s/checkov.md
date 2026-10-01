checkov
===

对Terraform、Kubernetes、Helm等基础设施即代码做策略扫描的工具

## 补充说明

**checkov命令** 是 Prisma Cloud(Palo Alto Networks)开源的 **IaC 静态扫描工具**,由 `bridgecrewio` 组织维护,Apache 2.0 许可。它和本页其他工具最根本的区别在**覆盖范围**:

```shell
kube-linter / kubesec / kube-score   只看 Kubernetes
checkov                              看整个 IaC 层:Terraform、CloudFormation、K8s、
                                     Helm、Kustomize、Dockerfile、Ansible、
                                     GitHub/GitLab 配置、ARM、Bicep、Serverless……
```

对 Kubernetes 团队来说,它的价值在于**把集群清单和「清单所依赖的云资源」放在同一条流水线里检查**:Terraform 建出来的集群有没有开审计日志,和 Deployment 有没有跑成 root,是同一批人要在同一个 MR 里解决的问题。

在这批工具里的分工:

```shell
kubeconform   只做 schema 校验
kube-linter   只做 K8s 清单 lint
kubesec       只给单份 K8s 清单评分
checkov       跨 IaC 框架的策略扫描 —— 本页
trivy         漏洞 + 配置 + 密钥(也支持 IaC,但以镜像与集群为主)
```

维护状态:**非常活跃**,最近版本 **3.3.19(2026-09-17)**,发布节奏以天计。许可无变化,仍是标准 Apache 2.0 文本。

### 安装

```shell
# Python(主要方式)
pip3 install checkov

# Homebrew
brew install checkov
brew upgrade checkov

# 容器
docker pull bridgecrew/checkov
docker run --tty --rm --volume /user/tf:/tf --workdir /tf \
  bridgecrew/checkov --directory /tf
```

环境要求与提醒:README 的 Requirements 写 Python `>= 3.9, <= 3.12`,但同一篇 README 的另一个小节又说支持 3.9 - 3.13,两处自相矛盾;Terraform 建议 `>= 0.12`。Debian 12 这类受 PEP 668 约束的系统需要先建 venv:

```shell
python3 -m venv /path/to/venv/checkov
cd /path/to/venv/checkov && source ./bin/activate
pip install checkov
sudo ln -s /path/to/venv/checkov/bin/checkov /usr/local/bin/checkov
```

用 `docker run --tty` 时如果重定向输出到文件,输出里会混入控制字符 —— 去掉 `--tty` 即可。

### 语法

```shell
checkov -d <目录>      扫描目录
checkov -f <文件>      扫描单个文件(可重复:-f a.yml -f b.yml)
```

`-d` 与 `-f` **互斥**,不能同时用。

常用参数:

```shell
--framework / --skip-framework  限定或跳过某些框架(见下)
-c, --check           只跑指定检查,逗号分隔
--skip-check          跳过指定检查,逗号分隔
-o, --output          输出格式,可重复
--external-checks-dir 加载自定义策略目录(可重复)
-s, --soft-fail       软失败:有问题也返回 0
--soft-fail-on        软失败范围(按 ID 或严重级别)
--hard-fail-on        硬失败范围
--baseline            与基线文件比对,只报新增问题
--create-baseline     生成基线文件
--output-baseline-as-skipped  把基线跳过的项也列出来
--skip-path           跳过路径(正则,可重复)
--quiet               只显示失败的检查,同时关闭进度条
--compact             不显示代码块
--download-external-modules   下载 Terraform 外部模块
-evaluate-variables   是否求值 Terraform 变量,默认 true
--repo-id / -b, --branch      关联到平台时的仓库与分支标识
--config-file         指定配置文件
--create-config       把当前参数导出成配置文件
--show-config         显示每个配置项来自哪里
```

`-o/--output` 支持的取值:`cli`(默认)、`csv`、`cyclonedx`、`cyclonedx_json`、`spdx`、`json`、`junitxml`、`github_failed_only`、`gitlab_sast`、`sarif`。可重复指定,同时输出多种:

```shell
checkov -d . -o sarif -o cli
```

### --framework 的完整取值

官方 CLI 参考文档里的框架列表是**过时的**,权威来源是源码里的 `CheckType` 定义:

```shell
terraform / terraform_plan / terraform_json       cloudformation
kubernetes / helm / kustomize                     dockerfile / serverless
arm / bicep / ansible                             openapi / json / yaml
github_configuration / github_actions             gitlab_configuration / gitlab_ci
bitbucket_configuration / bitbucket_pipelines     azure_pipelines / circleci_pipelines
cdk / sca_package / sca_image / secrets           3d_policy
sast / sast_python / sast_java / sast_javascript / sast_typescript / sast_golang
all
```

文档里漏掉了 `ansible`、`azure_pipelines`、`cdk`、`circleci_pipelines`、`terraform_json`、整个 `sast_*` 家族以及 `3d_policy`。

```shell
# 逗号分隔或空格分隔都支持
checkov -d . --framework terraform,kubernetes
checkov -d . --framework terraform kubernetes

# 只看 K8s 相关
checkov -d ./manifests --framework kubernetes,helm,kustomize
```

**`--framework` 没有做取值校验。** 写错了不会被参数解析器拦下,只是静默不扫描。这一点在排查「为什么什么都没扫出来」时要留意。

### 检查 ID 前缀

```shell
CKV_K8S_*        Kubernetes 清单检查,如 CKV_K8S_20、CKV_K8S_14
CKV_AWS_*        Terraform / CloudFormation 的 AWS 检查,如 CKV_AWS_20
CKV2_AWS_*       第二代(图)检查,如 CKV2_AWS_6
CKV_ANSIBLE_*    Ansible,如 CKV_ANSIBLE_3
CKV_DOCKER_*     Dockerfile
CKV_SECRET_*     密钥扫描,如 CKV_SECRET_6
CKV_CVE_*        软件成分分析发现的 CVE
BC_LIC_*         许可证检查
```

### 误报抑制的四种方式

这也是 checkov 用法里最容易搞错的部分 —— **不同 IaC 类型用的语法不一样**。

**方式一:行内注释(Terraform / CloudFormation / Dockerfile / 密钥)**

```shell
resource "aws_s3_bucket" "foo-bucket" {
  region        = var.region
    #checkov:skip=CKV_AWS_20:The bucket is a public static content host
  bucket        = local.bucket_name
  force_destroy = true
  acl           = "public-read"
}
```

格式是 `#checkov:skip=<检查ID>:<原因>`,一项一行。Dockerfile 里这个注释可以放在**文件的任意一行**;密钥扫描则要求注释紧邻问题行的前一行、后一行或本行。

**Kubernetes 清单用的是注解,不是注释** —— 这是最容易踩空的地方:

```shell
metadata:
  annotations:
    checkov.io/skip1: CKV_K8S_20=我确认这里不需要禁止提权
    checkov.io/skip2: CKV_K8S_14
    checkov.io/skip3: CKV_K8S_11=为了 BestEffort QoS 故意不设 CPU 限额
```

格式是 `checkov.io/skip<数字>: <检查ID>=<原因>`,原因可省略,`<数字>` 是字面序号。**在 K8s 清单里写 `#checkov:skip=` 注释是不生效的。**

**方式二:`--skip-check`**

```shell
checkov -d . --skip-check CKV_K8S_20,CKV_AWS_20   # 按 ID
checkov -d . --skip-check "CKV_AWS*"              # 通配符
checkov -d . --skip-check HIGH,CRITICAL           # 按严重级别
checkov -d . --skip-check kube-system             # Kubernetes 按命名空间
```

**`--skip-check` 不接受检查的「名字」,只接受 ID、BC ID、严重级别、通配符或密钥校验状态。** 写人类可读的检查名不会生效。

**方式三:配置文件 `.checkov.yaml` / `.checkov.yml`**

自动发现顺序是:被扫描的 `--directory` 目录 → 当前工作目录 → `$HOME`。用 `--config-file` 指定时,这三处都不再被读取。键名就是长参数名:

```shell
branch: develop
check: [CKV_DOCKER_1]
compact: true
directory: [test-dir]
framework: [all]
quiet: true
skip-check: [CKV_DOCKER_3, CKV_DOCKER_2]
skip-framework: [dockerfile, secrets]
soft-fail: true
```

`checkov --create-config <路径>` 可以把当前命令行参数原样导出成这个格式,比自己手搓可靠。`checkov --show-config` 则能显示每个值最终来自哪里,排查「配置为什么没生效」时很好用。

**官方提醒配置文件必须来自可信来源** —— 它能指定扫描哪些文件、跑哪些检查、加载哪些自定义策略,等同于一段可执行配置。

**方式四:基线文件 `.checkov.baseline`**

```shell
# 生成基线:把当前的存量问题全部记为「已知」
checkov -d . --create-baseline

# 后续只报相对基线的新增问题
checkov -d . --baseline .checkov.baseline

# 顺便把因基线而跳过的项也输出出来
checkov -d . --baseline .checkov.baseline --output-baseline-as-skipped
```

**`--create-baseline` 只能配合 `--directory` 使用**,不能配 `-f`。这是把 checkov 引入存量项目时的标准做法:先把历史问题固化成基线,让流水线只对新增问题负责,再逐步偿还。

### 软失败与硬失败

退出码:

```shell
0   全部通过,或处于软失败状态
1   硬失败
2   崩溃(可用 --no-fail-on-crash 抑制)
```

判定优先级(官方文档):命中 `--hard-fail-on` 的 ID → 硬失败;命中 `--soft-fail-on` 的 ID → 软失败;严重级别 >= `--hard-fail-on` 的级别 → 硬失败;严重级别 <= `--soft-fail-on` 的级别 → 软失败;都不命中时看 `--soft-fail` 的取值。

```shell
checkov -d . --hard-fail-on CRITICAL   # 只有 CRITICAL 才阻断流水线
checkov -d . --soft-fail               # 什么都不阻断,只出报告
```

细节:**硬失败取所列级别里最低的那个作为门槛,软失败取最高的那个**;只要有一条硬失败,整次运行就是硬失败。另外**按严重级别过滤需要配合平台 API key**,纯本地模式下拿不到分级信息。

### 密钥扫描

密钥扫描**不是独立的 `--scan-secrets` 参数**,而是走 framework:

```shell
checkov -d /MyDirectory --framework secrets
```

相关的真实参数是 `--enable-secret-scan-all-files`(扫描所有文件而不只是常见配置文件)、`--scan-secrets-history`(扫描 git 历史)与 `--block-list-secret-scan`(指定屏蔽清单)。`--skip-check` 在密钥场景下还支持**用正则限定文件**:`--skip-check 'CKV_SECRET_6:.*DontScan\.json$'`。

### 注意

1. **Kubernetes 清单的抑制要用注解,不是注释**。Terraform 里写 `#checkov:skip=CKV_AWS_20:原因`;K8s 里必须写 `metadata.annotations` 下的 `checkov.io/skip1: CKV_K8S_20=原因`。把 Terraform 的注释用法照搬到 YAML 上,注释会被当成普通注释丢掉,检查照样报。这是 checkov 最常见的误用。
2. **`--skip-check` 不认检查名**。它只接受检查 ID(`CKV_*`)、BC 平台 ID、严重级别(`LOW`/`MEDIUM`/`HIGH`/`CRITICAL`)、通配符,以及密钥的校验状态(`Invalid`)。写 `--skip-check "privileged container"` 这类描述性文字不会有任何效果,而且不报错。
3. **官方文档的 `--framework` 列表是过时的**。文档漏了 `ansible`、`azure_pipelines`、`cdk`、`circleci_pipelines`、`terraform_json`、`sast_*` 系列等一大票取值。以源码里的 `CheckType` 定义为准(本页上方已列全)。反过来,`--framework` 不做取值校验,写错了只会静默不扫描。
4. **`--create-baseline` 只能配 `--directory`**。加上 `-f` 会失败。想给单个文件建基线目前做不到。
5. **Terraform plan 扫描会丢失行号**。`terraform show -json tf.plan > tf.json` 输出的是**单行 JSON**,于是所有问题都报在第 0 行。正确做法是过一遍格式化:

```shell
terraform show -json tf.plan | jq '.' > tf.json
```

   同时用 `--repo-root-for-plan-enrichment /path/to/iac` 恢复文件路径与代码块 —— 官方说明这也是让 **plan 扫描的抑制生效** 的前提。
6. **配置文件必须来自可信来源**。官方 README 专门提醒这一点:配置文件能决定扫描哪些文件、加载哪些自定义策略,等同于一端可执行配置。在 CI 里不要从不可信的 PR 里读取 `.checkov.yaml`。另外自动发现路径有三处(被扫描目录 → 当前目录 → `$HOME`),一旦用 `--config-file` 显式指定,其他三处全部失效;排查配置不生效时先用 `--show-config` 看清楚实际取值来源。
7. **基线是技术债的账本,不是免死金牌**。`.checkov.baseline` 把存量问题一次性冻结,好处是流水线立刻可用,代价是**这些问题从此不再被报告**。要有定期回顾与缩减基线的机制,否则它会变成永久豁免清单。
9. **`--soft-fail` 会让门禁形同虚设**。它让命令无论扫出什么都返回 0。作为过渡手段可以接受,长期挂在流水线上就等于没有门禁。用 `--hard-fail-on` 精确指定要阻断的级别更合适。
10. **按严重级别过滤需要平台 API key**。纯本地跑的时候,严重级别相关的阈值判断拿不到完整信息,行为可能和预期不一致。
11. **扫描 Kubernetes 清单时它有和 kube-linter 重叠的检查项**。两者都能查 privileged、资源限额、latest tag。同时接入时不要重复配置:让 checkov 负责「跨 IaC 的一致性」(比如 Terraform 里的安全组和 K8s 里的 NetworkPolicy 要匹配),把纯 K8s 清单的细粒度 lint 留给 kube-linter,分工更清楚,告警也不会翻倍。
12. **它扫的是代码,不是运行中的集群**。checkov 完全不连集群,只看文件。集群的**实际**状态有没有偏离这份代码,要靠 trivy-operator、kubescape operator 这类集群内工具回答。

### 相关命令

- `kube-linter` — 只做 K8s 清单 lint,与本页在 K8s 场景下互补
- `kubeconform` — 只做 schema 校验
- `kubesec` — 单份清单的安全评分
- `trivy` — 也支持 IaC 扫描,但主打镜像与集群
- `conftest` — 用 Rego 写自定义规约
- `kubescape` — 集群侧的框架合规扫描
- `trivy-operator` — 集群内持续扫描,结果写成 CRD
### 参考链接

- [Checkov 官方文档](https://www.checkov.io/)
- [CLI 参数参考](https://www.checkov.io/2.Basics/CLI%20Command%20Reference.html)
- [抑制与跳过策略](https://github.com/bridgecrewio/checkov/blob/main/docs/2.Basics/Suppressing%20and%20Skipping%20Policies.md)
- [硬失败与软失败](https://github.com/bridgecrewio/checkov/blob/main/docs/2.Basics/Hard%20and%20soft%20fail.md)
- [密钥与凭据扫描](https://github.com/bridgecrewio/checkov/blob/main/docs/2.Basics/Scanning%20Credentials%20and%20Secrets.md)
- [Checkov GitHub 仓库](https://github.com/bridgecrewio/checkov)
