kubevela
===

基于OAM模型的应用交付平台,用声明式模板抽象Kubernetes复杂度

## 补充说明

**KubeVela** 是 CNCF 孵化中的现代化应用交付平台。它基于 **OAM(Open Application Model,开放应用模型)** 规范,把「一个应用由哪些组件构成、需要哪些运维特征、如何发布到多个环境」抽象成一层面向开发者的 API,让业务方不必直接面对 Deployment、Service、Ingress、HPA 这一堆原生资源。

它要解决的核心痛点是:**Kubernetes 的抽象层级对业务开发者太低**。一个「带域名、要扩到 5 副本、有健康检查」的 Web 服务,在原生 YAML 里可能要写四个资源、上百行配置;而在 KubeVela 里就是一个 `webservice` 组件加两个 trait。

### OAM 模型

KubeVela 的应用由四类概念组成:

```shell
Component     组件:应用的最小工作单元,如 webservice、worker、cron-task
Trait         特征:附加在组件上的运维能力,如 scaler、ingress、route、labels
Policy        策略:决定应用「部署到哪里、以什么形态部署」,如 topology、override
Workflow      工作流:描述发布过程,如多集群分批发布、人工审批、依赖编排
```

这四者的组合形成一个 `Application` 资源:

```shell
Application = Components + Traits + Policies + Workflow
```

背后的关键机制是 **Definition(定义)**:平台工程师用 **CUE 语言**编写 `ComponentDefinition`、`TraitDefinition`、`PolicyDefinition`、`WorkflowStepDefinition`,把「一个 webservice 组件应该渲染成哪些 Kubernetes 资源」固化下来。业务开发者只消费这些定义,写高层语义。

这意味着 KubeVela 的真正价值在于**平台工程**:把公司的标准化实践(镜像规范、资源配额、灰度策略、合规标签)编码进 Definition,让业务方的 YAML 天然符合规范,而不是靠文档和 code review 去约束。

### 安装

```shell
# 方式一:装到已有的 Kubernetes 集群上
helm repo add kubevela https://kubevela.github.io/charts
helm repo update
helm install --create-namespace -n vela-system kubevela kubevela/vela-core --wait

# 确认控制平面
kubectl get pods -n vela-system
kubectl api-resources | grep oam
```

安装 vela CLI:

```shell
# macOS / Linux
curl -fsSl https://kubevela.io/script/install.sh | bash

# Homebrew(仅正式版本)
brew update && brew install kubevela

# 验证
vela version
```

CLI 也可以在已有集群上一键安装控制平面:

```shell
vela install
```

### 方式二:VelaD 一体化安装

VelaD 是官方提供的「KubeVela + 依赖 + VelaUX」一体化工具,内部用 K3s/k3d 拉起集群,适合本机体验:

```shell
# 安装 VelaD
curl -fsSl https://kubevela.io/script/install-velad.sh | bash

# 本机安装(含集群)
velad install

# 远程主机安装
velad install --bind-ip=$SERVER_PUBLIC_IP

# 导出 kubeconfig
export KUBECONFIG=$(velad kubeconfig --host)
vela comp
velad uninstall
```


### 部署第一个应用

```shell
vela env init prod --namespace prod
vela up -f https://kubevela.io/example/applications/first-app.yaml
vela status first-vela-app
vela port-forward first-vela-app 8000:8000
vela delete first-vela-app
```

一份完整的多环境发布应用长这样:

```shell
apiVersion: core.oam.dev/v1beta1
kind: Application
metadata:
  name: first-vela-app
spec:
  components:
    - name: express-server
      type: webservice
      properties:
        image: oamdev/hello-world
        ports:
          - port: 8000
            expose: true
      traits:
        - type: scaler
          properties:
            replicas: 1
  policies:
    - name: target-default
      type: topology
      properties:
        clusters: ["local"]
        namespace: "default"
    - name: target-prod
      type: topology
      properties:
        clusters: ["local"]
        namespace: "prod"
    - name: deploy-ha
      type: override
      properties:
        components:
          - type: webservice
            traits:
              - type: scaler
                properties:
                  replicas: 2
  workflow:
    steps:
      - name: deploy2default
        type: deploy
        properties:
          policies: ["target-default"]
      - name: manual-approval
        type: suspend
      - name: deploy2prod
        type: deploy
        properties:
          policies: ["target-prod", "deploy-ha"]
```

`topology` 策略决定发到哪个集群的哪个命名空间,`override` 策略做差异化覆盖,`workflow` 用 `suspend` 步骤实现人工审批 —— 这就是 OAM 表达「灰度发布到多环境」的方式。

### 常用 CLI

```shell
# 应用生命周期
vela up -f app.yaml
vela status <app-name>
vela status <app-name> --tree
vela status <app-name> --endpoint
vela logs <app-name>
vela exec <app-name> -- ls -al
vela port-forward <app-name> 8080:80
vela delete <app-name>

# 工作流控制
vela workflow resume <app-name>
vela workflow suspend <app-name>
vela workflow terminate <app-name>
vela workflow logs <app-name> --step <step-name>

# 环境管理
vela env init dev --namespace dev
vela env ls

# 可用的组件与特征类型
vela comp
vela trait
vela def list
```

### 多集群

```shell
# 纳管成员集群
vela cluster list
vela cluster join ~/.kube/member1.config
vela cluster rename <cluster-name> <new-name>
vela cluster detach <cluster-name>
```

纳管之后,`topology` 策略里的 `clusters` 就能直接引用这些集群。

### 插件与 UI

```shell
# 查看可用插件
vela addon list

# 启用 VelaUX 可视化控制台
vela addon enable velaux

# 取访问地址
vela status addon-velaux -n vela-system --endpoint

# 本地端口转发访问
vela port-forward addon-velaux -n vela-system 8080:80

# 暴露为 NodePort(远程主机)
vela addon enable velaux serviceType=NodePort

# VelaD 环境下从本地目录启用
vela addon enable ~/.vela/addons/velaux
```

VelaUX 默认账号 `admin`,初始密码 `VelaUX12345`,首次登录会强制修改。

### 编写自定义 Definition

平台工程师用 CUE 定义新的组件类型:

```shell
apiVersion: core.oam.dev/v1beta1
kind: ComponentDefinition
metadata:
  name: my-webservice
  namespace: vela-system
spec:
  workload:
    definition:
      apiVersion: apps/v1
      kind: Deployment
  schematic:
    cue:
      template: |
        output: {
          apiVersion: "apps/v1"
          kind:       "Deployment"
          spec: {
            selector: matchLabels: app: context.name
            template: {
              metadata: labels: app: context.name
              spec: containers: [{name: context.name, image: parameter.image}]
            }
          }
        }
        parameter: {image: string}
```

保存后用 `vela def apply` 注册,业务方就能直接使用 `type: my-webservice`。

### 注意

1. **KubeVela 是平台工程工具,不是「更简单的 kubectl」**。它的收益来自「用 Definition 收敛规范」,如果只是把原生 YAML 换成一层 OAM 包装、不做任何约束,反而多了一层间接。上手前先想清楚要解决的是「谁写 YAML」的问题。
2. **Definition 用 CUE 编写,学习曲线不低**。CUE 的语法与类型系统对多数运维人员是全新的,排查模板渲染问题(如 `vela status --tree` 里资源对不上)需要能读懂 CUE。这是 KubeVela 最主要的隐性成本。
3. **`Application` 是唯一的交付入口**。直接 `kubectl apply` 一个 Deployment 也能跑,但不受 KubeVela 管理,不会被 `vela status` 看到,也不会被回收。混用两套方式会让「谁在管这个资源」变得模糊。
4. **`override` 策略是按组件类型匹配的,不是按组件名**。写 `type: webservice` 会命中该应用下**所有** webservice 组件,只想改一个组件时要配合 `name` 字段。
5. **`topology` 策略里的 namespace 必须提前存在**。KubeVela 不会因为策略里写了 `prod` 就去创建这个命名空间,缺失时工作流会在部署步骤报错。
6. **工作流的 `suspend` 步骤会一直等待**,直到有人执行 `vela workflow resume`。这在生产是优点(人工卡点),在测试环境是坑(忘了 resume,应用一直卡在 `workflowSuspending`)。CI 里自动化时要显式 resume 或改用别的步骤类型。
7. **插件(addon)体系庞大但质量参差**。`vela addon list` 里有几十个插件,部分插件版本滞后于上游组件。生产环境建议只启用需要的,并锁定版本。
8. **多集群能力基于 KubeVela 自己的 cluster 注册机制**,与 Cluster API、Karmada 的集群概念互不相通。同时使用多套多集群方案时,集群身份需要各自维护一遍。
9. **KubeVela 只维护最近两个版本**,发布节奏约 2-3 个月一次。升级跨度大时不要跳版本,按官方迁移文档逐步走;文档站上的旧版本页面会标注「不再积极维护」,别照着 v1.2、v1.7 的文档操作新集群。
10. **VelaUX 的默认密码必须第一时间修改**。用 VelaD 或 addon 启起来的 VelaUX 使用统一初始密码,直接暴露到公网等于把交付平台交出去。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `helm` — KubeVela 的安装方式
- `karmada` — 另一种多集群调度方案
- `argocd` — GitOps 交付方案
- `flux` — GitOps 交付方案

### 参考链接

- [KubeVela 官方文档](https://kubevela.io/docs/)
- [KubeVela 安装指南](https://kubevela.io/docs/installation/kubernetes)
- [OAM 应用模型说明](https://kubevela.io/docs/platform-engineers/oam/oam-model/)
- [VelaD 一体化安装](https://kubevela.io/docs/installation/standalone)
- [KubeVela GitHub 仓库](https://github.com/kubevela/kubevela)
