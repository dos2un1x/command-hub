falco
===

云原生运行时安全检测工具,基于系统调用实时发现容器内的异常行为

## 补充说明

**Falco** 是 CNCF 毕业项目(2024 年 2 月毕业),云原生运行时安全检测的事实标准。它从内核获取系统调用数据流,实时匹配规则,发现容器、Pod 与主机上的异常行为:容器里被起了 shell、敏感文件被读取、权限被提升、出现反向连接等。

架构上分三层:

```shell
驱动(libs)     采集系统调用,有 modern eBPF 与内核模块两种实现
Falco 引擎     用规则匹配事件流
输出(outputs)  把告警送到 stdout、文件、HTTP、Syslog 等
```

在 Kubernetes 里 Falco 以 **DaemonSet** 方式部署,每个节点一份,否则看不到该节点上所有容器的系统调用。

驱动选型是部署时的第一个决策:

| 驱动 | 说明 | 内核要求 |
| --- | --- | --- |
| modern_ebpf | CO-RE 现代 eBPF 探针,单一二进制跨内核通用,无需现场编译、无需特权 initContainer | 5.8+,推荐 5.10+ |
| kmod | 传统内核模块,需要编译或预编译包并在宿主机加载 | 任意内核,但必须特权 |
| ebpf | 旧版 eBPF 探针,已于 0.44.0 移除 | — |

**内核模块路径需要完整的特权容器**(`privileged: true`),而 modern eBPF 只需要一组 capability。托管 Kubernetes(EKS/GKE/AKS)与 Talos 这类锁定型节点系统上,内核模块基本不可用,应直接使用 `modern_ebpf`。

### 安装

```shell
helm repo add falcosecurity https://falcosecurity.github.io/charts
helm repo update

# 基础安装:驱动由 chart 自动选择(auto,优先 modern eBPF)
helm install falco falcosecurity/falco \
  --namespace falco --create-namespace

# 显式指定现代 eBPF 驱动
helm install falco falcosecurity/falco \
  --namespace falco --create-namespace \
  --set driver.kind=modern_ebpf

# 内核模块方式(需要特权)
helm install falco falcosecurity/falco \
  --namespace falco --create-namespace \
  --set driver.kind=kmod
```

如果命名空间启用了 Pod Security Admission,需要放开限制:

```shell
kubectl label namespace falco pod-security.kubernetes.io/enforce=privileged --overwrite
```

安装后确认驱动是否正常加载:

```shell
kubectl get pods -n falco
kubectl logs -n falco -l app.kubernetes.io/name=falco | head -30
# 日志里会打印 libs 版本与选中的驱动,例如 "modern_bpf" 或 "kmod"
```

### 规则

Falco 规则是 YAML,由三种元素组成:

```shell
rule     一条检测规则:条件 + 输出 + 优先级
macro    可复用的条件片段
list     可复用的列表,如 shell 二进制文件名
```

一条规则的结构:

```shell
- rule: 容器内启动 Shell
  desc: 容器内出现交互式 shell,通常意味着入侵或调试行为
  condition: >
    spawned_process and container
    and proc.name in (shell_binaries)
  output: >
    容器内启动了 shell (user=%user.name container=%container.name
    image=%container.image.repository command=%proc.cmdline)
  priority: WARNING
  tags: [container, shell]
```

优先级由高到低:

```shell
EMERGENCY > ALERT > CRITICAL > ERROR > WARNING > NOTICE > INFORMATIONAL > DEBUG
```

### 注入自定义规则

用 chart values 承载自定义规则,是最容易维护的方式:

```shell
# custom-rules.yaml(chart values 文件)
customRules:
  my-rules.yaml: |-
    - rule: 容器内启动 Shell
      desc: 容器内出现交互式 shell
      condition: >
        spawned_process and container
        and proc.name in (shell_binaries)
      output: >
        容器内启动了 shell (user=%user.name container=%container.name
        command=%proc.cmdline)
      priority: WARNING
      tags: [container, shell]

falco:
  rules_file:
    - /etc/falco/falco_rules.yaml
    - /etc/falco/falco_rules.local.yaml
    - /etc/falco/rules.d
```

```shell
helm upgrade --install falco falcosecurity/falco -n falco -f custom-rules.yaml

# 语法检查:加载失败时 Falco 会拒绝启动并打印具体行号
kubectl logs -n falco -l app.kubernetes.io/name=falco | grep -i error
```

用 `exceptions` 给规则放开白名单,比直接关掉整条规则更精细:

```shell
- rule: 容器内启动 Shell
  exceptions:
    - name: 允许运维镜像
      fields: [container.image.repository]
      comps: [in]
      values:
        - [registry.example.com/tools/debug]
```

### 规则与插件的自动更新

chart 默认部署两个 `falcoctl` 容器:

```shell
falcoctl-artifact-install   initContainer,启动前安装规则与插件
falcoctl-artifact-follow    sidecar,周期性检查并拉取新版本
```

```shell
# 查看当前 pod 里的容器
kubectl get pod -n falco -l app.kubernetes.io/name=falco \
  -o jsonpath='{.items[0].spec.containers[*].name}'

# 固定规则版本、关闭自动跟随
helm upgrade falco falcosecurity/falco -n falco \
  --set falcoctl.artifact.follow.enabled=false
```

### 常用操作

```shell
# 版本与驱动信息
kubectl exec -n falco ds/falco -- falco --version

# 列出已加载的规则、宏、字段与配置
kubectl exec -n falco ds/falco -- falco --list
kubectl exec -n falco ds/falco -- falco --list=rules
kubectl exec -n falco ds/falco -- falco --list=fields
kubectl exec -n falco ds/falco -- falco --list=macros

# 打印当前生效的配置
kubectl exec -n falco ds/falco -- falco --print-config

# 打印统计信息(丢事件、驱动状态),排障时最有用
kubectl exec -n falco ds/falco -- falco --stats-interval 5000

# 告警日志
kubectl logs -n falco -l app.kubernetes.io/name=falco -f | grep -i warning
```

### 告警转发

Falco 自身只输出告警,生产里通常交给 **falcosidekick** 转发到 Slack、Elasticsearch、Loki、PagerDuty 等:

```shell
helm install falcosidekick falcosecurity/falcosidekick -n falco

# 让 Falco 把告警发到 sidekick
helm upgrade falco falcosecurity/falco -n falco \
  --set falco.json_output=true \
  --set falco.http_output.enabled=true \
  --set falco.http_output.url=http://falcosidekick:2801/
```

### 注意

1. **驱动不是可选项**。Falco 依赖内核提供系统调用数据,`modern_ebpf` 要求内核 5.8+(部分关键 hook 需要 5.10+),老内核(如 RHEL 8 的 4.18)只能退回 `kmod`,而 `kmod` 必须在宿主机加载内核模块,在托管 Kubernetes 上往往直接失败。**部署前先确认节点内核版本**。
2. **必须特权或具备特定 capability**。`modern_ebpf` 至少需要 `CAP_SYS_BPF`、`CAP_SYS_PERFMON`、`CAP_SYS_RESOURCE`、`CAP_SYS_PTRACE`;`kmod` 只能整块 `privileged: true`。命名空间若启用了 Pod Security Admission,要打上 `pod-security.kubernetes.io/enforce=privileged` 标签,否则 Pod 会被拒绝创建。
3. **旧版 eBPF 探针已在 0.44.0 移除**,同一版本还移除了 gRPC 输出与 gVisor 引擎支持。从 0.43 及更早版本升级时,`driver.kind=ebpf`、`grpc_output` 相关配置会直接失效,升级前必须清理。
4. **chart 的 `driver.kind` 默认是 `auto`**,`auto` 会优先选择 modern eBPF,失败才回退内核模块。**回退是静默发生的**,想确认实际用了哪个驱动只能看启动日志里的 libs 行,或 `falco --print-config`。
5. **Falco 的默认规则误报率不低**。「容器内启动 Shell」「读取 /etc/shadow」这类规则在任何装了运维工具的镜像上都会持续刷告警。上线流程应是先跑一周只观察、统计高频规则,再用 `exceptions` 或 `customRules` 收敛,**不要直接关掉整条规则**。
6. **规则文件的加载顺序决定覆盖关系**。同一条 rule 在后面的文件里重新定义会覆盖前面的,`append: true` 才是追加。把自定义规则放在 `falco_rules.local.yaml` 之后是官方推荐的做法。
7. **`falcoctl` 会自动更新规则**。sidecar 默认定时拉取 `falco-rules` 新版本,于是规则会在无人干预的情况下变化,表现为「昨天好好的,今天开始报警」。需要可复现的环境时应关闭 follow 或锁定 artifact 版本。
8. **Falco 是检测工具,不是阻断工具**。它只产生告警,不阻止系统调用、不杀进程。要真正响应需要自己接处置逻辑(常见做法是 falcosidekick 触发 webhook,再配合 NetworkPolicy 隔离或删除 Pod)。
9. **丢事件是运行中的正常现象**。系统调用量远超处理能力时 Falco 会丢事件,用 `--stats-interval` 能看到丢弃计数;持续大量丢弃说明需要缩小监控范围或提高资源配额,否则会漏掉关键告警。
10. **告警内容含大量敏感信息**(完整命令行、文件路径、部分环境变量)。转发到第三方日志平台前要评估合规要求,`proc.cmdline` 这类字段往往包含凭据。
11. **不可变节点系统只能用 modern eBPF**。Talos、Flatcar 等系统不允许加载内核模块;反之,部分发行版内核没有开启 BTF,`modern_ebpf` 也会加载失败 —— 两头都卡住的场景需要换节点镜像。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kube-bench` — CIS 安全基线检查,与运行时检测互补
- `networkpolicy` — 检测到异常后的隔离手段
- `pod` — 运行时行为的载体
- `prometheus` — 承接 Falco 指标与告警的平台
- `loki` — 集中存放 Falco 告警日志

### 参考链接

- [Falco 官方文档](https://falco.org/docs/)
- [规则语法](https://falco.org/docs/concepts/rules/)
- [内核事件源与驱动选型](https://falco.org/docs/concepts/event-sources/kernel/)
- [在 Kubernetes 上部署](https://falco.org/docs/setup/kubernetes/)
- [Falco Helm Chart](https://github.com/falcosecurity/charts/tree/master/charts/falco)
