kubeaudit
===

按安全控制项审计Kubernetes集群与清单的检查工具

## 补充说明

> **本项目已于 2024-10-30 被 Shopify 归档(Public archive),不再维护。** README 顶部的废弃声明写明「planned for deprecation by October 2024」,并明确推荐改用 **kube-bench**;更麻烦的是,**每次执行审计时它都会往 stderr 打印这段废弃提示**,包括「`kubernetes.io` override 标签将被弃用,今后要用 `kubeaudit.io`」的第二条警告。最后一个版本是 **v0.22.2(2024-08-21)**,已约 25 个月没有新发布,不会再有安全补丁。新项目不建议引入;已有流水线可以继续跑存量版本,但要清楚它不会再更新检查项,也不会跟进新的 Kubernetes 安全基线。**替代方案:kube-bench(CIS 基线)、kubescape(NSA/CISA 与 MITRE 框架)、trivy config / kube-linter(清单扫描)。**

**kubeaudit命令** 是 Shopify 开源的容器安全配置审计工具(Go 写的 CLI,也可作为 Go 包使用),出发点是回答一个问题:**「我要部署的这个工作负载,有没有把该关的危险开关都关掉?」**

它检查的是容器安全里最经典的那批项:

```shell
不要以 root 运行              nonroot
根文件系统只读                rootfs
丢弃危险 capability,不新增    capabilities
不允许提权                    privesc
不允许 privileged             privileged
不要打开 hostPID/hostIPC/hostNetwork  hostns
不要挂敏感 hostPath            mounts
不允许访问元数据服务(IMDS)    asat(自动挂载默认 ServiceAccount Token)
命名空间要有默认拒绝的 NetworkPolicy  netpols
镜像必须有 tag 且符合预期版本   image
必须设置 resource limits       limits
要有 AppArmor / Seccomp        apparmor / seccomp
不要用废弃的 apiVersion        deprecatedapis
```

在这批工具里的分工:

```shell
kube-bench   CIS Kubernetes Benchmark 基线,读节点与进程配置
kubescape    NSA/CISA、MITRE 等框架合规,自带集群内 Operator
kube-linter  清单 lint,规则以 template/check 组织
kubeaudit    容器安全控制项审计,可对清单也可对集群 —— 本页(已归档)
kubesec      清单安全评分,输出一个分数
trivy        漏洞 + 配置 + 密钥扫描
```

### 安装

```shell
# Homebrew
brew install kubeaudit

# 下载官方二进制
# 见 https://github.com/Shopify/kubeaudit/releases

# 从源码构建(需要较新的 Go)
go get -v github.com/Shopify/kubeaudit

# 作为 kubectl 插件使用:把二进制改名为 kubectl-audit 放进 PATH
mv kubeaudit kubectl-audit
kubectl audit all
```

**注意:官方已不再往 Docker Hub 推镜像**(原因是 Docker Hub 取消了免费团队组织)。当前可用的镜像是 GitHub Container Registry 上的 **`ghcr.io/shopify/kubeaudit:v0.22.2`**(`latest`、`v0.22` 等标签也都停在归档那一刻);Docker Hub 上的 `shopify/kubeaudit` 是旧镜像,README 说它们「may stop being available at any time」,不要依赖。

### 三种运行模式

kubeaudit 的「模式」由参数决定,不是子命令:

```shell
清单模式    kubeaudit all -f /path/to/manifest.yml        # -f 也接受 `-` 从标准输入读取
本地模式    kubeaudit all --kubeconfig ~/.kube/config --context my_cluster
            用本机 kubeconfig 连集群,审计集群里已有的资源
集群模式    kubeaudit all
            检测到自己在集群内的容器中运行时,自动审计所在集群的全部资源
```

最小可运行的环境要求:**Kubernetes >= 1.19**。

### 语法

```shell
kubeaudit [command]
```

```shell
kubeaudit all        运行全部审计项(或用配置文件指定的一部分)
kubeaudit autofix    自动修复安全问题 —— 仅清单模式,见下
kubeaudit version    查看版本
```

单个审计项也可以作为命令直接执行:

```shell
kubeaudit apparmor       容器是否缺少 AppArmor 配置
kubeaudit asat           是否自动挂载了默认 ServiceAccount Token
kubeaudit capabilities   是否丢弃推荐 capability / 新增危险 capability
kubeaudit deprecatedapis 是否使用了废弃的 API 版本
kubeaudit hostns         是否开启 hostPID / hostIPC / hostNetwork
kubeaudit image          镜像是否使用了预期版本或缺少 tag
kubeaudit limits         CPU / 内存限额是否缺失或超限
kubeaudit mounts         是否挂载了敏感宿主路径
kubeaudit netpols        命名空间是否缺少默认拒绝的 NetworkPolicy
kubeaudit nonroot        容器是否以 root 运行
kubeaudit privesc        是否允许特权提升
kubeaudit privileged     是否以 privileged 运行
kubeaudit rootfs         根文件系统是否可写
kubeaudit seccomp        是否缺少 Seccomp 配置
```

### 全局参数

```shell
-p, --format           输出格式:sarif / pretty(默认) / logrus / json
--kubeconfig           本地模式下的 kubeconfig 路径,默认 $HOME/.kube/config
-c, --context          kubeconfig 中的上下文名
-f, --manifest         要审计的 YAML 路径,`-` 表示从标准输入读取;仅清单模式
-n, --namespace        只审计指定命名空间;清单模式不支持
-g, --includegenerated 连同生成的资源一起扫描(如 Deployment 生成的 Pod)
-m, --minseverity      最低报告级别:error / warning / info,默认 info
-e, --exitcode         出现 error 级别结果时的退出码,默认 2
--no-color             关闭彩色输出
```

`--includegenerated` 的用途比较特别:默认只审计「你声明的对象」,加上它才会把 Deployment 派生出来的 Pod 也纳入,适合排查孤儿资源(owner 已被删除但 Pod 还在)。另外 `-p` 是 `--format` 的短参数,README 的参数表里没写,以源码为准。

### 常用操作

```shell
# 审计单个清单文件
kubeaudit all -f deployment.yaml

# 从标准输入审计(如渲染后的 Helm 输出)
helm template ./chart | kubeaudit all -f -

# 只跑一个审计项 / 审计整个集群
kubeaudit nonroot -f deployment.yaml
kubeaudit all --kubeconfig ~/.kube/config

# 只看 error,不看 warning / info
kubeaudit all -f deployment.yaml -m error

# 输出 JSON 供流水线处理;SARIF 供代码扫描平台归档
kubeaudit all -f deployment.yaml --format json
kubeaudit all -f deployment.yaml --format sarif > kubeaudit.sarif

# error 级别的结果让流水线失败(默认退出码已是 2)
kubeaudit all -f deployment.yaml -m error -e 1
```

### 自动修复:autofix

`autofix` 会把 ERROR 级别的检查项对应的字段直接补进清单。例如给这个几乎空白的 Deployment:

```shell
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
      - name: myContainer
```

执行 `kubeaudit autofix -f manifest.yml` 后会补出:

```shell
      containers:
      - name: myContainer
        resources: {}
        securityContext:
          allowPrivilegeEscalation: false
          capabilities:
            drop:
            - ALL
          privileged: false
          readOnlyRootFilesystem: true
          runAsNonRoot: true
      automountServiceAccountToken: false
      securityContext:
        seccompProfile:
          type: RuntimeDefault
```

参数只有两个:

```shell
-o, --outfile     把修复结果写到新文件,而不是覆盖源文件
-k, --kconfig     指定 kubeaudit 配置文件,按自定义规则修复
```

**注意把参数名记准:是 `--outfile` 不是 `--output`。** README 正文里多处写成「use the `-o/--output` flag」,但源码里注册的名字是 `outfile`,只有 `docs/autofix.md` 与源码一致。按 README 敲 `--output` 会报未知参数。

### 配置文件

配置文件解决两件事:**只启用部分审计项**,以及**给审计项传参**。

```shell
enabledAuditors:
  # 未显式写出的审计项默认启用;写 false 即关闭
  apparmor: false
  asat: false
  capabilities: true
  deprecatedapis: true
  hostns: true
  image: true
  limits: true
  mounts: true
  netpols: true
  nonroot: true
  privesc: true
  privileged: true
  rootfs: true
  seccomp: true

auditors:
  capabilities:
    allowAddList: ['AUDIT_WRITE', 'CHOWN']   # 加进白名单,避免误报
  deprecatedapis:
    currentVersion: '1.22'
    targetedVersion: '1.25'
  image:
    # 镜像 tag 与它不一致时报 warning
    image: 'myimage:mytag'
  limits:
    cpu: '750m'
    memory: '500m'
```

```shell
kubeaudit all -k kubeaudit-config.yml -f deployment.yaml
kubeaudit autofix -k kubeaudit-config.yml -f deployment.yaml -o fixed.yaml
```

**只有 `all` 与 `autofix` 支持配置文件**,单独跑某个审计项时不读配置。参数与配置文件同时给出时,**参数优先**。

### 用标签豁免误报

对确认可接受的项,可以用 override 标签把它从 `error` 降级为 `info`,结果名会带上 `Allowed` 后缀。标签值是豁免理由,会出现在 `info` 结果的 `OverrideReason` 字段里。

```shell
# 容器级:只豁免某个容器
container.kubeaudit.io/[容器名].[override 标识]
# Pod 级:豁免该 Pod 内所有容器
kubeaudit.io/[override 标识]
```

```shell
metadata:
  labels:
    kubeaudit.io/asat: "该工作负载需要访问 IMDS,已评估接受"
```

### 注意

1. **本项目已归档,不会再更新**。最后的 v0.22.2 发布于 2024-08-21,README 的废弃声明推荐改用 kube-bench。继续使用意味着检查项停留在 2024 年的认知水平,新出现的风险点不会被覆盖。
2. **`autofix` 只作用于清单文件,不会修改集群**。官方文档明确写着「`autofix` can only be used in manifest mode」,命令实现也是直接打开 `-f` 指定的文件。很多人以为它像「一键加固集群」,其实不是 —— 想加固集群要自己把修好的清单 apply 回去。
3. **`autofix` 不给 `-o` 时会直接截断并覆盖源清单文件**。实现里是 `os.OpenFile(rootConfig.manifest, os.O_WRONLY|os.O_TRUNC, 0755)` —— 原地覆写,**没有 `--dry-run`,没有确认提示,也不会留备份**。在版本控制之外的文件上跑它等于丢掉原始内容。养成先 `git diff` 的习惯,或始终带 `-o`。
4. **`autofix` 只修 `error` 级别的结果**。帮助文本写的是修「all ERROR results generated by 'kubeaudit all'」—— warning 与 info 不会被处理。所以「autofix 跑过了」不等于「这份清单已经加固完毕」,修复后应当再跑一遍 `kubeaudit all` 复核。
5. **`-f -`(标准输入)与 `autofix` 不能组合**。从 stdin 读取时 manifest 路径为空,而 autofix 恰恰要用这个路径回写,结果是写入失败。想修就先用 `-f` 落到一个真实文件上。
6. **`image` 审计项必须给 `-i`/`--image` 才有意义**。不指定期望镜像时它只能报 `ImageTagMissing` 这类通用警告,无法判断版本是否符合预期。`all` 命令同样接受这个参数,可以 `kubeaudit all -f x.yaml --image gcr.io/example/app:1.7` 一把跑完。
7. **`autofix` 补出来的安全上下文可能让应用直接起不来**。它会给容器加上 `runAsNonRoot: true`、`readOnlyRootFilesystem: true`、`capabilities.drop: [ALL]`。原始镜像若以 root 运行、或需要写根文件系统,修复后 Pod 会 `CreateContainerConfigError` 或启动即崩。自动修复的结果必须逐个工作负载验证,不能直接批量 apply 到生产。
8. **没有 `audit` / `fix` 这两个子命令,也没有 `--auditors` 参数**。当前版本只有 `all`、`autofix`、`version` 加 14 个审计项命令;「audit 模式 / fix 模式」是更早版本(v0.9 时代)的说法。选哪些审计项只有两条路:直接跑单个审计项子命令,或用配置文件里的 `enabledAuditors`。照旧博客敲 `kubeaudit audit --auditors nonroot` 会直接报错。
9. **审计项名字有一批容易记错的**。资源限额归 `limits`(不存在叫 `resources` 的项);镜像缺 tag 归 `image`(不存在 `imageTag`);挂载检查叫 `mounts`,老资料里的 `mountdocker` 是拼写错误。准确的 14 项请以本页上方列表或 `kubeaudit all --help` 为准。
10. **Override 标签正在从 `kubernetes.io` 迁到 `kubeaudit.io`**。README 说明使用未注册的 `kubernetes.io` 注解形式的 override 标签「will be deprecated」,今后要统一用 `kubeaudit.io`。这段警告在每次运行时也会打到 stderr。存量清单里的老标签需要逐步替换,否则某次升级后会集体失效、误报重新出现。
11. **`-e/--exitcode` 的默认值是 2 而不是 0**。这意味着只要有 `error` 级别结果,命令就以 2 退出 —— 放进 CI 天然会失败,不需要额外加参数。反过来,如果你希望它「只报告不阻塞」,必须显式 `-e 0`。
12. **清单模式与集群模式的检查范围不同**。`-f` 只审计你给的那个文件;集群模式审计的是**已存在的对象**,由控制器动态生成的资源默认不在内(`-g`/`--includegenerated` 才会包含)。同一套清单,两种模式给出的结果可能对不上,对比时要认清这一点。
13. **`-n/--namespace` 在清单模式下无效**。官方文档写明 not currently supported in manifest mode,想按命名空间过滤只能自己切分文件。
14. **集群模式需要一批读权限**。它至少要能 `list` Pod、PodTemplate、ReplicationController、Namespace、ServiceAccount、DaemonSet、StatefulSet、Deployment、CronJob 与 NetworkPolicy。别用 `cluster-admin` 跑常规审计,给它单建一个只读 ClusterRole。
15. **文档里的集群部署示例已经过时**。`docs/cluster.md` 中的 Job 示例仍引用 `shopify/kubeaudit:v0.11` 和 `rbac.authorization.k8s.io/v1beta1` 这类早就移除的 API,直接照抄会失败。要放进集群跑请自己改写镜像地址与 apiVersion。
16. **退役项目的替代路径要提前规划**。归档不等于立刻停用,但要把它从「长期治理工具」降级为「过渡期工具」:新流水线直接用 kube-linter 或 trivy config 卡清单,集群侧的持续审计交给 kubescape operator 或 trivy-operator。

### 相关命令

- `kube-bench` — kubeaudit 官方推荐的替代品,CIS 基线检查
- `kubescape` — NSA/CISA 与 MITRE 框架合规扫描
- `kube-linter` — 清单 lint 工具
- `kubesec` — 清单安全评分
- `kubectl` — Kubernetes集群管理工具

### 参考链接

- [kubeaudit GitHub 仓库(已归档)](https://github.com/Shopify/kubeaudit)
- [kubeaudit autofix 文档](https://github.com/Shopify/kubeaudit/blob/main/docs/autofix.md)
- [kubeaudit 各审计项文档](https://github.com/Shopify/kubeaudit/tree/main/docs/auditors)
- [kube-bench(官方推荐的替代品)](https://github.com/aquasecurity/kube-bench)
