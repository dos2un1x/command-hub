kube-score
===

对Kubernetes清单做可靠性与安全性的静态评分

## 补充说明

**kube-score命令** 是 zegl 开源的清单静态分析工具,定位是「Kubernetes YAML 的静态代码分析」—— 输入是清单文件,输出是一份带评分的检查报告,每条检查分为 **CRITICAL(严重)**、**WARNING(警告)**、**OK(通过)** 三档。

它关心的不是「字段写没写对」,而是「这么写上线后会不会出事」:

```shell
可靠性     有没有配 PDB、探针是否合理、副本数是否够、反亲和是否设置
安全性     securityContext、只读根文件系统、privileged、UID/GID
规范性     镜像 tag 是否明确、pullPolicy、废弃 apiVersion、标签值合法性
```

在这批工具里的分工:

```shell
kubeconform  字段是否合法(schema)
conftest     自定义合规规则
pluto        apiVersion 是否废弃/移除
polaris      最佳实践体检 + 准入控制
kube-score   最佳实践评分 —— 本页,纯 CLI,无运行时组件
popeye       集群现状体检(只读)
```

与 polaris 的区别在于:**kube-score 只是命令行工具**,不需要在集群里部署任何东西,天然适合 CI;polaris 则提供了 dashboard 与准入 webhook,偏向长期治理。两者的检查项有大量重叠,选哪个主要看团队是想「流水线里卡」还是「集群里管」。

**它检查的是磁盘上的 YAML,不是集群现状**。这一点和 popeye 正好互补。

### 安装

```shell
# Homebrew(macOS / Linux)
brew install kube-score
kube-score version

# krew(kubectl 插件形式)
kubectl krew install score
kubectl score my-app.yaml

# Docker
docker pull zegl/kube-score
docker run -v $(pwd):/project zegl/kube-score:latest score my-app/*.yaml

# 直接下载二进制
# 从 https://github.com/zegl/kube-score/releases 选择对应平台(含 macOS / Linux / Windows)
```

### 语法

```shell
kube-score <action> [flags] <文件|目录|-> ...
```

```shell
kube-score score    对清单评分(默认动作,可省略)
kube-score list     以 CSV 形式列出全部可用检查项及其 ID
kube-score version  查看版本
kube-score help     帮助
```

### 常用参数

```shell
-o, --output-format string     输出格式:human(默认)、json、ci、sarif
--output-version string        JSON / SARIF 输出的结构版本
--ignore-test string           忽略某个检查,按测试 ID,可重复
--enable-optional-test string  启用某个可选检查,可重复
--all-default-optional         启用全部「默认可选」的检查
--kubernetes-version string    判定废弃 apiVersion 时依据的 Kubernetes 版本,默认 v1.18
--min-replicas-deployment int  Deployment 最少副本数,默认 2
--min-replicas-hpa int         HPA 最少副本数,默认 2
--ignore-container-cpu-limit   不要求容器设置 CPU limit
--ignore-container-memory-limit 不要求容器设置内存 limit
--exit-one-on-warning          有 WARNING 也返回退出码 1
--disable-ignore-checks-annotations    忽略对象上的 kube-score/ignore 注解
--disable-optional-checks-annotations  忽略对象上的 kube-score/enable 注解
-v, --verbose                  详细输出,可叠加
```

### 检查项

用 `kube-score list` 可以打印完整的 CSV 列表。主要检查项(含是否需要手动开启):

```shell
# 资源与可靠性
container-resources                                   Pod 必须设置 requests 与 limits(默认开启)
container-resource-requests-equal-limits              requests 必须等于 limits(可选)
container-cpu-requests-equal-limits                   CPU 的 requests 等于 limits(可选)
container-memory-requests-equal-limits                内存的 requests 等于 limits(可选)
deployment-replicas                                   Deployment 副本数不少于阈值(默认 2)
horizontalpodautoscaler-replicas                      HPA 最少副本数(默认 2)
deployment-has-poddisruptionbudget                    Deployment 必须被 PDB 覆盖
statefulset-has-poddisruptionbudget                   StatefulSet 必须被 PDB 覆盖
poddisruptionbudget-has-policy                        PDB 必须指定 minAvailable 或 maxUnavailable
deployment-has-host-podantiaffinity                   Deployment 必须设置 podAntiAffinity
statefulset-has-host-podantiaffinity                  StatefulSet 必须设置 podAntiAffinity
pod-topology-spread-constraints                       Pod 拓扑分布约束
deployment-targeted-by-hpa-does-not-have-replicas-configured  HPA 托管时不应写死 replicas
deployment-strategy                                   被 Service 选中的 Deployment 应用 RollingUpdate
statefulset-has-servicename                           StatefulSet 必须有可用的 headless serviceName

# 探针
pod-probes                                           探针配置是否安全(如不指向未开放端口)
pod-probes-identical                                 就绪与存活探针不能完全一样

# 网络
pod-networkpolicy                                    每个 Pod 都应被 NetworkPolicy 覆盖
networkpolicy-targets-pod                            NetworkPolicy 至少要选中一个 Pod
service-targets-pod                                  Service 必须能选中 Pod
service-type                                         Service 不应使用 NodePort
ingress-targets-service                              Ingress 必须指向存在的 Service

# 安全上下文
container-security-context-user-group-id             必须设置合法的 UID / GID
container-security-context-privileged                不得使用特权容器
container-security-context-readonlyrootfilesystem    必须设置只读根文件系统
container-seccomp-profile                           必须配置 seccomp 策略(可选)

# 镜像与元数据
container-image-tag                                  必须使用明确的非 latest tag
container-image-pull-policy                          pullPolicy 应为 Always
container-ephemeral-storage-request-and-limit        必须设置临时存储的 requests 与 limits
container-ports-check                                容器端口检查(可选)
environment-variable-key-duplication                 环境变量键不得重复
label-values                                         标签值必须合法
stable-version                                       不得使用已废弃的 apiVersion
deployment-pod-selector-labels-match-template-metadata-labels  选择器标签与模板标签必须一致
statefulset-pod-selector-labels-match-template-metadata-labels 同上
cronjob-has-deadline                                 CronJob 必须配置 deadline
cronjob-restartpolicy                                CronJob 的 RestartPolicy 必须合法
horizontalpodautoscaler-has-target                   HPA 必须指向有效对象
```

### 常用操作

```shell
# 基础评分
kube-score score deployment.yaml

# 评分整个目录
kube-score score ./manifests/*.yaml

# 从标准输入读取
helm template ./chart | kube-score score -
kustomize build overlays/prod | kube-score score -

# 明确指定 Kubernetes 版本(重要,见「注意」第 1 条)
kube-score score --kubernetes-version v1.32 my-app.yaml

# 忽略某个检查
kube-score score --ignore-test container-image-pull-policy my-app.yaml

# 启用可选检查
kube-score score --enable-optional-test container-seccomp-profile my-app.yaml
kube-score score --all-default-optional my-app.yaml

# 放宽资源检查
kube-score score --ignore-container-cpu-limit my-app.yaml

# 警告也算失败
kube-score score --exit-one-on-warning my-app.yaml

# CI 紧凑输出
kube-score score --output-format ci my-app.yaml

# SARIF 输出,对接 GitHub Code Scanning
kube-score score --output-format sarif my-app.yaml > kube-score.sarif

# 列出全部检查项
kube-score list
```

### 对象级忽略与启用

```shell
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  annotations:
    # 忽略若干检查,逗号分隔,取值是测试 ID
    kube-score/ignore: service-type,container-image-pull-policy
    # 单独打开某个可选检查
    kube-score/enable: container-seccomp-profile
spec: {}
```

注解里的取值是 `kube-score list` 输出的测试 ID(如 `container-security-context-privileged`、`pod-networkpolicy`),不是检查项的中文描述。

### 退出码

```shell
0    没有 CRITICAL 级别的问题
1    存在 CRITICAL 级别的问题;使用 --exit-one-on-warning 时存在 WARNING 也会返回 1
```

### 注意

1. **`--kubernetes-version` 的默认值是 `v1.18`,写在源码里至今没改**。这直接影响 `stable-version` 这项检查的判定 —— 在 1.32 的集群上跑默认参数,那些在 1.22~1.26 之间被移除的 apiVersion 可能检查不出来。**CI 里必须显式指定**,如 `--kubernetes-version v1.32`。注意这个参数要带 `v` 前缀,和 kubeconform 的写法正好相反。

2. **默认只有 CRITICAL 会让流水线失败**。WARNING 不影响退出码。想严格拦截要加 `--exit-one-on-warning`;反过来,如果发现流水线「一直是绿的」,先确认是不是所有问题都只是 WARNING。

3. **忽略检查靠注解,而注解写错不会报错**。`kube-score/ignore` 的值是逗号分隔的测试 ID,拼错了只是静默不生效 —— 你以为忽略了,实际没有,或者反之。所有合法 ID 用 `kube-score list` 打印,建议在仓库里固定一份 ID 清单。

4. **可选检查默认关闭**。像 `container-seccomp-profile`、`container-resource-requests-equal-limits` 这类偏严格的项默认不跑,需要 `--enable-optional-test` 逐项打开或 `--all-default-optional` 全部打开。不知道有这回事的话,会误以为 kube-score「没检查 seccomp」。

5. **注解既能放宽也能收紧,方向要想清楚**。`kube-score/ignore` 是放宽,`kube-score/enable` 是收紧。如果团队可以随意加注解,那等于检查形同虚设 —— 需要在 CI 里用 `--disable-ignore-checks-annotations` 把忽略权收回流水线参数,或者至少对注解做 code review。

6. **`container-resources` 默认同时要求 CPU 与内存的 requests 和 limits**。很多团队不设置 CPU limit(避免 throttling),这时要用 `--ignore-container-cpu-limit` 明确关掉,而不是加一堆注解。同理内存对应 `--ignore-container-memory-limit`。

7. **`--output-format` 有四种:`human`、`json`、`ci`、`sarif`**。`ci` 是给流水线日志看的紧凑格式;`sarif` 可以接 GitHub Code Scanning 把问题直接标注到 PR 的代码行上,比贴日志好用得多。`--output-version` 用于 JSON/SARIF 结构的版本兼容,升级 kube-score 后消费端如果解析失败,先来看这个参数。

8. **它不渲染 Helm chart**。直接喂 chart 目录会把它当普通 YAML 解析,结果要么报错要么得出错误结论。正确做法是先 `helm template` 再管道给 `kube-score score -`。

9. **检查结果是「建议」不是「真理」**。比如 `deployment-has-poddisruptionbudget` 对有状态服务可能不适用,`service-type` 禁止 NodePort 在裸金属环境下也可能过严。官方定位就是「recommendations for improved reliability and security」,落地时应当按业务实际裁剪检查集,而不是无脑全开。

10. **它和 pluto 有重叠但不等价**。kube-score 的 `stable-version` 也会检查废弃 apiVersion,但判定依据是它自己内置的版本表,且受 `--kubernetes-version` 默认值 v1.18 的影响;pluto 在这一点上更专业(有独立的 target-versions 与替代品建议)。两者都跑不冲突,但**废弃 API 的权威判定建议以 pluto 为准**。

11. **发版节奏偏慢**。最近一个 release 是 v1.20.0(2025 年 4 月),但仓库仍在接受提交,并非停止维护。检查项的更新会滞后于 Kubernetes 的发布节奏,新版本 k8s 的特性(如新的调度字段)未必有对应检查。

### 相关命令

- `polaris` — 最佳实践体检与准入控制
- `kubeconform` — 按官方schema校验清单字段
- `pluto` — 检测废弃与移除的apiVersion
- `conftest` — 用rego做策略即代码检查
- `popeye` — 集群资源的只读体检
- `kubectl` — Kubernetes集群管理工具
- `helm` — Kubernetes包管理器

### 参考链接

- [kube-score GitHub 仓库](https://github.com/zegl/kube-score)
- [kube-score 检查项清单](https://github.com/zegl/kube-score/blob/master/README_CHECKS.md)
- [kube-score 官网](https://kube-score.com/)
- [Kubernetes 配置最佳实践](https://kubernetes.io/docs/concepts/configuration/overview/)
