polaris
===

Kubernetes工作负载配置的最佳实践体检工具

## 补充说明

**polaris命令** 是 Fairwinds 开源的工作负载配置检查工具,内置 30 多条策略,覆盖 **Security(安全)**、**Efficiency(效率)**、**Reliability(可靠性)** 三大类,用来回答「这个 Deployment 的配置,能不能在真实生产里跑得住」。

它有三种运行姿态,这是理解 polaris 的第一件事:

```shell
dashboard    集群内部署一个 Web 面板,持续展示全集群的体检结果
webhook      作为 Validating Admission Webhook,直接拒绝不合规的工作负载
CLI          对本地 YAML 跑一次性检查,适合接在 CI 流水线里
```

三者的检查项与配置完全一致,区别只在「什么时候执行、执行结果怎么用」。

在这批工具里的分工:

```shell
kubeconform  字段是否合法(schema)
conftest     自定义合规规则
pluto        apiVersion 是否废弃/移除
polaris      最佳实践体检 —— 本页;唯一能主动拦截的(webhook 模式)
kube-score   最佳实践评分,纯静态检查,无运行时组件
popeye       集群现状体检(只读扫描已部署资源)
```

polaris 与 kube-score 的差别值得单独说一下:两者的检查项有大量重叠,但 **kube-score 是纯 CLI 的静态检查**,而 **polaris 提供了常驻的 dashboard 与准入 webhook**,更偏向「持续治理」;代价是要在集群里跑组件、维护配置。

### 安装

```shell
# CLI:Homebrew
brew tap FairwindsOps/tap
brew install FairwindsOps/tap/polaris
polaris version

# CLI:直接下载二进制
# 从 https://github.com/FairwindsOps/polaris/releases 选择对应平台

# dashboard / webhook:Helm(推荐)
helm repo add fairwinds-stable https://charts.fairwinds.com/stable
helm repo update
helm upgrade --install polaris fairwinds-stable/polaris \
  --namespace polaris --create-namespace

# 只看 dashboard,不装 webhook
helm upgrade --install polaris fairwinds-stable/polaris \
  --namespace polaris --create-namespace \
  --set dashboard.enable=true --set webhook.enable=false

# 容器镜像(注意 registry 已迁移,且不再提供浮动 tag)
# us-docker.pkg.dev/fairwinds-ops/oss/polaris:v<major>.<minor>.<patch>
docker run -d -p8080:8080 \
  -v ~/.kube/config:/opt/app/config:ro \
  us-docker.pkg.dev/fairwinds-ops/oss/polaris:v10.2.5 \
  polaris dashboard --kubeconfig /opt/app/config
```

### 语法

```shell
polaris [全局参数] <子命令> [子命令参数]
```

```shell
polaris audit      对集群或本地 YAML 跑一次性检查
polaris dashboard  启动 Web dashboard
polaris webhook    启动准入 webhook 服务
polaris fix        自动修复 YAML 中的部分问题
polaris version    查看版本
polaris help       帮助
```

### 全局参数

```shell
-c, --config string                   配置文件路径
-x, --context string                  指定 kube context
--kubeconfig string                   kubeconfig 路径,集群外运行时需要
--disallow-exemptions                 禁止任何形式的豁免
--disallow-config-exemptions          禁止配置文件里定义的豁免
--disallow-annotation-exemptions      禁止通过注解声明的豁免
--log-level string                    日志级别,默认 info
--insights-host string                Fairwinds Insights 地址(可选)
```

### audit 子命令参数

```shell
--audit-path string                   审计本地 YAML 目录/文件,而不是集群
-f, --format string                   输出格式:json(默认)、yaml、pretty、score
--color                               彩色输出,默认 true
--only-show-failed-tests              只输出失败的检查项
--checks strings                      只跑指定检查项
--severity string                     按严重级别过滤结果
--namespace string                    只审计指定命名空间(仅集群内审计有效)
--resource string                     审计单个资源,格式 namespace/kind/version/name
--display-name string                 给这次审计起个标识名
--output-file string                  结果写入文件
--output-url string                   结果推送到指定 URL
--helm-chart string                   审计 Helm chart(内部执行 helm template)
--helm-values string                  配合 --helm-chart 的 values 文件
--helm-skip-tests bool                对应 helm template 的 --skip-tests
--set-exit-code-on-danger             出现 danger 级别问题时退出码 3
--set-exit-code-below-score int       得分低于阈值(1-100)时退出码 4
--skip-ssl-validation                 跳过 HTTPS 证书校验
```

### dashboard / webhook / fix 参数

```shell
# dashboard
-p, --port int                dashboard 端口,默认 8080
--listening-address string    监听地址
--base-path string            服务路径前缀,默认 /
--audit-path string           不连集群,直接审计本地 YAML
--load-audit-file string      用历史审计结果渲染 dashboard
--display-name string         审计标识名

# webhook
-p, --port int                 webhook 端口,默认 9876
--disable-webhook-config-installer  不在启动时安装 webhook 配置资源

# fix
--files-path string            要修复的 YAML 目录
--checks strings               要修复的检查项,checks=all 表示全部
--template                     修复的是 Helm 模板(实验性)
```

### 在流水线里使用

```shell
# 基础审计,人类可读输出
polaris audit --audit-path ./deploy --format=pretty

# CI 用法:出现 danger 或得分低于 90 就失败
polaris audit --audit-path ./deploy/ \
  --set-exit-code-on-danger \
  --set-exit-code-below-score 90

# 只看失败项
polaris audit --audit-path ./deploy/ --only-show-failed-tests

# JSON 输出并落盘
polaris audit --audit-path ./deploy/ --format json --output-file polaris.json

# 审计 Helm chart(需要本地有 helm)
polaris audit --helm-chart ./deploy/chart --helm-values ./deploy/chart/values.yml

# 只审计某个资源
polaris audit --resource nginx-ingress/Deployment.apps/v1/default-backend

# 只跑指定检查项
polaris audit --audit-path ./deploy/ --checks cpuLimitsMissing,readinessProbeMissing
```

### 自动修复

```shell
# 对目录下的原始 YAML 应用能自动修的项
polaris fix --files-path ./deploy/ --checks=all

# 只修特定检查项
polaris fix --files-path ./deploy/ --checks=hostIPCSet,hostPIDSet
```

polaris 会在部分改动旁留注释(例如探针),提醒人工确认取值是否合理 —— 自动补的只是占位值。

### dashboard 与 webhook

```shell
# 本地启动 dashboard 连集群
polaris dashboard --port 8080

# 不连集群,直接看本地 YAML
polaris dashboard --port 8080 --audit-path=./deploy/

# Helm 端口转发
kubectl port-forward --namespace polaris svc/polaris-dashboard 8080:80

# 启用准入 webhook(需要 TLS 证书)
helm upgrade --install polaris fairwinds-stable/polaris \
  --namespace polaris --create-namespace \
  --set webhook.enable=true --set dashboard.enable=false

# 启用「变更型」webhook:不拒绝,而是自动改写
helm upgrade --install polaris fairwinds-stable/polaris \
  --namespace polaris --create-namespace \
  --set webhook.enable=true --set webhook.mutate=true
```

### 退出码

```shell
0    默认。即使存在 danger,只要没加显式参数也返回 0
3    使用了 --set-exit-code-on-danger 且存在 danger 级别问题
4    使用了 --set-exit-code-below-score N 且总分低于 N
其他  执行出错
```

### 注意

1. **退出码不是默认就有的**,这是 CI 集成里最常见的「假通过」。`polaris audit` 默认**永远返回 0**,必须显式加上 `--set-exit-code-on-danger`(退出码 3)或 `--set-exit-code-below-score N`(退出码 4)。只跑 audit 不加参数,流水线永远是绿的。

2. **`--format` 而不是 `--output-format`**。polaris 用的是 `-f/--format`,取值 `json`(默认)、`yaml`、`pretty`、`score`。默认输出 JSON,不熟悉的人接上终端会一脸茫然 —— 先加 `--format=pretty`。

3. **webhook 只拦 danger,不拦 warning**。官方文档明确说明:severity 为 `warning` 的检查项会**通过**准入校验,唯一能看到警告的地方是 dashboard 或 webhook 日志。也就是说,「上了 webhook 就万无一失」是错觉,日常巡检仍然要看 dashboard。

4. **webhook 需要有效的 TLS 证书**。装了 cert-manager 时 Helm 安装开箱即用;没有 cert-manager 就要自己提供 `webhook.caBundle` 并在集群里创建对应的 TLS Secret,再把 Secret 名传给 `webhook.secretName`。证书不对的表现是 API Server 调用 webhook 失败,创建 Pod 会直接报错。

5. **webhook 的 Workload 类型是白名单制的**。内置只覆盖 Deployment、Job、DaemonSet 等已知控制器类型,要拦自定义控制器需要在 Helm 里设置 `webhook.rules` 显式追加,否则那些资源的创建请求根本不会走到 polaris。

6. **`fix` 只能改原始 YAML,改不了 Helm chart**。Helm 模板里的参数化结构无法安全地静态改写,`--template` 参数虽然存在,但官方标注为实验性。想修 chart 只能人工改 values 或模板。

7. **默认策略很严,别拿默认分当 KPI**。官方文档自己就写了「我们的默认标准相当高,分数低于预期不必惊讶」。真实落地时需要自建配置文件,调整检查项的 severity 或加豁免;否则团队会被迫到处贴豁免注解,反而失去了治理意义。

8. **豁免有三层开关,安全场景要收紧**。豁免可以写在配置文件里,也可以写在对象注解上。`--disallow-annotation-exemptions`、`--disallow-config-exemptions`、`--disallow-exemptions` 分别禁止对应来源。生产准入场景建议至少禁掉注解豁免 —— 否则任何有 Deployment 写权限的人都能通过加一行注解绕过检查。

9. **镜像 registry 与 tag 策略都变了**。从 v10.2.0 起镜像迁到 `us-docker.pkg.dev/fairwinds-ops/oss/polaris`,`quay.io/fairwinds/polaris` 已废弃;同时官方取消了 `latest`、`v10`、`v10.1` 这类浮动 tag,只剩不可变的完整版本 tag 与 digest。老脚本里写 `quay.io/fairwinds/polaris:latest` 会直接拉不到。

10. **CLI 只吃原始 YAML**。本地目录里的 Helm chart 不能直接审计,必须先 `helm template` 出清单,或者用 `--helm-chart` / `--helm-values` 让 polaris 代为渲染(此时本机需装 helm)。

11. **`--audit-path` 与集群审计是互斥的**。传了 `--audit-path` 就只看本地文件,不会连集群;不传则走 kubeconfig。想让 dashboard 展示历史数据用 `--load-audit-file`,它同样不连集群。

12. **它不做 schema 校验、不查废弃 API**。字段拼错、apiVersion 被移除这类问题 polaris 不管。完整流水线应当是 `kubeconform`(schema)→ `pluto`(废弃 API)→ `polaris` / `kube-score`(最佳实践)→ `conftest`(组织规约)。

### 相关命令

- `kube-score` — 清单的可靠性与安全评分
- `kubeconform` — 按官方schema校验清单字段
- `pluto` — 检测废弃与移除的apiVersion
- `conftest` — 用rego做策略即代码检查
- `goldilocks` — 基于实际用量推荐资源请求与限额
- `vpa` — 垂直Pod自动扩缩容
- `kubectl` — Kubernetes集群管理工具

### 参考链接

- [polaris 官方文档](https://polaris.docs.fairwinds.com/)
- [polaris CLI 参数参考](https://polaris.docs.fairwinds.com/cli/)
- [polaris 基础设施即代码用法](https://polaris.docs.fairwinds.com/infrastructure-as-code/)
- [polaris 准入控制器](https://polaris.docs.fairwinds.com/admission-controller/)
- [polaris GitHub 仓库](https://github.com/FairwindsOps/polaris)
