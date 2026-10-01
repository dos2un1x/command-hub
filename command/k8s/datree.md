datree
===

已停运的Kubernetes清单策略校验CLI,仅离线模式可用

## 补充说明

**datree 已经停止服务,请勿在新项目中使用。** 支撑这个项目的商业公司于 **2023 年 7 月关闭**,官方仓库 README 的标题已经改成 `# Datree [DEPRECATED]`,正文中明确写着「Since July 2023, the commercial company that supports and actively maintains this project has been closed」。GitHub 仓库随后被标记为 **Public archive**,不再接受任何代码变更 —— **包括安全补丁**。最后一个版本是 **1.9.19(2023-07-23)**。

停运清单如下,这些都是依赖云端的部分,已经全部不可用:

```shell
集中式策略库(centralized policy registry)   已停
自动 Kubernetes schema 校验服务                已停
Dashboard 与活动日志、token 管理                已停
datree.io 主站                                  已无法正常访问
仓库维护与安全更新                              已停止(仓库已 Archive)
```

**仍然可用的部分**:CLI 二进制本身以及内置的 100+ 条离线规则(覆盖工作负载安全、高可用、NSA 加固等),在**离线模式**下依然能在本地跑完。这也是本页仍有价值的原因 —— 存量流水线里可能还在用它,需要知道怎么让它别卡在连云端。

**迁移建议(按职责拆分)**:

```shell
schema 校验(字段合法性)    → kubeconform(datree 内置的 schema 校验正是换成了它)
策略即代码(自定义规约)      → Kyverno / OPA Gatekeeper / conftest
最佳实践评分                → kube-score / polaris
废弃 apiVersion 检测        → pluto
集群现状体检                → popeye
```

需要说明的是,datree 当年主打的「集中式策略管理 + 审计面板」这套服务端能力,在开源侧没有直接对等物,需要自行组合 Kyverno 的策略仓库或商业方案。

### 安装

CLI 仍可从 GitHub Releases 下载,但只有历史版本:

```shell
# Linux
curl -L https://github.com/datreeio/datree/releases/download/1.9.19/datree_1.9.19_linux_x86_64.tar.gz \
  | tar xz
sudo mv datree /usr/local/bin/
datree version

# macOS
curl -L https://github.com/datreeio/datree/releases/download/1.9.19/datree_1.9.19_macOS_arm64.tar.gz \
  | tar xz
sudo mv datree /usr/local/bin/
```

注意没有 Homebrew formula 可用,官方安装脚本(`get.datree.io`)指向的服务端也已失效,不要再用。

### 语法

```shell
datree <子命令> [flags]
```

```shell
datree test <文件|glob|->    对清单做策略校验(主命令)
datree kustomize <目录>      对 kustomize 目录做校验
datree config set <k> <v>    写入本地配置
datree config get <k>        读取本地配置
datree publish <策略文件>    发布策略到云端 —— 已失效
datree version               查看版本
datree upgrade               升级 CLI —— 已失效
datree docs                  打开文档站
datree completion            生成 shell 补全
```

### test 子命令参数

```shell
-o, --output string          输出格式:simple、yaml、json、xml、JUnit、sarif
-s, --schema-version string  按哪个 Kubernetes 版本做 schema 校验
-p, --policy string          使用哪个策略(仅在策略可用时有效)
--policy-config string       本地策略配置文件路径
--schema-location strings    schema 搜索路径,可重复指定
--ignore-missing-schemas     找不到 schema 时跳过而不是失败
--permissive-schema          非严格 schema 校验(允许 schema 之外的属性)
--skip-validation string     跳过某个校验环节,目前只支持 'schema'
--only-k8s-files             只处理同时含 apiVersion 与 kind 的 YAML
--exclude string             路径排除正则
--no-record                  不把校验元数据上报后端
--save-results string        结果写入指定文件
--save-rendered              保留渲染产物(helm / kustomize 场景)
--verbose                    展示「如何修复」的链接
--quiet                      不打印被跳过的规则信息
```

相关环境变量:

```shell
DATREE_POLICY_CONFIG     等价于 --policy-config
DATREE_SCHEMA_LOCATION   等价于 --schema-location(多个用逗号分隔)
```

### 本地配置

配置写在 `~/.datree/config.yaml`,可用的键只有四个:

```shell
token             访问令牌(云端已停,保留字段)
offline           设为 local 即进入离线模式
policy_config     本地策略文件路径
schema_locations  schema 搜索路径
```

```shell
# 查看当前配置
datree config get offline

# 进入离线模式(关键步骤)
datree config set offline local

# 指定本地策略文件
datree config set policy_config ./policies.yaml
```

### 离线使用

```shell
# 第一步:切到离线模式,否则 CLI 会尝试连云端并卡住或报错
datree config set offline local

# 用内置默认策略跑清单
datree test k8s-demo.yaml
datree test ./manifests/*.yaml

# 从标准输入读取
cat deployment.yaml | datree test -

# 用自定义策略文件
datree test k8s-demo.yaml --policy-config policies.yaml

# 指定 Kubernetes 版本
datree test k8s-demo.yaml --schema-version 1.25.0

# 指向本地的 schema 目录(离线环境下必须)
datree test k8s-demo.yaml \
  --schema-location 'v1.21.0-standalone-strict/{{.ResourceKind}}{{.KindSuffix}}.json'

# 只校验策略,跳过 schema 环节
datree test k8s-demo.yaml --skip-validation schema

# 只在本地跑,不上报任何数据
datree test k8s-demo.yaml --no-record

# JSON / SARIF 输出
datree test ./manifests/*.yaml --output json --save-results result.json
datree test ./manifests/*.yaml --output sarif
```

### 退出码

```shell
0   没有发现问题
非0 存在 YAML 解析失败、K8s 资源校验失败,或有策略规则未通过
```

判定条件(来自源码 `wereViolationsFound`)是三者之一:YAML 解析失败、K8s 校验失败、`TotalFailedRules > 0`。

### 注意

1. **离线模式是 `datree config set offline local`,不是 `--offline` 参数**。当前版本的 `datree test` 根本没有 `--offline` flag(很多博客里的写法是错的),离线状态来自本地配置里的 `offline: local`。在没配置的情况下直接跑 `datree test`,CLI 会先去请求云端的策略预拉取接口,而该服务早已下线,表现是长时间卡住或直接报错退出。

2. **不要设 `DATREE_TOKEN` 之类的环境变量去「修复」连接问题**。云端已经没有了,提供 token 不会让请求成功,只会让失败路径更晚出现。已经设过的环境变量应当清掉,让 CLI 走离线分支。

3. **`--policy-config` 需要策略即代码模式,而该模式的开关在云端**。源码里的判断是「本地离线模式 **或** 云端返回的策略即代码模式」二者之一成立才允许自定义策略文件。停运后前半段是唯一出路 —— 也就是必须先 `datree config set offline local`,`--policy-config` 才会生效。只加 `--policy-config` 而不开离线,会直接报错提示需要先启用策略即代码模式。

4. **schema 校验在离线环境下需要自己准备 schema 目录**。datree 内置的 schema 校验其实是内嵌了 kubeconform 的能力,默认从 GitHub 拉 schema;断网环境必须先手工把对应版本目录(如 `v1.21.0-standalone-strict/`)拷进去,再用 `--schema-location` 指过去。路径模板里的 `{{.ResourceKind}}{{.KindSuffix}}.json` 是**字面量占位符**,CLI 会自己解析目录下所有匹配的 `.json`,不需要你替换。

5. **`--schema-version` 默认值停留在 1.24.0**。源码里的兜底逻辑是:命令行 → 本地配置 → 云端预拉取返回的默认值 → 最后硬编码 `1.24.0`。离线模式下走不到云端那一步,所以实际默认就是 **1.24.0**。在 1.30+ 集群上不显式指定版本,判定会明显偏松。

6. **`--output` 的取值大小写敏感**,合法值是 `simple`、`yaml`、`json`、`xml`、`JUnit`、`sarif`。注意 **`JUnit` 的 J 是大写**,写成 `junit` 会直接报参数非法；`sarif` 是小写。不加 `-o` 时进入交互式输出(带彩色与图标),在 CI 里会因为非 TTY 而输出混乱,流水线中务必显式指定格式。

7. **仓库已归档意味着没有安全补丁**。datree 的二进制会解析你仓库里的 YAML 并联网(离线配置不当的情况下),继续在流水线里跑归档项目是有风险的。若短期内无法下线,至少确保它完全离线、固定版本、并且不要给它任何集群凭据 —— datree 只需要清单文件,不需要 kubeconfig。

8. **规则不会更新**。内置的 100+ 条规则是编译进二进制的,停更之后就停在 2023 年 7 月的状态。Kubernetes 之后新增的字段、新的 API 版本、新的安全建议都不会被覆盖到 —— 它能查出问题,但查不出新问题。

9. **`datree.io` 主站已不可用,文档站还在**。命令里的 `datree docs` 会尝试打开 `hub.datree.io`,该站点目前仍能返回内容,但不要指望它长期存在。需要查阅时建议直接看归档仓库里的源码与 README。

10. **迁移时注意「职责拆分」而不是找替代品**。datree 一个工具同时做了三件事:schema 校验、策略校验、云端治理。迁移时应当分别对应到 kubeconform(schema)、Kyverno / OPA Gatekeeper / conftest(策略)、kube-score / polaris(最佳实践),而不是找一个「什么都做」的工具硬替。

11. **历史流水线的清理清单**:移除 `datree test` 步骤、移除 `DATREE_TOKEN` 等环境变量、移除 `get.datree.io` 安装脚本、删除仓库里的 `.datree` 配置目录。只删命令不删环境变量,后续排查时很容易被误导。

### 相关命令

- `kubeconform` — datree内置schema校验能力的现役来源
- `kube-score` — 清单的可靠性与安全评分
- `polaris` — 最佳实践体检与准入控制
- `conftest` — 用rego做策略即代码检查
- `pluto` — 检测废弃与移除的apiVersion
- `kubeval` — 同样已停维护的schema校验工具
- `kubectl` — Kubernetes集群管理工具

### 参考链接

- [datree GitHub 仓库(已归档)](https://github.com/datreeio/datree)
- [datree 离线模式文档](https://hub.datree.io/cli/offline-mode)
- [kubeconform — schema 校验的替代方案](https://github.com/yannh/kubeconform)
- [Kyverno — 策略引擎替代方案](https://kyverno.io/)
- [OPA Gatekeeper — 准入策略替代方案](https://open-policy-agent.github.io/gatekeeper/)
