conftest
===

用rego策略对Kubernetes清单等结构化配置做合规校验

## 补充说明

**conftest命令** 是 Open Policy Agent(OPA)项目下的命令行工具,用 **Rego** 语言对结构化配置写断言。它本身不关心 Kubernetes —— YAML、JSON、HCL、Dockerfile、XML、TOML 都能测 —— 但 Kubernetes 是它最主流的用法:把「不允许跑 root」「必须指定资源限额」「镜像 tag 不许用 latest」这类组织规约写成策略,在 CI 里拦住不合规的清单。

一句话概括它的定位:**schema 校验之外的「组织规约」层**。

```shell
kubeconform  字段是否合法      —— 官方规范说了算,只能查客观错误
conftest     配置是否合规      —— 你自己说了算,查的是主观规约
pluto        apiVersion 是否废弃/移除
kube-score   可靠性与安全最佳实践评分
polaris      最佳实践体检 + 准入控制
popeye       集群现状体检(只读)
```

与 kube-score、polaris 的关键差别是:**conftest 的规则完全由你写**。内置策略是固定的,而 conftest 什么规则都没有,策略库要自己维护 —— 灵活,但也意味着更高的维护成本。

### 安装

```shell
# Homebrew(macOS / Linux)
brew install conftest
conftest --version

# 直接下载二进制
LATEST_VERSION=$(curl -s https://api.github.com/repos/open-policy-agent/conftest/releases/latest \
  | grep '"tag_name"' | cut -d'"' -f4 | sed 's/^v//')
curl -L "https://github.com/open-policy-agent/conftest/releases/download/v${LATEST_VERSION}/conftest_${LATEST_VERSION}_$(uname)_$(arch).tar.gz" \
  | tar xz
sudo mv conftest /usr/local/bin

# Docker(注意:instrumenta/conftest 镜像已废弃,用 openpolicyagent/conftest)
docker run --rm -v $(pwd):/project openpolicyagent/conftest test deployment.yaml

# Go 安装
CGO_ENABLED=0 go install github.com/open-policy-agent/conftest@latest

# Scoop(Windows)
scoop install conftest

# mise
mise use -g conftest@latest
```

### 语法

```shell
conftest test   [flags] <文件|目录|-> ...     对配置跑策略
conftest verify [flags] <策略目录> ...        跑策略自身的单元测试
conftest pull   <URL|oci://...>               下载策略包
conftest push   <oci://...>                   发布策略包
```

### 策略目录结构

默认从当前工作目录下的 `policy/` 读取策略,可用 `--policy` / `-p` 改。工具会**递归**查找目录下所有 `.rego`:

```shell
policy/
├── k8s/
│   ├── deployment.rego
│   └── service.rego
└── terraform/
    └── s3.rego
```

约定:每个 `.rego` 用 `package main`,规则名以 `deny` / `warn` / `violation` 开头。

### 写第一条策略

```shell
package main

# 必须以 deny/violation 开头才会被计为「失败」
deny contains msg if {
  input.kind == "Deployment"
  not input.spec.template.spec.securityContext.runAsNonRoot
  msg := "Containers must not run as root"
}

# warn 开头计为「警告」,默认不影响退出码
warn contains msg if {
  input.kind == "Deployment"
  some container in input.spec.template.spec.containers
  not endswith(container.image, ":1.27.0")
  msg := sprintf("container %s should pin image tag", [container.name])
}

# 也可以返回对象,便于携带额外信息
deny contains violation if {
  input.kind == "Service"
  input.spec.type == "NodePort"
  violation := {
    "msg": "NodePort service is not allowed",
    "title": "service-type",
    "severity": "high",
  }
}
```

规则名的识别规则(来自源码,容易踩):

```shell
warn  / warn_xxx           计入「警告」
deny  / deny_xxx           计入「失败」
violation / violation_xxx  计入「失败」
denyXYZ                    不会被识别 —— 前缀不完全匹配就静默失效
```

### 例外与豁免

```shell
package main

deny_run_as_root contains msg if {
  input.kind == "Deployment"
  not input.spec.template.spec.securityContext.runAsNonRoot
  msg := "Containers must not run as root"
}

# exception 里的 rules 与 deny_/violation_ 的后缀对应
exception contains rules if {
  input.kind == "Deployment"
  input.metadata.name == "can-run-as-root"
  rules := ["run_as_root"]
}
```

被例外放过的检查会在汇总里单独计数(形如 `2 tests, 1 passed, 0 warnings, 0 failures, 1 exception`),所以豁免不是「静默忽略」,而是可统计的。

### 常用参数

```shell
--policy / -p            策略目录,可重复;多个目录会合并为一组策略
--namespace / -n         只跑指定 namespace 下的策略,默认 [main],支持通配如 'k8s.*'
--data / -d              载入 JSON/YAML 数据文件供策略查询,可递归
--combine                把多个输入合并成一个数组再交给策略(行为破坏性,见「注意」)
--update / -u            先下载策略再执行测试
--ignore                 正则,匹配到的目录与文件跳过
--parser                 强制指定解析器,而不是按扩展名推断
--output / -o            输出格式:stdout、json、tap、table、junit、github、azuredevops、sarif
--trace                  打印 Rego 求值细节,仅对 stdout 格式有效
--fail-on-warn           让警告也影响退出码
--no-color               关闭彩色输出
--config-file / -c       指定 conftest 配置文件
```

配置优先级是「命令行 > 环境变量 > 配置文件」,配置文件固定为工作目录下的 `conftest.toml`,环境变量前缀是 `CONFTEST_`(如 `CONFTEST_POLICY`)。

### 常用操作

```shell
# 对单个文件跑策略
conftest test deployment.yaml

# 对整个目录跑
conftest test ./manifests/

# 从标准输入读取
helm template ./chart | conftest test -

# 与 kustomize 组合
kustomize build overlays/prod | conftest test --policy ./policy -

# 指定多个策略目录(组织级 + 团队级)
conftest test -p ./policy/org -p ./policy/team ./manifests/

# 载入外部数据供策略查询
conftest test --data ./allowed-registries.json ./manifests/

# CI 中拦截警告
conftest test --fail-on-warn --output json ./manifests/ > result.json

# 输出 SARIF,对接 GitHub Code Scanning
conftest test --output sarif ./manifests/ > conftest.sarif

# 只跑某个 namespace 的策略
conftest test --namespace 'k8s.*' ./manifests/

# 从 OCI registry 拉策略并直接测试
conftest test --update oci://registry.example.com/team/policies:latest deployment.yaml
conftest pull oci://registry.example.com/team/policies:latest
conftest push registry.example.com/team/policies:latest

# 跑策略自身的单元测试
conftest verify --policy ./policy
```

### 支持的配置格式

解析器按文件扩展名自动推断,可用 `--parser` 覆盖:

```shell
yaml / yml        Kubernetes 清单主力
json / jsonc      带注释的 JSON 也支持
hcl1 / hcl2        Terraform、HCL 配置
docker            Dockerfile
ini / properties / dotenv / toml / edn / hocon
xml / textproto / nginx / vcl
cue / jsonnet
groovy            Jenkins Pipeline
spdx / cyclonedx  SBOM 文件
```

**不同解析器交给策略的 `input` 结构完全不同**,写策略前务必先用 `--trace` 或 `conftest parse` 看清楚输入长什么样。

### 退出码

```shell
0    没有失败(有警告也算 0)
1    至少一条 deny / violation 命中
```

加上 `--fail-on-warn` 后变成三档:

```shell
0    既无失败也无警告
1    有警告但没有失败
2    至少一条失败
```

### 注意

1. **规则名前缀必须完全匹配**。源码里 `deny` 类规则的匹配正则是 `^(deny|violation)(_[a-zA-Z0-9]+)*$`,警告类是 `^warn(_[a-zA-Z0-9]+)*$`。写成 `denyXYZ`、`denyMsg` 这类没有下划线分隔的名字**不会被识别**,工具不报错、也不执行,策略看起来「写了但没生效」,是排查时间黑洞。想加标识就用下划线:`deny_run_as_root`。

2. **警告默认不影响退出码**。CI 里想拦住 `warn` 必须显式加 `--fail-on-warn`;加了之后退出码语义变成 0/1/2,而不是简单的 0/1,流水线脚本里判断退出码时不要写死 `!= 0` 就当成失败。

3. **策略文件必须用 `package main`**(或 `-n` 指定的 namespace)。写成 `package k8s` 而没传 `--namespace k8s` 时,规则不会被加载,`conftest test` 会直接报「0 tests」并通过 —— 又是一个静默失败。

4. **`--combine` 是破坏性的**。默认每个文件单独作为一个 `input`;开启后 `input` 变成一个数组,每项形如 `{"path": ..., "contents": ...}`。原有针对单文档写的策略全部失效,必须改写。官方文档专门用「BREAKING CHANGES in how Conftest provides input to rego policies」来警告这一点。只有在需要**跨文件比较**(如「所有 Ingress 的 host 不能重复」)时才用它。

5. **`--policy` 可重复,但多个目录会被合并成一组策略**,而不是互相隔离。同名规则(`deny` 与 `deny`)出现在两个目录里会产生冲突。组织级策略与团队级策略共存时,应当用**不同的规则名**(如 `deny_org_xxx` / `deny_team_xxx`)而不是重名。

6. **`--data` 装的是「数据」不是「被测配置」**。很多人误把要检查的 YAML 塞进 `--data`,结果策略里的 `input` 始终为空。被测内容走位置参数或 stdin;`--data` 只用来放白名单、映射表这类策略需要查询的静态数据。

7. **`--trace` 只对默认的 stdout 输出格式有效**。同时指定 `--output json` 时,输出格式胜出,追踪被静默跳过 —— 调试策略时先把 `-o` 去掉。

8. **解析器决定 `input` 的形状**。Kubernetes 的 YAML 会按 `kind` 展平成对象,而 Dockerfile、Terraform 的 `input` 是另一套完全不同的结构。跨格式复用同一份策略几乎不可行,按格式分目录放策略是更省事的做法。

9. **`conftest verify` 是策略的单元测试入口**,规则名以 `test_` 开头的会被当作测试。策略库一旦被多个团队共用,没有单测会非常危险 —— 一个手滑改错正则,等价于把检查全部关掉。

10. **策略可以从 OCI registry 分发**,`oci://` 前缀必须写全。省略 scheme 时 conftest 会按主机名猜协议,私有 registry 上大概率猜错。`--update` 可以一条命令完成「拉取 + 测试」,但会引入网络依赖,离线环境应当提前 `conftest pull` 到本地目录再用 `-p` 指定。

11. **`exception` 豁免写宽了等于关闭检查**。官方文档特意提醒:如果 `rules` 里给空字符串,会匹配所有 `deny`/`violation` 规则。豁免应当带上明确的对象名或标签条件,并且定期复查 `exception` 计数 —— 它涨得越快,说明策略越脱离实际。

12. **它不校验字段合法性**。conftest 只看你写了什么规则,`spec.replicas` 写成字符串它也不会拦。schema 层面的问题请交给 kubeconform,两者在流水线里是互补而非替代关系。

### 相关命令

- `kubeconform` — 按官方schema校验清单字段
- `kubectl` — Kubernetes集群管理工具
- `kustomize` — Kubernetes配置定制工具
- `helm` — Kubernetes包管理器
- `pluto` — 检测废弃与移除的apiVersion
- `kube-score` — 清单的可靠性与安全评分
- `polaris` — 最佳实践体检与准入控制

### 参考链接

- [conftest 官方文档](https://www.conftest.dev/)
- [conftest 安装说明](https://www.conftest.dev/install/)
- [conftest 参数参考](https://www.conftest.dev/options/)
- [conftest GitHub 仓库](https://github.com/open-policy-agent/conftest)
- [Open Policy Agent 与 Rego 语言](https://www.openpolicyagent.org/docs/latest/policy-language/)
