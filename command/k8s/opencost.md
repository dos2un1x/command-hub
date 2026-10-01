opencost
===

Kubernetes成本监控:按命名空间、工作负载与Pod拆分集群开支

## 补充说明

**OpenCost** 是一个开源的 Kubernetes 成本监控方案,它从 **Prometheus** 读取资源用量,结合云厂商的定价数据,把集群的开支拆分到命名空间、工作负载、Pod、节点等维度。

它同时是**一个规范**:OpenCost 定义了「Kubernetes 成本该如何计算」的开放模型,许多成本工具(包括 Kubecost)都基于这套模型实现。OpenCost 本身由 CNCF 托管。

核心事实:

```shell
数据来源      Prometheus(必须自备,OpenCost 不自带)
定价来源      云厂商公开价格 API,或自定义价格文件
暴露方式      HTTP API(默认 9003)+ 自带 UI(默认 9090)
时间粒度      由 Prometheus 的采集与保留策略决定
```

它和 Kubecost 的关系可以这样理解:OpenCost 是开放的成本模型与实现,GPU、网络、PV 等成本项都遵循同一套账目口径;Kubecost 则是在此基础上加了企业级能力的商业产品。**如果只需要基础的成本可见性,OpenCost 已经够用**。

### 安装

```shell
helm repo add opencost-charts https://opencost.github.io/opencost-helm-chart
helm repo update
helm install opencost opencost-charts/opencost --namespace opencost --create-namespace
```

升级与卸载:

```shell
helm upgrade opencost opencost-charts/opencost --namespace opencost -f values.yaml
helm uninstall opencost
```

安装后主要对象:

```shell
Deployment/opencost     主进程,提供 API(9003)与 UI(9090)
Service/opencost        默认 ClusterIP,按需改为 NodePort 或配 Ingress
ServiceAccount + RBAC   读取集群中的节点、Pod、PV 等对象
```

确认 Pod 已就绪后再访问 UI —— OpenCost 启动时需要拉取一段历史数据,刚起来时页面可能是空的:

```shell
kubectl get pods -n opencost
kubectl logs -n opencost deploy/opencost --tail=50
```

### 访问 UI 与 API

```shell
# 只转发 API
kubectl -n opencost port-forward deployment/opencost 9003

# API 与 UI 一起转发
kubectl -n opencost port-forward deployment/opencost 9003 9090
# 浏览器打开 http://localhost:9090

# API 直接查询
curl 'http://localhost:9003/allocation?window=1d'
curl 'http://localhost:9003/assets?window=1d'
```

**注意端口分工**:9003 是 API,9090 是 UI,两者容易混。UI 只是 API 的前端,查数一律走 9003。

主要端点:

```shell
/allocation           按命名空间、工作负载、Pod 等维度拆分成本
/assets               底层资产成本(节点、磁盘、负载均衡等)
/cloudCost            来自云厂商账单的成本数据
/customCost/timeseries 第三方服务成本的时间序列
/customCost/total      第三方服务成本的汇总
```

`/allocation`、`/assets`、`/cloudCost` 都**必须带 `window` 参数**,否则请求会失败。常用参数还有 `aggregate`、`step`、`resolution`、`includeIdle`、`shareIdle`、`idleByNode`、`accumulate`、`filter`。

### 对接 Prometheus

Prometheus 是硬性依赖,默认假设集群里有一个名为 `prometheus-server` 的服务:

```shell
# 默认:集群内 Prometheus
opencost:
  prometheus:
    internal:
      enabled: true
      serviceName: prometheus-server
      namespaceName: prometheus-system
      port: 80
      scheme: http

# 使用外部 Prometheus(如托管服务)
opencost:
  prometheus:
    internal:
      enabled: false
    external:
      enabled: true
      url: https://prometheus.example.com/prometheus
    insecureSkipVerify: false
```

需要认证时提供用户名密码或 Bearer Token:

```shell
opencost:
  prometheus:
    username: ""
    password: ""
    bearer_token: ""
    existingSecretName: ""
    secret_name: ""
prometheus:
  # 也可以是 Thanos、Amazon Managed Prometheus 等
  thanos:
    enabled: false
  amp:
    enabled: false
    workspaceId: ""
```

### 云集成与定价

不配置任何云集成时,OpenCost 会用内置的默认价格表估算,结果只适合做量级判断。要拿到与账单一致的数字,需要提供 `cloud-integration.json`:

```shell
# 1. 准备 cloud-integration.json,内容形如:
{
  "aws": {
    "athena": [
      {
        "bucket": "aws-athena-query-results-bucket",
        "region": "us-east-1",
        "database": "athenacurcfn_my_name",
        "table": "my_name",
        "workgroup": "primary"
      }
    ]
  }
}

# 2. 创建 Secret
kubectl create secret generic cloud-integration \
  --from-file=cloud-integration.json -n opencost

# 3. 安装时引用
helm upgrade opencost opencost-charts/opencost --namespace opencost \
  --set opencost.cloudIntegrationSecret=cloud-integration
```

也可以直接把 JSON 塞进 values(`opencost.cloudIntegrationJSON`),但凭据会以明文留在 values 文件里,不推荐。

按量的云账单数据(Cloud Costs)需要额外开启,默认是关闭的:

```shell
opencost:
  cloudCost:
    enabled: true          # 默认 false
    runWindowDays: 3
    queryWindowDays: 7
    refreshRateHours: 6
    monthToDateInterval: 6
```

自建机房或私有云环境没有云账单可查,应改用自定义价格:

```shell
opencost:
  customPricing:
    enabled: true
    provider: custom
    createConfigmap: true
    configmapName: custom-pricing-model
    costModel:
      CPU: 1.25
      RAM: 0.5
      GPU: 0.95
      storage: 0.25
      zoneNetworkEgress: 0.01
      regionNetworkEgress: 0.01
      internetNetworkEgress: 0.12
      spotCPU: 0.006655
      spotRAM: 0.000892
```

价格单位是「每单位每小时」的美元数,填错单位会让整个集群的成本数字差出几个数量级。

### 指标与集群标识

OpenCost 会把自己计算的成本以 Prometheus 指标形式暴露出来,常见的有节点小时成本与容器资源分摊:

```shell
node_total_hourly_cost        节点每小时总成本
node_cpu_hourly_cost          节点 CPU 每小时成本
node_ram_hourly_cost          节点内存每小时成本
container_cpu_allocation      容器分摊到的 CPU 核数
container_memory_allocation_bytes  容器分摊到的内存字节数
pod_pvc_allocation            Pod 关联的持久卷分摊
```

这些指标与 API 共用 **9003** 端口,直接 `curl http://localhost:9003/metrics` 即可看到。要让它们被采集,需要打开 ServiceMonitor:

```shell
opencost:
  metrics:
    serviceMonitor:
      enabled: true
      additionalLabels: {}
      scrapeInterval: 30s
```

集群标识用于多集群场景下区分数据来源:

```shell
opencost:
  exporter:
    defaultClusterId: default-cluster   # 未设置 cluster_id 时的兜底值
```

### 与 kubectl cost 配合

`kubectl cost` 插件对 OpenCost 提供了专门的支持:

```shell
kubectl krew install cost

# --opencost 等价于指定:端口 9003、服务名 opencost、命名空间 opencost
kubectl cost namespace --opencost
kubectl cost deployment --opencost --window 7d
kubectl cost pod --opencost --historical --window yesterday --show-cpu
```

也可以逐个指定参数,便于对接非标准命名空间:

```shell
kubectl cost namespace \
  --service-name opencost \
  --service-port 9003 \
  --kubecost-namespace opencost \
  --allocation-path /allocation/compute
```

### 注意

1. **OpenCost 不自带 Prometheus,Kubecost 自带**。这是两者最容易踩的差异:装完 OpenCost 却没有可用的 Prometheus,UI 会一直空着,日志里报无法连接数据源。集群里没有 Prometheus 时,必须先把 Prometheus 部署起来。
2. **API 在 9003,UI 在 9090,别弄反**。只转发 9090 时 API 查询会失败,只转发 9003 时浏览器打不开页面,两个端口都要转才能同时用。
3. **`/allocation`、`/assets`、`/cloudCost` 必须带 `window` 参数**,这是最常见的 400 错误来源。
4. **默认定价的准确性有限**。没有云集成时用的是内置价格表,和实际账单对不上是常态;要精确到账单级别,必须配置 `cloud-integration.json` 并使用云厂商的账单导出(如 AWS CUR)。配置云账单还会产生额外的存储与查询费用。
5. **可查询的时间范围受 Prometheus 保留期限制**。OpenCost 不做长期存储,Prometheus 只保留 15 天,就只能查 15 天;想保留一年,得靠 Prometheus 侧的远程存储。
6. **云账单数据不与按需定价做对账**。官方明确说明当前没有把按需价格与账单实际金额做调和,账单数据本身还有数小时到 24 小时的延迟。因此「拿 OpenCost 的数字直接核账」这个预期并不成立,它更适合做趋势与归因。
7. **`cloudCost.enabled` 默认为 false**。云账单相关的数据与界面默认不出现,需要显式开启,并且依赖有效的集成凭据,凭据无效时不会报错、只会没有数据。
8. **指标重复采集需要显式处理**。OpenCost 会输出与 kube-state-metrics 重叠的指标,配置里提供 `emitKsmV1Metrics` / `emitKsmV1MetricsOnly` 控制开关,与已有的 KSM 同时采集会造成重复与冲突。
9. **MCP Server 默认开启**。新版 chart 会一并部署一个 MCP 服务(默认端口 8081),把成本数据通过模型上下文协议暴露给 AI 工具。不清楚用途时应显式关闭,避免多开一个对外接口。
10. **成本分摊口径需要人工确认**。闲置成本与共享成本(如 kube-system 的开销、未被任何工作负载占用的节点容量)如何分摊,会显著影响「谁花了多少钱」的结论,`includeIdle`、`shareIdle`、`idleByNode` 这几个参数要先和财务口径对齐。
11. **没有 requests 的工作负载成本会落到闲置成本里**。成本按请求量分摊,未设置 requests 的容器无法归因,最终表现为「命名空间成本很低但集群总成本很高」,这是资源配置不规范的直接反映。
12. **UI 默认没有认证**。Service 是 ClusterIP,端口转发访问尚可;要用 Ingress 暴露必须自行加认证层,否则等于把整个集群的开支明细公开。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kubecost` — 基于 OpenCost 的商业版成本平台
- `prometheus` — 指标存储与查询系统,OpenCost 的数据源
- `kube-state-metrics` — 对象状态指标导出器,与 OpenCost 存在指标重叠
- `grafana` — 可视化平台,可直接对接 OpenCost 的指标

### 参考链接

- [OpenCost 官方文档](https://opencost.io/docs/)
- [OpenCost GitHub 仓库](https://github.com/opencost/opencost)
- [OpenCost Helm Chart](https://github.com/opencost/opencost-helm-chart)
- [OpenCost API 说明](https://opencost.io/docs/integrations/api)
- [kubectl cost 插件](https://github.com/kubecost/kubectl-cost)
