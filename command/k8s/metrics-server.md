metrics-server
===

Kubernetes集群资源指标采集组件

## 补充说明

**metrics-server** 是 Kubernetes 官方维护的集群资源指标采集器。它定期从每个节点的 kubelet 拉取 Summary API,聚合成标准 Metrics API(`metrics.k8s.io`)并通过 API 聚合层暴露出去。

它是两个高频功能的**前置依赖**:

- `kubectl top node` / `kubectl top pod` — 查看节点与 Pod 的实时 CPU、内存占用
- **HorizontalPodAutoscaler(HPA)** — 基于 CPU/内存利用率自动扩缩容

组件构成(通常部署在 `kube-system`):

```shell
Deployment/metrics-server               采集与聚合进程
Service/metrics-server                  暴露给聚合层
APIService/v1beta1.metrics.k8s.io       把 metrics.k8s.io 注册到 API Server
ClusterRole/ClusterRoleBinding          读取 nodes、pods、nodes/stats 等资源
RoleBinding/metrics-server-auth-reader  允许访问扩展 API
```

数据流:`kubelet(Summary API) → metrics-server → Metrics API → kubectl top / HPA`

metrics-server **只在内存中保留最近若干次采样**,不写入持久化存储,因此**不能**用于长期趋势分析、容量规划或计费,这类需求请使用 Prometheus。

### 安装

```shell
# 方式一:官方清单(单副本)
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

# 方式二:高可用部署(需要 enable-aggregator-routing=true)
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/high-availability-1.21+.yaml

# 方式三:Helm
helm repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/
helm repo update
helm upgrade --install metrics-server metrics-server/metrics-server \
  --namespace kube-system \
  --set args="{--kubelet-insecure-tls}"

# 指定版本
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.7.2/components.yaml
```

自签证书集群(如 kubeadm 默认部署)需要额外放宽 kubelet 证书校验:

```shell
kubectl patch deployment metrics-server -n kube-system --type=json -p='[
  {"op": "add", "path": "/spec/template/spec/containers/0/args/-", "value": "--kubelet-insecure-tls"},
  {"op": "add", "path": "/spec/template/spec/containers/0/args/-", "value": "--kubelet-preferred-address-types=InternalIP,Hostname"}
]'
```

### 常用启动参数

```shell
--kubelet-insecure-tls                              跳过 kubelet 证书校验(仅测试环境)
--kubelet-preferred-address-types=InternalIP,Hostname  选择连接 kubelet 的地址类型
--kubelet-use-node-status-port                      使用节点状态中的端口,而非默认 10250
--metric-resolution=15s                             采集间隔,默认 15 秒
--secure-port=4443                                  HTTPS 服务端口
--cert-dir=/tmp                                     证书目录
--requestheader-allowed-names                       API 聚合层请求头认证
--authorization-always-allow-paths=/.well-known/openid-configuration,/healthz
```

### kubectl top 常用操作

```shell
# 节点资源占用
kubectl top node
kubectl top node --sort-by=memory
kubectl top node <node-name>

# Pod 资源占用
kubectl top pod
kubectl top pod -A
kubectl top pod -n kube-system
kubectl top pod --sort-by=cpu
kubectl top pod --sort-by=memory

# 按容器拆分显示
kubectl top pod my-app-7d9f8b6c5-abcde --containers

# 按标签筛选并汇总
kubectl top pod -l app=nginx --sum

# 指定命名空间
kubectl top pod -l app=nginx -n dev
```

### 验证 Metrics API 是否可用

```shell
# 查看 APIService 状态,Available 必须为 True
kubectl get apiservice v1beta1.metrics.k8s.io
kubectl get apiservice v1beta1.metrics.k8s.io -o yaml

# 直接查询原始指标
kubectl get --raw "/apis/metrics.k8s.io/v1beta1/nodes"
kubectl get --raw "/apis/metrics.k8s.io/v1beta1/nodes/$(kubectl get nodes -o jsonpath='{.items[0].metadata.name}')"
kubectl get --raw "/apis/metrics.k8s.io/v1beta1/namespaces/default/pods"

# 确认资源已注册
kubectl api-resources | grep metrics

# 查看组件状态与日志
kubectl get deploy,pod -n kube-system -l k8s-app=metrics-server
kubectl logs -n kube-system deploy/metrics-server --tail=100
```

### HPA 使用示例

HPA 的目标利用率是「实际用量 / requests」,**必须为容器配置 requests** 才能生效:

```shell
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: my-app
  namespace: dev
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-app
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300
```

```shell
kubectl autoscale deployment my-app --cpu-percent=70 --min=2 --max=10 -n dev
kubectl get hpa -n dev
kubectl describe hpa my-app -n dev
```

### 排障

```shell
# 1. Metrics API not available —— 组件没装好或 APIService 未就绪
kubectl top pods
kubectl get apiservice v1beta1.metrics.k8s.io

# 2. x509: cannot validate certificate for x.x.x.x —— kubelet 证书不被信任
kubectl logs -n kube-system deploy/metrics-server | grep -i x509
# 临时方案:增加 --kubelet-insecure-tls

# 3. dial tcp x.x.x.x:10250: connect: connection refused
#    节点地址类型选错,通常是走了 Flannel/Calico 网段之外的地址
#    增加 --kubelet-preferred-address-types=InternalIP

# 4. no metrics known for pod —— 刚启动尚无采集数据,等 1~2 个周期
kubectl get --raw "/apis/metrics.k8s.io/v1beta1/nodes"

# 5. HPA 显示 <unknown>/70%
kubectl describe hpa my-app -n dev
kubectl get deploy my-app -n dev -o jsonpath='{.spec.template.spec.containers[*].resources}'
```

### 注意

1. **HPA 依赖 metrics-server**。未安装时 `kubectl get hpa` 会显示 `<unknown>`,事件里报 `unable to get metrics for resource cpu: no metrics returned from resource metrics API`。
2. **容器未设置 `resources.requests` 时 HPA 无法计算利用率**。utilization 是相对 requests 的百分比,缺了 requests 目标值只能是 `<unknown>/70%`,HPA 不会扩缩容。
3. **自签证书集群必须处理证书问题**。kubeadm 部署的集群 kubelet 使用自签证书,直接安装会持续报 `x509` 错误,测试环境可加 `--kubelet-insecure-tls`,**生产环境应把集群 CA 配置给 metrics-server 而不是跳过校验**。
4. **刚部署完 `kubectl top` 会报错**,需要等待至少一个 `--metric-resolution` 周期(默认 15 秒)才有数据,属于正常现象。
5. **`--metric-resolution` 不建议调得过小**。每次采集都会访问全部节点的 kubelet,大集群下过高的采集频率会显著增加 kubelet 与 API Server 压力。
6. **metrics-server 数据不持久化**,仅保留极短的窗口(约最近若干次采样),重启后立即清空,不适合用来做监控大盘或成本核算。
7. **不要同时部署 Heapster**。Heapster 已在 1.13 之后废弃,与 metrics-server 同时存在会争抢 Metrics API 注册导致异常。
8. **高可用部署需要 API Server 开启 `enable-aggregator-routing`**,否则多副本时请求会被随机转发到尚未就绪的实例,出现间歇性 `Metrics API not available`。
9. **kubelet 需要开启 Webhook 认证与授权**(`--authentication-token-webhook=true`、`--authorization-mode=Webhook`),这是绝大多数发行版的默认值,但手工编译的 kubelet 可能未开启,表现为 401/403。
10. 聚合层要求 **API Server 能访问 metrics-server 的 Service**,网络策略(NetworkPolicy)限制 `kube-system` 出流量时会直接导致采集失败。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kubeadm` — Kubernetes集群安装工具
- `k9s` — 终端下的 Kubernetes 管理 UI
- `helm` — Kubernetes包管理器

### 参考链接

- [metrics-server GitHub 仓库](https://github.com/kubernetes-sigs/metrics-server)
- [资源指标管道官方文档](https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/)
- [kubectl top 命令参考](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_top/)
- [HorizontalPodAutoscaler 官方文档](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)
