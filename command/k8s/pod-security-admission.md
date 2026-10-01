pod-security-admission
===

Kubernetes内置的Pod安全准入控制,按命名空间强制安全基线

## 补充说明

**Pod Security Admission(PSA)** 是 Kubernetes **内置**的准入控制器,只需给命名空间打一个标签,就能把 **Pod Security Standards(PSS)** 施加到该空间内新建的 Pod 上。它从 v1.23 起默认启用(beta),**v1.25 起 GA**。

PSA 是 **PodSecurityPolicy(PSP)** 的官方替代品。PSP 在 v1.21 被弃用、**v1.25 被彻底移除**,新集群上 `kubectl get psp` 只会报 `the server doesn't have a resource type "psp"`。如果升级前没有迁移,PSP 的约束会**静默消失** —— Pod 照常运行,但保护伞没了。

它的设计取舍很明确:**不做自定义策略**。PSA 只提供三档固定基线,靠标签声明,不引入新的 API 对象,也不需要 RBAC 绑定(这正是 PSP 最大的坑:权限模型绕、配错反而静默失效)。需要镜像仓库白名单、必填资源限制这类细粒度规则,应交给 Kyverno、OPA Gatekeeper 等策略引擎,PSA 负责兜底。

三档**级别(level)**,限制逐级叠加:

| 级别 | 说明 |
| --- | --- |
| `privileged` | 完全不受限,等同于不启用 |
| `baseline` | 阻止已知提权手段,兼容绝大多数常规工作负载 |
| `restricted` | 当前 Pod 加固最佳实践,显著收紧 |

`baseline` 的核心是「不要设置危险字段」:`hostNetwork`/`hostPID`/`hostIPC` 必须为空或 `false`,`privileged` 必须为空或 `false`,禁止 `hostPath` 卷,`capabilities.add` 只允许一份固定白名单(不含 `SYS_ADMIN`、`NET_ADMIN` 等),`seccompProfile.type` 不得显式为 `Unconfined`。

`restricted` 在 `baseline` 之上追加四条硬性要求,且对 **所有** `containers`、`initContainers`、`ephemeralContainers` 逐一检查:

```shell
allowPrivilegeEscalation  必须为 false
runAsNonRoot              必须为 true
capabilities.drop         必须包含 ALL(只能再加回 NET_BIND_SERVICE)
seccompProfile.type       必须为 RuntimeDefault 或 Localhost(不能留空)
```

三种**模式(mode)**,彼此完全独立,可以给同一个命名空间配不同的级别:

| 模式 | 行为 |
| --- | --- |
| `enforce` | 违规直接**拒绝**创建请求 |
| `audit` | 放行,但在审计日志里给事件打上 `pod-security.kubernetes.io/audit-violations` 注解 |
| `warn` | 放行,但向发起者返回 `Warning` 提示 |

### 语法

```shell
kubectl label --overwrite ns <命名空间> pod-security.kubernetes.io/enforce=<级别>
kubectl label --overwrite ns <命名空间> pod-security.kubernetes.io/audit=<级别>
kubectl label --overwrite ns <命名空间> pod-security.kubernetes.io/warn=<级别>
kubectl label --overwrite ns <命名空间> pod-security.kubernetes.io/enforce-version=<版本>
```

标签键固定为 `pod-security.kubernetes.io/<模式>`,值是级别;`<模式>-version` 用来把该模式的策略定义**钉在**某个 Kubernetes 小版本(如 `v1.37`)或 `latest`。

### 命名空间清单示例

```shell
apiVersion: v1
kind: Namespace
metadata:
  name: my-baseline-namespace
  labels:
    # 当前实际拦截的级别
    pod-security.kubernetes.io/enforce: baseline
    pod-security.kubernetes.io/enforce-version: v1.37
    # audit/warn 指向「下一步要达到的级别」,用来预先观察影响
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: v1.37
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: v1.37
```

这个「enforce 落后一档、audit/warn 领先一档」的写法是官方推荐姿势:拦截范围保持保守,同时持续收集「如果切到 restricted 会打掉哪些工作负载」。

### 上线顺序

从零到 enforce 最稳的路径是四步走,不要一步到位:

```shell
# 1. 全集群先只开 audit + warn,不设 enforce
kubectl label --overwrite ns --all \
  pod-security.kubernetes.io/audit=baseline \
  pod-security.kubernetes.io/warn=baseline

# 2. 找出还没被评估过的命名空间(不含 enforce 标签的)
kubectl get namespaces --selector='!pod-security.kubernetes.io/enforce'

# 3. 切换前先用服务端 dry-run 预演,它会照常执行检查并返回警告
kubectl label --dry-run=server --overwrite ns --all \
  pod-security.kubernetes.io/enforce=baseline

# 4. 逐个命名空间落地,并钉住策略版本
kubectl label --overwrite ns my-namespace \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/enforce-version=v1.37
```

### 违规信息解读

被 `enforce` 拦截时,报错会逐条列出原因,直接照着改即可:

```shell
Error from server (Forbidden): error when creating "pod.yaml": pods "nginx" is forbidden:
violates PodSecurity "restricted:latest": allowPrivilegeEscalation != false
(container "nginx" must set securityContext.allowPrivilegeEscalation=false),
unrestricted capabilities (container "nginx" must set securityContext.capabilities.drop=["ALL"]),
runAsNonRoot != true (pod or container "nginx" must set securityContext.runAsNonRoot=true),
seccompProfile (pod or container "nginx" must set securityContext.seccompProfile.type
to "RuntimeDefault" or "Localhost")
```

`warn` 模式下同样的文本会以 `Warning:` 开头出现在 `kubectl` 输出里,请求本身成功。

常见违规与对应修法:

```shell
allowPrivilegeEscalation != false  →  容器加 securityContext.allowPrivilegeEscalation: false
unrestricted capabilities          →  容器加 capabilities.drop: ["ALL"]
runAsNonRoot != true               →  Pod 或容器加 runAsNonRoot: true
seccompProfile                     →  加 seccompProfile.type: RuntimeDefault
privileged                         →  去掉 privileged: true,按需 add 单个 capability
hostPath volumes                   →  改用 PVC、emptyDir 或 projected 卷
hostNetwork / hostPID / hostIPC    →  改为 false,或整体迁到 privileged 命名空间
```

### 豁免与集群级默认值

标签只能配级别,**豁免名单和默认级别**必须写在 apiserver 的 `AdmissionConfiguration` 文件里,通过 `--admission-control-config-file` 传入:

```shell
apiVersion: apiserver.config.k8s.io/v1
kind: AdmissionConfiguration
plugins:
- name: PodSecurity
  configuration:
    apiVersion: pod-security.admission.config.k8s.io/v1   # v1.25+;1.23/1.24 用 v1beta1
    kind: PodSecurityConfiguration
    defaults:                       # 命名空间没打标签时生效
      enforce: "privileged"
      enforce-version: "latest"
      audit: "privileged"
      audit-version: "latest"
      warn: "privileged"
      warn-version: "latest"
    exemptions:
      usernames: []                 # 已认证用户名,豁免
      runtimeClasses: []            # 运行时类名,豁免
      namespaces: []                # 命名空间,整体豁免
```

默认文件里三档默认值都是 `privileged`,即**没打标签的命名空间不受任何约束**。要全集群兜底,应把 `defaults.enforce` 改成 `baseline`。

### 可观测性

PSA 会向 apiserver 暴露三个指标,适合做「违规趋势」看板:

```shell
pod_security_evaluations_total   实际执行的策略评估次数(不含被豁免的)
pod_security_exemptions_total    命中豁免的请求数
pod_security_errors_total        评估出错次数(出错时可能回退到最新 restricted 配置)
```

### 注意

1. **`enforce` 不作用于工作负载对象,只作用于 Pod**。创建 Deployment 时不会被拦,是它的控制器建 Pod 时才失败 —— 表现为 Deployment 反复报 `ReplicaFailure`,而不是 `kubectl apply` 报错。`audit` 和 `warn` 则**会**作用于 Deployment/Job 等工作负载,方便提前发现。
2. **三种模式互不干扰,但级别可以不同**。只配 `enforce: baseline` 而不配 `audit`/`warn`,并不会产生任何警告;配了 `warn: restricted` 也不代表拦截变严了。上生产前务必确认三者的级别是你想要的。
3. **`restricted` 的默认值全是「不满足即违规」**。`runAsNonRoot` 不写、`capabilities` 整块不写、`seccompProfile` 不写,全部算违规 —— 不存在「不写就走运行时默认」的宽容。
4. **`runAsNonRoot: true` 只检查有效用户,不检查镜像里的 `USER`**。`runAsUser: 0` 会直接被拒;kubelet 还会额外拒绝启动「镜像 `USER` 解析为 root」的容器。
5. **PSA 不会驱逐已运行的 Pod**。改标签只影响新建的 Pod;改 `enforce` 级别或版本时,apiserver 会**重新评估**该命名空间内已有的 Pod 并把违规以警告形式返回,但不会杀进程。已有工作负载需要自行滚动重建才会合规。
6. **豁免 `usernames` 通常拦不住真实流量**。绝大多数 Pod 由控制器创建,豁免某个终端用户只在他**直接**建 Pod 时生效;真正要豁免的是 `system:serviceaccount:kube-system:replicaset-controller` 这类控制器身份,但那等于豁免了所有能建 Deployment 的人,极危险。
7. **默认级别是 `privileged`**。不写 `AdmissionConfiguration` 又不打标签的命名空间,等于完全没有保护,别以为「装了 PSA 就安全了」。
8. **`baseline` 并非完全无害**。它仍允许 `hostPort`、`hostPath` 之外的多数常规配置,以及 `runAsUser: 0`,只是堵住了已知提权路径;要防容器内提权必须上 `restricted`。
9. **`*-version` 不写就等于 `latest`**,策略会随集群升级自动跟进。生产环境建议显式钉住版本,否则一次小版本升级可能突然引入新的检查项,把原本能跑的工作负载拦在门外。
10. **PSA 不做任何字段改写**。PSP 时代的部分「mutating」行为(如自动补 `runAsNonRoot`)在 PSA 中不存在,不满足就是拒绝,必须自己把字段补齐。
11. **特权组件要单独放行**。CNI、监控 Agent、日志采集等需要 `hostNetwork`/`privileged` 的组件,应放进独立的 `privileged` 命名空间,并通过 `exemptions.namespaces` 或标签显式豁免,而不是为了它们把整个业务空间的 enforce 降档。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `securitycontext` — Pod 与容器安全上下文
- `namespace` — 命名空间管理
- `rbac` — 基于角色的访问控制
- `kube-apiserver` — 准入控制器与 apiserver 参数

### 参考链接

- [Pod Security Admission 官方文档](https://kubernetes.io/docs/concepts/security/pod-security-admission/)
- [Pod Security Standards 策略定义](https://kubernetes.io/docs/concepts/security/pod-security-standards/)
- [使用命名空间标签实施 Pod 安全标准](https://kubernetes.io/docs/tasks/configure-pod-container/enforce-standards-namespace-labels/)
- [通过配置内置准入控制器实施 Pod 安全标准](https://kubernetes.io/docs/tasks/configure-pod-container/enforce-standards-admission-controller/)
- [从 PodSecurityPolicy 迁移到内置 PodSecurity 准入控制器](https://kubernetes.io/docs/tasks/configure-pod-container/migrate-from-psp/)
