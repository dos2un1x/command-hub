linkerd
===

超轻量级Kubernetes服务网格,以低资源占用提供mTLS与可观测性

## 补充说明

**Linkerd** 是与 Istio 并列的服务网格实现,定位同样是把服务间通信下沉到基础设施层,但走的是完全不同的技术路线:Istio 用功能齐全的 Envoy 做数据平面,Linkerd 自己用 Rust 写了一个只做必要事情的微代理 `linkerd-proxy`。

这带来的直接差别是**资源占用**。Linkerd 的代理单实例通常只占几 MB 到十几 MB 内存,而 Envoy 往往是几十 MB 起步。Pod 数量上千时这个差距会非常明显,所以 Linkerd 常被描述为「更轻、更快上手」的那一个。

能力上的取舍也要看清:

- Linkerd **默认自动开启 mTLS**,不需要像 Istio 那样显式配置 `PeerAuthentication`。
- Linkerd 的路由能力基于 **Gateway API 的 HTTPRoute**,而不是自研的 VirtualService。想做灰度、按 Header 分流,写的就是标准的 `HTTPRoute`。
- Linkerd **不做 Ingress Controller**。它只负责集群内部的东西向流量,集群入口要靠 ingress-nginx、Traefik 之类的独立组件。
- Linkerd 的配置面比 Istio 窄得多,没有 `EnvoyFilter` 这类逃生舱口,遇到特殊需求时灵活性不如 Istio。

记住这个分工:**要入口就用 Ingress Controller,要网格内部的 mTLS 与流量治理再考虑 Linkerd 或 Istio**。

### 安装 CLI

```shell
# 官方脚本,默认装最新的 edge 版本
curl --proto '=https' --tlsv1.2 -sSfL https://run.linkerd.io/install-edge | sh
export PATH=$HOME/.linkerd2/bin:$PATH

# 指定版本
export LINKERD2_VERSION=edge-24.2.4
curl --proto '=https' --tlsv1.2 -sSfL https://run.linkerd.io/install-edge | sh

# 验证
linkerd version
```

此时 `Server version` 会显示 `unavailable`,因为控制平面还没装。

### 安装到集群

顺序不能反:**必须先装 CRD,再装控制平面**。

```shell
# 1. 安装前检查集群是否满足条件
linkerd check --pre

# 2. 先装 CRD
linkerd install --crds | kubectl apply -f -

# 3. 再装控制平面
linkerd install | kubectl apply -f -

# 4. 安装后自检
linkerd check
```

生产环境建议加上高可用参数:

```shell
linkerd install --ha | kubectl apply -f -
```

### 用 Helm 安装

Helm 是官方推荐的生产部署方式,因为可重复、可版本控制。但它**不会替你生成证书**,必须自己准备信任锚与签发者证书:

```shell
helm repo add linkerd-edge https://helm.linkerd.io/edge
helm repo update

# 生成信任锚(有效期 10 年)与签发者证书(有效期 1 年)
step certificate create root.linkerd.cluster.local ca.crt ca.key \
  --profile root-ca --no-password --insecure

step certificate create identity.linkerd.cluster.local issuer.crt issuer.key \
  --profile intermediate-ca --not-after 8760h --no-password --insecure \
  --ca ca.crt --ca-key ca.key

# 先装 CRD
helm install linkerd-crds linkerd-edge/linkerd-crds \
  -n linkerd --create-namespace

# 再装控制平面
helm install linkerd-control-plane \
  -n linkerd \
  --set-file identityTrustAnchorsPEM=ca.crt \
  --set-file identity.issuer.tls.crtPEM=issuer.crt \
  --set-file identity.issuer.tls.keyPEM=issuer.key \
  linkerd-edge/linkerd-control-plane
```

### 把服务纳入网格

和 Istio 一样,注入发生在 Pod 创建时,改完要重建 Pod:

```shell
# 方式一:命名空间注解,该空间内新建 Pod 自动注入
kubectl annotate namespace default linkerd.io/inject=enabled

# 重建已有的 Pod
kubectl rollout restart deployment -n default

# 方式二:单份清单手动注入
linkerd inject deployment.yaml | kubectl apply -f -

# 方式三:对集群里已有的资源注入
kubectl get deploy -n default -o yaml | linkerd inject - | kubectl apply -f -
```

验证注入结果:

```shell
kubectl get pods -n default
# READY 应该从 1/1 变成 2/2,多出来的是 linkerd-proxy

# 只检查数据平面
linkerd check --proxy -n default
```

### 可观测性扩展

```shell
# 安装 viz 扩展(自带 Prometheus 与 Web 面板)
linkerd viz install | kubectl apply -f -
linkerd check

# 打开面板
linkerd viz dashboard &

# 端口转发方式
kubectl port-forward -n linkerd-viz svc/web 8084:8084
```

### 常用运维命令

```shell
# 实时流量指标:成功率、延迟、吞吐
linkerd viz stat deploy -n default
linkerd viz stat pod -n default
linkerd viz stat deploy/web -n default --to deploy/api

# 实时抓取单个请求
linkerd viz tap deploy/web -n default
linkerd viz tap deploy/web --to deploy/api

# 实时查看最耗时的请求
linkerd viz top deploy/web

# 服务间调用关系
linkerd viz edges deploy -n default

# 路由级别的指标
linkerd viz routes deploy/web

# 查看当前生效的授权策略
linkerd diagnostics policy

# 查看控制平面组件版本
linkerd version --client --short
```

### 用 HTTPRoute 做流量切分

Linkerd 的动态路由能力建立在 Gateway API 之上,必须先安装 Gateway API 的 CRD:

```shell
kubectl apply --server-side -f \
  https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.2.0/standard-install.yaml
```

然后声明一条标准的 HTTPRoute:

```shell
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: reviews-route
  namespace: default
spec:
  parentRefs:
    - name: reviews
      kind: Service
      group: core
      port: 8080
  rules:
    - backendRefs:
        - name: reviews-v1
          port: 8080
          weight: 90
        - name: reviews-v2
          port: 8080
          weight: 10
```

### CNI 插件

集群禁止容器提权时,用 CNI 插件替代 init 容器:

```shell
# 必须在控制平面之前安装
linkerd install-cni | kubectl apply -f -

# 安装控制平面时声明启用了 CNI
linkerd install --linkerd-cni-enabled | kubectl apply -f -

# 用 Helm 时
helm install linkerd-cni linkerd-edge/linkerd2-cni -n linkerd
# 并在控制平面安装时加 --set cniEnabled=true
```

### 卸载

```shell
linkerd viz uninstall | kubectl delete -f -
linkerd uninstall | kubectl delete -f -
```

### 注意

1. **Linkerd 仍然使用 sidecar,但默认需要一个特权 init 容器**。`linkerd-init` 要以 root 身份运行并持有 `NET_ADMIN` 与 `NET_RAW` 能力来写 iptables 规则。集群启用了严格的 Pod 安全策略(如 RKE2 的 CIS 配置)时,Pod 会因为拿不到这两个能力而卡在 `Init` 状态。
2. **遇到禁止提权的集群,改用 Linkerd CNI 插件**。CNI 插件以 DaemonSet 形式在集群级别完成同样的 iptables 重定向,不需要每个 Pod 都要特权。**但 CNI 插件必须先于控制平面安装**,顺序反了会报错。
3. **用了 CNI 插件后,init 容器会失去网络访问**。iptables 规则在 Pod 调度前就已生效,而 `linkerd-proxy` 要等所有 init 容器跑完才启动,因此任何需要联网的 init 容器都会失败。规避办法是让 init 容器以代理的 UID(默认 2102)运行,这些连接不会被网格接管。
4. **Helm 安装不会自动生成证书**。`linkerd install` 会替你生成信任锚与签发者,Helm 路径不会,必须自己用 `step` 之类的工具先生成再通过 `--set-file` 传入。签发者证书默认有效期 1 年,到期前需要轮换,否则身份签发会失败。
5. **必须严格按「先 CRD、后控制平面」的顺序安装**。`linkerd install --crds` 与 `linkerd install` 是两个独立的步骤,顺序反了控制平面会因为找不到 CRD 而无法就绪。
6. **Linkerd 的动态路由依赖 Gateway API CRD**。要用 HTTPRoute 做流量切分,集群里必须先有 `gateway.networking.k8s.io` 组的 CRD,否则路由资源创建后不生效。
7. **Linkerd 不做 ingress**。它是纯服务网格,没有南北向入口能力。集群入口仍然需要部署独立的 Ingress Controller,或者用 LoadBalancer Service 直接暴露。
8. **`linkerd check` 是排查问题的第一入口**。它会按顺序检查前置条件、控制平面、数据平面、扩展,每条失败项后面都直接给出官方文档链接。生产环境建议把它接进监控定期跑。
9. **Cilium 作为 CNI 的集群需要额外配置**。Cilium 的 kube-proxy 替换模式会影响 Linkerd 的服务发现,部署前要对照官方「集群配置」文档做适配。
10. **Linkerd 与 Istio 的配置模型不通用**。Istio 的 `VirtualService`、`DestinationRule` 在 Linkerd 里没有对应物,反向也成立。选型时如果重度依赖 Istio 的流量治理 CRD,迁移成本不低。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `istio` — 功能更全的服务网格实现
- `istioctl` — Istio服务网格的官方命令行工具
- `gateway-api` — Linkerd动态路由依赖的API标准
- `helm` — Kubernetes包管理器

### 参考链接

- [Linkerd 官方文档](https://linkerd.io/docs/)
- [Linkerd 快速上手](https://linkerd.io/2-edge/getting-started/)
- [使用 Helm 安装 Linkerd](https://linkerd.io/2-edge/tasks/install-helm/)
- [Linkerd CNI 插件](https://linkerd.io/2-edge/features/cni/)
