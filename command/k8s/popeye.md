popeye
===

只读扫描集群中已部署资源的健康与配置问题

## 补充说明

**popeye命令** 是 derailed(k9s 的作者)开源的集群资源体检工具,定位是「Kubernetes Cluster resource sanitizer」—— 扫描集群里**已经部署的**资源,找出僵尸配置、错误引用、资源浪费与潜在故障点,最后给一个 0-100 的集群得分。

最重要的一条特性写在官方 README 里:

> Popeye is a readonly tool, it does not alter any of your Kubernetes resources in any way!

**它完全只读,不会修改集群里的任何对象**。

第二条同样关键:**它扫的是「已部署的现状」,不是磁盘上的 YAML**。官方原话是 "based on what's deployed and not what's sitting on disk"。

这两点决定了它的位置:

```shell
kubeconform  字段是否合法(schema)          —— 扫磁盘上的 YAML
pluto        apiVersion 是否废弃/移除       —— 两者都能扫
kube-score   最佳实践评分                   —— 扫磁盘上的 YAML
polaris      最佳实践体检 + 准入控制         —— 两者都能
popeye       集群现状体检                   —— 只扫集群,只读
```

也就是说,**popeye 不能用于 CI 阶段拦截清单错误** —— 那时资源还没进集群。它的正确用法是:定期巡检线上集群、升级前做一次体检、或者接到告警后快速定位「哪个命名空间有问题」。

它检查的资源类型很全,涵盖 node、namespace、pod、service、deployment、statefulset、daemonset、job、cronjob、configmap、secret、serviceaccount、RBAC、PV/PVC、HPA、PDB、Ingress、NetworkPolicy、Gateway API 等近三十类。

### 安装

```shell
# Homebrew(macOS / Linux)
brew install derailed/popeye/popeye
popeye version

# krew(kubectl 插件形式)
kubectl krew install popeye
kubectl popeye

# Go 安装
go install github.com/derailed/popeye@latest

# 容器镜像
docker run --rm -it -v $HOME/.kube:/root/.kube \
  quay.io/derailed/popeye --context foo -n bar

# 直接下载二进制
# 从 https://github.com/derailed/popeye/releases 选择对应平台(Linux / macOS / Windows)
```

### 语法

```shell
popeye [flags]
```

popeye 是单命令工具,没有子命令,直接跑就是全量扫描。

### 常用参数

```shell
# 范围
-n, --namespace string     只扫描指定命名空间
-A, --all-namespaces       扫描全部命名空间
-s, --sections strings     只扫描指定资源类型,如 -s po,svc,deploy
--context string           指定 kube context
--cluster string           指定 kubeconfig 中的 cluster
--user string              指定 kubeconfig 中的用户
--kubeconfig string        kubeconfig 路径

# 输出
-o, --out string           输出格式,默认 standard
--save                     把报告落盘(必须与 --output-file 同时使用)
--output-file string       报告文件名
--s3-bucket string         报告上传到 S3(与 --save 互斥)
--s3-region string         S3 区域
--s3-endpoint string       S3 兼容端点
--push-gtwy-url string     Prometheus Pushgateway 地址
--push-gtwy-user string    Pushgateway 用户名
--push-gtwy-password string Pushgateway 密码

# 行为
-l, --lint string          日志级别门槛:ok(默认)、info、warn、error
--min-score int            集群得分低于该值时返回非零退出码,默认 50
--force-exit-zero          无论是否有问题都返回 0
-f, --file string          spinach YAML 配置文件
--over-allocs              额外检查 CPU / 内存的过度分配
--cluster-name string      在集群内运行时标识集群名
-c, --clear                运行前清屏
-v, --log-level int        日志级别 0|1|2|3|4,对应 disable|info|warn|error|debug
--logs string              日志文件位置,设为 none 表示输出到 stdout
```

### 输出格式

```shell
standard    默认。带图标与颜色的完整报告
jurassic    纯文本,无图标无颜色(适合在不支持 ANSI 的环境里看)
yaml        YAML 结构化输出
json        JSON 结构化输出
html        HTML 报告
junit       JUnit XML,可对接 CI 测试报告
prometheus  Prometheus 指标(必须配合 --push-gtwy-url)
score       只输出一个 0-100 的分数
```

### 常用操作

```shell
# 扫描整个集群
popeye

# 只扫某个命名空间
popeye -n prod

# 显式全命名空间
popeye -A

# 只扫 Pod、Service、Deployment
popeye -n prod -s po,svc,dp

# 指定 context
popeye --context prod-cluster

# JSON 输出并落盘
popeye -o json --save --output-file /tmp/popeye.json

# 只取分数
popeye -o score

# 输出到 Prometheus Pushgateway
popeye -o prometheus --push-gtwy-url http://localhost:9091

# 用配置文件定制(排除项、资源阈值等)
popeye -f spinach.yaml

# 在 CronJob 里跑:必须加 --force-exit-zero
popeye --force-exit-zero -o junit --save --output-file /reports/popeye.xml

# 调高日志级别便于排错
popeye -n prod --logs /tmp/popeye.log -v4

# 减少输出噪音,只保留 warn 以上
popeye -l warn
```

### spinach 配置文件

`-f/--file` 指向的 YAML 会被 JSON Schema 校验,格式不符直接报错退出:

```shell
popeye:
  # 排除某些命名空间或资源
  excludes:
    kube-system:
      - dp/aws-node
      - po/coredns.*
    ".*":
      - cm/kube-root-ca.crt

  # 资源水位阈值
  resources:
    node:
      limits:
        cpu: 80
        memory: 80
    pod:
      restarts: 5

  # 允许的镜像仓库
  registries:
    - docker.io
    - registry.example.com

  # 检查项开关
  checks:
    "dp.zero_replicas": ignore
```

**排除项只能写在配置文件里,没有对应的命令行参数。**

### 退出码

```shell
0    没有 lint 错误,且集群得分不低于 --min-score
1    存在 lint 错误,或集群得分低于 --min-score(默认 50)
```

判定逻辑(来自源码)可以概括为:

```shell
若加了 --force-exit-zero            → 直接返回 0
否则若 errCount > 0                 → 返回 1
否则若 score < --min-score(默认 50) → 返回 1
其余情况                            → 返回 0
```

### 注意

1. **只读且只看现状,所以它不能替代流水线检查**。popeye 不会改集群里的任何东西,也不会读你 Git 仓库里的 YAML。想拦住「即将提交的错误清单」,必须用 kubeconform、kube-score、pluto 这些静态工具;popeye 管的是「已经跑起来的东西有没有问题」。

2. **默认退出码在 50 分就翻脸,比想象中敏感**。`--min-score` 默认值是 **50**,只要集群得分低于 50,即便一条 lint 错误都没有,popeye 也返回 1。在 CronJob 里跑,这会让 Pod 进 Error 状态并反复重试 —— 官方 README 明确建议此时加 `--force-exit-zero`。

3. **`-l/--lint` 是「日志级别门槛」而不是「只检查这个级别」**。取值 `ok`(默认)、`info`、`warn`、`error`,调高只会把低级别的问题**隐藏掉**,而不是筛选。用 `-l error` 之后看到的报告会「很干净」,但那是过滤的结果,不是集群真的没问题。

4. **`-s/--sections` 写了不存在的名字不会报错**。section 的取值不做校验(源码里直接透传),拼错的资源名不会提示,只会静默地什么都不扫。常用简写:node、ns、po、svc、sa、sec、cm、dp、sts、ds、pv、pvc、hpa、pdb、cr、crb、ro、rb、ing、np、psp、cj、job、gwc、gw、gwr。

5. **配置文件参数是 `-f/--file`,不是 `--spinach`**。很多老教程里写成 `--spinach`,在当前版本会直接报未知参数。另外 `-f` 指向的文件会先过一遍 JSON Schema 校验,写错字段名会明确报 `validation failed`,比想象中严格。

6. **排除项(`excludes`)只能写在配置文件里**。命令行没有 `--exclude` 之类的参数。排除规则支持正则(`po/coredns.*`)和命名空间通配(`".*"`),写得太宽会把真正的问题一起吞掉,建议排除项也纳入 code review。

7. **`--save` 与 `--output-file` 必须配对出现,且与 `--s3-bucket` 互斥**。源码里三条校验:`--save` 必须配合 `--output-file`;`--save` 不能与 `--s3-bucket` 同用;`-o prometheus` 必须配合 `--push-gtwy-url`。触发任何一条都会直接报错退出。

8. **需要集群范围的读权限**。popeye 要 list/get 几乎所有资源类型,权限不足时表现为大量报错而不是「自动跳过」,报告会很难看。用只读的 ClusterRole 授权即可,不要图省事给 cluster-admin。

9. **扫描结果依赖 API Server 的响应,不能脱离集群离线跑**。断网、apiserver 抖动、RBAC 受限都会直接反映成报告里的错误项,排查问题时先确认是不是采集侧的问题,再判断资源本身的问题。

10. **它和 kube-score 的检查维度不同**。kube-score 看的是「这份 YAML 写得规不规范」(有没有 PDB、探针、securityContext),popeye 看的是「线上这份资源有没有出事」(副本数为 0、Service 选不中 Pod、PVC 没绑定、镜像仓库不被信任、重启次数超标、资源分配过度)。**两者不能互相替代**,一个在提交前把关,一个在上线后巡检。

11. **发版节奏偏慢,但并未停止维护**。最近一个 release 是 v0.22.1(2025 年初),不过仓库在 2025 年底仍有提交,项目并非归档状态。检查项对最新 Kubernetes 版本特性的跟进会滞后,新特性(如 Gateway API 的新字段)不一定有对应检查。

12. **报告里的「得分」不是绝对值,不要横向比较不同集群或不同版本之间的分数**。得分受扫描范围(`-n` 与 `-A` 结果差异很大)、检查项开关、阈值配置影响。要跟踪趋势,必须固定参数与版本,并记录每次运行的配置。

### 相关命令

- `k9s` — 同作者的终端Kubernetes管理UI
- `kube-score` — 清单的可靠性与安全评分
- `polaris` — 最佳实践体检与准入控制
- `kubeconform` — 按官方schema校验清单字段
- `kubectl` — Kubernetes集群管理工具
- `kube-state-metrics` — 集群对象状态指标导出
- `descheduler` — 重新平衡集群中的Pod分布

### 参考链接

- [popeye GitHub 仓库](https://github.com/derailed/popeye)
- [popeye 官网](https://popeyecli.io)
- [popeye 配置文件参考](https://github.com/derailed/popeye/blob/master/docs/configuration.md)
- [k9s GitHub 仓库](https://github.com/derailed/k9s)
