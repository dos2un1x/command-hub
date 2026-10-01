kubeflow
===

Kubernetes上的机器学习平台套件(笔记本/训练/流水线/推理)

## 补充说明

**Kubeflow** 不是单一软件,而是一整套 ML 平台组件的**发行版**:把笔记本、训练作业、流水线、模型服务、超参搜索、多租户隔离这些东西装在同一个集群里,共用一套身份与网络。它由多个子项目组成,每个子项目也可以单独安装。

**状态要点(先看这三条,能省不少时间)**:

```shell
1. Kubeflow 已在 2026-08 从 CNCF 毕业(Graduated)
   之前是 incubating(2023 加入)

2. 承载安装清单的仓库已改名
   github.com/kubeflow/manifests → github.com/kubeflow/community-distribution
   产品名随之称为 Kubeflow Community Distribution / Kubeflow Platform

3. kfctl 已归档(最后推送 2023-08),它不是安装方式了
   现在唯一受支持的方式是 kustomize + kubectl
```

版本改为**日历式版本号**(CalVer),节奏大约是每年两个版本、每个版本尽力维护 6 个月:

```shell
26.03.1     2026-06-15(当前稳定版)
26.03       2026-03-22
v1.11.0     2025-12-15
v1.10.2     2025-07-18
```

### 组件构成

发行版的清单分三层组织:`common/`(公共基础设施)、`applications/`(各组件)、`experimental/`(第三方,如 KubeRay)。`example/kustomization.yaml` 默认装的是:

```shell
公共层
  cert-manager       证书管理
  Istio              istio-crds + istio-namespace + istio-install(默认 oauth2-proxy overlay)
  oauth2-proxy       身份代理
  Dex               OIDC 提供方(内置静态账号)
  Knative Serving    默认安装(Knative Eventing 被注释掉)
  cluster-local-gateway、kubeflow-namespace、kubeflow-roles、
  kubeflow-istio-resources、user-namespace

应用层
  pipeline           Kubeflow Pipelines
  katib              超参搜索
  dashboard          Central Dashboard
  notebooks-v1       Jupyter 笔记本
  trainer            Kubeflow Trainer v2(Training Operator 的继任者)
  kserve + kserve-ui 模型服务
  spark-operator     Spark 作业
  hub                模型注册表与模型目录
```

**被注释掉、默认不装的**:`experimental/ray/kuberay-operator`、**Workspaces(Notebooks v2)**(官方标注 pre-GA,`DO NOT DEPLOY THIS TO A PRODUCTION CLUSTER`)、pipeline 的 K8s 原生模式、Knative Eventing。

两个重要的缺席者:**Training Operator v1 与 MPI Operator 都不在默认发行版里**,前者已被 Trainer v2 取代,后者是独立子项目。老文档里「Kubeflow 装了就有 TFJob/PyTorchJob」的说法已经不成立。

各组件版本与资源占用(发行版 `master` 的快照):

```shell
组件                上游版本      CPU     内存      PVC
Trainer             v2.3.0        8m      143Mi     0
Notebooks(v1)       v1.11.0      43m      806Mi     0
Dashboard           v2.0.0       10m      302Mi     0
Katib               v0.19.0      13m      476Mi     10GB
KServe              v0.20.0     600m     1200Mi     0
KServe UI           v1.0.1        6m      259Mi     0
Kubeflow Pipelines  2.17.2      970m     3552Mi     35GB
Hub                 v0.3.16     510m     2112Mi     20GB
Spark Operator      2.5.2         9m       41Mi     0
Istio               1.31.0      750m     2364Mi     0
Knative             v1.23.0    1450m     1038Mi     0
cert-manager        1.21.1        3m      128Mi     0
Dex                 2.45.1        3m       27Mi     0
oauth2-proxy        7.15.4        3m       27Mi     0
合计                            4377m    12316Mi    65GB
```

也就是说:**全套装下来大约需要 4.4 核、12GB 内存与 65GB 存储**,官方给的推荐规格是 8 核 16GB 以上。

### 安装

唯一受支持的方式是 kustomize 逐层 apply,而且**第一次 apply 失败是正常现象**(CRD 与 webhook 之间存在依赖),官方给出的写法是循环重试:

```shell
git clone https://github.com/kubeflow/community-distribution.git
cd community-distribution

while ! kustomize build example | kubectl apply --server-side --force-conflicts -f -; do
  echo "Retrying to apply resources"
  sleep 20
done
```

资源紧张时可以从 `example/kustomization.yaml` 里删掉组件,官方说可以压到 4-8GB 内存 / 2-4 核。

访问入口(先端口转发到网关):

```shell
kubectl port-forward svc/istio-ingressgateway -n istio-system 8080:80
# 浏览器打开 http://localhost:8080
```

**默认账号是 `user@example.com` / `12341234`**(Dex 的静态密码),生产环境必须改:

```shell
# 方式一:改 common/dex/base/dex-passwords.yaml 后重新 apply
# 方式二:删掉 auth 命名空间里的 dex-passwords Secret 并重建
kubectl delete secret dex-passwords -n auth
```

注意用 NodePort / LoadBalancer / Ingress 暴露时**必须启用 HTTPS**:登录组件用的是安全 Cookie,纯 HTTP 下会登录不上。

### 多租户:Profile

多租户靠 `Profile` 对象实现(API 版本 **`kubeflow.org/v1`**,CRD 是 `profiles.kubeflow.org`):

```shell
apiVersion: kubeflow.org/v1
kind: Profile
metadata:
  name: my-profile          # 这个名字会成为命名空间名
spec:
  owner:
    kind: User
    name: user@example.com
  resourceQuotaSpec: {}
```

创建 Profile 时,Profile Controller 会连带创建:命名空间、`namespaceAdmin` 的 RoleBinding、Istio 的 AuthorizationPolicy、`default-editor` 与 `default-viewer` 两个 ServiceAccount 及对应绑定、资源配额与 PSS 标签。**KFAM** 负责「contributor」级别的授权(走 SubjectAccessReview),owner 由 Profile 直接表达。

### 组件访问与命名空间的变化

**命名空间正在迁移中**,这是当前版本最容易踩的地方:

```shell
kubeflow → kubeflow-system   官方 README 明说「正在从 kubeflow 迁到 kubeflow-system」
                             JobSet 控制器已经住在 kubeflow-system
KServe 控制面与 Models Web App   在 26.03 之后的版本迁到 kserve 命名空间
Central Dashboard / Profile Controller / KFAM
                             迁到独立仓库 kubeflow/dashboard(v2.0.0)
```

写自动化脚本时不要写死 `kubeflow` 命名空间,先确认目标版本的实际位置。

```shell
kubectl get pods -n kubeflow
kubectl get pods -n kubeflow-system
kubectl get pods -n kserve
kubectl get profiles
```

### 注意

1. **kfctl 已归档,不要再用**。仓库最后推送是 2023-08,官方安装路径只剩 kustomize;同一批被归档的还有 `pytorch-operator`、`mxnet-operator`、`xgboost-operator`、`kfserving-lts` 等老组件。
2. **`kubeflow/manifests` 会跳转到 `kubeflow/community-distribution`**。老教程里的安装命令、目录结构、issue 链接都可能对不上;发行版本身也改用了日历版本号。
3. **不要全装**。默认清单包含 Istio、Knative、cert-manager、Dex、oauth2-proxy 等一整套基础设施,资源占用约 4.4 核 / 12GB 内存 / 65GB 存储。只需要某个组件(如 Pipelines 或 Notebooks)时,应该单独安装该组件的清单,而不是装整套发行版。
4. **`kubectl apply` 失败要重试**。官方文档明说首次执行「可能会失败」,给出的命令本身就是 `while ! ... do ... done` 的循环。不要把它当成配置错误。
5. **默认口令必须改**。`user@example.com` / `12341234` 是 Dex 的静态账号,README 明确提示生产环境要改密码;改的是 `auth` 命名空间里的 `dex-passwords` Secret。
6. **Istio 仍然是必需依赖**,官方术语是「most Kubeflow components」都靠它做流量安全、授权与路由。近期默认改为 **Istio CNI** 模式(免去特权 init 容器、更符合 Pod Security Standards),另外还提供 **ambient 模式**的 overlay —— 注意 ambient 是「Istio 不带 sidecar」,**不是「不用 Istio」**。目前没有受支持的「Kubeflow without Istio」方案。
7. **不要把 Notebooks v2(Workspaces)装到生产**。它在清单里被显式标注为 pre-GA,并附了一句大写警告「DO NOT DEPLOY THIS TO A PRODUCTION CLUSTER」。
8. **训练作业的 CRD 变了**。发行版里装的是 **Trainer v2**(`TrainJob` + `TrainingRuntime`,`trainer.kubeflow.org/v1alpha1`),而培训教材里常见的 `PyTorchJob`/`TFJob` 属于 Training Operator v1,它**不在默认发行版里**,需要单独安装;MPI Operator 同理。
9. **KServe 已不属于 Kubeflow**。它 2022 年捐给 LF AI & Data、2025 年进入 CNCF 成为 incubating 项目;发行版里只是把它作为一个组件装进来而已,文档与 issue 都应去 KServe 自己的仓库找。
10. **别删 `Profiles` CRD**。删除它会连带删掉所有 profile 命名空间与其中的工作负载 —— 这是 README 单独点名的一条警告。
11. **集群 DNS 与 CNI 需要配合**。用 Cilium 作为 CNI 时必须正确配置它与 Istio 的集成,否则会出现「登录后 Central Dashboard 报 RBAC access denied」这类现象。
12. **ARM64 支持不完整**。部分组件镜像没有 `linux/arm64` 变体,在 Apple Silicon 或 ARM 服务器上安装可能卡在镜像拉取。
13. **kind 之类的本地集群要先调内核参数**。`fs.inotify.max_user_instances=2280`、`fs.inotify.max_user_watches=1255360`,否则会因为 inotify 耗尽而出现组件反复重启。
14. **端口转发之外的方式要 HTTPS**。安全 Cookie 决定了 NodePort/LoadBalancer/Ingress 都必须带 TLS,否则登录流程无法完成。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kubeflow-pipelines` — 最常单独安装的组件
- `training-operator` — 训练作业控制器的上一代
- `kserve` — 模型服务组件(已是CNCF项目)
- `ray-operator` — 发行版中以experimental形式提供
- `katib` — 超参搜索(本页未展开)
- `istio` — 多租户流量与授权的基础
- `cert-manager` — 发行版依赖的证书组件
- `kustomize` — 唯一受支持的安装方式
- `crd` — Profile与各组件CRD的基础

### 参考链接

- [Kubeflow 官网](https://www.kubeflow.org/)
- [安装 Kubeflow(子项目与发行版)](https://www.kubeflow.org/docs/started/installing-kubeflow/)
- [Kubeflow Community Distribution 仓库](https://github.com/kubeflow/community-distribution)
- [默认清单 example/kustomization.yaml](https://github.com/kubeflow/community-distribution/blob/master/example/kustomization.yaml)
- [Profile 与多租户](https://www.kubeflow.org/docs/components/central-dash/profiles/)
- [CNCF 宣布 Kubeflow 毕业](https://www.cncf.io/announcements/2026/08/17/cncf-announces-kubeflows-graduation-solidifying-the-standard-for-cloud-native-ai-operations/)
