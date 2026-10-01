kubeconform
===

快速校验Kubernetes清单的schema正确性

## 补充说明

**kubeconform命令** 是 kubeval 的继任者,由 Yann Hamon 开发,用于在不连接集群的情况下,按 Kubernetes 官方 OpenAPI 规范校验 YAML/JSON 清单的字段合法性。官方定位是「inspired by, contains code from and is designed to stay close to Kubeval」(受 kubeval 启发、复用其代码、并刻意保持用法接近)。

它针对 kubeval 的三个痛点做了改进:

```shell
性能      多协程并发 + 内存级 schema 缓存,官方给出的对比是同一批清单 6.7s vs kubeval 的 35.3s
schema    支持自定义 schema 地址,既能校验 CRD,也能完全离线运行
时效性    作者自己维护 schema 仓库 yannh/kubernetes-json-schema,跟随新版 Kubernetes 发布
```

kubeconform 是这批工具里**唯一负责「字段层面对不对」**的那一个。搞清楚分工很重要:

```shell
kubeconform  字段是否合法(schema)          ← 本页
pluto        apiVersion 是否被废弃/移除
kube-score   可靠性与安全最佳实践评分
polaris      最佳实践体检 + 准入控制
popeye       集群里已部署资源的现状体检
conftest     自定义合规规则(策略即代码)
```

也就是说,kubeconform 通过不代表「配置合理」,只代表「字段没问题」。四者串起来用才是完整的一条流水线。

需要注意的是,kubeconform 只能做**客户端** schema 校验。控制器侧的行为(准入 webhook、默认值填充、CRD 的 CEL 校验规则)覆盖不到,这部分要靠 `kubectl apply --dry-run=server` 或 Kyverno 之类的准入引擎。官方 README 也明确提示了这一点。

### 安装

```shell
# Homebrew(macOS / Linux)
brew install kubeconform
kubeconform -v

# Windows
winget install YannHamon.kubeconform

# 直接下载二进制(以 Linux amd64 为例)
curl -L https://github.com/yannh/kubeconform/releases/latest/download/kubeconform-linux-amd64.tar.gz \
  | tar xz
sudo mv kubeconform /usr/local/bin/

# Go 安装
go install github.com/yannh/kubeconform/cmd/kubeconform@latest

# 容器镜像(CI 中使用,注意是 ghcr.io)
docker run --rm -v $(pwd):/work ghcr.io/yannh/kubeconform:latest -summary /work/manifests
```

### 语法

```shell
kubeconform [flags] <file|目录|-> ...
```

不传文件或传 `-` 时从标准输入读取,因此可以直接接在 `helm template`、`kustomize build` 后面。

### 常用参数

```shell
-kubernetes-version string   校验所依据的版本,如 1.32.0,默认 master
-schema-location value       schema 地址,可重复指定,按顺序查找,命中即停
-strict                      禁止 schema 之外的属性,并禁止重复键
-ignore-missing-schemas      找不到 schema 时跳过该文件,而不是判为失败
-skip string                 逗号分隔的 Kind 或 GVK,忽略不校验
-reject string               逗号分隔的 Kind 或 GVK,出现即视为不允许
-ignore-filename-pattern     正则,匹配到的路径直接跳过,可重复指定
-summary                     结束时打印一段汇总
-output string               输出格式:text(默认)、json、junit、pretty、tap
-verbose                     打印所有资源的结果,而不只打印出问题的
-n int                       并发协程数,默认 4
-cache string                把从 HTTP 下载的 schema 缓存到本地目录
-exit-on-error               遇到第一个错误立即停止
-debug                       打印调试信息
-insecure-skip-tls-verify    跳过 HTTPS 证书校验
-v                           查看版本
```

模板变量(用于自定义 `-schema-location`):

```shell
{{ .NormalizedKubernetesVersion }}   带 v 前缀的版本号,如 v1.32.0
{{ .StrictSuffix }}                  strict 模式下为 -strict,否则为空
{{ .ResourceKind }}                  资源 Kind,如 Deployment
{{ .ResourceAPIVersion }}            apiVersion 的版本部分,如 v1
{{ .Group }}                         api 组,如 monitoring.coreos.com
{{ .KindSuffix }}                    由 apiVersion 推导的后缀,兼容 kubeval 的目录结构
```

### schema 地址

`default` 是内置别名,展开后等价于:

```shell
https://raw.githubusercontent.com/yannh/kubernetes-json-schema/master/{{ .NormalizedKubernetesVersion }}-standalone{{ .StrictSuffix }}/{{ .ResourceKind }}{{ .KindSuffix }}.json
```

`-schema-location` 的取值规则有两条,很容易踩:

```shell
不以 .json 结尾    按 kubeval 风格的「目录结构」处理,工具自行拼接文件名
以 .json 结尾      按 Go 模板字符串处理,变量由你负责拼
```

### 常用操作

```shell
# 校验单个文件
kubeconform deployment.yaml

# 校验目录并打印汇总
kubeconform -summary ./manifests

# 指定 Kubernetes 版本(生产环境务必显式指定)
kubeconform -kubernetes-version 1.32.0 -summary ./manifests

# 严格模式
kubeconform -strict -summary ./manifests

# 跳过缺失 schema 的资源(CRD 在默认源下找不到 schema)
kubeconform -ignore-missing-schemas -summary ./manifests

# 同时用 CRDs-catalog 校验自定义资源
kubeconform -summary \
  -schema-location default \
  -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
  ./manifests

# 从标准输入读取
helm template ./chart | kubeconform -strict -summary
kustomize build overlays/prod | kubeconform -summary -

# 提高并发并缓存 schema
kubeconform -n 16 -cache /tmp/kubeconform-cache -summary ./manifests

# 完全离线:指向本地 schema 目录
kubeconform -schema-location 'schemas/{{ .ResourceKind }}{{ .KindSuffix }}.json' -summary ./manifests

# JSON 输出,便于流水线归档
kubeconform -summary -output json ./manifests > kubeconform.json

# 拒绝某些 Kind 出现在仓库里
kubeconform -reject Deployment -summary ./manifests
```

### 退出码

```shell
0    没有 invalid,也没有 error
1    出现 invalid(字段校验不通过),或出现 error(读文件失败、schema 拉取失败等)
```

判定的依据是每条资源结果的 `Status`:只有 `Error` 与 `Invalid` 会把整体标记为失败。`Skipped` 不算失败。

### 注意

1. **`-strict` 与 `-ignore-missing-schemas` 解决的是两个完全不同的问题,不要混为一谈**。`-strict` 管的是「**已经找到 schema** 的资源,是否允许 schema 之外的字段和重复键」;`-ignore-missing-schemas` 管的是「**找不到 schema** 时,该文件算跳过还是算失败」。一个收紧校验强度,一个放宽覆盖面,可以同时使用。

2. **`-strict` 会改变 schema 路径**。strict 模式下 `StrictSuffix` 变成 `-strict`,请求的地址从 `v1.32.0-standalone/Deployment-apps-v1.json` 变成 `v1.32.0-standalone-strict/Deployment-apps-v1.json`。如果自定义的 `-schema-location` 里没有对应的 `-strict` 目录,结果会从「校验失败」变成「找不到 schema」,报错信息完全不同,排查时别被带偏。

3. **`-kubernetes-version` 默认是 `master`**,意味着默认请求的是 `master-standalone` 目录。这个目录的 schema 跟随 Kubernetes 主干,可能包含尚未发布的字段,也可能因为上游变动而临时不可用。生产流水线应当**显式锁定版本**,如 `-kubernetes-version 1.32.0`;注意这里写的是不带 `v` 的 `1.32.0`,工具会自己归一化成 `v1.32.0`。

4. **`-ignore-missing-schemas` 是 CI 里最危险的参数**。加它之后,「没有 schema」从 error 降级为 skipped,退出码变成 0。如果仓库里大量是 CRD,而你又没配 `-schema-location` 指向 CRDs-catalog,就会出现「流水线全绿,但其实一个自定义资源都没校验过」。建议要么补上 CRDs-catalog 源,要么在 CI 里用 `-output json` 统计 skipped 数量并设阈值。

5. **多个 `-schema-location` 是按顺序查找、命中即止的**。把 `default` 放在第一位再放 CRDs-catalog 是标准写法;顺序反了会把内置资源的请求先打到 CRDs-catalog 上,徒增网络开销。

6. **CRD 的 schema 不在官方规范里,必须外部提供**。`datreeio/CRDs-catalog` 是社区维护的公共目录,收录主流 Operator 的 CRD schema;内部自研 CRD 可以在流水线里用 controller-gen 从 CRD 的 `openAPIV3Schema` 生成 JSON Schema 后,用本地 `-schema-location` 挂进去。

7. **`-cache` 在 CI 里收益很大**。默认每次运行都会重新下载 schema,大仓库 + 远程源很容易触发 GitHub raw 的限流(表现为大量 `Error` 状态)。配合 `-n` 调大并发时更要注意,因为并发拉取会成倍放大瞬时请求数。

8. **`-verbose` 与 `-summary` 在部分输出格式下会被忽略**。`-verbose` 对 tap 和 junit 无效,`-summary` 对 junit 无效 —— 这不是 bug,是这两种格式本身就有自己的汇总结构。

9. **它不做策略检查**。「没配资源限额」「没配探针」「跑了 root」这类问题 kubeconform 一律不管,因为那些字段在 schema 上都是合法的。这类需求分别对应 kube-score、polaris 与 conftest。

10. **`-reject` 与 `-skip` 的差别**要分清:`-skip` 是「忽略这些资源,不校验也不报错」,`-reject` 是「一旦出现就判为失败」。想禁止团队提交某种资源(例如禁止直接提交 `Secret` 明文)时,用 `-reject` 才是正确语义。两者都接受 Kind(如 `Deployment`)或 GVK(如 `apps/v1/Deployment`)。

11. **默认不校验文件名**,目录里混入的 `values.yaml`、`Chart.yaml` 之类非清单文件会被当成「空文档」而跳过,一般不报错。真要排除特定路径,用 `-ignore-filename-pattern` 显式写正则。

### 相关命令

- `kubeval` — kubeconform的前身,已停止维护
- `kubectl` — Kubernetes集群管理工具
- `kustomize` — Kubernetes配置定制工具
- `helm` — Kubernetes包管理器
- `pluto` — 检测废弃与移除的apiVersion
- `conftest` — 用rego做策略即代码检查
- `kube-score` — 清单的可靠性与安全评分

### 参考链接

- [kubeconform GitHub 仓库](https://github.com/yannh/kubeconform)
- [yannh/kubernetes-json-schema 官方 schema 源](https://github.com/yannh/kubernetes-json-schema)
- [datreeio/CRDs-catalog 公共 CRD schema 目录](https://github.com/datreeio/CRDs-catalog)
- [Kubernetes API 规范与 OpenAPI](https://kubernetes.io/docs/reference/using-api/api-concepts/)
