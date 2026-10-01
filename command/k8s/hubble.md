hubble
===

Cilium的可观测层:实时观测集群内flow、判定丢包原因、绘制服务依赖图

## 补充说明

**Hubble** 是 Cilium 的可观测性组件,基于 eBPF 在内核数据面上直接采集 flow 信息,给出「谁在跟谁说话、结果如何、被谁丢掉了」的完整视图。它**不能脱离 Cilium 使用** —— 没有 Cilium 就没有这套数据来源。

它由四个部分组成,分清楚这几层是排障的前提:

```shell
Hubble Agent     内嵌在 cilium-agent 里,不单独部署。
                 在数据面上采集 flow,通过 gRPC 暴露(TCP 4244)。
                 注意:开 Hubble 只需要这个,默认 helm 安装就已启用。

hubble-relay     独立的 Deployment。聚合所有节点 agent 的 flow,对外提供统一 API。
                 没有它,只能一个节点一个节点地连 agent。
                 hubble CLI 默认连的就是它(TCP 4245)。
                 要求所有跑 Cilium 的节点开放 TCP 4244。

hubble-ui        独立的 Deployment + Service(hubble-ui)。
                 提供图形化的服务依赖图与 flow 列表。

hubble CLI       本地命令行,用来查询 relay。不装它也能用 cilium CLI 的
                 cilium hubble 子命令。
```

### 启用

```shell
# 方式一:Cilium CLI
cilium hubble enable
cilium hubble enable --ui          # 连同 UI 一起装

# 方式二:Helm
helm upgrade cilium oci://quay.io/cilium/charts/cilium 1.20.2 \
  --namespace kube-system --reuse-values \
  --set hubble.enabled=true \
  --set hubble.relay.enabled=true \
  --set hubble.ui.enabled=true

# 方式三:只补装 UI(Cilium 与 relay 已存在时)
helm upgrade cilium oci://quay.io/cilium/charts/cilium 1.20.2 \
  --namespace kube-system --reuse-values \
  --set hubble.ui.enabled=true \
  --set hubble.ui.standalone.enabled=true
```

注意一个容易踩的差异:**用 Helm 安装 Cilium 时 `hubble.enabled` 默认就是 true**,但 relay 与 UI 仍要显式打开;用 `cilium install` 安装时默认则不开 Hubble。

### 连接 relay

```shell
# 方式一:cilium CLI 建隧道(前台进程,保持运行)
cilium hubble port-forward
# Hubble Relay is available at 127.0.0.1:4245

# 方式二:kubectl 自己转发
kubectl -n kube-system port-forward service/hubble-relay 4245:80

# 方式三:hubble CLI 自带端口转发(不用先开隧道)
hubble observe -P
hubble status -P

# 如果用了非默认端口,显式指定
hubble observe --server localhost:4245
export HUBBLE_SERVER=localhost:4245
```

### 查看状态

```shell
# Cilium 与 Hubble 的整体状态
cilium status

# relay 的健康状况、当前 flow 数、每秒流量、已连接节点数
hubble status

# relay 自己的日志(定位连接问题的第一站)
kubectl -n kube-system logs -l k8s-app=hubble-relay --tail=200
kubectl -n kube-system get pods -l k8s-app=hubble-relay

# 打开 UI
cilium hubble ui
# Forwarding from 0.0.0.0:12000 -> 8081
# 浏览器打开 http://localhost:12000
```

### 观测 flow

```shell
# 最近 50 条
hubble observe --last 50

# 持续跟随
hubble observe --follow

# 按命名空间、Pod
hubble observe --namespace default
hubble observe --pod default/backend-0
hubble observe --from-pod default/frontend --to-pod default/backend

# 只看被丢弃的流量(排障最常用)
hubble observe --verdict DROPPED --last 50

# 只看某类 L7 协议
hubble observe --pod deathstar --protocol http
hubble observe --type l7

# 加密/非加密
hubble observe --encrypted
hubble observe --unencrypted

# 请求方向
hubble observe --reply
hubble observe --not-reply

# 结构化输出,便于喂给 jq
hubble observe -o json --last 20 | jq '.flow.verdict'

# 在 agent 所在 Pod 里直接看(1.16 起 agent 内命令改名为 cilium-dbg)
kubectl -n kube-system exec ds/cilium -- cilium-dbg monitor --type drop
kubectl -n kube-system exec ds/cilium -- cilium-dbg monitor --type trace
```

### 排障

```shell
# 1. Hubble 开了没
cilium status | grep -i hubble
kubectl -n kube-system get configmap cilium-config -o yaml | grep -i hubble

# 2. relay 起来了没、能不能连上 agent
kubectl -n kube-system get pods -l k8s-app=hubble-relay -o wide
kubectl -n kube-system logs -l k8s-app=hubble-relay --tail=200

# 3. 报 connection refused 通常是 relay 连不到 agent 的 hubble-peer Service
kubectl -n kube-system get svc hubble-peer
kubectl -n kube-system get endpointslice -l kubernetes.io/service-name=hubble-peer
# 检查所有节点是否开放 TCP 4244

# 4. 单个节点上 agent 的 Hubble 是否正常
kubectl -n kube-system exec ds/cilium -- cilium-dbg status | grep -i hubble
kubectl -n kube-system logs <cilium-pod> | grep subsys=hubble

# 5. 指标异常(如 unknown-metric)说明 agent 侧 Hubble 初始化有问题
kubectl -n kube-system logs <cilium-pod> | grep -i "failed to setup metrics"

# 6.启用 TLS 后 CLI 要带证书参数
hubble observe --tls --tls-ca-cert-files ca.crt \
  --tls-client-cert-file client.crt --tls-client-key-file client.key
```

### 注意

1. **必须有 Cilium,没有替代路径**。Hubble 采集的是 Cilium eBPF 数据面上的信息,Calico、Flannel、Antrea 都用不了。非 Cilium 集群请用各自的可观测能力或 `network-troubleshooting` 里的抓包方案。
2. **开了 `hubble.enabled` 不等于有 relay 和 UI**。Agent 侧的 Hubble 是默认开启的,但 `hubble.relay.enabled` 与 `hubble.ui.enabled` 都要单独打开,否则 `hubble observe` 会连不上(`hubble-relay` Service 根本不存在)。这是「说开了 Hubble 但用不了」的首要原因。
3. **relay 要求所有节点开放 TCP 4244**。relay 通过 `hubble-peer` Service 去连每个节点上的 agent,端口不通的表现是 `connection refused`。安全组、防火墙、NetworkPolicy 都可能挡它 —— 这是官方明确写出的前提条件。
4. **agent 内的命令自 Cilium 1.16 起从 `cilium` 改名为 `cilium-dbg`**。老文档里的 `kubectl exec ds/cilium -- cilium monitor` 在新版本会找不到命令,要写成 `cilium-dbg monitor`。宿主上的 `cilium` CLI 不受影响。
5. **UI 通过 `cilium hubble ui` 访问,本地 12000 转到 Pod 的 8081**。也可以 `kubectl -n kube-system port-forward svc/hubble-ui 12000:80`。UI 依赖 relay,relay 挂了 UI 会一片空白而不是报错。
6. **Hubble 的数据是内存中的环形缓冲,不是持久化存储**。`hubble observe` 只能看到最近一段时间的 flow,默认容量有限。需要留存历史必须另外配置导出(Hubble exporter / 转发到 OpenTelemetry),别指望事后回溯几小时前的丢包。
7. **L7 可见性是有前提的**。只有经过 Envoy 的流量(即被 L7 策略或 Ingress/Gateway 处理的流量)才有 HTTP/gRPC 等协议层的解析;纯 L3/L4 转发的流量只能看到五元组与 verdict。`--protocol http` 看不到东西不代表没有流量。
8. **开启 Hubble 有实打实的资源成本**。eBPF ring buffer 与 relay 都消耗内存与 CPU,大流量集群需要调大 `hubble.eventBufferCapacity`,或只按需采样。生产环境建议先在小范围评估。
9. **`cilium hubble port-forward` 是前台进程**。终端一关隧道就断,`hubble observe` 随即报连接失败。用 `-P` 让 hubble CLI 自己管隧道,或把它放进一个常驻的终端里。
10. **`--verdict DROPPED` 是排查策略问题最快的方式**,但要记得丢包 verdict 是数据面判定出来的:如果包根本没到数据面(比如被上游交换机丢了),这里什么也看不到,得回到节点侧抓包。
11. **relay 与 UI 都以 Deployment 形式跑在 Cilium 的命名空间里**(默认 `kube-system`),不是 DaemonSet。查 Pod 时别用 `-l k8s-app=cilium` 那个选择器。
12. **启用 TLS 后 CLI 必须带证书参数**。relay 的 mTLS 打开后,`hubble observe` 不带 `--tls-*` 会直接连接失败,而错误信息并不总是提示证书问题。

### 相关命令

- `cilium` — Hubble所属的CNI项目
- `networkpolicy` — 用Hubble验证策略是否按预期拦截
- `network-troubleshooting` — Hubble在其中承担数据面观测
- `coredns` — DNS流量同样可以在Hubble里观察
- `conntrack` — 连接跟踪层的问题与Hubble视角互补
- `kubectl` — Kubernetes集群管理工具

### 参考链接

- [Hubble 官方文档](https://docs.cilium.io/en/stable/observability/hubble/)
- [Hubble 安装与配置](https://docs.cilium.io/en/stable/observability/hubble/setup/)
- [Hubble CLI 用法](https://docs.cilium.io/en/stable/observability/hubble/hubble-cli/)
- [Hubble UI](https://docs.cilium.io/en/stable/observability/hubble/hubble-ui/)
- [Cilium Helm values(hubble 部分)](https://docs.cilium.io/en/stable/helm-values/)
