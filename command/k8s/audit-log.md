audit-log
===

API Server审计日志,记录谁在何时对集群做了什么

## 补充说明

**审计日志(Audit Log)** 是 kube-apiserver 按时间顺序输出的安全相关事件流,回答七个问题:发生了什么、何时、谁发起、作用于什么对象、在哪观察到、从哪发起、结果如何。用户、控制器、控制平面自身的请求都会留下记录,事后溯源、合规取证、异常检测都依赖它。

事件的生命周期全在 apiserver 内部:**每个请求在每个执行阶段产生一个审计事件**,事件先经**策略(policy)**过滤和裁剪,再由**后端(backend)**持久化。

```shell
Policy(决定记什么)  →  Event(结构化记录)  →  Backend(写到哪)
```

两个内置后端:

| 后端 | 落点 | 关键标志 |
| --- | --- | --- |
| Log | 本地文件 | `--audit-log-path` |
| Webhook | 外部 HTTP 服务 | `--audit-webhook-config-file` |

两者可以同时启用。**不设 `--audit-log-path` 且不设 webhook 配置文件,就等于没有审计**;只设 `--audit-policy-file` 不会产生任何输出。

### 四个审计级别

策略中的每条规则都要指定级别,决定记录多少内容:

| 级别 | 记录范围 |
| --- | --- |
| `None` | 不记录匹配的事件 |
| `Metadata` | 只记元数据(用户、时间戳、资源、动词、结果),**不含请求体与响应体** |
| `Request` | 元数据 + 请求体,不含响应体;对非资源型请求无效 |
| `RequestResponse` | 元数据 + 请求体 + 响应体;对非资源型请求无效 |

### 四个执行阶段

每个事件带一个 `stage` 标记,`omitStages` 可按阶段过滤:

```shell
RequestReceived   审计处理器收到请求时立即产生,尚未进入处理链
ResponseStarted   响应头已发出但响应体未发完,仅长连接请求(如 watch)才有
ResponseComplete  响应体发送完毕
Panic             处理过程中发生 panic 时产生
```

### 策略文件结构

```shell
apiVersion: audit.k8s.io/v1     # 必填;v1beta1/v1alpha1 已移除
kind: Policy
omitStages:
  - "RequestReceived"           # 常见的降噪手段,避免每个请求记两条
rules:
  # 规则自上而下匹配,命中第一条即定级,不再往下看
  - level: RequestResponse
    resources:
    - group: ""
      resources: ["pods"]
```

一条规则的可用匹配字段:

```shell
level            必填,None / Metadata / Request / RequestResponse
users            发起者用户名
userGroups       发起者所属组
verbs            动词,如 get、list、create、update、patch、delete、watch
resources        资源匹配,含 group / resources / resourceNames 三个子字段
namespaces       命名空间名(空字符串 "" 表示匹配非命名空间级资源)
nonResourceURLs  非资源型 URL,支持 * 通配,如 "/healthz"、"/version"
omitStages       本条规则要跳过的阶段
```

### 策略文件示例

```shell
apiVersion: audit.k8s.io/v1
kind: Policy
omitStages:
  - "RequestReceived"
rules:
  # 1. Secret 与 ConfigMap 的读取只记元数据,避免凭据进入日志
  - level: Metadata
    resources:
    - group: ""
      resources: ["secrets", "configmaps"]
  # 2. 所有写操作记录请求体,便于追溯改了什么
  - level: Request
    verbs: ["create", "update", "patch", "delete", "deletecollection"]
  # 3. kube-proxy 的 watch 噪音直接丢弃
  - level: None
    users: ["system:kube-proxy"]
    verbs: ["watch"]
    resources:
    - group: ""
      resources: ["endpoints", "services"]
  # 4. 健康检查等非资源型请求不记
  - level: None
    userGroups: ["system:authenticated"]
    nonResourceURLs:
    - "/healthz*"
    - "/version"
    - "/metrics"
  # 5. 兜底规则:其余请求记元数据
  - level: Metadata
```

**规则顺序至关重要**:匹配是顺序进行的,第一条命中的规则决定级别。兜底规则必须放在最后,否则它会把前面所有精细规则都吃掉。

### 在 kubeadm 集群中启用

kubeadm 部署的 apiserver 是静态 Pod,改 `/etc/kubernetes/manifests/kube-apiserver.yaml` 即可。三步缺一不可:

```shell
# 1. 准备策略文件(宿主机路径)
sudo mkdir -p /etc/kubernetes/audit
sudo vi /etc/kubernetes/audit/policy.yaml

# 2. 备份清单后追加启动参数
sudo cp /etc/kubernetes/manifests/kube-apiserver.yaml /root/kube-apiserver.yaml.bak
sudo vi /etc/kubernetes/manifests/kube-apiserver.yaml
```

在 `spec.containers[0].command` 中追加:

```shell
- --audit-policy-file=/etc/kubernetes/audit/policy.yaml
- --audit-log-path=/var/log/kubernetes/audit/audit.log
- --audit-log-maxage=30
- --audit-log-maxbackup=10
- --audit-log-maxsize=100
```

在 `volumeMounts` 与 `volumes` 中挂载宿主目录(**这一步最容易漏**):

```shell
# container 的 volumeMounts
- mountPath: /etc/kubernetes/audit
  name: audit-policy
  readOnly: true
- mountPath: /var/log/kubernetes/audit
  name: audit-log
  readOnly: false

# pod 的 volumes
- name: audit-policy
  hostPath:
    path: /etc/kubernetes/audit
    type: DirectoryOrCreate
- name: audit-log
  hostPath:
    path: /var/log/kubernetes/audit
    type: DirectoryOrCreate
```

```shell
# 3. 保存后 kubelet 会自动重建静态 Pod,观察是否正常
kubectl get pods -n kube-system -l component=kube-apiserver -w
sudo tail -f /var/log/kubernetes/audit/audit.log

# 起不来就回滚
sudo cp /root/kube-apiserver.yaml.bak /etc/kubernetes/manifests/kube-apiserver.yaml
```

### 日志后端参数

```shell
--audit-log-path=/var/log/kubernetes/audit/audit.log   # "-" 表示写标准输出
--audit-log-format=json                                # json(默认) / legacy
--audit-log-mode=blocking                              # blocking(默认) / batch / blocking-strict
--audit-log-maxage=30                                  # 按文件名时间戳保留天数,默认 366
--audit-log-maxbackup=10                               # 保留的旧文件个数,默认 100
--audit-log-maxsize=100                                # 单个文件多少 MB 后轮转,默认 100
--audit-log-compress                                   # 轮转文件用 gzip 压缩
--audit-log-batch-buffer-size=10000                    # batch 模式的缓冲通道大小
--audit-log-batch-max-size=1                           # batch 模式的批次条数上限
--audit-log-batch-max-wait=1s                          # batch 模式的最长等待
--audit-log-truncate-enabled                           # 截断超限事件
--audit-log-truncate-max-event-size=102400             # 单事件上限,超了先删请求/响应体
--audit-log-truncate-max-batch-size=10485760           # 单批上限
```

三种模式的差异值得留意:`blocking` 会阻塞请求直到事件写入;`batch` 缓冲后异步写,吞吐高但 apiserver 崩溃时可能丢事件;`blocking-strict` 在 `blocking` 基础上,**若写入失败则整个请求失败**。

### Webhook 后端

Webhook 后端把事件 POST 到外部服务,适合集中采集(如转发到 SIEM):

```shell
--audit-webhook-config-file=/etc/kubernetes/audit/webhook.yaml
--audit-webhook-mode=batch              # batch(默认) / blocking / blocking-strict
--audit-webhook-initial-backoff=10s     # 首次失败后的重试间隔
--audit-webhook-batch-max-size=400
--audit-webhook-batch-max-wait=30s
--audit-webhook-batch-throttle-enable=true
--audit-webhook-batch-throttle-qps=10
--audit-webhook-batch-throttle-burst=15
--audit-webhook-version=audit.k8s.io/v1
```

配置文件是 kubeconfig 格式,指向接收审计事件的 HTTP 端点。

### 查看与采集

```shell
# 实时观察谁在做什么
sudo tail -f /var/log/kubernetes/audit/audit.log | jq -c \
  '{time:.requestReceivedTimestamp, user:.user.username, verb:.verb, res:.objectRef.resource}'

# 筛选特定用户的写操作
sudo cat /var/log/kubernetes/audit/audit.log | jq -r \
  'select(.verb=="create" or .verb=="delete") | "\(.requestReceivedTimestamp) \(.user.username) \(.verb) \(.objectRef.resource)/\(.objectRef.name)"'

# 找被拒绝的请求(403 集中出现通常意味着权限排查或扫描行为)
sudo cat /var/log/kubernetes/audit/audit.log | jq -r \
  'select(.responseStatus.code==403) | "\(.user.username) \(.verb) \(.objectRef.resource)"' | sort | uniq -c | sort -rn

# 找直接操作 etcd 或读取 Secret 的高危行为
sudo cat /var/log/kubernetes/audit/audit.log | jq -r \
  'select(.objectRef.resource=="secrets" and .verb=="get") | "\(.requestReceivedTimestamp) \(.user.username) \(.objectRef.namespace)/\(.objectRef.name)"'
```

日志文件落在节点本地,不会被 `kubectl logs` 看到,也不会自动进日志系统 —— 生产环境应交给 fluent-bit、Fluentd、Filebeat 等采集器送走,并设置独立的磁盘分区。

### 注意

1. **只配 `--audit-policy-file` 不会产生任何日志**。必须同时配置后端(`--audit-log-path` 或 `--audit-webhook-config-file`),否则事件算完就被丢弃。
2. **审计日志会显著增加 apiserver 的内存占用**。每个请求的审计上下文都要驻留内存直到事件写出,`RequestResponse` 级别在对象大的场景(比如整个 ConfigMap 的响应体)下尤其明显。
3. **`RequestResponse` 会把 Secret 内容原样写进日志**。Secret 的 create/update 请求体、get 的响应体都是明文(Base64),审计日志文件因此变成了高价值凭据库,必须当作敏感数据保护 —— 对 secrets/configmaps 固定使用 `Metadata` 级别。
4. **策略文件在 apiserver 启动时读取,改完必须重启才生效**。在 kubeadm 集群里就是改完静态 Pod 清单等 kubelet 重建,改文件本身不会触发热加载。
5. **忽略 `omitStages` 会让事件量翻倍**。默认每个请求会在 `RequestReceived` 与 `ResponseComplete` 两个阶段各产生一条事件,只关心结果时应当 `omitStages: ["RequestReceived"]`。
6. **规则顺序决定结果,兜底规则放错位置等于策略失效**。匹配到第一条就停止,`level: None` 的规则若写在前面会把后续所有规则屏蔽掉。
7. **一个 `rules` 为空的策略是非法的**,apiserver 会拒绝启动并报策略解析错误。至少要有一条规则。
8. **日志量足以压垮 apiserver 和磁盘**。中等规模集群在 `Request` 级别下每天可产生数十 GB;`--audit-log-path` 应指向独立磁盘,并配合 `maxsize`/`maxbackup`/`maxage` 与外部采集双重保险,否则磁盘写满会连带 apiserver 一起挂掉。
9. **`blocking` 模式会把磁盘 IO 压力传导到请求延迟上**。审计写入变慢时,所有 API 请求一起变慢;`blocking-strict` 更激进,写不进去就直接让请求失败。写入慢的存储上建议改用 `batch` 并接受少量丢失。
10. **审计记录的是「收到的请求」,不等于「操作成功」**。判断结果要看事件里的 `responseStatus.code`,只看 `verb` 会误判。
11. **webhook 后端失败时事件会被丢弃**。`batch` 模式重试若干次后即放弃,不会阻塞 apiserver,因此不能把审计日志当作唯一的事后取证来源。
12. **托管集群通常不让你改这些参数**。EKS、GKE、AKS 的控制平面由云厂商托管,审计日志需通过云平台自带的日志服务开启,本地无 `kube-apiserver.yaml` 可改。
13. **`resourceNames` 是精确匹配,不支持通配**。想排除一整类敏感对象名,只能靠列举或改用 `nonResourceURLs`/`namespaces` 等维度。
14. **子资源要单独列出**。规则里写 `pods` 不会匹配 `pods/log`、`pods/exec`,而 `pods/exec` 恰恰是横向移动的高危入口,必须显式加进规则。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kube-apiserver` — 承载审计功能的组件与其参数
- `kube-bench` — CIS 基线中对审计配置的检查项
- `fluent-bit` — 轻量日志采集,常用于搬运审计日志
- `fluentd` — 日志采集与转发
- `rbac` — 与审计日志配合判断「这个操作本是否该被允许」

### 参考链接

- [审计官方文档](https://kubernetes.io/docs/tasks/debug/debug-cluster/audit/)
- [审计策略 API 参考(audit.k8s.io/v1)](https://kubernetes.io/docs/reference/config-api/apiserver-audit.v1/)
- [kube-apiserver 审计相关参数](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-apiserver/)
- [CIS Kubernetes Benchmark 中的审计要求](https://www.cisecurity.org/benchmark/kubernetes/)
