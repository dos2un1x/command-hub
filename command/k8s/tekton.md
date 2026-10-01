tekton
===

Kubernetes原生CI/CD流水线框架

## 补充说明

**Tekton** 是一套以 CRD 形式运行在 Kubernetes 上的 CI/CD 框架。所有概念都是集群对象,没有任何需要长期驻留的「构建服务器」:流水线定义、每次执行、执行结果全部以 Kubernetes 资源的形式存在。

**三层对象关系是理解 Tekton 的关键**,必须分清「定义」与「执行」:

- **Task** —— 定义,一组按顺序执行的 `steps`,每个 step 是一个容器。
- **TaskRun** —— Task 的一次执行实例,通过 `taskRef` 引用 Task,或直接用 `taskSpec` 内联定义。
- **Pipeline** —— 定义,由多个 Task 组成的 DAG(用 `runAfter` 表达依赖)。
- **PipelineRun** —— Pipeline 的一次执行实例,**会自动为 Pipeline 中的每个 Task 创建对应的 TaskRun**,命名规则为 `<pipelinerun 名>-<pipeline 中 task 名>`,并在自己的 `status.childReferences` 中列出这些子对象。

也就是说:你提交的是 TaskRun / PipelineRun,Task 与 Pipeline 本身只被读取,不会被「运行」。

组件构成:

- **Tekton Pipelines** —— 核心,提供上面这些 CRD 与执行控制器。
- **Tekton Triggers** —— 接收外部事件(Webhook、GitHub 推送)并触发 PipelineRun。
- **Tekton Dashboard** —— Web UI。
- **Tekton CLI(`tkn`)** —— 命令行工具。
- **Tekton Chains / Hub / Operator** —— 供应链签名、模板仓库、集群级运维。

### 安装

要求 Kubernetes **1.28 或更高**。所有组件都安装在 `tekton-pipelines` 命名空间:

```shell
# Pipelines(最新版)
kubectl apply --filename https://infra.tekton.dev/tekton-releases/pipeline/latest/release.yaml

# 指定版本(生产环境务必锁版本)
kubectl apply --filename \
  https://infra.tekton.dev/tekton-releases/pipeline/previous/<version>/release.yaml

# 容器运行时不支持 tag@digest 时改用 release.notags.yaml

# Triggers(注意:截至目前官方 Triggers 文档仍指向旧的 GCS 地址)
kubectl apply --filename \
  https://storage.googleapis.com/tekton-releases/triggers/latest/release.yaml
kubectl apply --filename \
  https://storage.googleapis.com/tekton-releases/triggers/latest/interceptors.yaml

# Dashboard(默认只读;需要写操作时用 release-full.yaml)
kubectl apply --filename \
  https://infra.tekton.dev/tekton-releases/dashboard/latest/release.yaml

# 观察安装进度
kubectl get pods --namespace tekton-pipelines --watch
```

官方文档明确说明:这些清单「适用于快速开始,**不适用于生产环境**」,生产集群应改用 Tekton Operator 来安装与升级。

### 安装 tkn CLI

```shell
# macOS
brew install tektoncd-cli
# 需要作为 kubectl 插件使用时建软链接
ln -s $(brew --prefix)/opt/tektoncd-cli/bin/tkn /usr/local/bin/kubectl-tkn

# Linux(以 0.46.0 为例,注意文件名区分架构)
curl -LO https://github.com/tektoncd/cli/releases/download/v0.46.0/tkn_0.46.0_Linux_x86_64.tar.gz
sudo tar xvzf tkn_0.46.0_Linux_x86_64.tar.gz -C /usr/local/bin/ tkn

# Debian / RHEL 系也可以直接装包
sudo apt install -y tektoncd-cli
dnf copr enable chmouel/tektoncd-cli && dnf install tektoncd-cli
```

### Task 与 TaskRun

```shell
apiVersion: tekton.dev/v1
kind: Task
metadata:
  name: build-and-push
spec:
  params:
  - name: image
    type: string
  workspaces:
  - name: source
  results:
  - name: digest
    description: 构建出的镜像 digest
  steps:
  - name: build
    image: gcr.io/kaniko-project/executor:debug
    script: |
      #!/busybox/sh
      /kaniko/executor --context=$(workspaces.source.path) \
        --destination=$(params.image) --no-push
```

执行它:

```shell
# 用 tkn 启动
tkn task start build-and-push \
  --param image=registry.example.com/app:1.0.0 \
  --workspace name=source,claimName=my-pvc \
  --showlog

# 查看 TaskRun 与日志
tkn taskrun list
tkn taskrun logs build-and-push-run-abcde -f      # 持续输出
```

TaskRun 既可以用 `taskRef` 引用已存在的 Task,也可以把 Task 定义直接嵌进 `taskSpec`。**注意一个硬限制:workspace 只能传递给内联的 `taskSpec`,不能在 `taskRef` 引用外部 Task 时注入 workspace**。

### Pipeline 与 PipelineRun

```shell
apiVersion: tekton.dev/v1
kind: Pipeline
metadata:
  name: ci-pipeline
spec:
  params:
  - name: git-url
    type: string
  workspaces:
  - name: shared-data
  tasks:
  - name: clone
    taskRef:
      name: git-clone
    params:
    - name: url
      value: $(params.git-url)
    workspaces:
    - name: output
      workspace: shared-data
  - name: test
    runAfter: [clone]
    taskRef:
      name: run-tests
    workspaces:
    - name: source
      workspace: shared-data
```

Pipeline 还支持 `finally` 段,其中的 Task 无论前面成功与否都会执行,适合做通知与清理。

```shell
# 启动 PipelineRun
tkn pipeline start ci-pipeline \
  --param git-url=https://github.com/example/app.git \
  --workspace name=shared-data,volumeClaimTemplateFile=workspace-template.yaml \
  --showlog

# 一个 PipelineRun 会生成多个 TaskRun
tkn pipelinerun list
tkn pipelinerun logs ci-pipeline-run-abcde -f

# 查看它派生出的子对象
kubectl get pipelinerun ci-pipeline-run-abcde -o jsonpath='{.status.childReferences}'
```

PipelineRun 同样支持 `pipelineRef`(引用已存在的 Pipeline)或 `pipelineSpec`(内联定义)。

### Workspaces:数据在步骤间怎么传递

每个 step 是独立容器,步骤之间共享数据只能靠 workspace。在 PipelineRun/TaskRun 中为每个 workspace 绑定**唯一一种** VolumeSource:

```shell
workspaces:
# 1. 复用已有 PVC
- name: source
  persistentVolumeClaim:
    claimName: my-pvc
    subPath: app

# 2. 每次运行自动创建 PVC,运行结束随之删除
- name: source
  volumeClaimTemplate:
    spec:
      accessModes: [ReadWriteOnce]
      resources:
        requests:
          storage: 1Gi

# 3. 临时目录:只在同一个 TaskRun 的 steps 之间共享
- name: tmp
  emptyDir: {}

# 4. 只读挂载(要求对象已存在,大小上限 1MB)
# - name: config
#   configMap:
#     name: build-config
# - name: creds
#   secret:
#     secretName: registry-creds
```

### Triggers:用事件触发流水线

Triggers 用三件套把外部事件翻译成 PipelineRun:`EventListener` 接收请求,`TriggerBinding` 提取事件字段,`TriggerTemplate` 渲染出资源清单。

EventListener 会自动创建一个 Service 作为事件接收端点,配套的 RBAC 决定它能创建哪些资源:

```shell
kubectl get eventlistener
kubectl get svc -n default
```

### 结果保留与清理

TaskRun / PipelineRun 记录会持续累积,撑大 etcd。Tekton Pruner 通过两级 ConfigMap 控制保留策略:

```shell
# 全局策略(命名空间 tekton-pipelines,必须带 global 标签)
kubectl edit configmap tekton-pruner-default-spec -n tekton-pipelines
```

```shell
apiVersion: v1
kind: ConfigMap
metadata:
  name: tekton-pruner-default-spec
  namespace: tekton-pipelines
  labels:
    pruner.tekton.dev/config-type: global
data:
  global-config: |
    ttlSecondsAfterFinished: 300
    successfulHistoryLimit: 3
    enforcedConfigLevel: global
```

命名空间级策略使用同样带标签的 `tekton-pruner-namespace-spec`(数据键为 `ns-config`)。TTL 与历史条数两套规则**独立生效**,系统允许的最大 TTL 为 2592000 秒(30 天)。

### 权限与安全上下文

TaskRun 的 Pod 默认使用 `default` ServiceAccount,在开启 Pod Security Admission `restricted` 策略的命名空间里会直接被拒绝:

```shell
# 在 feature-flags 中开启,让 Tekton 注入安全上下文
kubectl edit configmap feature-flags -n tekton-pipelines
# data:
#   set-security-context: "true"     # 默认为 false
```

`config-defaults` 里的 `default-pod-template` 可以给所有 TaskRun Pod 统一加上 `nodeSelector`、`tolerations`、`securityContext` 等。

### 注意

1. **ClusterTask 已在 Pipelines 1.0 中被移除**。v1 版本的 `tekton.dev/v1` 里根本没有这个 kind,`taskRef.kind: ClusterTask` 会直接校验失败;替代方案是用命名空间级的 `Task` 加一个 `ClusterResolver`(需要开启 `enable-cluster-resolver`)。
2. **PipelineRun 不是「执行 Pipeline」,而是「为每个 Task 创建 TaskRun」**。真正跑起来的是 TaskRun;排查失败时要下钻到具体那个 TaskRun,而不是只看 PipelineRun 的状态。
3. **workspace 不能注入到被引用的 Task**。官方明确的限制是「workspace 只能传递给内联的 `taskSpec`」,用 `taskRef` 引用外部 Task 时无法从上层注入 workspace,只能依赖 Pipeline 层声明并在 Task 中同名声明。
4. **`emptyDir` 类型的 workspace 不能跨 Task 共享**。它随 TaskRun 的 Pod 生灭,只有同一个 TaskRun 内的 steps 之间能共享;要在 Task 之间传文件必须用 PVC 或 `volumeClaimTemplate`。
5. **`configMap` / `secret` 挂载的 workspace 是只读的,且必须在提交前就存在**,还有 1MB 大小上限 —— 不要把构建产物写进去。
6. **`volumeClaimTemplate` 生成的 PVC 随运行对象删除**。删掉 PipelineRun,它的 PVC 也会被回收,想保留构建产物要用外部存储或提前绑定已有 PVC。
7. **不清理 TaskRun 会撑爆集群**。默认没有保留策略时记录会无限增长;要部署 Pruner 组件并配置 `tekton-pruner-*` ConfigMap,注意两个 ConfigMap 都必须带对应的 `pruner.tekton.dev/config-type` 标签才会生效。
8. **`restricted` 命名空间下 Pod 起不来**。Tekton 注入的容器默认不满足受限策略,需要把 `feature-flags` 里的 `set-security-context` 打开(默认是 `false`);该特性在 Windows 节点上不生效,部分发行版(如个别 OpenShift 环境)也可能不兼容。
9. **Pipelines 与 Triggers 的下载地址目前不一致**。Pipelines 与 Dashboard 已经迁到 `infra.tekton.dev`,而 Triggers 的官方文档仍指向 `storage.googleapis.com`;升级前建议先确认目标版本的真实地址,不要按直觉把域名换掉。
10. **官方清单不适合直接用于生产**。文档原文注明这些命令「适合快速开始,不适用于生产环境」,生产集群应通过 Tekton Operator 安装、升级与管理。
11. **`tkn hub` 已废弃**。Hub 的能力正在被并入 `tkn` 本体,新项目不要再基于 `tkn hub` 构建流程。
12. **TaskRun 的 Pod 默认没有资源限制**,一个失控的构建能把节点拖垮;应在 `config-defaults` 或 Pod 模板中统一设置 requests/limits。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `jenkins` — CI/CD自动化服务器
- `argo-workflows` — Kubernetes原生工作流引擎
- `gitlab-runner` — GitLab CI 执行器
- `skaffold` — Kubernetes构建与部署流水线工具

### 参考链接

- [Tekton 官方文档](https://tekton.dev/docs/)
- [安装 Tekton Pipelines](https://tekton.dev/docs/pipelines/install/)
- [TaskRun 说明](https://tekton.dev/docs/pipelines/taskruns/)
- [PipelineRun 说明](https://tekton.dev/docs/pipelines/pipelineruns/)
- [Workspaces](https://tekton.dev/docs/pipelines/workspaces/)
- [Tekton Pruner](https://tekton.dev/docs/pruner/)
