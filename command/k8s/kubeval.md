kubeval
===

校验Kubernetes清单是否符合指定版本的schema

## 补充说明

**kubeval命令** 是早期使用最广的 Kubernetes 清单离线校验工具,由 Gareth Rushgrove(@garethr)开发。它把 Kubernetes 官方 OpenAPI 规范转成 JSON Schema,再拿本地 YAML/JSON 清单逐字段比对,从而在**不连接集群**的前提下发现字段拼写错误、类型错误、必填字段缺失等问题。

**状态提示(重要,先看这一段)**:`kubeval` 已经**停止维护**。原仓库 `instrumenta/kubeval` 的 README 顶部第一行就写着「NOTE: This project is no longer maintained, a good replacement is kubeconform」,官方推荐的替代品是 `kubeconform`。最后一个版本停留在 **v0.16.1(2021-03-30)**,此后没有任何发布。

有一个流传很广的说法需要纠正:

```shell
仓库是否被 GitHub 标记为 Archived    否,仍是 Public 状态,可以正常 clone / fork
是否仍有人维护                        否,README 明确声明不再维护
最后一个 release                      v0.16.1(2021-03-30)
默认 schema 源                        https://kubernetesjsonschema.dev —— 该站点已失效
官方推荐替代品                        kubeconform(README 中直接给出链接)
```

也就是说,**它不是「已归档」,而是「已弃养」** —— 仓库还开着,但没人修。更重要的是它的默认 schema 源已经挂了(见下方「注意」第 1 条),所以今天直接 `kubeval xxx.yaml` 大概率连跑都跑不起来。

本页保留完整用法,一是维护老流水线时还要对照参数,二是它的参数设计被 kubeconform 大量继承,理解了 kubeval 就等于理解了一半 kubeconform。

在这批清单校验工具里的分工:

```shell
kubeval      按 OpenAPI schema 校验字段合法性 —— 已停维护,用 kubeconform 代替
kubeconform  同上,速度快、支持 CRD、支持新版本 k8s —— 现役主力
conftest     策略即代码(合规规则),不是 schema 校验
pluto        检测废弃/移除的 apiVersion
polaris      最佳实践体检(资源、安全、可靠性),可做准入控制
kube-score   最佳实践评分(侧重可靠性与安全)
popeye       集群现状体检(只读扫描已部署资源)
```

### 安装

```shell
# Homebrew(macOS / Linux)
brew tap instrumenta/instrumenta
brew install kubeval
kubeval --version

# 直接下载二进制(Linux)
wget https://github.com/instrumenta/kubeval/releases/latest/download/kubeval-linux-amd64.tar.gz
tar xf kubeval-linux-amd64.tar.gz
sudo cp kubeval /usr/local/bin

# macOS 二进制
wget https://github.com/instrumenta/kubeval/releases/latest/download/kubeval-darwin-amd64.tar.gz
tar xf kubeval-darwin-amd64.tar.gz
sudo cp kubeval /usr/local/bin

# Go 安装
go install github.com/instrumenta/kubeval@latest

# Docker(官方文档里的镜像名是 garethr/kubeval)
docker run -it -v $(pwd)/fixtures:/fixtures garethr/kubeval fixtures/*

# Scoop(Windows)
scoop bucket add instrumenta https://github.com/instrumenta/scoop-instrumenta
scoop install kubeval
```

### 语法

```shell
kubeval <file> [file...] [flags]
kubeval -d <目录> [flags]
cat manifest.yaml | kubeval [flags]
```

### 常用参数

```shell
--kubernetes-version / -v    校验所依据的 Kubernetes 版本,默认 master
--schema-location / -s       schema 基础地址,默认 https://kubernetesjsonschema.dev
--additional-schema-locations 备用 schema 地址(逗号分隔),主地址找不到时依次回退
--openshift                  改用 OpenShift schema 而不是上游 Kubernetes
--strict                     禁止 schema 中未定义的字段
--ignore-missing-schemas     没有对应 schema 的资源直接跳过,不算失败
--skip-kinds                 逗号分隔、大小写敏感的 Kind 列表,跳过校验
--reject-kinds               逗号分隔、大小写敏感的 Kind 列表,出现即视为不允许
--directories / -d           递归扫描目录下的 .yaml / .yml
--ignored-path-patterns / -i 正则,匹配到的路径跳过
--default-namespace / -n     资源未写 metadata.namespace 时假定的命名空间,默认 default
--filename / -f              从 stdin 读取时,报告中显示的文件名,默认 stdin
--output / -o                输出格式:stdout(默认)、json、tap
--exit-on-error              遇到第一个错误立即退出,不再聚合后续错误
--quiet                      除直接结果外不输出任何日志
--insecure-skip-tls-verify   跳过 HTTPS 证书校验(拉取 schema 时)
--force-color                即使 stdout 不是 TTY 也输出彩色
```

环境变量前缀是 `KUBEVAL`,其中 schema 地址对应 `KUBEVAL_SCHEMA_LOCATION`。参数与环境变量同名时,命令行优先。

### 常用操作

```shell
# 校验单个文件
kubeval deployment.yaml

# 校验整个目录
kubeval -d ./manifests

# 从标准输入读取(配合 helm / kustomize)
helm template ./chart | kubeval
kustomize build overlays/prod | kubeval --strict

# 指定 Kubernetes 版本与 schema 源
kubeval --kubernetes-version 1.18.0 \
  --schema-location https://raw.githubusercontent.com/yannh/kubernetes-json-schema/master \
  deployment.yaml

# 跳过没有 schema 的资源(CRD 场景必备)
kubeval --ignore-missing-schemas -d ./manifests

# 跳过特定 kind
kubeval --skip-kinds CustomResourceDefinition,APIService -d ./manifests

# 禁止未定义字段
kubeval --strict deployment.yaml

# JSON 输出,便于 CI 消费
kubeval -o json -d ./manifests > result.json

# TAP 输出
kubeval -o tap deployment.yaml
```

### 输出格式

```shell
stdout    默认。逐资源打印「contains a valid/invalid X」,人类可读
json      结构化数组,每项含 filename / kind / status / errors
tap       Test Anything Protocol,可对接 tap 消费端
```

JSON 里的 `status` 有三个取值:`valid`、`invalid`、`skipped`。**空文档与「没有找到 schema 因而未校验」都会落进 `skipped`** —— 这一点直接决定了退出码,详见「注意」第 6 条。

### 退出码

```shell
0    全部资源校验通过(或被成功跳过)
1    至少一个资源校验失败;也包括文件读不到、schema 拉不下来等错误
```

`--exit-on-error` 只影响「是否继续跑完剩余文件」,不影响退出码本身的含义。

### 注意

1. **默认 schema 源已经彻底失效,这是当前最大的坑**。kubeval 的 `DefaultSchemaLocation` 常量写死为 `https://kubernetesjsonschema.dev`,而该域名如今已不再提供 schema 服务 —— 请求会返回 404,甚至 TLS 握手都会失败(证书已不属于该域名)。表现是类似 `Failed initializing schema https://kubernetesjsonschema.dev/master-standalone/...: Could not read schema from HTTP, response status is 404 Not Found` 的报错。**必须显式换源**,推荐指向仍在更新的 `yannh/kubernetes-json-schema`:

   ```shell
   kubeval --schema-location https://raw.githubusercontent.com/yannh/kubernetes-json-schema/master \
     deployment.yaml

   # 或用环境变量,适合统一在 CI 环境里设置
   export KUBEVAL_SCHEMA_LOCATION=https://raw.githubusercontent.com/yannh/kubernetes-json-schema/master
   ```

2. **不支持 CRD**。schema 来自 Kubernetes 上游 OpenAPI 规范,自定义资源没有对应 schema,会落到「未校验」状态。老版本 kubeval 需要自己转换 CRD 的 `openAPIV3Schema` 生成 schema 再喂给 `--additional-schema-locations`,过程相当繁琐 —— 这也是 kubeconform 更受欢迎的原因之一,后者可以直接指向 `datreeio/CRDs-catalog`。

3. **schema 仓库不再跟进新版本**。kubeval 生态原本依赖 `garethr/kubernetes-json-schema`,该仓库已停止更新。如果 `--kubernetes-version` 填了较新的版本号(如 1.28),大概率找不到对应目录而全量报错。用 `yannh/kubernetes-json-schema` 可缓解,但它的目录命名规则与原仓库并非完全一致,换源后建议先用单个文件验证。

4. **`--skip-kinds` / `--reject-kinds` 是大小写敏感的 Kind 名**,写的是 `Deployment`、`CustomResourceDefinition` 这种 Kind,不是 `apps/v1` 这种 apiVersion。写错不会报错,只会静默不生效。

5. **`--strict` 比 api-server 更严格**。开启后任何 schema 未定义的字段都会报错,而 kubectl 提交时这类字段只是被丢弃(不报错)。历史上很多清单里带着 `creationTimestamp: null` 之类的冗余字段,开 `--strict` 后会大面积飘红,迁移时要有心理准备。

6. **「未校验」不等于「校验通过」**。没有 `--ignore-missing-schemas` 时,缺 schema 会被当作错误处理(退出码 1);加上它之后变成 `skipped`,`kubeval` 会安静地返回 0。CI 里如果无脑加了 `--ignore-missing-schemas`,很容易出现「全绿但什么都没校验」的假阳性 —— 建议同时在流水线里统计 `skipped` 的数量。

7. **`--output` 的合法值是 `stdout`、`json`、`tap`**,默认是 `stdout`,**不是** `standard`。写成 `--output standard` 会静默回退到默认输出,不报错,容易让人以为 JSON 模式没生效。

8. **它只做 schema 层面的校验**。字段拼错、类型错误、缺必填字段能查出来;但「这个 Deployment 没配探针」「这个容器跑了 root」这类策略问题它不管,那是 kube-score、polaris、conftest 的职责;服务端准入层面的校验(如 webhook、默认值填充、CRD 的 CEL 规则)只能靠 `kubectl apply --dry-run=server`。

9. **新项目请直接选 kubeconform**。kubeconform 由 kubeval 的 schema 维护者 Yann Hamon 开发,参数设计高度兼容,同时解决了「不支持 CRD」「schema 不更新」「性能差」三个核心问题,并且仍在发版。本页仅用于维护存量流水线。

### 相关命令

- `kubeconform` — kubeval的现役替代品,支持CRD与新版本schema
- `kubectl` — Kubernetes集群管理工具
- `kustomize` — Kubernetes配置定制工具
- `helm` — Kubernetes包管理器
- `pluto` — 检测废弃与移除的apiVersion
- `conftest` — 用rego做策略即代码检查

### 参考链接

- [kubeval GitHub 仓库(已停止维护)](https://github.com/instrumenta/kubeval)
- [kubeval 安装文档](https://github.com/instrumenta/kubeval/blob/master/docs/installation.md)
- [kubeconform — 官方推荐替代品](https://github.com/yannh/kubeconform)
- [yannh/kubernetes-json-schema 可用的 schema 源](https://github.com/yannh/kubernetes-json-schema)
