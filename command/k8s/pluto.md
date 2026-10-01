pluto
===

扫描清单与集群中已废弃或已移除的apiVersion

## 补充说明

**pluto命令** 是 Fairwinds 开源的 apiVersion 检测工具,用来回答一个非常具体的问题:**这份清单(或这个集群)里,有没有用上已经被 Kubernetes 废弃、甚至已经删除的 apiVersion?**

它覆盖两个方向:

```shell
存量代码   扫描 Git 仓库里的静态清单与 Helm chart
线上现状   扫描集群里正在运行的 Helm Release 与 API 资源
```

判定结果有两档,对应 Kubernetes 的废弃策略:

```shell
DEPRECATED  在当前目标版本中仍可用,但已被标记废弃,后续版本会删除
REMOVED     在目标版本中已经彻底移除,提交会直接被 API Server 拒绝
```

在这批工具里的分工,pluto 是唯一专攻这件事的:

```shell
kubeconform  字段是否合法(schema)
conftest     自定义合规规则
pluto        apiVersion 是否废弃/移除 —— 本页
polaris      最佳实践体检 + 准入控制
kube-score   最佳实践评分
popeye       集群现状体检(只读)
```

**它在升级 Kubernetes 前后是刚需**:从 1.16 到 1.32,几乎每一个大版本都删掉过一批 apiVersion(`extensions/v1beta1` Ingress、`policy/v1beta1` PodDisruptionBudget、`autoscaling/v2beta2` HPA、`flowcontrol.apiserver.k8s.io/v1beta3` 等),漏掉任何一个都会让 `kubectl apply` 直接失败。

### 安装

```shell
# Homebrew
brew install FairwindsOps/tap/pluto
pluto version

# asdf
asdf plugin-add pluto
asdf list-all pluto
asdf install pluto <latest version>
asdf local pluto <latest version>

# Scoop(Windows,非官方维护)
scoop install pluto

# 直接下载二进制
# 从 https://github.com/FairwindsOps/pluto/releases 选择对应平台

# 容器镜像(注意 registry 已迁移,且无浮动 tag)
# us-docker.pkg.dev/fairwinds-ops/oss/pluto:v<major>.<minor>.<patch>
docker run --rm -v $(pwd):/work \
  us-docker.pkg.dev/fairwinds-ops/oss/pluto:v5.24.4 \
  detect-files -d /work
```

GitHub Action:

```shell
- name: Download Pluto
  uses: FairwindsOps/pluto/github-action@master

- name: Detect deprecated apiVersions
  run: pluto detect-files -d ./manifests
```

### 语法

```shell
pluto <子命令> [flags]
```

```shell
pluto detect-files           扫描本地目录
pluto detect <文件|->        扫描单个文件或标准输入(适合管道)
pluto detect-helm            扫描集群中的 Helm Release
pluto detect-api-resources   扫描集群中的 API 资源
pluto detect-all-in-cluster  上两者合并执行
pluto list-versions          输出内置的版本对照表
```

### 通用参数

```shell
-o, --output string       输出格式:normal(默认)、wide、custom、json、yaml、markdown、csv
-t, --target-versions     目标版本映射,如 k8s=v1.32.0
-r, --only-show-removed   只显示已移除的项(同时影响退出码与 JSON/YAML 结果)
-H, --no-headers          markdown / csv / normal 输出不打印表头
-f, --additional-versions 附加的自定义版本对照文件
--columns                 指定列,配合 --output custom(必填)或 markdown
--components              只检查指定组件,如 k8s、cert-manager、istio
--ignore-deprecations     忽略「发现废弃 apiVersion」的退出码 2
--ignore-removals         忽略「发现已移除 apiVersion」的退出码 3
--ignore-unavailable-replacements  忽略「替代 apiVersion 在目标版本尚不可用」的退出码 4
```

子命令专属参数:

```shell
-d, --directory            detect-files 的扫描目录,默认当前目录
-n, --namespace            限定命名空间(三个集群内子命令)
--kube-context             指定 kube context
--kubeconfig               指定 kubeconfig 路径
```

所有参数都有对应的环境变量,前缀是 `PLUTO_`,连字符换成下划线,例如 `PLUTO_TARGET_VERSIONS`、`PLUTO_OUTPUT`、`PLUTO_ONLY_SHOW_REMOVED`。命令行参数优先于环境变量。

### 常用操作

```shell
# 扫描整个目录(Git 仓库里的静态清单与 Helm chart 模板)
pluto detect-files -d ./manifests

# 输出宽表,带上「在哪个版本废弃 / 在哪个版本移除」
pluto detect-files -d ./manifests -owide

# 只看已经彻底移除的项
pluto detect-files -d ./manifests -r

# 明确指定目标版本(强烈建议,原因见「注意」第 1 条)
pluto detect-files -d ./manifests --target-versions k8s=v1.32.0

# 扫描单个文件
pluto detect deployment.yaml

# 管道:先渲染 Helm chart 再检查
helm template ./chart | pluto detect -
helm template ./chart --namespace prod | pluto detect -

# 扫描集群中所有 Helm Release
pluto detect-helm -owide
pluto detect-helm -n cert-manager -owide

# 扫描集群中的 API 资源
pluto detect-api-resources -owide

# 一次把集群里的 Helm 与 API 资源都扫掉
pluto detect-all-in-cluster -o wide

# JSON 输出,便于流水线归档或二次处理
pluto detect-files -d ./manifests -ojson | jq .

# 输出 markdown 报告
pluto detect-files -d ./manifests -o markdown > pluto-report.md

# 自定义列
pluto detect-files -d ./manifests -ocustom --columns NAMESPACE,NAME,KIND,VERSION,REPLACEMENT

# 查看内置的 apiVersion 对照表
pluto list-versions -o json

# 附加自定义的废弃版本表(自研 CRD 也能纳管)
pluto detect-files -d ./manifests -f ./custom-versions.yaml
```

### 自定义版本对照表

`-f/--additional-versions` 传入的文件格式与内置 `versions.yaml` 一致:

```shell
target-versions:
  k8s: v1.32.0
deprecated-versions:
  - version: example.com/v1alpha1
    kind: MyResource
    deprecated-in: v1.20.0
    removed-in: v1.28.0
    replacement-api: example.com/v1
    replacement-available-in: v1.22.0
    component: my-operator
```

自定义文件里的 `target-versions` 只有在内置表中**不存在**该组件时才会被采纳,不能覆盖内置组件的默认值 —— 想覆盖只能用命令行 `--target-versions`。

### 退出码

```shell
0    没有发现问题
1    执行出错(文件读不到、连不上集群等)
2    发现已废弃的 apiVersion
3    发现已被移除的 apiVersion
4    替代 apiVersion 在目标版本中尚不可用
```

注意这四档是**层层递进**的,`-r/--only-show-removed` 会同时改变判定结果与退出码。

### 注意

1. **默认目标版本严重滞后,这是 pluto 最大的坑**。版本对照表内嵌在二进制里,当前默认值是:

   ```shell
   k8s:          v1.25.0
   cert-manager: v1.5.3
   istio:        v1.11.0
   ```

   在 1.30+ 的集群上不传 `--target-versions`,判定会系统性偏乐观 —— 本该报 `REMOVED` 的会被报成 `DEPRECATED`。例如 `flowcontrol.apiserver.k8s.io/v1beta3` 在 1.32 被移除,默认目标 1.25 下只会显示为废弃。**生产流水线必须显式指定**,如:

   ```shell
   pluto detect-files -d ./manifests --target-versions k8s=v1.32.0
   ```

   (顺带一提,官方文档站的部分页面还写着默认值是 v1.22.0,已经过时;以 `pluto list-versions` 的输出为准。)

2. **版本号必须带前导 `v`**。`--target-versions` 的取值会过一遍 semver 校验,写 `k8s=1.32.0` 会直接报错退出,必须写 `k8s=v1.32.0`。

3. **`--target-versions` 会覆盖内置默认值中同名组件的版本,覆盖不了内置的条目本身**。也就是说你可以改「以哪个版本为基准」,但不能通过 `-f` 修改内置对照表里已有的 apiVersion 记录 —— `-f` 只能**追加**新条目。想微调内置记录只能自己维护一份完整对照表并在本地分支里编译。

4. **退出码默认就会让 CI 失败**。很多工具默认返回 0,pluto 不是:发现废弃就退 2,发现移除就退 3。放在流水线里是好事,但如果是「只收集报告不拦截」的用途,记得加 `--ignore-deprecations` / `--ignore-removals` / `--ignore-unavailable-replacements`,否则每次都会红。

5. **`-r` 不只是过滤输出**。`--only-show-removed` 会改变内部判定结果,进而影响退出码以及 JSON/YAML 的内容。想要「完整报告 + 只对移除项告警」,不能靠 `-r`,应当看 JSON 输出里的 `deprecated` 字段自行判断。

6. **`detect-api-resources` 依赖 `last-applied-configuration` 注解**。它通过对象上的 `kubectl.kubernetes.io/last-applied-configuration` 反推 apiVersion。用 **Server-Side Apply** 或 **Helm** 部署的对象可能没有这个注解,结果是「集群里明明有老 apiVersion,pluto 却扫不出来」。用 SSA 的集群应优先用 `detect-helm` 或直接查 API Server 的 discovery 结果。

7. **`detect-files` 扫的是文件内容,不是渲染后的结果**。Helm chart 的模板里写着 `{{ .Values.apiVersion }}` 这种参数化 apiVersion 时,pluto 无法判断最终值 —— 必须先 `helm template` 再用 `pluto detect -` 检查渲染产物。仓库级扫描建议两个都跑:模板扫一遍找明显的硬编码,渲染产物再扫一遍。

8. **`--output custom` 必须同时给 `--columns`**,否则直接报错。列名是固定枚举(如 `NAMESPACE`、`NAME`、`KIND`、`VERSION`、`DEPRECATED`、`REMOVED`、`REPLACEMENT`,`--columns` 传错会提示可用值)。带空格的列名要转义或加引号。

9. **它只比对 apiVersion 字符串,不校验字段**。pluto 能告诉你「`policy/v1beta1` 的 PodDisruptionBudget 在 1.25 被删了,该换成 `policy/v1`」,但换成 `policy/v1` 之后字段结构对不对(比如 `policy/v1` 里 `spec.selector` 语义有变化),它不管。**换完 apiVersion 后一定要再跑一次 kubeconform**,这一步经常被漏掉。

10. **`detect-all-in-cluster` 是前两个的串联**,退出码取两者中较严重的那个。它在扫描不出结果时**不会**明确告诉你「是没找到还是没权限」,权限不足通常表现为整体报错退出 1,排错时先用 `pluto detect-helm` 与 `pluto detect-api-resources` 分别跑一遍定位。

11. **`list-versions` 是排查判定结果的最快手段**。拿不准某个 apiVersion 在 pluto 眼里是废弃还是移除、替代品是什么,直接 `pluto list-versions -o json | jq` 查,比翻文档快。

12. **容器镜像不再有浮动 tag**。从 v5.24.0 起镜像迁到 `us-docker.pkg.dev/fairwinds-ops/oss/pluto`,`quay.io/fairwinds/pluto` 已废弃;`v5`、`v5.23`、`latest` 这些浮动 tag 也已取消,只剩不可变的完整版本 tag 与 digest。老脚本要一并更新。

### 相关命令

- `kubeconform` — 按官方schema校验清单字段
- `kubectl` — Kubernetes集群管理工具
- `helm` — Kubernetes包管理器
- `kustomize` — Kubernetes配置定制工具
- `conftest` — 用rego做策略即代码检查
- `kube-score` — 清单的可靠性与安全评分
- `kubeadm` — Kubernetes集群安装与升级工具

### 参考链接

- [pluto 官方文档](https://pluto.docs.fairwinds.com/)
- [pluto 快速上手](https://pluto.docs.fairwinds.com/quickstart/)
- [pluto 高级用法与参数](https://pluto.docs.fairwinds.com/advanced/)
- [pluto GitHub 仓库](https://github.com/FairwindsOps/pluto)
- [Kubernetes 废弃策略](https://kubernetes.io/docs/reference/using-api/deprecation-policy/)
