spiffe
===

工作负载身份的标准规范,用SPIFFE ID与SVID取代静态密钥

## 补充说明

**SPIFFE**(Secure Production Identity Framework For Everyone)是一套**规范**,不是软件。它回答两个问题:

```shell
1. 一个工作负载的身份应该长什么样    → SPIFFE ID(一个 URI)
2. 它怎么证明自己就是这个身份        → SVID(一张短期可验证的凭据)
```

SPIFFE 与它的参考实现 SPIRE 于 **2022-09-20 从 CNCF 毕业**。之所以先有规范再有实现,是因为身份标识必须跨系统通用 —— Istio、Consul、Envoy、gRPC、Vault 等都能识别 SPIFFE ID,这样服务网格里的 mTLS 身份与 SPIRE 签发的身份才是同一套东西,而不是各管各的。

核心价值在于:**消除共享密钥**。传统方案里,服务间互信靠预置 Token 或密码,于是有了分发、存储、轮换这一整套负担;SPIFFE 让工作负载用自身已有属性证明身份,拿到一张短期凭据,过期自动换新,磁盘上不存在任何长期密钥。

### SPIFFE ID

SPIFFE ID 是一个 RFC 3986 URI,格式固定为:

```shell
spiffe://<trust domain>/<path>

# 示例
spiffe://example.org/billing/payments
spiffe://acme.com/ns/default/sa/my-app
spiffe://example.org/spire/agent/k8s_psat/demo-cluster/6f1c...-node-uid
```

规范对每一部分都有硬性约束,写成清单更清楚:

```shell
scheme
  必须是 spiffe

authority(trust domain)
  不能为空
  必须全小写
  只能包含 [a-z0-9.-_]  —— 字母、数字、点、短横线、下划线
  不允许 percent-encoding
  userinfo 与 port 部分必须为空
  最长 255 字节
  IPv4 点分形式可用,IPv6 被排除(冒号不在允许字符集内)

path
  每个路径段只能包含 [a-zA-Z0-9.-_]
  不允许空段,不允许 . 与 .. 这类相对路径修饰符
  不允许以 / 结尾
  不允许 percent-encoding

整体
  不允许 query(?a=b)
  不允许 fragment(#frag)
  实现必须支持到 2048 字节,生成时不应超过 2048 字节
```

大小写规则值得单独强调:**scheme 与 trust domain 大小写不敏感,而 path 大小写敏感**。`spiffe://Example.Org/A` 与 `spiffe://example.org/A` 是同一个身份,但 `spiffe://example.org/a` 不是。

### Trust Domain

trust domain 对应「信任根」的范围,通常是一个组织、一个环境或一个集群。它的实际含义是:**同一 trust domain 内的身份,由同一套根密钥签发,可以互相验证。**

划分粒度的官方建议:

```shell
- 处于不同物理位置(数据中心、云区域)的负载 → 拆开
- 安全策略不同的负载(生产 vs 预发)         → 拆开
- 需要跨域互信的场景                        → 用联邦(federation),不是塞进同一个域
```

Kubernetes 上常见的做法是一个集群一个 trust domain,或一个环境一个域。

### SVID

SVID(SPIFFE Verifiable Identity Document)是「证明身份的那张纸」。核心约束是:**每张 SVID 恰好携带一个 SPIFFE ID**,并且由该 ID 所属 trust domain 内的权威签发。

两种格式,用途不同:

```shell
X.509-SVID
  - SPIFFE ID 放在证书的 URI SAN 里
  - 附带与该 ID 绑定的私钥
  - 可直接用于 mTLS,是最常用的形式
  - 规范明确推荐优先使用它

JWT-SVID
  - SPIFFE ID 放在 JWT 的 sub 声明里
  - 必须带 exp 过期时间
  - 用 aud 指定受众,校验方必须核对 aud
  - 只在无法用 TLS 的场景使用(如经过 L7 代理/负载均衡)
  - 因为 token 可被重放,安全性弱于 X.509-SVID
```

JWT-SVID 的关键在于**必须校验 `aud`**。只验签名不验受众,等于让一个签给 A 服务的 token 可以拿去冒充访问 B 服务。

### Workload API

工作负载通过 **SPIFFE Workload API** 获取 SVID 与信任包,它是一个本地 gRPC 接口,Linux 上走 Unix domain socket(SPIRE 的典型路径是 `/run/spire/sockets/agent.sock`,客户端通常通过 `SPIFFE_ENDPOINT_SOCKET` 环境变量指定)。

这个接口有两个很容易被忽略的设计要点:

```shell
1. 工作负载【不需要知道自己是谁】
   它不去「申请某个身份」,而是连接 socket,由 Agent 通过进程属性反查
   从而判定它是谁、该拿什么身份

2. 调用时【不需要携带任何认证凭据】
   没有 bootstrap token,没有密码
   这正是「无共享密钥」得以成立的前提
```

API 返回的内容:

```shell
X.509 路径
  - 本工作负载的 SPIFFE ID
  - 与 ID 绑定的私钥和短期证书
  - 信任包(用于验证对端)

JWT 路径
  - 本工作负载的 SPIFFE ID
  - JWT token
  - 信任包
```

### Trust Bundle

信任包是一组应当被信任的 CA 根证书集合,同时包含 X.509 与 JWT 两种 SVID 所需的公钥材料:

```shell
X.509 校验  → 一组 CA 证书
JWT 校验    → 一个原始公钥(JWT-SVID 用)
```

信任包的内容会随 CA 轮换而变化,因此工作负载应当**通过 Workload API 持续订阅**,而不是把 bundle 一次性写进配置文件。

### 与 Kubernetes ServiceAccount 的关系

这是最容易混淆的一点。两者不是同一个层次的东西:

| | ServiceAccount | SPIFFE ID |
| --- | --- | --- |
| 性质 | Kubernetes 的一种 API 资源 | 跨平台的规范 |
| 谁签发 | kube-apiserver(投影 token) | trust domain 的权威(如 SPIRE Server) |
| 面向 | 调用 kube-apiserver | 任意服务间的身份认证 |
| 凭据形式 | JWT | X.509 证书或 JWT |
| 作用域 | 单个集群 | 可跨集群、跨云、跨运行时 |

实务中的三种组合方式:

```shell
1. 用 ServiceAccount 作为【证明素材】
   SPIFFE 实现通过 k8s:ns + k8s:sa 选择器判定身份,签发 SVID
   这是 SPIRE 的 k8s 工作负载证明插件最常见的用法

2. 一个 ServiceAccount 对应一个 SPIFFE ID
   Istio 就是这种映射:spiffe://<trust-domain>/ns/<ns>/sa/<sa>

3. 完全不用 ServiceAccount
   直接用镜像名、Pod 标签等更细的粒度做身份判定
```

### 常见实现

```shell
SPIRE        SPIFFE 官方参考实现,独立于任何服务网格
Istio        Citadel/Istiod 为 sidecar 签发 SPIFFE 格式的身份
Consul       Connect 的身份模型基于 SPIFFE ID
Vault        SPIFFE 认证后端,可把 SVID 换成 Vault token
云厂商       部分服务支持以 SPIFFE 作为联邦主体
```

选型时注意区分:**如果只是想让服务之间做 mTLS,服务网格自带的能力可能已经够用;如果需要跨集群、跨运行时、跨云的统一身份,SPIFFE + SPIRE 才是对症的方案。**

### 注意

1. **SPIFFE 是规范,不是可以「装」的东西**。真正要部署的是实现(通常是 SPIRE)。看到「安装 SPIFFE」的说法时,先问清楚对方指的是规范、SPIRE,还是某个服务网格的内置能力。
2. **SPIFFE ID 的字符集限制比想象中严格**。路径段只允许 `[a-zA-Z0-9.-_]`,不接受空段、`.`、`..`,也不接受 percent-encoding。想用 `spiffe://example.org/team/payments (prod)` 这样的字符串会直接违反规范。
3. **trust domain 必须全小写**。`spiffe://Example.Org/foo` 不合规。虽然规范说校验时大小写不敏感,但生成端必须是全小写 —— 很多实现会在签发时直接拒绝。
4. **`aud` 是 JWT-SVID 的安全边界,必须校验**。SPIFFE 规范要求校验方核对受众;只验签名就接受 token,会让面向 A 服务的 token 被拿去访问 B 服务,是典型的横向移动入口。
5. **X.509-SVID 优先于 JWT-SVID**。JWT 可被重放,规范明确说在能建立 TLS 的场景应使用 X.509-SVID。把 JWT-SVID 当作长期 API key 使用是反模式。
6. **SVID 是短期凭据,不要落盘缓存**。有效期的设计意图就是「暴露了也很快失效」。把 SVID 写到磁盘再复用,既破坏了它的安全属性,又会在轮换时读到过期文件而出现难以定位的间歇故障。
7. **SPIFFE ID 不表达权限,只表达身份**。它回答「你是谁」,不回答「你能做什么」。授权必须另外做(如 RBAC、策略引擎)。把权限信息编码进路径(`/admin/...`)只是约定,不构成任何强制。
8. **跨 trust domain 需要显式联邦**。A 域的工作负载无法直接验证 B 域的 SVID,必须通过 federation 交换信任包。以为「都是 SPIFFE 就能互认」是常见的误解。
9. **信任包会变,必须动态获取**。CA 轮换后旧 bundle 无法验证新 SVID,而依赖方如果硬编码了 bundle 文件,会突然出现大面积校验失败。
10. **不同实现的 SPIFFE ID 命名可能冲突**。Istio 用 `ns/<ns>/sa/<sa>`,SPIRE 的示例常用同一套路径 —— 但如果同一个 trust domain 下有两套签发者,路径规范不统一会导致选择器与策略难以编写。建议在组织内先固定命名约定。

### 相关命令

- `spire` — SPIFFE 的官方参考实现
- `serviceaccount` — Kubernetes 原生身份,常作为 SPIFFE 的证明素材
- `istio` — 内置 SPIFFE 身份的服务网格实现
- `workload-identity` — 云厂商侧的工作负载身份方案

### 参考链接

- [SPIFFE 官方网站](https://spiffe.io/)
- [SPIFFE 概念](https://spiffe.io/docs/latest/spiffe-about/spiffe-concepts/)
- [SPIFFE ID 规范](https://github.com/spiffe/spiffe/blob/main/standards/SPIFFE-ID.md)
- [X.509-SVID 规范](https://github.com/spiffe/spiffe/blob/main/standards/X509-SVID.md)
- [JWT-SVID 规范](https://github.com/spiffe/spiffe/blob/main/standards/JWT-SVID.md)
- [SPIFFE Workload API 规范](https://github.com/spiffe/spiffe/blob/main/standards/SPIFFE_Workload_Endpoint.md)
