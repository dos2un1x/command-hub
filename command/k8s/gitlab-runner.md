gitlab-runner
===

GitLab CI的作业执行器

## 补充说明

**gitlab-runner** 是 GitLab CI/CD 的执行代理:它从 GitLab 领取作业(job),在本地环境中执行 `.gitlab-ci.yml` 定义的步骤,再把日志与产物回传。在 Kubernetes 上部署时,通常使用 **kubernetes executor**:

- 常驻的 Runner Pod 只负责**领取作业**,不执行构建。
- 每接到一个作业,**动态创建一个 Pod** 来执行:Pod 内有 `build` 容器(真正跑脚本)、`helper` 容器(负责拉代码、传产物),以及每个 service 一个容器(命名规则是服务别名,否则为 `svc-N`,`N` 从 0 开始)。
- 服务容器与构建容器在同一个 Pod 内,**共享 localhost 网络**,因此两个服务不能占用同一个端口。

这个模型带来的直接结果是:构建环境干净、天然隔离,但**每一个作业都是全新的文件系统** —— 所以缓存必须放在集群外部的对象存储里。

### 安装

官方推荐的部署方式是 Helm Chart:

```shell
# 添加官方 Helm 仓库
helm repo add gitlab https://charts.gitlab.io
helm repo update gitlab
helm search repo -l gitlab/gitlab-runner

# 准备 values 文件后安装
helm install --namespace <NAMESPACE> gitlab-runner \
  -f <CONFIG_VALUES_FILE> gitlab/gitlab-runner

# 指定 Chart 版本
helm install --namespace gitlab-runner gitlab-runner \
  -f values.yaml gitlab/gitlab-runner --version <CHART_VERSION>

# Chart 0.92.2 起也支持 OCI 仓库
helm install --namespace gitlab-runner gitlab-runner \
  -f values.yaml --version <CHART_VERSION> \
  oci://registry.gitlab.com/charts/charts.gitlab.io/release/gitlab-runner

# 升级
helm upgrade --namespace gitlab-runner gitlab-runner \
  -f values.yaml gitlab/gitlab-runner
```

### 创建 Runner 并获取令牌

现在的流程是**先在 GitLab 里创建 Runner,再把令牌交给 Runner**:

```shell
# 在 GitLab 界面:项目/群组/实例的 Settings → CI/CD → Runners → New runner
# 创建后会得到一个认证令牌,前缀为 glrt-
```

```shell
# 容器内也可以手工注册(注意是 --token,不是旧的 --registration-token)
gitlab-runner register \
  --non-interactive \
  --url "https://gitlab.example.com/" \
  --token "glrt-xxxxxxxxxxxxxxxxxxxx" \
  --executor "kubernetes"
```

认证令牌(`glrt-` 前缀)取代了老的注册令牌。老的注册令牌流程已被废弃,并在 GitLab 17.0 起默认禁用;不同官方页面给出的移除时间点并不一致(有 18.0 与 20.0 两种说法),新部署一律使用认证令牌。

### values.yaml 关键配置

```shell
# GitLab 实例地址
gitlabUrl: https://gitlab.example.com/

# Runner 认证令牌,建议用 Secret 引用而不是明文写在这里
runnerToken: "glrt-xxxxxxxxxxxxxxxxxxxx"

# 让 Chart 创建创建 Pod 所需的 RBAC
rbac:
  create: true

serviceAccount:
  create: true
  name: gitlab-runner

# 全局并发上限:同时能跑多少个作业
concurrent: 10

# Runner 的 config.toml(支持 Helm 模板变量)
runners:
  # 作业 Pod 所在命名空间,默认为 Release 所在命名空间
  jobNamespace: gitlab-runner
  config: |
    [[runners]]
      name = "k8s-runner"
      executor = "kubernetes"
      [runners.kubernetes]
        namespace = "{{ .Release.Namespace }}"
        image = "alpine:3.20"
        privileged = false
        service_account = "gitlab-runner"
        helper_image = "registry.gitlab.com/gitlab-org/gitlab-runner/gitlab-runner-helper:x86_64-v17.0.0"
        poll_timeout = 180
        cpu_limit = "2"
        memory_limit = "4Gi"
        cpu_request = "500m"
        memory_request = "1Gi"
```

已经废弃的字段不要再使用:`rbac.serviceAccountName`、`rbac.generatedServiceAccountName`、`rbac.serviceAccountAnnotations`、`rbac.imagePullSecrets`、`metrics.serviceMonitor`,以及历史上的 `runnerRegistrationToken`。

### 缓存配置

每个作业跑在全新的 Pod 里,没有分布式缓存的话每次构建都要重新下载依赖:

```shell
  config: |
    [[runners]]
      executor = "kubernetes"
      [runners.kubernetes]
        namespace = "{{ .Release.Namespace }}"
        image = "alpine:3.20"
      [runners.cache]
        Type = "s3"
        Path = "gitlab-runner"
        Shared = true
        [runners.cache.s3]
          ServerAddress = "minio.example.com:9000"
          BucketName = "runner-cache"
          Insecure = false
          AuthenticationType = "access-key"
```

`Type` 的取值是 `s3`、`gcs`、`azure`;`Path` 是缓存路径前缀;`Shared = true` 表示多个 Runner 之间共享同一份缓存。

### RBAC

kubernetes executor 需要创建、查看、进入 Pod 的权限。用 Chart 的 `rbac.create: true` 会自动生成;自定义时至少需要:

```shell
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: gitlab-runner
  namespace: gitlab-runner
rules:
- apiGroups: [""]
  resources: ["pods", "pods/attach", "pods/exec", "pods/log"]
  verbs: ["create", "delete", "get", "list", "watch", "patch"]
- apiGroups: [""]
  resources: ["services", "secrets", "configmaps"]
  verbs: ["create", "delete", "get", "update", "list", "watch"]
- apiGroups: [""]
  resources: ["serviceaccounts"]
  verbs: ["get"]
- apiGroups: [""]
  resources: ["events"]
  verbs: ["list", "watch"]
```

需要注意的是:**`PriorityClass` 是集群级资源**,使用暂停 Pod 或自动伸缩相关能力时必须使用 `ClusterRole` + `ClusterRoleBinding`,命名空间级的 Role 授权不到。

### 常用运维命令

```shell
# 查看 Runner Pod
kubectl get pods -n gitlab-runner
kubectl logs -n gitlab-runner deploy/gitlab-runner --tail=200

# 进入 Runner 容器操作
kubectl exec -it -n gitlab-runner deploy/gitlab-runner -- bash
gitlab-runner list          # 列出已注册的 Runner
gitlab-runner verify        # 验证与 GitLab 的连接
gitlab-runner run           # 前台运行(容器里通常已由 entrypoint 启动)

# 令牌与配置分别存放的位置
kubectl get secret -n gitlab-runner gitlab-runner-gitlab-runner-secret -o yaml
kubectl get configmap -n gitlab-runner -o name

# 观察作业 Pod 的创建
kubectl get pods -n gitlab-runner -w
```

Chart 会把令牌放在名为 `<release>-gitlab-runner-secret` 的 Secret 中(包含 `runner-token` 与 `runner-registration-token` 两个键),`config.toml` 则渲染进 ConfigMap。**迁移到新认证流程时**,把 `runner-registration-token` 置空、把令牌写入 `runner-token`。

### executor 的选择

```shell
Kubernetes         在集群里为每个作业创建 Pod(本文主题)
Docker             在宿主机上用容器执行,需要本机 Docker
Docker Autoscaler  自动伸缩的 Docker 执行器(使用 fleeting)
Instance           面向云主机实例的执行器(使用 fleeting)
SSH / Shell / VirtualBox / Parallels / Custom   维护模式,只修安全问题不再加新功能
Docker Machine     已废弃
```

在 Kubernetes 上部署时,应选 `kubernetes`;需要跑 Docker 命令(构建镜像)时,要么开 DinD,要么改用 Kaniko/Buildah 之类无需守护进程的方案。

### 注意

1. **认证方式已经换代**。用 `glrt-` 前缀的 Runner 认证令牌,不再使用注册令牌;`--registration-token` 虽然仍能用,但走的是 legacy 兼容流程,且注册令牌流程自 GitLab 17.0 起默认被禁用。
2. **每个作业一个 Pod,所以 RBAC 必须给足**。ServiceAccount 没有创建 Pod 的权限时,作业会直接报 `Forbidden`,表现为「Runner 在线但作业一直 pending」。
3. **不配缓存等于每次从零开始**。新 Pod 没有上一次构建的任何文件,`cache:` 配置必须指向对象存储(S3/GCS/Azure),否则依赖需要反复下载,流水线会慢得离谱。
4. **DinD 需要 `privileged = true`**。在 `[runners.kubernetes]` 中开启特权模式才能跑 Docker-in-Docker,这在安全上是明显的削弱;能用 Kaniko、Buildah 或 BuildKit 无守护进程方案时应优先选用它们。
5. **`concurrent` 不能为 0**。该值表示跨所有 Runner 的并发作业上限,设为 0 会让 Runner 进程直接以严重错误退出。
6. **helper 镜像要与 Runner 版本匹配**。`helper_image` 用于拉代码、上传产物,版本不匹配时会出现难以定位的通信失败;除非有特殊需求,交给 Chart 管理即可。
7. **不要 `exec` 进去手工改 `config.toml`**。配置来自 ConfigMap,`helm upgrade` 或 Pod 重建后手工改动会被覆盖,要通过 values 修改。
8. **服务容器共享 localhost,端口不能冲突**。同一个作业里两个 service 监听同一端口会有一个起不来,表现为连接被拒。
9. **`privileged = true` 会被限制性 Pod 安全策略拒绝**。开启 PSA `restricted` 的命名空间会直接禁止特权容器,需要改用基线以上的策略或换免特权构建方案。
10. **卸载时注意注销行为**。Chart 的 `unregisterRunners` 控制卸载时是否顺带在 GitLab 上注销 Runner;反复 `helm uninstall`/`install` 会在 GitLab 里留下一堆失效的 Runner 记录。
11. **作业 Pod 的命名空间与 RBAC 范围要对应**。设置了 `jobNamespace` 却只在原命名空间授权(或反之),都会导致作业无法创建 Pod。
12. **`Shell`、`SSH`、`VirtualBox`、`Parallels`、`Custom` 已进入维护模式**。这些执行器只接收关键安全更新,不再新增功能,新部署不要再基于它们设计。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `helm` — Kubernetes包管理器
- `jenkins` — CI/CD自动化服务器
- `tekton` — Kubernetes原生CI/CD流水线框架
- `skaffold` — Kubernetes构建与部署流水线工具

### 参考链接

- [GitLab Runner 官方文档](https://docs.gitlab.com/runner/)
- [在 Kubernetes 上安装 Runner](https://docs.gitlab.com/runner/install/kubernetes.html)
- [Kubernetes executor 配置](https://docs.gitlab.com/runner/executors/kubernetes/)
- [executor 一览](https://docs.gitlab.com/runner/executors/)
- [Runner 高级配置(config.toml)](https://docs.gitlab.com/runner/configuration/advanced-configuration/)
