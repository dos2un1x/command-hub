kubecost
===

Kubernetes成本管理平台:成本分摊、闲置识别与资源优化建议

## 补充说明

**Kubecost** 是 Kubernetes 的成本管理平台。它把集群的资源消耗换算成钱,拆分到命名空间、工作负载、团队等维度,并给出降本方向上的建议 —— 例如哪些工作负载长期申请了远超实际需求的 CPU、哪些节点大部分时间处于空闲。

它基于开源的 **OpenCost** 成本模型构建,在其上增加了多集群联邦、告警、预算、SSO 等企业能力。Kubecost 已被 IBM/Apptio 收购,官方文档现由 IBM 维护。

**安装前必须注意版本断代** —— 网上绝大多数教程讲的是 2.x,而 3.x 的安装方式与架构都已改变:

| 对比项 | Kubecost 2.x | Kubecost 3.x |
| --- | --- | --- |
| Helm 仓库 | `https://kubecost.github.io/cost-analyzer/` | `https://kubecost.github.io/kubecost` |
| Chart 名 | `cost-analyzer` | `kubecost` |
| 数据存储 | DuckDB | ClickHouse |
| 指标来源 | Prometheus | 直接采集 |
| 采集组件 | `cost-model`(secondary) | `finops-agent`(子 chart) |

最直观的差异是访问 UI 时的 Deployment 名:2.x 是 `kubecost-cost-analyzer`,3.x 是 `kubecost-frontend`,用旧命令转发端口会直接报找不到资源。

### 安装

```shell
# 方式一:一条命令
helm install kubecost \
  --repo https://kubecost.github.io/kubecost kubecost \
  --namespace kubecost --create-namespace \
  --set global.clusterId=GLOBALLY_UNIQUE_CLUSTER_ID

# 方式二:先加仓库再安装
helm repo add kubecost https://kubecost.github.io/kubecost/
helm repo update
helm install kubecost kubecost/kubecost \
  --namespace kubecost --create-namespace \
  --set global.clusterId=GLOBALLY_UNIQUE_CLUSTER_ID

# 查看可配置项
helm show values kubecost/kubecost --version VERSION
```

`global.clusterId` 是**多集群场景下的全局唯一标识**,单集群也应显式指定一个有意义的字符串(如生产集群的代号),留空会导致后续接第二个集群时数据互相混淆。

升级与卸载:

```shell
helm upgrade kubecost kubecost/kubecost --namespace kubecost

# 卸载
helm uninstall kubecost --namespace kubecost

# 注意:卸载不会删除持久卷,要彻底清理需删除命名空间
kubectl delete namespace kubecost
```

### 访问 UI

```shell
# 3.x:前端 Service 名为 kubecost-frontend
kubectl port-forward --namespace kubecost svc/kubecost-frontend 9090
# 浏览器打开 http://localhost:9090

# 等价地按 Deployment 转发
kubectl port-forward deployment/kubecost-frontend 9090 --namespace kubecost

# 2.x 及更早版本使用另一个名字
kubectl port-forward deployment/kubecost-cost-analyzer 9090 --namespace kubecost

# EKS 附加组件安装的版本
kubectl port-forward deployment/cost-analyzer 9090 --namespace kubecost
```

UI 能打开不代表数据已就绪:刚装完需要等待 5–10 分钟(集群较大时更久)才会有完整的成本数字。

### 命令行查询:kubectl cost

不想开浏览器时,`kubectl cost` 插件可以在终端里拿到同样的数据:

```shell
# 安装插件
kubectl krew install cost

# 各命名空间的月度预测开销
kubectl cost namespace

# 显示全部成本项(CPU、内存、GPU、PV、网络、共享成本)
kubectl cost namespace --show-all-resources

# 过去 5 天的实际开销,不显示效率
kubectl cost namespace --historical --window 5d --show-cpu --show-memory --show-efficiency=false

# 按控制器、按 Deployment、按 Pod、按节点聚合
kubectl cost controller --window 5d --show-pv
kubectl cost deployment --window month -A
kubectl cost pod --historical --window yesterday --show-cpu -n kube-system
kubectl cost node --historical --window 7d --show-cpu --show-memory

# 按标签聚合,适合团队/项目维度的分摊
kubectl cost label --historical -l app

# 终端 UI
kubectl cost tui
```

子命令 `namespace`、`deployment`、`controller`、`label`、`pod`、`node` 各有两个模式:**默认按速率**给出月度预测开销,**加 `--historical`** 则给出窗口期内的实际总开销。

**预估未部署变更的成本**是需要 Kubecost v1.100 以上版本的功能,对容量评审很有用:

```shell
kubectl cost predict -f k8s-deployment.yaml
echo "$DEF" | kubectl cost predict -f -
kubectl cost predict -f 'k8s-deployment.yaml' --show-cost-per-resource-hr
```

常用连接参数:

```shell
-r, --release-name        Helm release 名,默认 kubecost
--service-name            成本服务名,默认由 release 名推导
--service-port            服务端口,默认 9090
-N, --kubecost-namespace   Kubecost 所在命名空间
--use-proxy               经由 apiserver 代理而非本地端口转发
--opencost                一键切换到 OpenCost 默认参数(端口 9003、路径不同)
```

### 成本模型

Kubecost 把集群开销拆成几类,理解口径才能读懂页面上的数字:

```shell
CPU / 内存        按容器实际用量与 requests 分摊
GPU               按卡时计费
PV                持久卷按容量与存储类计价
网络              跨可用区、跨地域与公网出流
共享成本          集群级组件的开销,按规则分摊到各命名空间
闲置成本          未被任何工作负载占用的容量
```

其中**闲置成本与共享成本的分摊方式**对结论影响最大。同一份数据,采用不同的分摊策略,可以让某个命名空间的「成本」相差数倍,因此上生产前必须先和财务口径对齐。

### 降本视角

拿到数据之后,通常按下面几条线索找降本空间:

```shell
# 1. 请求量远高于实际用量的工作负载 —— 白交的钱
kubectl cost deployment --window 7d --show-cpu --show-memory -A

# 2. 长期空闲的节点
#    UI 的 Cluster Costs 页面查看节点利用率

# 3. 未设置 requests 的工作负载 —— 无法归因,也说明资源配置不规范
kubectl get pods -A -o json | jq -r '.items[] | select(.spec.containers[].resources.requests == null) | .metadata.namespace + "/" + .metadata.name'

# 4. 建议值:结合 VPA 推荐横向印证
kubectl get vpa -A
```

Kubecost 里的「效率(efficiency)」指标就是「实际用量 ÷ 请求量」,长期低于 0.3 的工作负载基本都可以考虑下调 requests。

### 注意

1. **3.x 与 2.x 的 Helm 仓库和 Chart 名都变了**。旧的 `helm repo add kubecost https://kubecost.github.io/cost-analyzer/` 与 `kubecost/cost-analyzer` 属于 2.x;照抄老教程装出来的版本、组件名、访问方式全都是旧的,与本文描述的 3.x 行为不一致。
2. **3.x 首次安装会重新摄入全部历史数据**,耗时从 20 分钟到 2 天不等,取决于数据规模与持久卷的性能。这期间 UI 可用但会显示进度条,不要误以为安装失败而反复重装。
3. **从 2.x 升级到 3.x 有明确的升级顺序**:官方建议所有 agent 先升到 2.9 并稳定运行两天,再升级到 3.0;主集群(primary)必须先于 agent 升级。
4. **卸载不会删除持久卷**。`helm uninstall` 之后 PV 仍留在集群里持续计费,彻底清理需要 `kubectl delete namespace kubecost`。
5. **定价数据需要集群具备出网能力**。默认价格来自云厂商的公开价格 API,隔离网络环境下必须配置自定义价格,否则成本数字会失真;自定义价格的单位是「每单位每小时」的美元金额,单位填错会导致数量级偏差。
6. **精确到账单的成本依赖云厂商账单集成**。仅靠资源用量估算只能得到与账单趋势一致的数字;要对账,必须接入云厂商的成本与用量报告(AWS CUR、GCP 账单导出、Azure 导出)。
7. **闲置成本的分摊策略直接决定结论**。默认把集群级开销平摊到所有工作负载,可能让一个小服务背上高额「共享成本」。把工作负载成本与共享成本分开看,才能判断真实的优化空间。
8. **没有设置 requests 的工作负载无法被正确归因**。其成本会落到闲置成本里,表现为「命名空间成本很低、集群总成本很高」,这通常是资源配置不规范而非工具问题。
9. **免费版有明确的容量与留存上限**。Kubecost Free 不限制安装的集群数量,但 UI 一次只能查看一个集群、总量上限 250 核、历史数据只保留 15 天;此外 3.x 的数据存放在 ClickHouse 中,持久卷容量不足时历史数据同样会被清理,查长周期成本前先确认版本与存储余量。
10. **`kubectl cost` 依赖集群内可访问的成本服务**。它默认 `--release-name kubecost`,release 名与之不符时必须显式指定 `-r`,否则会找不到服务而报错;临时转发的端口在命令结束后可能仍处于 TCP `TIME_WAIT` 状态,短时间内重复执行可能提示端口占用。
11. **UI 默认没有认证**。通过 Ingress 或 LoadBalancer 暴露前务必配置认证,否则等于公开整个集群的成本与资源画像;Kubecost 企业版提供 SSO 与 RBAC,免费版需要自行在入口层解决。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `opencost` — 开源的成本模型与实现,Kubecost 的基础
- `prometheus` — 指标存储与查询系统,成本数据的来源
- `kube-state-metrics` — 对象状态指标导出器,成本归因依赖的资源清单
- `hpa` — 水平自动扩缩容,与成本优化直接相关

### 参考链接

- [Kubecost Helm Chart 仓库](https://github.com/kubecost/cost-analyzer-helm-chart)
- [Kubecost 官方文档(IBM)](https://www.ibm.com/docs/en/kubecost/self-hosted/3.x)
- [kubectl cost 插件](https://github.com/kubecost/kubectl-cost)
- [OpenCost 官方文档](https://opencost.io/docs/)
