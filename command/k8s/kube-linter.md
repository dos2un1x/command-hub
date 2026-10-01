kube-linter
===

对Kubernetes清单、Helm与Kustomize做静态检查的lint工具

## 补充说明

**kube-linter命令** 是 StackRox(已被 Red Hat 收购)开源的清单静态检查工具,官方定位是「analyzes Kubernetes YAML files, Helm charts, and Kustomize manifests」。它由 Red Hat 持续维护,仓库活跃(最近提交 2026-09,最近版本 v0.8.3 / 2026-03-10),**没有归档,也没有被废弃**。

它最重要的特性是:**完全不需要集群**。没有 kubeconfig、没有 API Server、没有常驻组件 —— 给它文件路径、Helm chart 目录或 Kustomize 目录,它就地分析并给出结果。这一点让它可以毫无顾虑地接进 CI,在 `kubectl apply` 之前就把问题拦下来。

理解 kube-linter 的关键是分清三个概念:

```shell
Template  参数的、可复用的规则实现(Go 代码 + 参数 schema),是逻辑的载体
          定义在仓库的 pkg/templates/<名字>/ 目录下

Check     模板的一次具名实例化,带参数、描述、修复建议与作用范围
          内置检查定义在 pkg/builtinchecks/yamls/*.yaml,共 65 条
          你在输出里看到的是 Check 名,配置里启用/禁用的也是 Check 名

customChecks  你基于已有 Template 自建的 Check,写在配置文件里
```

**记住这一条就够了:Check 名与 Template 名不一样。** 详见「注意」第 1 条。

在这批工具里的分工:

```shell
kubeconform   只管 schema:字段名对不对、类型对不对(kube-linter 内置了它的模板)
kube-linter   清单 lint:安全与生产就绪的约 65 条opinionated检查 —— 本页
kubesec       单份清单的安全评分
kubescape     NSA/CISA、MITRE 框架合规,可扫集群
conftest      自定义 Rego 规约
trivy         漏洞 + 配置 + 密钥
```

kube-linter 与 **kubeconform 不是竞争关系**。它把 schema 校验**吸收**了进来 —— 通过 `kubeconform` 模板与 `schema-validation` 检查就能做 schema 校验,一个工具兼顾两类问题。

### 安装

```shell
# Go
go install golang.stackrox.io/kube-linter/cmd/kube-linter@latest

# Homebrew
brew install kube-linter

# nix-shell
nix-shell -p kube-linter

# 容器镜像
docker pull stackrox/kube-linter:latest

# 二进制:从 Releases 页下载 kube-linter-linux / -darwin / -windows
```

镜像有 **cosign 签名**,可校验:

```shell
cosign verify --key kubelinter-cosign $IMAGE_NAME
```

**没有官方 Helm chart**,不要去找 —— 它是纯客户端工具,本来也不需要。

### 语法

```shell
kube-linter lint [路径...]    执行检查(至少给一个路径)
kube-linter checks list      列出全部内置检查
kube-linter templates list   列出全部模板
kube-linter version          查看版本
```

### 常用操作

```shell
kube-linter lint deployment.yaml    # 检查单个文件
kube-linter lint ./k8s/             # 检查整个目录

# 检查 Helm chart(指向包含 Chart.yaml 的目录)
kube-linter lint ./charts/my-app/

# 检查 Kustomize 目录(自动识别并渲染,报告里保留源文件路径)
kube-linter lint ./overlays/prod/

# 用容器跑,免安装
docker run --rm -v $(pwd):/app stackrox/kube-linter lint /app/k8s/
```

`lint` 的参数:

```shell
--config                      指定配置文件路径
--include                     只启用这些检查(可重复)
--exclude                     禁用这些检查(可重复)
--add-all-built-in            启用全部内置检查
--do-not-auto-add-defaults    不自动启用默认检查
--ignore-paths                忽略的路径,glob 语法(可重复)
--format                      输出格式,可重复:plain(默认) / json / sarif
--output                      输出文件路径,可重复,与 --format 按位置配对
--fail-if-no-objects-found    没找到可检查对象时返回非零退出码
--fail-on-invalid-resource    已废弃,见「注意」
-v, --verbose                 输出详细日志
```

多格式输出(v0.8.3 起支持),`--format` 与 `--output` **按位置配对**:

```shell
kube-linter lint --format sarif --output kube-linter.sarif \
                 --format json  --output kube-linter.json ./k8s/
```

### 配置文件

不带 `--config` 时,它会在当前工作目录按顺序自动查找:

```shell
.kube-linter.yaml     优先
.kube-linter.yml      其次
都找不到则用内置默认配置
```

**配置只有两个顶层小节:`customChecks` 和 `checks`。**

```shell
customChecks:
- name: required-label-app
  template: required-label
  params:
    key: app
  scope:
    objectKinds: [DeploymentLike]
  remediation: 请补上 app 标签。

checks:
  doNotAutoAddDefaults: false
  addAllBuiltIn: false
  include: [required-label-owner]
  exclude: [privileged-container]
  ignorePaths:
  - ~/foo/bar/**
  - /**/*/foo/**
  - /tmp/*.yaml
```

几个容易搞错的语义:

```shell
addAllBuiltIn 与 doNotAutoAddDefaults 同时为 true 时,addAllBuiltIn 胜出
exclude 永远压过 include —— 同一条检查同时出现在两边时会被跳过
ignorePaths 用的是 doublestar 语法,`**` 匹配任意层级
```

### 在对象上单独豁免

```shell
metadata:
  annotations:
    # 豁免某一条检查,值应当写明原因
    ignore-check.kube-linter.io/unset-cpu-requirements: "该组件按设计不设限额"
    # 豁免该对象上的全部检查
    kube-linter.io/ignore-all: "这是从上游复制的第三方清单"
```

### 内置检查

内置检查共 65 条。**默认启用**的一批主要包括:

```shell
dangling-service            Service 的 selector 选不到任何 Pod
deprecated-service-account-field  Deployment 里的废弃 serviceAccount 字段
docker-sock                 挂载了 docker.sock
drop-net-raw-capability     未丢弃 NET_RAW
duplicate-env-var           环境变量重名
env-var-secret              用环境变量传密钥
host-ipc / host-network / host-pid   开启了宿主命名空间
invalid-target-ports        Service targetPort 无效
job-ttl-seconds-after-finished  Job 未设置 TTL
latest-tag                  镜像用了 latest 或根本没写 tag
liveness-port / readiness-port  探针端口不存在
mismatching-selector        selector 与 template 标签不匹配
no-anti-affinity            缺少反亲和
no-extensions-v1beta        使用了 extensions/v1beta 这类老 API
no-read-only-root-fs        根文件系统可写
non-existent-service-account 引用了不存在的 ServiceAccount
pdb-max-unavailable / pdb-min-available / pdb-unhealthy-pod-eviction-policy
privilege-escalation-container  允许提权
privileged-container        以 privileged 运行
run-as-non-root             未设置 runAsNonRoot
sensitive-host-mounts       挂载了敏感宿主路径
ssh-port / startup-port     暴露了 22 端口 / 未配启动探针
unsafe-sysctls              使用了不安全的 sysctl
unset-cpu-requirements / unset-memory-requirements  未设置 requests/limits
```

**默认不启用、需要显式打开**的一批(通常是更强的主张或有误报风险):

```shell
access-to-create-pods / access-to-secrets   RBAC 权限过宽
cluster-admin-role-binding                  绑定了 cluster-admin
default-service-account                     使用了 default ServiceAccount
dangling-horizontalpodautoscaler / dangling-ingress / dangling-networkpolicy
dangling-servicemonitor
dnsconfig-options / env-value-from / sorted-keys / use-namespace
exposed-services                            使用了 NodePort / LoadBalancer
hpa-minimum-three-replicas / minimum-three-replicas
no-liveness-probe / no-readiness-probe / no-node-affinity
non-isolated-pod                            未被 NetworkPolicy 覆盖
priority-class-name / restart-policy / unsafe-proc-mount / writable-host-mount
privileged-ports                            使用了特权端口(小于 1024)
read-secret-from-env-var / required-annotation-email / required-label-owner
scc-deny-privileged-container
schema-validation                           schema 校验
wildcard-in-rules                           RBAC 规则用了通配符
```

`checks list` 与 `templates list` 可以看当前版本的准确清单:

```shell
kube-linter checks list
kube-linter templates list
```

### 在 CI 中使用

```shell
# 全量检查,有问题即非零退出
kube-linter lint --add-all-built-in ./k8s/

# 只启用指定检查 / 关掉误报较多的检查
kube-linter lint --include privileged-container --include unset-cpu-requirements ./k8s/
kube-linter lint --exclude sensitive-host-mounts ./k8s/

# 产出 SARIF 供代码扫描平台归档
kube-linter lint --format sarif --output kube-linter.sarif ./k8s/

# 确保「没有可检查对象」也算失败,避免路径写错导致空跑通过
kube-linter lint --fail-if-no-objects-found ./k8s/
```

官方提供 `stackrox/kube-linter-action` 作为 GitHub Action。

### 注意

1. **Check 名与 Template 名不是一回事**。这是最常见的困惑来源:`privileged-container` 是 Check,对应的 Template 叫 `privileged`;`no-read-only-root-fs` 对应 `read-only-root-fs`;`unset-cpu-requirements` 对应 `cpu-requirements`。写 `--include privileged` 会提示找不到检查。要照抄名字请从 `checks list` 的输出里取。
2. **`ignorePaths` 必须嵌在 `checks:` 下面**。写在顶层会被**静默忽略** —— 不报错、也不生效。对应源码里绑定的是 `checks.ignorePaths` 这个键名。
3. **`exclude` 静默压过 `include`**。同一条检查既 include 又 exclude 时不会报冲突,直接以 exclude 为准。排查「明明 include 了却没跑」时先看这里。
4. **没启用任何检查时退出码是 0**。源码里对「检查数为 0」的处理是打印一行 `Warning: no checks enabled.` 然后正常返回。这意味着 `include` 里写错一个名字,CI 会绿灯通过而什么都没检查。把 `--fail-if-no-objects-found` 一起用上,并在流水线里校验输出。
5. **没找到有效对象时默认也返回 0**,只会打印 `Warning: no valid objects found.`。路径写错、渲染失败都会走到这个分支。加 `--fail-if-no-objects-found` 是必须的防线。
6. **`--fail-on-invalid-resource` 已废弃**。源码里的废弃提示是「Use 'schema-validation' builtin check or kubeconform template for better schema validation」。注意旧版文档 `docs/using-kubelinter.md` 里仍把它写成可用参数,以源码为准。另外它曾短暂叫过 `--error-on-invalid-resource`,实际参数名是 `--fail-on-invalid-resource`。
7. **`--format markdown` 不能用于 `lint`**。源码里确实定义了 markdown 格式常量,但 `lint` 命令只注册了 `plain`、`json`、`sarif` 三个。写 markdown 会报 `unknown format`。可用的只有这三种。
8. **多格式输出时 `--format` 与 `--output` 必须一一对应**。数量不一致会直接报 `format/output mismatch`;而且**不能一部分写文件、一部分打到 stdout**(要么全给 `--output`,要么全不给)。重复的格式配不同输出文件是允许的。
9. **它不做集群现状校验**。「dangling-service」这类检查是**在给定文件集合内部**做的静态匹配,它不知道集群里跑着什么。真正的运行态体检(哪些 Service 真的没有后端)要靠 `popeye` 或 `kubectl` 自己查。
10. **Helm 支持有已知缺口**。chart 里使用了 alias 的子 chart 构建模板会失败;Helm 的 test hook 会被当成普通清单一起 lint;通过 `--set` 关闭的组件在某些版本里仍可能被检查出来(有用户报过误报)。渲染结果与真实部署不完全一致时,以 `helm template` 的输出为准再手工核对。
11. **Kustomize 支持也有已知问题**。使用了内置 transformer 的 kustomization 会报错;Kustomize 里再用 Helm 的场景同样有问题。遇到渲染失败时,先 `kustomize build` 出渲染结果,再对渲染结果跑 `kube-linter lint`。
12. **CRD 需要额外注册才能被针对性检查**。任意对象都会作为 unstructured 对象过一遍通用检查(如 `DeploymentLike` 类),但要**专门**检查某个 CRD 的字段,必须自定义 `objectKinds` 再配 custom check。官方测试文件里有一个 cert-manager `Certificate` 的完整例子可以照抄。
13. **`dangling-servicemonitor` 有已知误报**。它默认不区分 ServiceMonitor 所在的命名空间,跨命名空间的场景会报出不存在的悬空。
14. **旧的「静默丢弃」问题最近才修**。在 2026-09 的修复之前,无法解析的清单会被悄悄丢掉,结果是——**所有针对 Pod 模板的检查会整批失效**,而用户完全看不出来。使用较老版本时,这个假阴性风险是真实存在的;升级到最新版并留意它打印的加载失败信息。
15. **配置文件格式随时可能变**。README 明确写着「There may be breaking changes in the future to the command usage, flags, and configuration file formats」。升级版本后先在测试环境跑一遍,确认 `include` / `exclude` 的名字仍然有效。

### 相关命令

- `kubeconform` — 只做 schema 校验,kube-linter 已内置其模板
- `kube-score` — 可靠性与安全最佳实践评分
- `kubesec` — 单份清单的安全评分
- `kubescape` — 框架合规扫描,可扫集群
- `conftest` — 自定义 Rego 规约校验
- `kubectl` — Kubernetes集群管理工具

### 参考链接

- [kube-linter 官方文档](https://docs.kubelinter.io)
- [kube-linter GitHub 仓库](https://github.com/stackrox/kube-linter)
- [配置文件说明](https://github.com/stackrox/kube-linter/blob/main/docs/configuring-kubelinter.md)
- [内置检查清单](https://github.com/stackrox/kube-linter/blob/main/docs/generated/checks.md)
- [模板清单](https://github.com/stackrox/kube-linter/blob/main/docs/generated/templates.md)
