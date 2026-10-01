pixie
===

基于 eBPF 的 Kubernetes 免埋点可观测性工具,自动采集协议级请求数据

## 补充说明

**Pixie** 是 CNCF Sandbox 项目,用 eBPF 在内核态自动抓取集群内的协议级数据:HTTP/gRPC 请求、数据库调用、DNS 查询、Kafka 消息,不需要改应用代码、不需要重启 Pod、也不需要 sidecar。它由 New Relic 在 2020 年底收购后开源,代码托管在 `pixie-io` 组织下持续开发。

它解决的具体问题是「线上服务已经在跑,现在就想看到服务之间在说什么」。传统做法要引入 SDK 重新发版,或者注入 sidecar 重建 Pod;Pixie 直接在每个节点上挂 eBPF 探针,几分钟内就能看到现成的 HTTP 请求列表与延迟分布。

### 组件

```shell
PEM(Pixie Edge Module)  每节点一个,以 DaemonSet 部署,eBPF 探针与本地数据存储都在这里
Vizier                  每集群一个,负责查询执行并管理 PEM
Pixie Cloud             用户管理、认证、数据代理,可用官方托管也可自托管
Pixie CLI(px)           部署、查询、管理密钥的命令行
PxL                     查询语言,Python 方言,UI / CLI / API 通用
```

数据默认**只留在集群内节点上**,PEM 用内存做短期存储(小时级)。需要长期留存时接 New Relic 或自建导出通道。

### 安装

```shell
# 方式一:CLI 交互式安装(会引导你确认集群、命名空间、Cloud 地址)
px deploy

# 方式二:Helm(适合 GitOps / 可复现部署;Pixie 的 chart 只支持 Helm 3)
helm repo add pixie-operator https://artifacts.px.dev/helm_charts/operator
helm repo update
helm install pixie pixie-operator/pixie-operator-chart \
  --namespace pl --create-namespace \
  --set cloudAddr=getcosmic.ai \
  --set deployKey=<deploy-key> \
  --set clusterName=<集群名>

# 自托管 Cloud 时去掉 cloudAddr,改用 devCloudNamespace
#   --set devCloudNamespace=plc
# 调整 PEM 内存上限(默认 2Gi,最低建议 1Gi)
#   --set pemMemoryLimit=1Gi

# 检查 PEM 与 Vizier 状态
kubectl get pods -n pl
px get viziers
px get pems
```

`px` 需要先认证到 Pixie Cloud:

```shell
px auth login          # 浏览器登录,拿到 API key
px auth login --api-key <key>   # 无浏览器环境
```

### 查询数据

Pixie 的价值集中在自带的 PxL 脚本上,这些脚本覆盖了大多数日常排障场景:

```shell
# 查看某个命名空间的 HTTP 请求(状态码、耗时、调用方)
px run px/http_data -n default

# 实时跟随某个脚本的输出
px live px/http_data

# 服务依赖拓扑(谁在调用谁)
px run px/service_stats

# DNS 查询与失败情况
px run px/dns_data

# 数据库调用(MySQL/Postgres/Redis 等)
px run px/mysql_data
px run px/pgsql_data

# 集群内流量最大的请求
px run px/http_data_filtered

# 列出所有可用脚本
px scripts list

# 在脚本基础上自己写查询
px run -f my_query.pxl
```

在 UI 里同样可以打开这些脚本并直接改参数。PxL 脚本本身是文本文件,可以存进 Git 版本管理——这也是 Pixie 区别于闭源 APM 的一点。

### 自建查询示例

```shell
# my_http_errors.pxl:统计 5xx 请求
import px
df = px.DataFrame(table='http_events', start_time='-5m')
df.service = df.ctx['service']
df = df[df.resp_status >= 500]
df = df.groupby(['service', 'req_path']).agg(
    errors=('resp_status', px.count),
    latency_p99=('latency', px.quantiles),
)
px.display(df, 'HTTP 5xx')
```

### 适用与不适用

```shell
适合    临时排查线上问题、没有埋点的遗留服务、快速确认服务依赖与错误分布
不适合  长期指标存储与告警(交给 Prometheus)、应用内部逻辑、业务维度打点
```

### 控制部署范围

大集群里把 Pixie 铺到所有节点代价很高,可以只部署到需要的节点池:

```shell
# Helm 值里限定部署的节点
# 只在这些节点上跑 PEM
--set nodeSelector.dedicated=observability

# 或反过来,排除特定节点
--set tolerations[0].key=dedicated
--set tolerations[0].operator=Equal
--set tolerations[0].value=observability
--set tolerations[0].effect=NoSchedule

# 确认实际跑了几个 PEM,以及它们落在哪些节点
kubectl get pods -n pl -l app=pem -o wide
px get pems
```

注意 PEM 只能看到**它所在节点**上的流量。只部署到部分节点时,跨节点的服务调用会只有一半的数据,服务地图看起来是断的——这属于配置预期,不是故障。

### 存储与保留

```shell
默认行为    PEM 把数据留在节点内存里,小时级保留,Pod 重启即丢
长期留存    接 New Relic,或自建导出管道把数据送出集群

# 查看 PEM 当前用了多少内存

kubectl top pods -n pl -l app=pem

# PEM 内存到顶时会丢数据,该扩容还是该降采样要按场景判断
```

### 与埋点方案如何共存

Pixie 不排斥 OpenTelemetry,两者解决的问题不同:

```shell
Pixie 擅长      "现在线上发生了什么" —— 服务依赖、错误分布、请求样本
OTel 擅长       "业务上发生了什么" —— 租户维度、订单链路、自定义属性
典型组合        用 Pixie 快速定位到某个服务有问题,再到 OTel 里查该服务
                关联的业务链路;或者用 Pixie 先验证问题确实存在,
                再决定要不要为长期观测补埋点
```

### 注意

1. **Pixie 官方要求 Linux 内核 4.14+**,Kubernetes v1.21+。内核越新可用的 eBPF 特性越多,老内核上部分协议解析(尤其是依赖较新挂载点的部分)会退化为不可用。部署前先在所有节点池上核对 `uname -r`,不要只看一个节点。
2. **三种环境直接不支持**:EKS Fargate、GKE Autopilot(不提供节点,拿不到 eBPF 权限),以及 kind / k3d / Docker Desktop(节点本身是容器,内核不归你管)。minikube 只有 `--driver=kvm2` 或 `hyperkit` 可用,`--driver=docker` 不行。选型前先确认你的开发与生产环境是否在支持列表内。
3. **资源开销要按节点内存预留**。官方建议 PEM 内存不超过节点总内存的 25%,默认 limit 是 2Gi,最低建议 1Gi。按节点计费的环境里这是一笔实打实的成本,大集群必须逐个节点池估算。
4. **需要特权与 hostPID**。PEM 以 `privileged: true` + `hostPID: true` 运行,`restricted` 级别的 Pod Security Admission 会直接拒绝。要在装了 Pixie 的命名空间上打 `pod-security.kubernetes.io/enforce=privileged` 标签。
5. **插桩范围受限于协议解析器**。Pixie 能看到的是它写了解析器的协议(HTTP、gRPC、DNS、MySQL、Postgres、Redis、Kafka、NATS 等)。自研 RPC 框架、私有二进制协议不在列表里,只能看到 TCP 层的连接数,不会自动出现「请求」这一层的数据。
6. **TLS 流量的可见性有边界**。Pixie 通过 uprobe 挂到进程内的 SSL 库上取明文。Go 程序用的是 Go 自带 crypto/tls,支持良好;BoringSSL 静态链接、自研 TLS、或者语言运行时非标准的 TLS 栈,可能取不到数据。遇到「协议是 HTTP 但看不到请求」时,先查这一点。
7. **默认只保留短期数据**。节点内存里的数据通常只有几小时,重启 Pod 即丢。需要回溯一周前的请求,必须接长期存储(New Relic 或自建导出),不要指望 PEM 本地存储。
8. **长期存储要收费,且是 New Relic 的商业能力**。开源部分是集群内观测与 UI/CLI,跨集群长期留存、告警、与其他遥测关联属于 New Relic 的商业集成。选型时要区分「开源 Pixie」与「New Relic 版 Pixie」的能力边界。
9. **PxL 脚本有维护成本**。自定义脚本不会自动跟随上游升级,底层表结构与字段名在新版本可能变化。生产里用到的自定义脚本要纳入版本管理与升级回归。
10. **它不是完整的 APM**。缺少业务维度打点(用户 ID、租户、订单号)、缺少与应用日志的直接关联、也缺少成熟的告警体系。定位是「零成本的即时观测入口」,不是替代 OpenTelemetry 与 Prometheus。
11. **自托管 Pixie Cloud 明显更复杂**。官方托管最省事;要完全离线或数据不出集群,得自己部署 Cloud 组件并维护域名与证书,长期维护成本不低,先评估是否有这个必要。
12. **`px deploy` 不会自动升级**。升级需要重新执行部署或更新 Helm release,跨大版本时 PEM 与 Vizier 版本要匹配,混版运行会出现查询失败。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `helm` — Kubernetes包管理器
- `ebpf-observability` — eBPF 免埋点观测的原理与边界
- `cilium` — 同样基于 eBPF 的网络可观测性方案
- `opentelemetry` — 需要业务维度埋点时的标准方案
- `prometheus` — 指标长期存储与告警
- `pod-security-admission` — 特权容器常被拦下的地方

### 参考链接

- [Pixie 官方文档](https://docs.px.dev/)
- [Pixie 是什么](https://docs.px.dev/about-pixie/what-is-pixie/)
- [安装要求(内核与 Kubernetes 版本)](https://docs.px.dev/installing-pixie/requirements/)
- [PxL 脚本参考](https://docs.px.dev/reference/pxl/)
- [Pixie GitHub 仓库](https://github.com/pixie-io/pixie)
