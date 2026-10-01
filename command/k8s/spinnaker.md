spinnaker
===

Kubernetes上的多云持续交付平台

## 补充说明

**Spinnaker** 是 Netflix 开源的持续交付平台,面向「多云 + 复杂发布策略」的场景,内置金丝雀发布、红黑部署、手工审批、回滚编排等能力。它本身是一组微服务,天然部署在 Kubernetes 上。

**安装方式的重大变更**:长期使用的 **Halyard(`hal` 命令)已被官方废弃**,`hal deploy apply` 那一套教程已经过时。当前的官方路径是 **kustomize 原生部署** —— 直接维护 Kubernetes 清单,用 `kubectl kustomize` 渲染后 apply。旧部署可以用官方迁移工具导出为 kustomize 风格,再逐步切换。

Spinnaker 的核心组件(都是 `spinnaker` 命名空间里的独立 Deployment):

- **deck** — Web UI,默认 9000 端口
- **gate** — API 网关,UI 与 CLI 的唯一入口,默认 8084 端口
- **orca** — 流水线编排引擎
- **clouddriver** — 云厂商适配层,真正执行部署动作
- **front50** — 应用与流水线元数据持久化
- **echo** — 事件总线与通知
- **igor** — 对接 Jenkins、GitLab 等 CI
- **rosco** — 镜像烘焙(Packer)
- **fiat** — 鉴权中心
- **kayenta** — 金丝雀自动分析

### 环境要求

官方给出的集群规格底线是 **至少 6 核 CPU 与 18GB 内存** —— Spinnaker 组件多、每个组件还带自己的 JVM,单节点测试集群基本跑不动。此外需要:

```shell
# kubectl 且内置 kustomize(kustomize 原生部署依赖它)
kubectl version --client

# 确认能连上目标集群
kubectl cluster-info
```

### 安装(kustomize 原生方式)

```shell
# 1. 准备工作目录
WORKING_DIR="$HOME/workspace-spinnaker-install"
mkdir -pv "$WORKING_DIR"

# 2. 克隆官方 monorepo(kustomize 清单在 spinnaker-kustomize 目录下)
git clone https://github.com/spinnaker/spinnaker.git "$WORKING_DIR"

# 3. 进入 kustomize 目录
pushd "$WORKING_DIR/spinnaker/spinnaker-kustomize"

# 4. 查看目录结构
ls -lha
ls -lha base/*/

# 5. 把清单里所有 example.com 换成自己的域名
grep -rn "example.com" .

# 6. 渲染清单
kubectl kustomize --output="spinnaker.yaml"

# 7. 应用
kubectl apply --filename="spinnaker.yaml"

# 8. 观察启动过程
kubectl get pods --namespace spinnaker --watch
kubectl get ingress --namespace spinnaker
```

版本通过 `spinnaker-kustomize/kustomization.yml` 中的镜像 tag 统一指定。自 2025 年起 monorepo 发布的所有 Spinnaker 版本共用同一套镜像 tag(形如 `2025.3.2`),改一处即可整栈升级,不要把各组件 tag 改成不同版本。

### 访问与验证

```shell
# 查看对外入口(默认 Ingress 主机名是 spinnaker.example.com)
kubectl get ingress --namespace spinnaker

# 没有 Ingress/DNS 时用端口转发临时访问
kubectl --namespace spinnaker port-forward svc/deck 9000:9000
kubectl --namespace spinnaker port-forward svc/gate 8084:8084

# 健康检查
curl -s http://localhost:8084/gate-api/health

# 浏览器访问 http://spinnaker.example.com/(或 http://localhost:9000)
```

默认账号密码配置在 `spinnaker-kustomize/overlays/config/files/gate-local.yml` 中。这套基础配置使用的是**简单的用户名/密码鉴权**,官方明确提示至少要先把鉴权配好再对外暴露,生产环境应切换到 OAuth2/SAML/LDAP(常见做法是接 Keycloak)。

### 常用运维命令

```shell
# 组件状态与日志
kubectl --namespace spinnaker get deploy
kubectl --namespace spinnaker get pods
kubectl --namespace spinnaker logs deploy/orca --tail=200
kubectl --namespace spinnaker logs deploy/clouddriver --tail=200
kubectl --namespace spinnaker logs deploy/gate --tail=200
kubectl --namespace spinnaker logs deploy/front50 --tail=200

# 重启单个组件(改配置后)
kubectl --namespace spinnaker rollout restart deploy/gate
kubectl --namespace spinnaker rollout status deploy/gate

# 渲染结果与集群对比
kubectl kustomize --output="spinnaker.yaml"
kubectl diff --filename="spinnaker.yaml"

# 升级:改完 kustomization.yml 的 tag 后重新渲染并应用
kubectl apply --filename="spinnaker.yaml"

# 卸载
kubectl delete --filename="spinnaker.yaml"
kubectl delete namespace spinnaker
```

### spin CLI

`spin` 是操作 Spinnaker 的官方命令行工具,直接调用 gate 的 API,适合把应用与流水线纳入 Git 管理:

```shell
# 安装(macOS)
brew install spin

# 配置 gate 地址
mkdir -p ~/.spin
cat > ~/.spin/config <<'EOF'
gate:
  endpoint: http://localhost:8084
EOF

# 应用管理
spin application list
spin application save --file app.json
spin application get --application myapp

# 流水线管理
spin pipeline list --application myapp
spin pipeline save --file pipeline.json
spin pipeline get --application myapp --name deploy-prod
spin pipeline execute --application myapp --name deploy-prod
spin pipeline delete --application myapp --name deploy-prod
```

### 接入目标集群

Spinnaker 部署应用的能力来自 clouddriver 里的「账号(Account)」。要让 Spinnaker 管理它所在的这个集群,需要先把它注册成一个 Kubernetes 账号,再在应用里选择该账号作为部署目标:

```shell
# 1. 确认 clouddriver 的 ServiceAccount 权限
kubectl --namespace spinnaker get sa

# 2. 在 overlays 中给 clouddriver 挂上目标集群的 kubeconfig 或使用集群内 ServiceAccount

# 3. 用 spin 验证账号是否可用(在 app.json 中指定 cloudProvider: kubernetes)
spin application save --file app.json
spin application get --application myapp
```

### 注意

1. **Halyard 已废弃,不要照着老教程装**。网上大量 `hal config` / `hal deploy apply` 的步骤已不再维护;新部署一律走 kustomize,旧环境用官方迁移工具导出后切换。
2. **默认配置的鉴权是明文用户名密码**。`gate-local.yml` 里的简单鉴权只是占位,官方原文即提示「强烈建议至少配置好鉴权」;不做鉴权就暴露 Ingress,等于把整个交付平台交给任何人。
3. **默认 Ingress 主机名是 `spinnaker.example.com`**。不改成自己的域名并配置 DNS 与证书,访问会落到不存在的域名上;生产环境应启用 cert-manager 走 HTTPS。
4. **集群规格不足会表现为「组件一直重启」**。18GB/6 核是底线,内存不足时 JVM 被 OOMKilled,日志里只有 `ExitCode 137`,很容易误判为配置错误。
5. **镜像 tag 必须整栈一致**。Spinnaker 各组件之间有严格的 API 契约,只把 orca 升到新版本、其余留在旧版本,会出现流水线卡死或序列化错误。版本统一在 `kustomization.yml` 里改。
6. **front50 的持久化必须换成外部存储**。默认配置面向演示,元数据落在集群内的存储中;一旦重建命名空间,所有应用与流水线定义随之消失,生产环境必须接对象存储(如 S3/MinIO)与数据库。
7. **组件启动有先后依赖**。gate 依赖 clouddriver 与 front50,启动早期报 `Connection refused` 属于正常现象;真正需要关注的是它长时间无法转为 Ready。
8. **`kubectl kustomize` 的版本很关键**。kustomize 的字段语义在不同版本间有差异,v5 起 `bases` 等旧字段被废弃;用独立 kustomize 二进制与用 kubectl 内置版本渲染,结果可能不同,团队内应统一。
9. **`spin` 需要单独登录/配置**。`spin` 不读 kubeconfig,只认 `~/.spin/config` 里的 gate 地址;gate 启用了鉴权后还需要配置 x509 证书或令牌,否则报 401。
10. **云账号是权限的边界**。一个 Spinnaker 账号对应一份云凭据,凭据过宽(如 cluster-admin)意味着任何能提交流水线的人都能操作整个集群;应配合 fiat 做应用级授权。
11. **升级前务必确认数据库兼容性**。Spinnaker 版本升级可能包含 front50/orca 的 schema 迁移,且不可回退;跨大版本升级前应先备份元数据。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kustomize` — Kubernetes声明式配置定制工具
- `argocd` — Kubernetes声明式GitOps持续交付工具
- `jenkins` — CI/CD自动化服务器

### 参考链接

- [Spinnaker 官方文档](https://spinnaker.io/docs/)
- [安装与配置 Spinnaker](https://spinnaker.io/docs/setup/install/)
- [kustomize 部署指南](https://spinnaker.io/docs/setup/install/deploy/)
- [从 Halyard/Operator 迁移到 kustomize](https://spinnaker.io/docs/setup/install/migration-to-kustomize-automation/)
- [spin CLI 仓库](https://github.com/spinnaker/spin)
