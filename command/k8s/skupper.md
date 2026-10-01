skupper
===

应用层(L7)的多集群互联,用代理把服务暴露到其它集群,不需要打通网络

## 补充说明

**Skupper** 是一个「虚拟应用网络」(Virtual Application Network)实现,由 Red Hat 主导并商品化为 Red Hat Service Interconnect,采用 Apache-2.0 许可。当前最新版本为 **2.2.2(2026-08-17)**,配套的 Skupper Router 为 3.5.x、Console 为 2.2.0,项目仍在活跃开发。

它与 Submariner、Cilium ClusterMesh 的根本区别在于**层次**。官方原话是:Skupper 工作在**应用层**,运行在既有 IP 网络之上;Layer 7 的应用路由器**在应用端点之间转发消息,而不是在网络端点之间转发 IP 包**。这意味着:

```shell
Submariner / ClusterMesh    打通 L3,Pod IP 直接可达,应用完全无感
Skupper                     不打通 L3,靠站点之间的路由器代理 TCP 连接
```

因此 Skupper 的典型使用场景不是「把两个集群变成一个集群」,而是**把某个服务从 A 集群暴露给 B 集群**(混合云、边缘到中心、跨组织协作),且往往能穿过只允许出站的防火墙。

> **时效性提醒**:Skupper v2 与 v1 的 API 与 CLI **完全不兼容**。网上大量教程仍是 v1 写法(`skupper init`、`skupper expose`、`skupper.io/v1alpha1`),在 v2 上会直接报错。本页只描述 v2。

### 核心概念

```shell
Site        一个「站点」,即运行工作负载的一处环境(Kubernetes 集群、Docker、Podman、Linux 主机)
Link        站点之间的通道
Connector   把本站的工作负载绑到远端站点的 listener 上(服务提供方)
Listener    把本地端口绑定到远端站点的 connector 上(调用方)
Routing key 连接器与监听器之间的匹配键,两者靠它配对
```

一个 Skupper 网络里所有站点共享同一个「虚拟应用网络」,但**站点名必须唯一**。

### 安装

CLI 与控制器是分开的两件事:

```shell
# 方式一:安装 CLI(下载对应平台包后解压)
tar -xzf skupper-cli-2.2.2-mac-arm64.tgz
sudo install -m 755 skupper /usr/local/bin/skupper
skupper version

# 方式二:用 Helm 装控制器(OCI chart)
helm install skupper oci://quay.io/skupper/helm/skupper --version 2.2.2

# 升级前先单独更新 CRD(server-side apply,避免注解体积超限)
kubectl apply --server-side -f \
  https://github.com/skupperproject/skupper/releases/download/2.2.2/skupper-crds.yaml
```

Controller 的部署清单也提供集群级与命名空间级两种作用域(`skupper-cluster-scope.yaml` / `skupper-namespace-scope.yaml`),后者适合「每个团队一个命名空间、各管各的站点」。

### 创建站点

```shell
# 在命名空间 west 中创建站点,并允许其它站点链接进来
skupper site create west --enable-link-access

# 查看站点状态(应该变成 Ready)
skupper site status
kubectl get site

# 删除站点
skupper site delete west
```

对应的声明式写法:

```shell
apiVersion: skupper.io/v2alpha1
kind: Site
metadata:
  name: west
  namespace: west
spec:
  linkAccess: default
```

`spec.linkAccess` 的取值:

```shell
none           默认值,不接受外部链接
default        接受链接,自动选择合适的暴露方式
route          使用 OpenShift Route
loadbalancer   使用 LoadBalancer Service
```

一个两站点网络中,**至少要有一个站点的 link access 不是 `none`**,否则两边无法建立 Link。

### 建立 Link

v2 用「短期访问令牌」把站点连起来,而不是手工交换证书:

```shell
# 在站点 west(需要已开启 link access)签发令牌
skupper token issue ~/west-token.yaml

# 在站点 east 兑换令牌,建立 Link
skupper token redeem ~/west-token.yaml
skupper link status
```

令牌对应的两个 CRD:

```shell
AccessGrant   允许在本地站点兑换令牌的权限(AccessToken 由它派生)
AccessToken   短期的链接凭证
```

也可以直接用 `skupper link create <token-file>` 建立链接、用 `skupper link delete` 断开。令牌是**短期凭证**,过期后需要重新签发,这也是它与静态证书方案在运维上的主要差别。

### 暴露与调用服务

服务提供方定义 Connector,调用方定义 Listener,二者通过 routing key 配对:

```shell
# 站点 west:把本地的 backend 服务暴露出去
skupper connector create backend 8080 --routing-key backend

# 站点 east:在本地监听 8080,流量转到 west 的 backend
skupper listener create backend 8080 --routing-key backend

# 查看
skupper connector status
skupper listener status
```

声明式写法:

```shell
apiVersion: skupper.io/v2alpha1
kind: Connector
metadata:
  name: backend
  namespace: west
spec:
  routingKey: backend
  port: 8080
  host: backend
```

### 支持的协议

```shell
tcp      默认;任何基于 TCP 的协议都可以跑在上面
http1    带 L7 路由与可观测性
http2    同上
```

官方**没有把 UDP 列入支持范围**。另外所有站点间流量都会被转换成 AMQP 消息在路由器之间传递:`tcp` 是一条流式消息,`http1`/`http2` 则按请求/响应路由。存在端口协商的协议(例如主动模式 FTP)也无法跨站点工作。

### 注意

1. **Skupper 是 L7 方案,不是 L3 方案**。它不会把集群网络打通:Pod IP 不跨集群可达,集群 DNS 也不会自动解析远端服务,必须显式创建 Connector/Listener 才能通信。想「跨集群直接 curl 到对方 Pod IP」的需求,Skupper 满足不了,应选 Submariner 或 Cilium ClusterMesh。
2. **v1 与 v2 的 API 与 CLI 不兼容**。`skupper init`、`skupper expose`、`skupper.io/v1alpha1` 都是 v1 的写法;v2 对应 `skupper site create`、`skupper connector create`、`skupper.io/v2alpha1`。照着旧博客操作会直接失败。
3. **建立 Link 需要至少一端有可达入口**。入口由 `spec.linkAccess` 决定;两个站点都在 NAT 后且都设成 `none` 时无法互连,此时至少一端需要 LoadBalancer 或 Route。
4. **站点名必须唯一**。同名站点加入同一网络会造成识别混乱,`kubectl get site` 的 `SITES IN NETWORK` 列可以用来核对网络里到底有几个站点。
5. **一个命名空间只能有一个活动 Site**。Site 是其命名空间内所有 Skupper 资源的父对象,重复创建不会得到第二个站点。
6. **升级要先更新 CRD 再升 chart**。官方明确建议在升级 chart 前用 `kubectl apply --server-side` 应用最新 CRD,否则新字段会被 API Server 的旧 schema 静默丢弃。
7. **访问令牌是短期凭证**。令牌过期后已建立的 Link 不受影响,但需要新链接时要重新 `token issue`。把令牌文件放进 Git 是不安全的做法。
8. **edge 站点是单向的**。`spec.edge: true` 的站点不能接受来自远端站点的 Link,只适合「我只连出去、不接受连入」的边缘场景,配错会表现为 Link 一直建不起来。
9. **它不解决服务发现**。远端服务不会出现在本地 DNS 里,调用方访问的是本地 Listener 监听的地址(例如 `localhost:8080` 或本集群的 Service),这一点在设计应用配置时很容易搞反。
10. **`spec.ha: true` 会启动两个活动路由器**。高可用模式下资源占用翻倍,小规模场景通常不需要开。
11. **它不替代多集群编排**。Skupper 只做连接,不做副本拆分、故障迁移、集群亲和 —— 这些属于 Karmada 一类工具的职责。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `submariner` — L3 跨集群网络,与 Skupper 定位互补
- `cilium` — ClusterMesh 提供 L3/L4 多集群能力
- `gateway-api` — Skupper v2 的路由依赖相关生态
- `istio` — 另一种跨集群服务互联思路
- `helm` — 用 OCI chart 部署 Skupper 控制器

### 参考链接

- [Skupper 官方文档](https://skupper.io/docs/)
- [Skupper API 资源参考](https://skupper.io/resources/index.html)
- [Site 资源参考](https://skupper.io/resources/site.html)
- [Skupper 概念(站点/链接/连接器/监听器)](https://skupperproject.github.io/refdog/concepts/index.html)
- [Skupper GitHub 仓库](https://github.com/skupperproject/skupper)
- [Red Hat Service Interconnect 支持的标准与协议](https://docs.redhat.com/en/documentation/red_hat_service_interconnect/1.9/html/using_service_interconnect/protocols)
