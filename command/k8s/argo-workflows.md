argo-workflows
===

Kubernetes原生工作流与批处理引擎

## 补充说明

**argo命令** 是 Argo Workflows 的 CLI。Argo Workflows 是**面向容器的工作流引擎**:工作流的每一步都是一个 Pod,引擎负责按依赖关系调度、传递参数与制品、收集日志与结果。

它和本站另外两个 Argo 项目的定位完全不同,不要混淆:

- **Argo Workflows** —— 一次性的**批处理 / DAG / 流水线**,跑完即结束。适合数据处理、模型训练、CI 编排、定时任务。
- **Argo CD** —— 持续交付,把 Git 中的清单同步到集群。
- **Argo Rollouts** —— 持续部署的**发布策略**,管理长期运行的服务如何灰度上线。

核心对象:

- **Workflow** —— 一次工作流运行实例,也是模板载体。
- **WorkflowTemplate** —— 命名空间级的可复用模板,用 `workflowTemplateRef` 引用。
- **ClusterWorkflowTemplate** —— 集群级模板,只有集群级安装(默认的 `install.yaml`)下可用,命名空间级安装用不了。
- **CronWorkflow** —— 定时触发的工作流,按 cron 表达式生成 Workflow。

模板类型(`templates[].*`)是关键概念:`container`(跑镜像)、`script`(跑脚本,镜像内生成 shell)、`resource`(直接操作集群资源)、`dag`(按依赖并行)、`steps`(顺序执行)、`suspend`(暂停等待审批)、`http`(发起 HTTP 请求)。

### 安装

```shell
# 1. 创建命名空间
kubectl create namespace argo

# 2. 安装控制器与 Server(集群级,可运行任意命名空间的工作流)
kubectl apply -n argo -f \
  https://github.com/argoproj/argo-workflows/releases/download/v4.1.4/install.yaml

# 命名空间级安装:控制器只能运行本命名空间内的工作流
kubectl apply -n argo -f \
  https://github.com/argoproj/argo-workflows/releases/download/v4.1.4/namespace-install.yaml

# 3. 试用:自带 MinIO 制品库的快速开始清单
kubectl apply -n argo -f \
  https://github.com/argoproj/argo-workflows/releases/download/v4.1.4/quick-start-minimal.yaml

# 4. 安装 CLI(Linux/macOS 通用下载方式)
ARGO_OS="darwin"
if [[ "$(uname -s)" != "Darwin" ]]; then
  ARGO_OS="linux"
fi

curl -sLO "https://github.com/argoproj/argo-workflows/releases/download/v4.1.4/argo-$ARGO_OS-amd64.gz"
gunzip "argo-$ARGO_OS-amd64.gz"
chmod +x "argo-$ARGO_OS-amd64"
sudo mv "./argo-$ARGO_OS-amd64" /usr/local/bin/argo
argo version
```

`install.yaml` 的体积极大(CRD 内嵌了完整的 OpenAPI 校验信息),apply 时会明显卡顿甚至触发注解长度限制,生产环境建议改用服务端 apply:`kubectl apply --server-side -n argo -f <install.yaml 地址>`。

### 访问 Web UI

```shell
# argo-server 是独立组件,默认 2746 端口
kubectl -n argo port-forward service/argo-server 2746:2746

# 浏览器访问 https://localhost:2746
# 注意是 https,且使用自签证书,需要手动确认例外
```

首次访问需要认证。默认 `server` 认证模式下,可以用 ServiceAccount 的 Token 登录:

```shell
# 取出 Server 的 SA Token 作为登录凭据
kubectl create token argo-server -n argo

# 也可以让 CLI 打印当前身份对应的 Token
argo auth token
```

### 第一个工作流

```shell
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  generateName: hello-world-      # 用 generateName,避免重名冲突
  namespace: argo
spec:
  entrypoint: main                # 必须与某个 template 的 name 一致
  arguments:
    parameters:
    - name: message
      value: "hello argo"
  templates:
  - name: main
    # dag 按依赖并行;换成 steps 则按顺序执行
    dag:
      tasks:
      - name: prepare
        template: echo
        arguments:
          parameters:
          - name: text
            value: "{{workflow.parameters.message}}"
      - name: build
        dependencies: [prepare]
        template: echo
        arguments:
          parameters:
          - name: text
            value: "building..."

  - name: echo
    inputs:
      parameters:
      - name: text
    container:
      image: alpine:3.20
      command: [sh, -c]
      args: ["echo {{inputs.parameters.text}}"]
```

```shell
# 提交(CLI 直接调用 Kubernetes API,默认不经过 argo-server)
argo submit -n argo hello-world.yaml --watch

# 提交并覆盖参数
argo submit -n argo hello-world.yaml -p message="hi"

# 只生成 Workflow 清单,不提交
argo submit -n argo hello-world.yaml --dry-run -o yaml
```

### 常用 CLI 命令

```shell
# 查看与日志
argo list -n argo                       # 列出工作流
argo list -n argo --running             # 只列运行中的
argo get -n argo hello-world-abcde      # 详情
argo logs -n argo hello-world-abcde     # 日志
argo logs -n argo hello-world-abcde -f  # 持续输出
argo watch -n argo hello-world-abcde    # 实时状态

# 操作
argo suspend -n argo <name>             # 暂停
argo resume -n argo <name>              # 恢复
argo terminate -n argo <name>           # 终止
argo stop -n argo <name>                # 停止后续步骤
argo retry -n argo <name>               # 重试失败的节点
argo resubmit -n argo <name>            # 用同样参数重新提交
argo delete -n argo <name>
argo delete -n argo --completed         # 清理已完成的工作流
argo delete -n argo --older 24h

# 模板管理
argo template create -n argo workflowtemplate.yaml
argo template list -n argo
argo template get -n argo my-template
argo template delete -n argo my-template

# 校验清单
argo lint hello-world.yaml
```

### CronWorkflow:定时任务

```shell
apiVersion: argoproj.io/v1alpha1
kind: CronWorkflow
metadata:
  name: nightly-etl
  namespace: argo
spec:
  schedule: "0 2 * * *"
  timezone: "Asia/Shanghai"        # 不写则按 UTC 解释
  concurrencyPolicy: Replace       # Allow / Forbid / Replace
  startingDeadlineSeconds: 300
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 3
  workflowSpec:
    entrypoint: main
    templates:
    - name: main
      container:
        image: alpine:3.20
        command: [sh, -c]
        args: ["echo nightly job"]
```

```shell
argo cron create -n argo cron.yaml
argo cron list -n argo
argo cron get -n argo nightly-etl
argo cron suspend -n argo nightly-etl    # 暂停定时触发
argo cron resume -n argo nightly-etl
argo cron delete -n argo nightly-etl
```

### 制品库配置

工作流之间传递文件、保留日志都依赖**制品仓库(artifact repository)**。没有配置时,带 `artifacts` 的模板会直接失败:

```shell
kubectl -n argo edit configmap workflow-controller-configmap
```

```shell
apiVersion: v1
kind: ConfigMap
metadata:
  name: workflow-controller-configmap
  namespace: argo
data:
  # 归档日志,否则 Pod 删除后日志就没了
  archiveLogs: "true"
  artifactRepository: |
    archiveLogs: true
    s3:
      bucket: argo-artifacts
      endpoint: minio.argo.svc.cluster.local:9000
      insecure: true
      accessKeySecret:
        name: my-minio-cred
        key: accesskey
      secretKeySecret:
        name: my-minio-cred
        key: secretkey
```

### RBAC 与权限

工作流 Pod 默认使用所在命名空间的 `default` ServiceAccount,权限需要显式授予:

```shell
apiVersion: v1
kind: ServiceAccount
metadata:
  name: workflow-runner
  namespace: argo
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: workflow-runner
  namespace: argo
rules:
- apiGroups: [""]
  resources: ["pods", "pods/log"]
  verbs: ["get", "list", "watch", "create", "delete", "patch"]
```

再用 RoleBinding 把 Role 绑定到该 ServiceAccount,并在 Workflow 中通过 `spec.serviceAccountName` 指定它;控制器本身的权限由 `install.yaml` 里的 ClusterRole 提供。

### 注意

1. **`entrypoint` 写错会让工作流瞬间失败**。`spec.entrypoint` 必须与 `templates` 中某个 `name` 完全一致,拼错时报 `failed to resolve {{steps...}}` 或直接 `Error`,而不是提示找不到模板。
2. **Argo CLI 默认绕过 argo-server**。`argo submit` / `argo logs` 直接读写 Kubernetes API,用的是本地 kubeconfig 的权限;因此「能登上 UI」不等于「能用 CLI 提交」,反之亦然。要让 CLI 走 Server(例如只有 Server 有集群访问权),需要显式指定 `--argo-server` 并配置认证。
3. **没有配置 artifactRepository 时不要用 artifacts**。`archiveLogs`、`artifacts:`、`outputs.artifacts` 全部依赖制品仓库,未配置时会报 `artifact repository not configured`;试用清单 `quick-start-minimal.yaml` 自带 MinIO,正式环境要换成自己的 S3/OSS。
4. **已完成的工作流不会自动清理**。默认既保留 Workflow 对象也保留 Pod(用于查看日志),长期运行会占满 etcd 与节点资源。需要主动设置 `ttlStrategy`(如 `secondsAfterCompletion`)、`podGC`,并定期 `argo delete --completed`。
5. **CronWorkflow 的时区默认是 UTC**。中国区业务必须显式写 `timezone: "Asia/Shanghai"`,否则「凌晨 2 点」会变成北京时间上午 10 点。
6. **`install.yaml` 体积巨大,普通 apply 容易失败**。CRD 内嵌完整校验信息,超过客户端 apply 的注解上限,建议用 `--server-side`;同时生产环境务必锁定版本号,不要用 latest。
7. **`dag` 与 `steps` 的语义不同**。`dag` 的任务默认并行,靠 `dependencies` 表达依赖;`steps` 是严格串行的二维步骤列表。把 DAG 的写法照搬进 `steps` 会得到完全不同的执行顺序。
8. **工作流 Pod 默认挂着 ServiceAccount Token**。这意味着工作流里的任意代码都能以 Pod 的身份访问 API Server;对不可信镜像务必设置 `automountServiceAccountToken: false` 或使用最小权限的 SA。
9. **v3 升级到 v4 有破坏性变更**。控制器与 CRD 的字段、默认行为均有调整,升级前必须阅读官方 upgrade 指南并备份工作流定义;可选的容器运行时执行器也在不断收敛,`docker` 执行器早已移除、`k8sapi` 执行器已废弃,新版本一律使用默认的 `emissary`。
10. **`suspend` 模板不是「暂停按钮」**。它需要一个外部动作(UI 上的 Resume、`argo resume` 或 `suspend` 模板的 `duration`)才会继续,常用于人工审批;在 CI 中误用会让流水线永久挂起。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `argocd` — Kubernetes声明式GitOps持续交付工具
- `argo-rollouts` — Kubernetes渐进式交付控制器
- `argo-events` — Kubernetes事件驱动自动化框架
- `tekton` — Kubernetes原生CI/CD流水线框架

### 参考链接

- [Argo Workflows 官方文档](https://argo-workflows.readthedocs.io/en/latest/)
- [快速开始](https://argo-workflows.readthedocs.io/en/latest/quick-start/)
- [字段参考](https://argo-workflows.readthedocs.io/en/latest/fields/)
- [Argo CLI 使用](https://argo-workflows.readthedocs.io/en/latest/walk-through/argo-cli/)
- [GitHub 仓库](https://github.com/argoproj/argo-workflows)
