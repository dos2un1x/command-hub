fluent-bit
===

轻量级日志与指标采集器,以DaemonSet形态采集容器日志

## 补充说明

**Fluent Bit** 是用 C 语言编写的轻量级日志与指标处理器,由 Fluentd 项目衍生而来。它只有一个约 450KB 的静态二进制,内存占用通常在几 MB 到几十 MB 量级,而 Fluentd(Ruby)在同等负载下往往要几百 MB。这个数量级差异决定了它在 Kubernetes 中的定位:**以 DaemonSet 形态跑在每个节点上做第一层采集**。

处理模型是一条流水线,靠 **Tag(标签)** 与 **Match(匹配)** 把数据从输入路由到输出:

```shell
INPUT          采集源。tail(容器日志)、systemd、kubernetes_events、forward、http
  ↓ Tag: kube.var.log.containers.xxx
PARSER         把原始文本解析成结构化字段(json、regex、logfmt、cri)
  ↓
FILTER         加工。kubernetes(补 Pod 元数据)、grep、modify、lua、multiline
  ↓
BUFFER         内存或文件系统缓冲,实现背压与重试
  ↓
OUTPUT         es / opensearch / loki / kafka / s3 / http / forward / stdout
```

`Match` 支持通配符,`Match kube.*` 表示处理所有以 `kube.` 开头的 Tag。**没有匹配任何 OUTPUT 的 Tag 会被静默丢弃**,这是配置时最容易忽略的一点。

与 Fluentd 的分工:

```shell
Fluent Bit   节点级采集,资源开销小,插件少
Fluentd      中心聚合,插件生态丰富(Ruby gem),资源开销大
```

常见架构是 Fluent Bit(DaemonSet)采集 → forward 协议发给 Fluentd 或 Fluent Bit Aggregator(Deployment)做聚合与路由 → 后端存储。官方 Helm Chart 仓库中对应 `fluent-bit-collector` 与 `fluent-bit-aggregator` 两个较新的 Chart,以及本页介绍的通用 `fluent-bit` Chart。

### 安装

```shell
helm repo add fluent https://fluent.github.io/helm-charts/
helm repo update

# 最小安装(注意:默认输出是 Elasticsearch,见下方「注意」)
helm install fluent-bit fluent/fluent-bit -n logging --create-namespace

# 输出到 Loki
helm install fluent-bit fluent/fluent-bit -n logging --create-namespace \
  --set 'config.outputs=[OUTPUT]' \
  --set config.outputs[0].Name=loki \
  --set config.outputs[0].Match=kube.* \
  --set config.outputs[0].Host=loki-gateway.logging.svc \
  --set config.outputs[0].Port=80 \
  --set config.outputs[0].Labels=job=fluent-bit \
  --set config.outputs[0].LabelKeys=namespace,pod,container \
  --set config.outputs[0].LineFormat=json

# 用 OCI 安装
helm install fluent-bit oci://ghcr.io/fluent/helm-charts/fluent-bit -n logging --create-namespace
```

Chart 默认值要点:

```shell
kind: DaemonSet                 # 也可设为 Deployment
image:
  repository: cr.fluentbit.io/fluent/fluent-bit
resources: {}                   # 默认没有任何 requests/limits
tolerations: []
service:
  type: ClusterIP
  port: 2020                    # 内置 HTTP 服务,暴露自身指标
env: []
config:
  service: ...                  # [SERVICE] 段
  inputs: ...                   # [INPUT] 段
  filters: ...                  # [FILTER] 段
  outputs: ...                  # [OUTPUT] 段
  customParsers: ...            # [PARSER] 段
  extraFiles: {}                # 额外的配置文件
```

### 配置结构

Chart 的 `config` 采用「第一个元素是段落名、其余是键值对」的写法:

```shell
config:
  service: |
    [SERVICE]
        Daemon Off
        Flush 1
        Log_Level info
        Parsers_File /fluent-bit/etc/parsers.conf
        Parsers_File /fluent-bit/etc/conf/custom_parsers.conf
        HTTP_Server On
        HTTP_Listen 0.0.0.0
        HTTP_Port 2020
        Health_Check On

  inputs: |
    [INPUT]
        Name tail
        Path /var/log/containers/*.log
        multiline.parser docker, cri
        Tag kube.*
        Mem_Buf_Limit 50MB
        Skip_Long_Lines On

    [INPUT]
        Name systemd
        Tag host.*
        Systemd_Filter _SYSTEMD_UNIT=kubelet.service
        Read_From_Tail On

  filters: |
    [FILTER]
        Name kubernetes
        Match kube.*
        Merge_Log On
        Keep_Log Off
        K8S-Logging.Parser On
        K8S-Logging.Exclude On

  outputs: |
    [OUTPUT]
        Name loki
        Match kube.*
        Host loki-gateway.logging.svc
        Port 80
        Labels job=fluent-bit
        LabelKeys namespace,pod,container
        LineFormat json
        Auto_Kubernetes_Labels On
```

### 常用插件

```shell
# 输入
tail                  读取文件,支持通配符与位点记录(tail)
systemd               读取 journald
kubernetes_events     采集集群事件
forward               接收其它 Fluent Bit / Fluentd 转发
http                  提供 HTTP 接收端点

# 过滤器
kubernetes            根据 Pod 元数据补充 namespace、pod、labels
grep                  按字段包含/排除
modify                增删改字段
multiline             多行合并(2.2 起,替代旧的 parser 方案)
lua                   用 Lua 脚本自定义处理
nest                  把多个字段折叠成嵌套结构
throttle              限速去重

# 输出
loki                  推送到 Loki
es / opensearch       推送到 Elasticsearch 兼容存储
kafka                 推送到 Kafka
s3                    直接写对象存储
forward               转发给上游 Fluentd / Fluent Bit
stdout                打印到标准输出,调试用
prometheus_exporter   暴露自身指标
```

### Kubernetes 元数据增强

`kubernetes` 过滤器依赖 RBAC 与服务账号:

```shell
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: fluent-bit-read
rules:
  - apiGroups: [""]
    resources: ["namespaces", "pods", "nodes"]
    verbs: ["get", "list", "watch"]
```

该过滤器会读取容器日志文件路径中的 `<namespace>_<pod>_<container>_<uid>` 信息,再用 API 补齐 Pod 标签与注解。若 RBAC 不足,日志仍会被采集,但 `namespace`、`pod`、`labels` 等字段为空。

### 多行日志与解析

```shell
# 在 INPUT 阶段声明多行解析器(推荐)
[INPUT]
    Name tail
    Path /var/log/containers/*.log
    multiline.parser cri

# 自定义多行规则
[MULTILINE_PARSER]
    Name java_stack
    Type regex
    Flush_Time 2
    Rule "start_state" "/^\d{4}-\d{2}-\d{2}/" "cont"
    Rule "cont" "/^\s+at /" "cont"

# 自定义解析器,并在 FILTER 中应用
[PARSER]
    Name my_json
    Format json
    Time_Key time

[FILTER]
    Name parser
    Match kube.*
    Key_Name log
    Parser my_json
    Reserve_Data On
```

### 缓冲与背压

```shell
[INPUT]
    Name tail
    Path /var/log/containers/*.log
    Mem_Buf_Limit 50MB          # 单输入内存缓冲上限,超出后暂停读取
    storage.type filesystem     # 改为文件系统缓冲,重启不丢

[SERVICE]
    storage.path /var/log/flb-storage/
    storage.sync normal
    storage.metrics on
    storage.backlog.mem_limit 20M
    storage.total_limit_size 5G # 所有输出共享的磁盘缓冲上限
```

### 验证与排障

```shell
kubectl get ds -n logging fluent-bit
kubectl get po -n logging -l app.kubernetes.io/name=fluent-bit -o wide
kubectl logs -n logging ds/fluent-bit --tail=200

# 内置 HTTP 服务暴露的自身指标
kubectl port-forward -n logging ds/fluent-bit 2020:2020
curl -s localhost:2020/api/v1/metrics/prometheus | grep -E "fluentbit_output"

# 查看运行时配置与插件列表 / 临时打开调试日志
curl -s localhost:2020/api/v1/config | head -c 1000
curl -s localhost:2020/api/v1/plugins | head -c 1000
kubectl exec -n logging ds/fluent-bit -- \
  curl -s -X POST localhost:2020/api/v1/log/level -d '{"level":"debug"}'

# 确认宿主日志路径是否可见
kubectl exec -n logging ds/fluent-bit -- ls -l /var/log/containers | head
kubectl exec -n logging ds/fluent-bit -- ls -l /var/log/pods | head
```

### 注意

1. **Chart 默认输出到 Elasticsearch,不是标准输出**。默认 `config.outputs` 里写的是 `Name es` / `Host elasticsearch-master`。集群里没有这个服务时,Fluent Bit 会持续重试并打印 `[error] [engine] failed to flush chunk`,同时把日志全部积压在缓冲里。安装后第一件事就是改 outputs。
2. **`resources` 默认为空**,既不设 requests 也不设 limits。这看起来「省事」,实际上意味着 Fluent Bit 可以无限制吃内存,在日志量突增时被节点 OOM Killer 干掉;反过来,把 limits 设得过小(如 64Mi)也会在突发日志下频繁 `OOMKilled`。建议 requests ≈ 100m/128Mi,limits ≈ 500m/512Mi,并配合 `Mem_Buf_Limit` 做背压。
3. **`Match` 没配对会导致日志静默消失**。Fluent Bit 不会为「没有输出匹配的 Tag」报错,数据直接被丢弃。调试时先加一个 `[OUTPUT] Name stdout / Match *` 确认数据确实流到了输出阶段。
4. **tail 的位点数据库(DB)必须持久化**。默认 `DB` 指向容器内路径,Pod 重建后位点丢失,节点上残留的全部日志文件会被从头重读一遍,向 Loki/ES 灌入大量重复数据。Chart 通常把 `/tail-db` 挂成 hostPath,但**节点重启且 `/var` 未持久化时同样会丢**。
5. **`/var/log/containers/*.log` 是指向 `/var/log/pods/` 的符号链接**。只挂载 `/var/log/containers` 而不挂 `/var/log/pods` 时,符号链接无法解析,tail 会报 `no such file or directory`。正确做法是挂载整个 `/var/log`。
6. **`kubernetes` 过滤器需要 RBAC**。缺少读取 pods/namespaces 的权限时,日志还能进,但元数据全空 —— 表现为 Loki 里只有 `job` 标签,`namespace`、`pod` 都是空的。
7. **多行日志在容器运行时层面已被切分**。CRI 运行时按行写文件,Java 堆栈进来就是一条行一条记录。要在 `[INPUT] tail` 上声明 `multiline.parser cri`,或用 `multiline` 过滤器 + 自定义 `[MULTILINE_PARSER]` 合并,否则 Grafana 里一屏只能看到一个异常。
8. **文件系统缓冲需要可写目录与容量规划**。开启 `storage.type filesystem` 后必须同时设置 `storage.path` 与 `storage.total_limit_size`。不设上限时磁盘会被写满;把 `storage.path` 放在 emptyDir 上则失去「重启不丢」的意义。
9. **插件不是全量内置的**。官方镜像包含常见插件,但某些输出(如特定的云厂商插件)需要自定义镜像。用 `fluent-bit -Z` 或 `/api/v1/plugins` 确认插件是否存在,不要去猜配置项名字。
10. **Fluent Bit 与 Fluentd 的资源开销差异很大,别把 Fluentd 的配置直接照搬**。Fluentd 的 `buffer` 配置语义、`match` 语法、插件名都与 Fluent Bit 不同。两者共存的架构里,Fluent Bit 侧应使用 `forward` 输出,由 Fluentd 侧用 `in_forward` 接收。
11. **`Skip_Long_Lines On` 与后端的 `max_message_length`**。超长日志行被截断或跳过会造成日志缺失;要根据后端限制调整,而不是默认忽略。
12. **控制平面节点的日志默认采不到**。Chart 的 `tolerations` 默认为空数组,而 master/control-plane 节点带 `NoSchedule` 污点。要采集这些节点,必须显式添加 `operator: Exists` 的容忍。
13. **Fluent Bit 自身的指标默认没有 ServiceMonitor**。要监控它的健康度,需打开 `service` 并创建指向 2020 端口 `/api/v1/metrics/prometheus` 的 ServiceMonitor。

### 相关命令

- `fluentd` — 日志采集与转发守护进程
- `loki` — 水平可扩展的日志聚合系统
- `promtail` — Loki 官方日志采集代理
- `kubectl` — Kubernetes集群管理工具
- `helm` — Kubernetes包管理器

### 参考链接

- [Fluent Bit 官方文档](https://docs.fluentbit.io/manual)
- [Fluent Bit 配置参考](https://docs.fluentbit.io/manual/administration/configuring-fluent-bit)
- [Fluent Bit Kubernetes 实践](https://docs.fluentbit.io/manual/installation/kubernetes)
- [fluent/helm-charts](https://github.com/fluent/helm-charts)
- [Fluent Bit 缓冲与背压](https://docs.fluentbit.io/manual/administration/buffering-and-storage)
