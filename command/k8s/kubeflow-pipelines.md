kubeflow-pipelines
===

Kubeflow的机器学习流水线编排系统(简称KFP)

## 补充说明

**Kubeflow Pipelines(简称 KFP)** 用 Python 代码定义机器学习流水线,编译成 IR YAML,再交给底层的 **Argo Workflows** 执行。它管的是「数据预处理 → 训练 → 评估 → 部署」这条链路:每个步骤是一个容器,步骤之间的输入输出由 KFP 管理,产物统一存到对象存储。

版本 **2.17.2(2026-09-04)**,迭代很快:

```shell
2.17.2   2026-09-04
2.17.1   2026-08-27
2.17.0   2026-07-09
2.16.1   2026-05-05
2.16.0   2026-02-25
```

在 Kubeflow 的子项目成熟度表里,KFP 属于 **Graduated** 级别,是这套生态里最成熟、也最常被单独安装的组件。

它有两套 SDK 历史,看教程时务必分清版本:

```shell
KFP v1(kfp 1.x)   已停止演进,只有零星维护版本(1.8.24,2026-03)
                  API 是 ContainerOp / create_component_from_func
KFP v2(kfp 2.x)   当前主线。用 @dsl.component 与 @dsl.pipeline 装饰器
                  kfp SDK 2.5.0 起已经移除对 kfp.v1 的支持
```

### 安装

**KFP 没有官方 Helm chart**(仓库里只有一个 GCP Marketplace 用的 chart),官方安装方式是 kustomize 直接 apply:

```shell
export PIPELINE_VERSION=2.17.2

kubectl apply -k "github.com/kubeflow/pipelines/manifests/kustomize/cluster-scoped-resources?ref=$PIPELINE_VERSION"
kubectl wait --for condition=established --timeout=60s crd/applications.app.k8s.io

kubectl apply -k "github.com/kubeflow/pipelines/manifests/kustomize/env/dev?ref=$PIPELINE_VERSION"
```

**命名空间是 `kubeflow`,不是 `kubeflow-pipelines`** —— 这一点与直觉相反,大量脚本都写错:

```shell
kubectl get pods -n kubeflow
kubectl port-forward -n kubeflow svc/ml-pipeline-ui 8080:80
```

`env/` 下的可选环境:

```shell
dev / dev-kind                    开发与本地 kind 集群,非生产
plain / plain-multi-user          不带 Istio 的简单部署
platform-agnostic                 单用户、与平台无关
platform-agnostic-multi-user      多用户(需要 Istio 与 Kubeflow 多租户)
platform-agnostic-postgresql      用 PostgreSQL 作为元数据库
platform-agnostic-multi-user-postgresql
cert-manager/...                  cert-manager 变体(含 pod 间 TLS、K8s 原生模式)
gcp / openshift                   平台专用
```

几个变体的说明:

```shell
env/pipeline/upstream/env/cert-manager/platform-agnostic-k8s-native
  K8s 原生模式:流水线定义存成 Pipeline/PipelineVersion 自定义资源,由准入 webhook 校验,
  不再依赖外部数据库;需要 cert-manager v1.18.2

env/cert-manager/platform-agnostic-standalone-tls
  开启 Pod 之间的 TLS
```

多用户模式会连带拉入 metacontroller、Argo 集群级安装、Istio 化的 MySQL 与对象存储等,并且**要求集群里已经有 Istio 与 Kubeflow 的多租户(Profiles/KFAM)**。官方对生产多租户的推荐是直接用 Kubeflow Community Distribution,而不是自己拼这套清单。

### 写一条流水线

```shell
from kfp import dsl, compiler

@dsl.component(base_image="python:3.11")
def add(a: int, b: int) -> int:
    return a + b

@dsl.component(base_image="python:3.11")
def multiply(a: int, b: int) -> int:
    return a * b

@dsl.pipeline(name="math-pipeline", description="两则运算")
def math_pipeline(a: int = 2, b: int = 3):
    first = add(a=a, b=b)
    multiply(a=first.output, b=b)

compiler.Compiler().compile(
    pipeline_func=math_pipeline,
    package_path="math_pipeline.yaml",
)
```

提交:

```shell
# 方式一:UI 上传 math_pipeline.yaml
# 方式二:CLI
kfp run create \
  --experiment-name my-exp \
  --run-name math-run \
  --package-file math_pipeline.yaml \
  a=10 b=20
```

`kfp` CLI 常用子命令(随 `pip install kfp` 一起安装):

```shell
kfp dsl compile --py path/to/pipeline.py --output out.yaml \
  [--function my_pipeline] [--pipeline-parameters '{"a": 10}'] [--disable-type-check]

kfp run create --experiment-name <exp> --run-name <name> \
  --package-file <yaml> [--pipeline-id ID] [--version VERSION_ID] [--timeout N] [--watch] \
  key=value key2=value2

kfp pipeline create / kfp pipeline create-version
kfp experiment create
kfp component build          # 需要 pip install "kfp[all]"
kfp run get / archive / unarchive / delete
```

注意 `kfp run create` 用的是 **`--package-file`**,并且**实验名是必填的**;`kfp component build` 需要安装附加依赖。

### 底层组件

```shell
Argo Workflows     真正的执行引擎。2.17.2 里带的版本是 v4.0.5
                   依赖矩阵里 v3.7 与 v4.0 都在支持范围内
MySQL              元数据与流水线定义(可换成 PostgreSQL 变体)
ML Metadata(MLMD) 记录 Artifact/Execution 血缘,仍然随发行版一起部署
对象存储            存流水线产物,默认已换成 SeaweedFS(见下)
cache-deployer     缓存服务,集群级资源,改命名空间时要额外处理
```

### 对象存储:MinIO 已经出局

这是当前版本最值得注意的一处变化:

```shell
2025-11(KFP 2.15.0)  默认对象存储由 MinIO 改为 SeaweedFS
2025-12-03           MinIO 上游仓库进入维护模式
2026-02-12           MinIO 仓库归档只读
```

官方文档的原话是「As of KFP 2.15, the default object store deployment has been changed to SeaweedFS, replacing the previous deployment of MinIO」。清单里 `platform-agnostic` 与 `platform-agnostic-multi-user` 引用的都是 `third-party/seaweedfs/*`,**已经没有 minio**。

两个细节:

- **默认的产物路径仍然写作 `minio://mlpipeline/v2/artifacts`** —— 这个 `minio://` 只是沿用了老的 scheme 名,底层已经是 SeaweedFS。
- 从 1.10.2 升到 1.11.0(=26.03)时,官方升级说明是「Migrates from minio to seaweedfs. Delete minio and optionally migrate your data via S3 commands to seaweedfs」,老数据要自己用 S3 命令搬。
- 任何 S3 兼容存储都可以继续用,MinIO 也仍受支持,只是默认清单不再带它。

### 常用操作

```shell
# 组件状态
kubectl get pods -n kubeflow
kubectl get svc -n kubeflow | grep ml-pipeline

# UI
kubectl port-forward -n kubeflow svc/ml-pipeline-ui 8080:80

# API 服务
kubectl port-forward -n kubeflow svc/ml-pipeline 8888:8888

# 某个 Run 的日志
kubectl get workflows -n kubeflow
kubectl logs -n kubeflow <workflow-pod> -c main

# 缓存服务
kubectl get pods -n kubeflow | grep cache
```

### 排障

```shell
# 1. UI 打不开 / 502
kubectl get pods -n kubeflow -o wide | grep -E "ml-pipeline|ml-pipeline-ui"
kubectl logs -n kubeflow deployment/ml-pipeline-ui --tail=100

# 2. 流水线一直 Pending
kubectl get workflows -n kubeflow
kubectl describe workflow <name> -n kubeflow
# 常见原因:Argo 的执行器权限、命名空间配额、PVC 没绑上

# 3. 步骤失败但日志为空
kubectl describe pod <pod> -n kubeflow           # 看 Events 与退出码
# ExitCode 137 通常是 OOM 或被抢占,需要调 resources

# 4. 产物找不到
kubectl get pods -n kubeflow | grep seaweedfs
kubectl logs -n kubeflow <seaweedfs-pod> --tail=100
```

### 注意

1. **命名空间是 `kubeflow`**,不是 `kubeflow-pipelines`。几乎所有 `-n kubeflow-pipelines` 的脚本都会失败,这是从老教程继承下来的高频错误。
2. **没有官方 Helm chart**。仓库里不存在 `charts/` 目录,社区里流传的 chart 都不是官方产物;官方只提供 kustomize 清单。
3. **升级 2.15.0 及以上要格外小心**。该版本带了 Gorm 后端的变更,需要执行一次数据库索引迁移,而且**官方说明该迁移不支持回滚**。生产环境升级前务必备份元数据库。
4. **对象存储已经换成 SeaweedFS**,老教程里的 MinIO 组件与 `minio-service` 在默认清单里已经不存在(MinIO 上游仓库 2026-02 已归档)。不过产物路径里的 `minio://` scheme 名仍然保留,看到它不要以为还在用 MinIO。
5. **多用户模式不是装上就能用**。它需要 Istio 与 Kubeflow 的多租户(Profiles/KFAM)一起配合;想省事就用 Kubeflow Community Distribution,官方也是这么推荐的。
6. **`env/dev` 是开发用途**。它单用户、无认证、非生产;把它当成生产环境部署,等于把流水线 API 裸露给所有能访问 Service 的人。
7. **KFP v1 的 API 已经不可用**。`kfp` SDK 2.5.0 起移除了 `kfp.v1`,`ContainerOp`、`create_component_from_func` 这些写法在 2.x 里都会失败;老教程(尤其中文博客)大量使用 v1 API,照抄必翻车。
8. **`kfp run create` 的实验名是必填参数**,参数是 `--package-file` 而不是 `--package`;位置参数形式的 `key=value` 会被当作流水线参数并自动做类型转换。
9. **Argo 版本可能比你以为的新**。2.17.2 里是 **v4.0.5**(老文档常写 v3.7.x);Argo 从 v3 到 v4 有不少行为变化,升级 KFP 时会连带升级它,排障时先确认实际版本:
   ```shell
   kubectl get deploy -n kubeflow workflow-controller -o jsonpath='{.spec.template.spec.containers[0].image}'
   ```
10. **cache-deployer 是集群级资源**。改命名空间后需要同步处理 `base/cache-deployer/cluster-scoped/cache-deployer-clusterrolebinding.yaml` 里的绑定,否则缓存功能报权限错误。
11. **MLMD 仍在,但方向在变**。当前版本依旧部署 ML Metadata 记录血缘;有一个提案要移除对外部 MLMD 的依赖、把持久化改到 KFP 自己的存储或 Kubernetes 原生 CR(`Pipeline`/`PipelineVersion`),但**它仍处于设计阶段**,不要在文档里写「MLMD 已被移除」。已经落地的是「K8s 原生模式」这条独立路线。
12. **流水线步骤的资源要自己声明**。KFP 不会为你的步骤推导 requests/limits,不写的话会用命名空间默认值,在训练类步骤上非常容易 OOM(退出码 137)。
13. **`PIPELINE_VERSION` 是文档约定的变量名**,用于固定 kustomize 拉取的 git ref;不固定就会拉到最新,生产环境务必写死版本。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kubeflow` — 整套平台,含本组件
- `argo-workflows` — KFP底层的执行引擎
- `training-operator` — 训练作业控制器,常与流水线配合
- `mpi-operator` — 多机训练作业,可作为流水线的一个步骤
- `kserve` — 流水线末端常把模型部署到这里
- `kustomize` — 官方安装方式
- `pvc` — 步骤间共享数据的另一种方式
- `crd` — Pipeline/PipelineVersion等资源的定义
- `minio` — 已被SeaweedFS取代的默认对象存储

### 参考链接

- [Kubeflow Pipelines 仓库](https://github.com/kubeflow/pipelines)
- [安装指南](https://www.kubeflow.org/docs/components/pipelines/operator-guides/installation/)
- [配置对象存储](https://www.kubeflow.org/docs/components/pipelines/operator-guides/configure-object-store/)
- [kfp CLI 用户指南](https://www.kubeflow.org/docs/components/pipelines/user-guides/core-functions/cli/)
- [元数据与 MLMD](https://www.kubeflow.org/docs/components/pipelines/concepts/metadata/)
- [2.15 起的 SeaweedFS 变更(Release)](https://github.com/kubeflow/pipelines/releases)
