rancher
===

企业级多集群Kubernetes管理平台,统一纳管与分发应用

## 补充说明

**Rancher** 是 SUSE 开源的多集群 Kubernetes 管理平台,Apache 2.0 协议。它本身不是 Kubernetes 发行版,而是**装在一个 Kubernetes 集群上的管理平面**:通过它的 Web UI 或 API,可以创建、导入、升级、监控几十甚至上百个下游集群,并在所有集群上统一部署应用。

Rancher 解决的问题是**集群数量增长后的运维失控**:当你有 3 个集群时,kubeconfig 切换还能忍;有 30 个集群、分布在三个云和两个机房时,版本一致性、证书到期、谁改了 RBAC、某个应用只在部分集群上生效——这些都需要一个中心。

SUSE 提供两个版本:

```shell
Rancher Community   开源版,Apache 2.0,社区支持
Rancher Prime       商业版,含长期支持、安全补丁与厂商支持
```

两者代码同源,Prime 主要多了支持周期与合规能力。

### 架构:下游集群与 Agent

理解 Rancher 的关键在于**通信方向**:

```shell
下游集群(downstream cluster)
    │
    │  cattle-cluster-agent 主动向外连接(443)
    ▼
Rancher Server(管理集群)
```

**Rancher 从不主动连进下游集群**,而是由下游集群里的 `cattle-cluster-agent` 主动连出来。这个设计意味着:

- 下游集群不需要对 Rancher 开放任何入站端口,可以藏在 NAT 或防火墙后面。
- Rancher 挂掉时,下游集群的业务照常运行,只是无法再通过 Rancher 做变更。
- Agent 的凭据泄露等于该集群被接管,证书轮换很重要。

另外还有一个 `cattle-node-agent` 以 DaemonSet 形式运行,负责节点级的操作(如 etcd 快照恢复、节点清理)。

### 安装方式

Rancher 官方推荐用 **Helm 装在已有的 Kubernetes 集群上**;单容器 `docker run` 的方式仅适合快速体验,已被明确标注不适合生产。

### 方式一:Helm 安装(推荐)

前置条件:一个可用的 Kubernetes 集群、已装 `kubectl` 与 `helm`、一个 Ingress Controller(K3s/RKE2 自带)。

```shell
# 1. 添加 Helm 仓库
helm repo add rancher-latest https://releases.rancher.com/server-charts/latest
helm repo add rancher-stable https://releases.rancher.com/server-charts/stable
helm repo add rancher-alpha  https://releases.rancher.com/server-charts/alpha
helm repo update

# 2. 创建命名空间(必须是 cattle-system,发布名建议固定为 rancher)
kubectl create namespace cattle-system
```

3. 安装 cert-manager(Rancher 需要它签发内部证书,除非你自带证书):

```shell
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.18.0/cert-manager.crds.yaml
helm repo add jetstack https://charts.jetstack.io
helm repo update
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set crds.enabled=true
```

4. 安装 Rancher:

```shell
# 使用 Rancher 自签 CA(默认)
helm install rancher rancher-stable/rancher \
  --namespace cattle-system \
  --set hostname=rancher.example.com \
  --set bootstrapPassword=admin

# 使用 Let's Encrypt
helm install rancher rancher-stable/rancher \
  --namespace cattle-system \
  --set hostname=rancher.example.com \
  --set bootstrapPassword=admin \
  --set ingress.tls.source=letsEncrypt \
  --set letsEncrypt.email=ops@example.com \
  --set letsEncrypt.ingress.class=nginx

# 使用自有证书(把 tls.crt / tls.key 提前放进 cattle-system 的 Secret)
helm install rancher rancher-stable/rancher \
  --namespace cattle-system \
  --set hostname=rancher.example.com \
  --set ingress.tls.source=secret

# 指定版本
helm install rancher rancher-stable/rancher --version 2.15.1 ...
```

5. 验证:

```shell
kubectl -n cattle-system rollout status deploy/rancher
kubectl -n cattle-system get deploy rancher
kubectl -n cattle-system get pods
```

6. 取初始密码:

```shell
kubectl get secret --namespace cattle-system bootstrap-secret \
  -o go-template='{{.data.bootstrapPassword|base64decode}}'
```

**安装时用到的 `--set` 参数必须记录下来**,后续 `helm upgrade` 时一个都不能少,否则配置会被重置。

### 方式二:单容器安装(仅体验)

```shell
docker run -d --restart=unless-stopped \
  -p 80:80 -p 443:443 \
  --privileged \
  rancher/rancher:latest

# 取初始密码
docker logs <container-id> 2>&1 | grep "Bootstrap Password:"
```

### 纳管下游集群

```shell
# 1. 在 Rancher UI 中:Cluster Management → Import Existing → Create
#    会得到一条带 token 的指令,形如:
kubectl apply -f https://rancher.example.com/v3/import/<token>.yaml

# 2. 在下游集群执行后,Agent 会被部署
kubectl -n cattle-system get pods
kubectl -n cattle-system logs deploy/cattle-cluster-agent

# 3. 在 Rancher 中确认状态变为 Active
```

该导入清单实际创建的是 `cattle-cluster-agent` 的 Deployment 与相关 RBAC。

### Authorized Cluster Endpoint(ACE)

默认情况下,通过 Rancher 操作下游集群的所有 kubectl 请求都要经过 Rancher Server 中转,链路长且 Rancher 是单点。**ACE** 允许 kubectl 直连下游集群的 API Server:

```shell
# 在 Rancher 中为集群启用 ACE,并指定对外暴露的地址
kubectl config use-context <downstream-cluster>
kubectl get nodes       # 此时已直连下游集群
```

适合大规模集群与网络延迟敏感的场景。

### 应用与 GitOps

```shell
# Fleet:Rancher 内置的 GitOps 引擎,可向成千上万个集群分发应用
# UI 中:Continuous Delivery → Git Repos → 添加仓库
# Fleet 会为匹配的集群生成 Bundle 与 GitRepo 资源
kubectl -n cattle-fleet-system get gitrepos
kubectl -n cattle-fleet-system get bundles
```

Rancher 也支持原生的 Helm 应用市场(Apps & Marketplace),以及通过 Fleet 做集群级的 YAML 分发。

### 集群升级

K3s 与 RKE2 集群可以通过 Rancher 直接升级,Rancher 会在下游集群部署 **system-upgrade-controller**,以声明式的 Plan 逐个节点滚动升级:

```shell
# 下游集群中会看到
kubectl -n cattle-system get plans
kubectl -n cattle-system get jobs
```

### 集群模板与 CAPI

Rancher 早期内置了一套 Cluster API 集成(`rancher-provisioning-capi`)。从 **Rancher v2.14 起,内置 CAPI 功能被移除**,官方统一改为通过 **Rancher Turtles** 集成:

```shell
# Turtles 以 operator 形式装到 Rancher 所在的集群上
# 升级到 2.14 时会被自动迁移,但手工禁用过 Turtles 的需要重新启用
kubectl get pods -n rancher-turtles-system
kubectl get clusters.cluster.x-k8s.io -A
```

### 升级 Rancher 自身

```shell
helm repo update
helm upgrade rancher rancher-stable/rancher \
  --namespace cattle-system \
  --version 2.15.1 \
  --set hostname=rancher.example.com \
  --set bootstrapPassword=admin
  # 其余安装时的 --set 参数需一并带上
```

### 注意

1. **安装时的 `--set` 参数必须在每次 `helm upgrade` 时重复一遍**。漏掉 `hostname`、`ingress.tls.source` 这类参数会导致 Ingress 与证书配置被重置,是最常见的「升级后访问不了」原因。建议把参数写进 values 文件并纳入版本管理。
2. **命名空间必须是 `cattle-system`,发布名建议固定为 `rancher`**。官方文档明确要求,改名会带来一堆意料之外的路径问题。
3. **`bootstrapPassword` 只在首次安装时生效**。安装完成、完成初始化设置后,该密码不再有用;忘记了就用 `bootstrap-secret` 那条命令取。
4. **Rancher 与下游集群的通信是「下游主动外连」**。因此防火墙只需放行下游 → Rancher 的 443,不需要反向放行。反过来,如果 Agent 连不上 Rancher,通常表现为集群状态一直 `Unavailable`,先查下游集群到 Rancher 域名的 DNS 与出站连通性。
5. **不要把 Rancher 装到它自己管理的下游集群上**。Rancher Server 所在的集群不应再由这个 Rancher 实例纳管,否则会形成循环,升级时可能把自己搞挂。
6. **单容器安装方式不适合生产**。它没有高可用、升级等于重建容器、数据存在容器卷里,官方已不建议;生产请用 Helm + 多副本。
7. **Rancher v2.14 起内置的 CAPI 功能已被移除**。升级后统一由 Rancher Turtles 承接,自动迁移虽然会自动进行,但**手工禁用过 Turtles 的实例不会被自动恢复**,升级后需要人工确认 `rancher-turtles-system` 下的组件是否正常运行。
8. **Rancher 自身也需要备份**。管理平面数据库丢了,所有下游集群的纳管关系与配置都要重建(业务本身不受影响,但运维入口没了)。Rancher 提供了基于 `rancher-backup` operator 的备份恢复方案。
9. **Agent 的证书与 token 是集群的接管凭据**。`cattle-cluster-agent` 的 Secret 泄露等于集群被接管,轮换证书要用 Rancher 提供的流程,不要直接删 Pod 了事。
10. **对下游集群的 kubectl 操作默认经过 Rancher 中转**,大规模集群或跨地域时会明显变慢。启用 ACE 可以绕过,但要注意此时 Rancher 的审计与 RBAC 不再拦截直连流量。
11. **版本升级有顺序要求**:先升 Rancher 自身,再升下游集群的 Kubernetes 版本;同时注意 Rancher 版本与 Kubernetes 版本的兼容矩阵,不要先升 K8s 再升 Rancher。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `helm` — Rancher 的推荐安装方式
- `k3s` — 常与 Rancher 搭配的轻量发行版
- `cluster-api` — Rancher Turtles 集成的上游项目
- `argocd` — 另一种 GitOps 交付方案

### 参考链接

- [Rancher 官方文档](https://ranchermanager.docs.rancher.com/)
- [在 Kubernetes 集群上安装 Rancher](https://ranchermanager.docs.rancher.com/getting-started/installation-and-upgrade/install-upgrade-on-a-kubernetes-cluster)
- [Rancher 与 Kubernetes 版本支持矩阵](https://www.suse.com/suse-rancher/support-matrix/all-supported-versions/)
- [Rancher Turtles 文档](https://turtles.docs.rancher.com/)
- [Rancher GitHub 仓库](https://github.com/rancher/rancher)
