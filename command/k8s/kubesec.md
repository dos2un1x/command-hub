kubesec
===

给Kubernetes清单打安全风险分的静态分析工具

## 补充说明

**kubesec命令** 是 ControlPlane 开源的 Kubernetes 资源安全风险分析工具,定位很窄也很清晰:**读一份 Kubernetes 清单,给一个数字分数,并逐条列出加分项与扣分项**。

它和 kube-score 的区别在于输出形态:`kube-score` 输出的是 CRITICAL / WARNING / OK 三档分级清单;`kubesec` 把它压成**一个整数分数**,正分代表「做对了」,负分代表「做错了」。

在这批工具里的分工:

```shell
kube-bench    CIS 基线检查,面向节点与集群配置
kubeaudit     容器安全控制项审计(已归档)
kube-linter   清单 lint,规则以 template/check 组织
kubesec       清单安全评分,输出单一分数 —— 本页
kubescape     框架合规扫描(NSA/CISA、MITRE)
kube-score    可靠性与安全最佳实践分级评分
```

**关于时效性:** 仓库未归档,master 分支到 2026-06 仍有功能性提交(「扫描指定规则」「表格输出格式」等都是 2026-06 合入的),属于**低强度但真实存在**的维护。但**最近一次正式发布是 v2.14.2(2024-11-22)**,此后约 22 个月没有新 release —— 这意味着文档里描述的若干新能力**尚未进入你下载到的二进制**。

**v1 API 已废弃。** 官方 README 顶部明确标注「🚨 v1 API is deprecated 🚨」。网上大量旧文章里那种 `kubesec -s`、`-o json`、`--keys` 的用法(以及向 `v1.kubesec.io` 提交)已经过时,当前 CLI 是 **v2** 的 `kubesec scan <文件>` 形式。

### 安装

```shell
# 容器镜像(推荐,内置 schema,可离线)
docker pull docker.io/kubesec/kubesec:v2
docker run -i kubesec/kubesec:v2 scan /dev/stdin < deployment.yaml

# Go 1.16+ 直接安装
go install github.com/controlplaneio/kubesec/v2@latest

# 其他方式:从 Releases 页下载 Linux / macOS / Windows 二进制
# https://github.com/controlplaneio/kubesec/releases
```

配套还有两个**独立仓库**的项目:

```shell
kubectl-kubesec        作为 kubectl 插件调用(注意:默认上传到 kubesec.io,见「注意」)
kubesec-webhook        Validating Admission Webhook,在准入阶段拦截
```

### 语法

```shell
kubesec scan <文件>           扫描清单并输出结果
kubesec print-rules          打印全部规则及其分值
kubesec http [[ip:]port]      以 HTTP 服务模式运行,接收 POST /scan
kubesec version              查看版本
```

`scan` 的参数:

```shell
--debug               输出调试日志
--absolute-path       报告里使用文件的绝对路径
-f, --format          输出格式:json(默认) / table / template
-t, --template        配合 --format template 使用的模板(文件或内联字符串)
-r, --rules           只扫描指定规则,逗号分隔(仅 master,未发布)
-o, --output          把结果写到指定文件 —— 这是文件路径,不是格式选择器
--kubernetes-version  指定用于 schema 校验的 Kubernetes 版本,如 1.25.3
--schema-location     schema 来源目录或地址(离线环境用)
--exit-code           失败时的退出码,默认 2
```

### 基本用法

```shell
kubesec scan deployment.yaml              # 扫描单个文件
kubesec scan deployment.yaml -o result.json   # 输出到文件

# 从标准输入读取(JSON 或 YAML 都可以)
cat file.json | kubesec scan -

# 扫描渲染后的 Helm chart
helm template -f values.yaml ./chart | kubesec scan /dev/stdin

# 扫描多个文档(用 --- 分隔)
{ cat a.yml; echo "---"; cat b.yml; } | kubesec scan -
```

### 评分模型

打分逻辑很直接:分数从 `0` 开始,**规则命中就加减**。规则分两类:

```shell
负分规则     命中就扣分,记入 scoring.critical
             例:privileged(-30)、CapSysAdmin(-30)、HostNetwork(-9)、
                 AllowPrivilegeEscalation(-7)、SecretsAsEnvironmentVariables(-5)

正分规则     做对了才加分,记入 scoring.passed
             例:ServiceAccountName(+3)、ApparmorAny(+3)、RunAsNonRoot(+1)、
                 ReadOnlyRootFilesystem(+1)、CapDropAll(+1)、RequestsCPU(+1)
```

第三条规则最容易看错:

```shell
正分规则「没做对」(规则没有匹配到任何容器)时,分数不变,
但会记入 scoring.advise —— 它只是提示你「这里本可以加分」,
不是已经拿到的分,也不是扣分。
```

所以三个数组的含义是:

```shell
scoring.critical   触发了的负分规则(真正的扣分项)
scoring.passed     已满足的正分规则(真正拿到的分)
scoring.advise     未满足的正分规则(0 分,纯建议)
```

顶层 `message` 按分数给出:`Score < 0` 时是 `Failed with a score of N points`,`Score >= 0` 时是 `Passed with a score of N points`;规则的 `kinds` 不覆盖该资源类型时会给出「This resource kind is not supported by kubesec」。

多数规则支持 `Pod`、`Deployment`、`StatefulSet`、`DaemonSet`;`SecretsAsEnvironmentVariables` 还覆盖 `ReplicaSet`、`Job`、`CronJob`;`BindingsToSystemAnonymous` 作用于 `RoleBinding`、`ClusterRoleBinding`;两条 volumeClaim 规则只作用于 `StatefulSet`。

### 输出格式

JSON(默认)是数组,每个元素对应一个被扫描的对象:

```shell
[
  {
    "object": "Pod/security-context-demo.default",
    "valid": true,
    "fileName": "deployment.yaml",
    "message": "Failed with a score of -30 points",
    "score": -30,
    "scoring": {
      "critical": [
        {
          "id": "CapSysAdmin",
          "selector": "containers[] .securityContext .capabilities .add == SYS_ADMIN",
          "reason": "CAP_SYS_ADMIN is the most privileged capability and should always be avoided",
          "points": -30
        }
      ],
      "passed": [
        {
          "id": "ReadOnlyRootFilesystem",
          "selector": "containers[] .securityContext .readOnlyRootFilesystem == true",
          "reason": "An immutable root filesystem can prevent malicious binaries",
          "points": 1
        }
      ],
      "advise": [
        {
          "id": "RunAsNonRoot",
          "selector": "containers[] .securityContext .runAsNonRoot == true",
          "reason": "Force the running image to run as a non-root user to ensure least privilege",
          "points": 1
        }
      ]
    }
  }
]
```

字段含义:`object` 是资源标识,格式为 `Kind/名称.命名空间`(命名空间默认 `default`);`fileName` 是来源文件名;`valid` 表示清单是否符合 Kubernetes schema;`message` 是人可读的总结;`score` 是最终得分;`scoring` 下三个数组见上。

三个数组都是 `omitempty` —— **为空时字段直接不出现**。只看到 `critical` 而没有 `passed` 不代表它没有这个字段,只是那一类没有条目。

`kubesec print-rules` 可以打印完整规则集:

```shell
[
  {
    "id": "AllowPrivilegeEscalation",
    "selector": "containers[] .securityContext .allowPrivilegeEscalation == true",
    "reason": "Ensure a non-root process can not gain more privileges",
    "kinds": ["Pod", "Deployment", "StatefulSet", "DaemonSet"],
    "points": -7,
    "advise": 0
  }
]
```

### 退出码与打分门槛

**最有价值的机制是它的退出码。** `kubesec scan` 在**任意一个对象的分数 `<= 0`** 时以 `--exit-code`(默认 **2**)退出;所有对象分数都 `> 0` 才返回 0。

```shell
kubesec scan deployment.yaml || echo "有对象得分不达标"
```

于是有一个反直觉的细节:**分数恰好为 0 时,`message` 会打印 "Passed with a score of 0 points",但进程以 2 退出。** 文字说「通过」,退出码说「没通过」,以退出码为准。

官方 README 里给的 `jq` 判断只是一个**示例**,不是工具自身的门槛:

```shell
# 自定义更严的门槛:要求分数大于 10
kubesec scan deployment.yaml | jq --exit-status '.score > 10'
```

放进流水线时,两种思路都可以:

```shell
# 思路一:直接用工具默认门槛(score <= 0 即失败)
kubesec scan deployment.yaml

# 思路二:叠加自定义门槛
kubesec scan deployment.yaml | jq --exit-status '.score > 10' || exit 1
```

门槛值要**由团队自己定并写进文档**,不同团队常用的起点是 0(不出现非正数分)或 10。无论选哪个,都要注意它是相对的:**同一个门槛在只有 Pod 的清单和带完整 securityContext 的 Deployment 上含义并不相同**。

### schema 校验与离线环境

kubesec 借 **kubeconform** 做清单的 schema 校验。校验不通过时 `valid: false`,规则评估会被跳过。

```shell
kubesec scan ./pod.yaml                       # 使用上游最新 schema

# 指定 schema 版本(格式 x.y.z,不带 v 前缀)
kubesec scan ./pod.yaml --kubernetes-version 1.25.3

# 气隙环境:走内网 HTTP 服务 / 直接读本地目录
kubesec scan ./deployment.yaml --kubernetes-version 1.25.3 \
  --schema-location https://schema.internal.example.com
kubesec scan ./deployment.yaml --kubernetes-version 1.25.3 \
  --schema-location /opt/schemas
```

官方镜像内置了 schema。若要在容器里改 schema 来源,需要设置环境变量 `K8S_SCHEMA_VER`(内置 schema 的版本)与 `SCHEMA_LOCATION`(schema 存放位置)。

### HTTP 服务模式

自建服务是把扫描能力留在内网的正确方式:

```shell
kubesec http 8080 &                     # 本地起服务
curl -sSX POST --data-binary @deployment.yaml http://localhost:8080/scan
kill %                                  # 用完停掉
```

```shell
# 用容器起同样的服务
docker run -d -p 8080:8080 kubesec/kubesec:v2 http 8080
```

`http` 子命令还有 `-k/--keypath`(in-toto 链签名密钥)、`--kubernetes-version`、`--schema-location`。监听地址可用环境变量 **`KUBESEC_ADDR`** 指定;旧的 `PORT` 变量已废弃,使用时会打警告。

### 注意

1. **CLI 不会把你的清单上传到任何地方**。`kubesec scan` 是**纯本地**分析:读文件、在进程内跑规则、把报告写到 stdout 或 `-o` 指定的文件,扫描路径上没有任何 HTTP 客户端。
2. **但 `kubectl-kubesec` 插件默认会上传**。它的 README 原文写着「By default the plugin will send scan requests to the hosted version of kubesec.io.」这是真正会泄露清单的那条路径 —— 在 CI 里用这个插件,工作负载的完整 spec(环境变量、hostPath、镜像名)会离开你的网络。要用就得加 `--url http://localhost:8080` 指向自建的 `kubesec http` 服务。
3. **公开托管服务明确不建议提交敏感内容**。README 原话是「**Do not submit sensitive YAML to this public service.**」,并说明该服务只是「good faith best effort basis」—— 随时可能不可用,也没有任何可用性承诺。生产团队的清单不要往那儿发。
4. **`-o` 是输出「文件路径」,不是格式选择器**。`kubesec scan x.yaml -o json` 会**写出一个名叫 `json` 的文件**,而不是输出 JSON。选格式要用 `-f/--format`。这组参数名和很多工具的习惯相反,是最容易写错的一个。
5. **`-s/--score`、`--keys`、`--http`、`--insecure` 在 v2 里都不存在**。阈值判断靠 `jq` 或工具的退出码;`--http` 是子命令不是标志位;`-k/--keypath` 是 `http` 子命令上给 in-toto 签名用的密钥路径,名字相近但用途完全不同。
6. **文档里的 `--rules` 与 `--format table` 尚未发布**。这两个能力是 2026-06 合入 master 的,而最后的 release 停在 2024-11 的 v2.14.2 —— **从 Releases 页下载的二进制里没有它们**,尽管 README 已经写了。想用只能自己从源码构建。
7. **分数 0 会打印「Passed」但以 2 退出**。文案和退出码不一致,写脚本时以退出码为准,不要用 `grep Passed` 判断。
8. **分数是启发式的,不是漏洞结论**。它只根据清单里有没有写某些字段来加减分,完全不看镜像里装了什么。一个把安全上下文配满、但跑着严重过期镜像的 Pod 可以拿高分;它做不了任何 CVE 检测。
9. **「字段没写」往往不等于「被扣分」**。许多负分规则只在字段显式为 `true` 时触发(如 `privileged`、`hostNetwork`)。字段缺失时负分规则不动,分数因此比直觉偏高 —— 真正该看的反而是 `advise` 里那串「本可以加分却没加」的条目。
10. **门槛必须自己定,而且默认门槛只保证「分数为正」**。工具自身的判断是 `score > 0`,这意味着得分 1 也算通过。要更严的标准就得在流水线里自己接 `jq` 或用模板输出做判断。
11. **规则集更新缓慢**。最近一次正式发布是 2024-11,此后约 22 个月没有新 release。新版本 Kubernetes 引入的安全相关字段它可能完全不认识(不会报错,只是不加分也不扣分)。把它当辅助信号,别当权威基线。
12. **`--format template` 需要自己维护模板**。模板随字段变化而失效时不会有明确报错,只会渲染出空白。
13. **气隙环境用容器镜像比用二进制省事**。镜像里内置了 schema;直接跑二进制的话默认会去上游拉 schema,断网时会因校验失败而报错,看起来像「清单不合法」,实际是网络问题。
14. **它只处理「单个清单对象」,不做跨对象关联**。比如「命名空间没有默认拒绝的 NetworkPolicy」这类需要看整体的问题,kubesec 覆盖不到 —— 那是 kubeaudit 的 `netpols` 或 kube-linter 的 netpol 类检查负责的领域。
15. **注意同名项目**。`kubeseal`(Bitnami Sealed Secrets 的 CLI)做的是密钥加密,与 kubesec 无关;也没有 Bitnami 出品的 kubesec 镜像,官方镜像只有 `docker.io/kubesec/kubesec:v2`。

### 相关命令

- `kube-score` — 可靠性与安全的分级评分,与 kubesec 定位最接近
- `kube-linter` — 清单 lint,规则更细
- `kubeaudit` — 容器安全控制项审计(已归档)
- `kubeconform` — kubesec 内部使用的 schema 校验工具
- `conftest` — 自定义合规规则
- `trivy` — 漏洞与配置扫描

### 参考链接

- [kubesec GitHub 仓库](https://github.com/controlplaneio/kubesec)
- [kubesec.io 在线服务](https://kubesec.io)
- [kubesec-webhook 准入控制器](https://github.com/controlplaneio/kubesec-webhook)
- [kubectl-kubesec 插件](https://github.com/controlplaneio/kubectl-kubesec)
