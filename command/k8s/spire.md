spire
===

SPIFFE运行时环境,为工作负载签发与轮换短期身份凭证的参考实现

## 补充说明

**SPIRE**(SPIFFE Runtime Environment)是 SPIFFE 规范的**参考实现**,也是目前生产环境中最主流的落地方式。它的职责可以一句话概括:**在不预先分发任何密钥的前提下,让一个工作负载拿到一张证明「它是谁」的短期证书,并自动轮换。**

SPIFFE 与 SPIRE 于 **2022-09-20 从 CNCF 毕业**,是工作负载身份领域成熟度最高的项目。当前版本线为 `1.15.x`(1.15.3 发布于 2026-08-21),迭代节奏稳定。

它解决的问题是传统的「共享密钥」困境:两个服务要互信,传统做法是预置一个 Token 或密码,于是就有了分发、存储、轮换、泄露、审计这一整条麻烦链。SPIRE 的做法是让服务**用自己已有的属性(命名空间、ServiceAccount、镜像、节点)证明身份**,签发一张几分钟到几小时有效期的证书,过期自动换新 —— 全程没有任何长期密钥落到磁盘上。

### 架构

SPIRE 由两个组件构成,职责划分很清楚:

```shell
SPIRE Server   集群级,单实例或 HA 部署
  - 持有 CA(自签或上游 PKI)
  - 保存注册条目(谁有资格拿到什么身份)
  - 存储后端(datastore),HA 时必须用外部数据库

SPIRE Agent    节点级,DaemonSet 每个节点一个
  - 向 Server 证明「我运行在哪个节点上」(节点证明)
  - 向 Server 证明「某个进程是谁」(工作负载证明)
  - 通过本地 Unix socket 把 SVID 交给工作负载
```

注意 Agent 是**唯一**对工作负载暴露接口的组件,而 Server 完全不需要工作负载直接访问 —— 这个设计让 Workload API 天然是「节点本地」的。

### 节点证明:k8s_psat

Agent 启动后第一件事是向 Server 证明自己的身份。Kubernetes 上使用的是 **`k8s_psat`**(PSAT = Projected Service Account Token)节点证明插件,原理是 Agent 把自己的投影 ServiceAccount token 交给 Server,Server 调用 kube-apiserver 的 TokenReview 接口验证。

Server 侧配置:

```shell
NodeAttestor "k8s_psat" {
  plugin_data {
    clusters = {
      "demo-cluster" = {
        # 允许哪些 ServiceAccount 作为 Agent 运行
        service_account_allow_list = ["spire:spire-agent"]

        # token 校验的受众,默认 ["spire-server"]
        audience = ["spire-server"]

        # Server 部署在集群内时留空,走 in-cluster 配置
        kube_config_file = ""

        # 允许哪些节点标签/ Pod 标签参与后续选择器
        allowed_node_label_keys = ["topology.kubernetes.io/zone"]
        allowed_pod_label_keys  = ["app"]
      }
    }
  }
}
```

各字段的确切含义:

| 字段 | 说明 |
| --- | --- |
| `clusters` | 以任意 ID 为键的集群映射。**为空时不会有任何集群被授权** |
| `service_account_allow_list` | 允许充当 Agent 的 ServiceAccount,格式 `namespace:name` |
| `audience` | token 受众;设为 `[]` 表示使用 API Server 的 audience。默认 `["spire-server"]` |
| `kube_config_file` | Server 跑在集群外时必填;为空则以 in-cluster 配置访问 API |
| `allowed_node_label_keys` / `allowed_pod_label_keys` | 哪些标签允许进入选择器 |
| `use_pod_uid_for_agent_id` | 用 Pod UID 而非节点 UID 生成 Agent ID,默认 `false` |

Agent 侧配置:

```shell
NodeAttestor "k8s_psat" {
  plugin_data {
    cluster = "demo-cluster"        # 必须与 Server 侧 clusters 的键一致
  }
}
```

**Agent 的 SPIFFE ID 格式是固定的**(这决定了注册条目里 `-parentID` 怎么写):

```shell
spiffe://<trust_domain>/spire/agent/k8s_psat/<cluster>/<node UID>

# use_pod_uid_for_agent_id = true 时变成
spiffe://<trust_domain>/spire/agent/k8s_psat/<cluster>/pod/<pod UID>
```

### 工作负载证明:k8s

Agent 收到工作负载的连接请求后,通过 kubelet 的 API 反查这个进程属于哪个 Pod,再据此判断身份。它产出的选择器(selector)是注册条目的匹配依据:

```shell
k8s:ns                     命名空间
k8s:sa                     ServiceAccount
k8s:pod-name               Pod 名
k8s:pod-uid                Pod UID
k8s:pod-label              Pod 标签(带 sigil)
k8s:pod-owner / k8s:pod-owner-uid
k8s:container-name         容器名
k8s:container-image        容器镜像
k8s:pod-image / k8s:pod-image-count
k8s:pod-init-image / k8s:pod-init-image-count
k8s:node-name              节点名
k8s:ns-label               命名空间标签(需显式开启 enable_namespace_labels)
```

**注解(annotation)不会被暴露为选择器**,这是有意为之的设计 —— 注解通常由有权限改 Pod 的人任意修改,不适合做安全判据。

### 注册条目

注册条目(registration entry)决定「谁 → 拿到什么身份」。它由**父 ID + 一组选择器**两部分组成:

```shell
# 第一步:节点别名条目(让 Agent 自己先有身份),必须带 -node
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry create \
    -spiffeID spiffe://example.org/ns/spire/sa/spire-agent \
    -selector k8s_psat:cluster:demo-cluster \
    -selector k8s_psat:agent_ns:spire \
    -selector k8s_psat:agent_sa:spire-agent \
    -node

# 第二步:工作负载条目,parentID 指向刚才那个 Agent 身份
kubectl exec -n spire spire-server-0 -- \
  /opt/spire/bin/spire-server entry create \
    -spiffeID spiffe://example.org/ns/default/sa/my-app \
    -parentID spiffe://example.org/ns/spire/sa/spire-agent \
    -selector k8s:ns:default \
    -selector k8s:sa:my-app \
    -ttl 3600 \
    -dns my-app.default.svc.cluster.local

# 查看与清理
spire-server entry show                    # 查看全部条目
spire-server entry delete -entryID <id>    # 删除
```

`entry create` 常用标志:

```shell
-spiffeID      签发的 SPIFFE ID(必填)
-parentID      父条目 ID;省略时配合 -node 表示节点条目
-selector      匹配条件,可重复出现(同一 -selector 类型多值时是「或」)
-node          标记为节点条目
-ttl           SVID 有效期上限
-dns           写入 X.509-SVID 的 DNS SAN
-federatesWith 需要联邦的其他信任域
```

### 在 Kubernetes 上部署

官方推荐用 **Helm chart**(`spire` chart,仓库 `https://spiffe.github.io/helm-charts-hardened/`),它会一并部署 Server、Agent、Controller Manager、SPIFFE CSI Driver 与 OIDC Discovery Provider:

```shell
helm repo add spiffe https://spiffe.github.io/helm-charts-hardened/
helm repo update

# CRD 单独一个 chart
helm upgrade --install -n spire-server spire-crds spire-crds \
  --repo https://spiffe.github.io/helm-charts-hardened/ --create-namespace

helm upgrade --install -n spire-server spire spire \
  --repo https://spiffe.github.io/helm-charts-hardened/
```

手工部署时,Server 是 **StatefulSet**(`spire-server-0`),Agent 是 **DaemonSet**;Server 需要对其所在命名空间的 ConfigMap 有 `get/patch` 权限,用于轮换 Agent 验证证书。工作负载侧把 Agent 的 Unix socket 挂进容器即可:

```shell
# Agent 暴露给工作负载的 socket(官方客户端常用 SPIFFE_ENDPOINT_SOCKET 指向它)
/run/spire/sockets/agent.sock

# 验证:在业务 Pod 里直接 fetch
spire-agent api fetch -socketPath /run/spire/sockets/agent.sock
```

### ClusterSPIFFEID:声明式注册

手工 `entry create` 在规模化场景下不可维护。**spire-controller-manager** 提供了 CRD 来把注册条目声明式化:

```shell
apiVersion: spire.spiffe.io/v1alpha1
kind: ClusterSPIFFEID
metadata:
  name: my-app
spec:
  spiffeIDTemplate: "spiffe://example.org/ns/{{ .PodMeta.Namespace }}/sa/{{ .PodSpec.ServiceAccountName }}"
  podSelector:
    matchLabels:
      spiffe.io/spire-managed-identity: "true"
  namespaceSelector:
    matchExpressions:
      - key: kubernetes.io/metadata.name
        operator: NotIn
        values: ["kube-system", "spire-server"]
  dnsNameTemplates:
    - "{{ .PodMeta.Name }}.{{ .PodMeta.Namespace }}.svc.cluster.local"
  ttl: 1h
  jwtTtl: 10m
  federatesWith: ["other.example.org"]
```

`spiffeIDTemplate` 是**必填**字段,使用 Go 的 `text/template` 语法,可用数据包括 `.TrustDomain`、`.ClusterName`、`.ClusterDomain`、`.PodMeta`、`.PodSpec`、`.NodeMeta`、`.NodeSpec`。其余可选字段:`podSelector`、`namespaceSelector`、`dnsNameTemplates`、`workloadSelectorTemplates`、`ttl`、`jwtTtl`、`federatesWith`、`admin`、`downstream`、`autoPopulateDNSNames`、`fallback`、`className`。

### HA 与 datastore

```shell
- 单机/测试:内置 sql 插件 + sqlite3。简单,但【不支持 HA】
- 生产 HA:内置 sql 插件 + PostgreSQL 或 MySQL,多个 Server 实例共享同一个库
- 只有内置的 sql 插件可用,自定义 datastore 插件已不再支持
```

配置形如:

```shell
server {
  trust_domain = "example.org"
  data_dir     = "/run/spire/data"
  bind_address = "0.0.0.0"
  bind_port    = "8081"
  ca_ttl       = "24h"          # 默认 24h
  ca_key_type  = "ec-p256"      # 默认 ec-p256
}

plugins {
  DataStore "sql" {
    plugin_data {
      database_type     = "postgres"
      connection_string = "postgres://spire:pass@db:5432/spire?sslmode=require"
    }
  }
}
```

### 与 Kubernetes ServiceAccount 的关系

两者不是替代关系,而是**互补**,并且经常配合使用:

| | ServiceAccount token | SPIFFE SVID |
| --- | --- | --- |
| 面向对象 | kube-apiserver | 任意服务(不限于 k8s) |
| 格式 | JWT | X.509 证书或 JWT |
| 身份粒度 | 命名空间 + SA | 可细化到镜像、标签、容器 |
| 用途 | 调用 k8s API | 服务间 mTLS、云资源访问、跨集群联邦 |

常见的组合方式是:**把 ServiceAccount 当作 SPIRE 的证明素材之一**(`k8s:ns` + `k8s:sa`),再让业务用 SVID 做服务间认证。

### 注意

1. **SPIRE Server 单点会拖垮全集群身份签发**。Server 挂了,新 Pod 拿不到 SVID,已有 SVID 到期后也无法续签,表现为大规模服务间调用 TLS 握手失败。生产必须 HA:多 Server 实例 + 外部数据库(PostgreSQL/MySQL),sqlite3 只适合单机测试。
2. **HA 的前提是共享 datastore,不是多副本**。多个 Server 实例各写各的 sqlite 文件等于多套互不相识的身份体系。同时 `spire-controller-manager` 需要靠 leader election 保证同一时刻只有一个实例在写注册条目。
3. **`k8s_psat` 的 `clusters` 为空意味着拒绝一切证明**。这是一个很容易踩的配置陷阱:配置写错或漏写 `clusters`,不会报错,只是所有 Agent 都连不上,日志里全是证明失败。Agent 侧的 `cluster` 名也必须与 Server 侧 `clusters` 的**键**完全一致。
4. **`use_pod_uid_for_agent_id` 会改变 Agent ID 的格式**,从 `<cluster>/<node UID>` 变成 `<cluster>/pod/<pod UID>`。一旦开启,所有引用旧格式 `-parentID` 的注册条目全部失效。切换前必须同步改掉全部条目。
5. **SPIFFE ID 的路径段有严格命名限制**。按规范:trust domain 必须全小写、只能含 `[a-z0-9.-_]`;路径段只能含 `[a-zA-Z0-9.-_]`,不允许空段、`.`、`..`、结尾 `/`,也不允许 percent-encoding;整体长度上限 2048 字节,trust domain 最长 255 字节。**把随意的字符串塞进路径会在签发时失败。**
6. **规范禁止 SPIFFE ID 带 query 或 fragment**,也没有端口与 userinfo。任何形如 `spiffe://example.org:8080/foo` 或 `spiffe://example.org/foo?x=1` 的写法都是非法的。
7. **注解不会成为选择器**。想靠 `kubectl annotate` 给工作负载「打标签发身份」的做法在 k8s 工作负载证明插件上走不通 —— 只有上述固定列表里的选择器可用。
8. **证书有效期短是特性不是缺陷**。X.509-SVID 的 TTL 通常几分钟到几小时,业务必须通过 Workload API **持续订阅**而不是「启动时取一次存到磁盘」。把 SVID 落盘缓存是反模式,既失去短有效期的意义,又会在轮换时读到过期文件。
9. **Server 的 CA 私钥是整个信任域的根**。它存在 datastore 里,一旦泄露等同于所有身份可被伪造。生产环境应把 `UpstreamAuthority` 指向真实 PKI(如 Vault、AWS ACM PCA),而不是用 SPIRE 自签 CA 当根。
10. **时钟漂移会直接导致证明失败**。短期证书对时间极为敏感,节点间时钟偏差超过几十秒就会出现「证书尚未生效 / 已过期」的间歇性错误。所有节点必须开启 NTP。
11. **`ClusterSPIFFEID` 的模板渲染失败是静默的**。模板写错(`.PodSpec.ServiceAccountName` 拼错等)不会阻止 CR 创建,只是对应 Pod 拿不到条目;排查要看 `status.stats` 里的 `podEntryRenderFailures` 计数。
12. **Agent 必须能访问 kubelet API** 才能做工作负载证明。kubelet 端口被防火墙拦截、或 Agent 没有相应 RBAC 时,工作负载证明会失败,但错误往往只出现在 Agent 日志里,业务侧只看到「连接 socket 超时」。

### 相关命令

- `spiffe` — SPIFFE 规范与身份模型
- `serviceaccount` — SPIRE 在 k8s 上的证明素材来源
- `cert-manager` — 另一类证书管理方案,面向 Ingress/服务端 TLS
- `workload-identity` — 云厂商侧的同类能力,面向云资源访问

### 参考链接

- [SPIRE 官方文档](https://spiffe.io/docs/latest/)
- [SPIFFE 概念](https://spiffe.io/docs/latest/spiffe-about/spiffe-concepts/)
- [Kubernetes 快速上手](https://spiffe.io/docs/latest/try/getting-started-k8s/)
- [k8s_psat 节点证明插件](https://github.com/spiffe/spire/blob/main/doc/plugin_server_nodeattestor_k8s_psat.md)
- [k8s 工作负载证明插件](https://github.com/spiffe/spire/blob/main/doc/plugin_agent_workloadattestor_k8s.md)
- [SPIRE Controller Manager](https://github.com/spiffe/spire-controller-manager)
- [SPIFFE/SPIRE CNCF 毕业公告](https://www.cncf.io/announcements/2022/09/20/spiffe-and-spire-projects-graduate-from-cloud-native-computing-foundation-incubator/)
