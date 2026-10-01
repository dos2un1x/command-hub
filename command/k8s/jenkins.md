jenkins
===

Kubernetes上运行的CI/CD自动化服务器

## 补充说明

**Jenkins** 是使用最广泛的持续集成/持续交付服务器。把它跑在 Kubernetes 上有两种截然不同的思路:

- **传统做法**:把 Jenkins 当普通应用塞进 Pod,构建全在控制器进程里跑 —— 镜像越做越大,一个构建就能把控制器拖垮。
- **Kubernetes 原生做法**:控制器只负责调度,每次构建由 **Kubernetes 插件**动态创建一个 Agent Pod,构建结束后 Pod 自动销毁。这是官方推荐、也是 Helm Chart 默认采用的模式。

控制器 Pod 内固定有 **Kubernetes 插件**(Kubernetes plugin,旧名 kubernetes-plugin),它通过集群内 API 创建 Agent Pod。因此部署 Jenkins 的核心工作其实是三件事:装控制器、给控制器访问 Pod 的 RBAC、配置 Pod 模板。

### 安装

```shell
# 添加官方 Helm 仓库(官方文档用 jenkinsci 作为仓库别名)
helm repo add jenkinsci https://charts.jenkins.io
helm repo update

# 创建命名空间
kubectl create namespace jenkins

# 默认安装(不推荐用于生产:没有持久化)
helm install jenkins -n jenkins jenkinsci/jenkins

# 推荐:导出默认 values 后修改
helm show values jenkinsci/jenkins > jenkins-values.yaml
helm install jenkins -n jenkins -f jenkins-values.yaml jenkinsci/jenkins

# 指定 Chart 版本(Chart 5.6.0 起也可以用 OCI 地址
# oci://ghcr.io/jenkinsci/helm-charts/jenkins)
helm install jenkins -n jenkins -f jenkins-values.yaml \
  jenkinsci/jenkins --version 5.8.0
```

### 获取初始密码与访问

```shell
# 取出 admin 初始密码(Secret 名默认等于 release 名)
kubectl get secret -n jenkins jenkins \
  -o jsonpath="{.data.jenkins-admin-password}" | base64 --decode && echo

# 端口转发
kubectl -n jenkins port-forward svc/jenkins 8080:8080

# 浏览器访问 http://127.0.0.1:8080,用户名 admin
```

### values.yaml 关键配置

```shell
controller:
  # 对外暴露方式:ClusterIP / NodePort / LoadBalancer
  serviceType: ClusterIP
  # 控制器资源,务必显式设置
  resources:
    requests:
      cpu: "500m"
      memory: "1Gi"
    limits:
      cpu: "2"
      memory: "4Gi"
  # 预装插件列表
  installPlugins:
  - kubernetes
  - workflow-aggregator
  - git
  - configuration-as-code
  - job-dsl
  # 配置即代码(JCasC)
  JCasC:
    defaultConfig: true
    configScripts:
      welcome: |
        jenkins:
          systemMessage: "Managed by Helm + JCasC"
  # 升级时递增,用于触发配置重载
  # sidecar 容器在配置变更时自动 reload
  sidecars:
    configAutoReload:
      enabled: true

# 必须:持久化,否则重启即丢全部任务与凭据
persistence:
  enabled: true
  storageClass: "standard"
  size: "20Gi"

# 必须:允许控制器创建 Agent Pod
rbac:
  create: true

serviceAccount:
  create: true
  name: jenkins

# 动态 Agent
agent:
  enabled: true
  # 控制器地址,必须是 Agent Pod 能解析到的集群内地址
  jenkinsUrl: "http://jenkins.jenkins.svc.cluster.local:8080"
  jenkinsTunnel: "jenkins-agent.jenkins.svc.cluster.local:50000"
  # 直连模式:Agent 直接连控制器,不经过隧道
  # directConnection: true
  podTemplates: {}
```

### 手动创建 ServiceAccount 与 RBAC

如果不用 Chart 的 `rbac.create`,需要自己准备。Kubernetes 插件至少需要创建、查看、删除 Pod 以及进入容器执行命令的权限:

```shell
apiVersion: v1
kind: ServiceAccount
metadata:
  name: jenkins
  namespace: jenkins
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: jenkins-agent
  namespace: jenkins
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["create", "delete", "get", "list", "watch", "patch", "update"]
- apiGroups: [""]
  resources: ["pods/exec"]
  verbs: ["create", "delete", "get", "list", "watch"]
- apiGroups: [""]
  resources: ["pods/log"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: jenkins-agent
  namespace: jenkins
subjects:
- kind: ServiceAccount
  name: jenkins
  namespace: jenkins
roleRef:
  kind: Role
  name: jenkins-agent
  apiGroup: rbac.authorization.k8s.io
```

### 配置 Kubernetes 云(JCasC)

控制器的 Pod 模板有两种维护方式:UI 手点(`系统管理 → 节点与云 → Clouds`)或 JCasC。生产环境应使用 JCasC,因为它可以被 Git 管理:

```shell
jenkins:
  clouds:
  - kubernetes:
      name: "kubernetes"
      serverUrl: "https://kubernetes.default.svc"
      namespace: "jenkins"
      # Agent 回调控制器用的地址,必须从 Pod 内可解析
      jenkinsUrl: "http://jenkins.jenkins.svc.cluster.local:8080"
      jenkinsTunnel: "jenkins-agent.jenkins.svc.cluster.local:50000"
      containerCapStr: "10"
      connectTimeout: 5
      readTimeout: 15
      # 新版插件用 templates,旧版插件里这个键叫 podTemplates
      templates:
      - name: "default"
        label: "k8s-agent"
        idleMinutes: 5
        instanceCapStr: "20"
        containers:
        # 容器名必须是 jnlp,插件靠这个名字注入通信逻辑
        - name: "jnlp"
          image: "jenkins/inbound-agent:latest"
          alwaysPullImage: false
          workingDir: "/home/jenkins/agent"
          resourceRequestCpu: "200m"
          resourceRequestMemory: "256Mi"
        - name: "maven"
          image: "maven:3.9-eclipse-temurin-17"
          command: "cat"
          ttyEnabled: true
```

### Pipeline 中使用动态 Agent

声明式流水线里用 `kubernetes` agent 直接声明一次性 Pod,是 Kubernetes 上最常用的写法:

```shell
pipeline {
  agent {
    kubernetes {
      // 只需声明业务容器,jnlp 容器由插件自动注入
      yaml '''
apiVersion: v1
kind: Pod
spec:
  containers:
  - name: maven
    image: maven:3.9-eclipse-temurin-17
    command: ['cat']
    tty: true
  - name: kaniko
    image: gcr.io/kaniko-project/executor:debug
    command: ['sleep']
    args: ['99d']
'''
    }
  }
  stages {
    stage('Build') {
      steps {
        container('maven') {
          sh 'mvn -B -DskipTests clean package'
        }
      }
    }
  }
}
```

### 共享库、凭据与插件

```shell
# 进入控制器容器执行 CLI
kubectl -n jenkins exec -it jenkins-0 -c jenkins -- bash

# 列出已装插件
jenkins-plugin-cli --list

# 安装插件
jenkins-plugin-cli --plugins kubernetes:latest git:latest
```

凭据建议用 JCasC 的 `credentials:` 块引用环境变量或 Kubernetes Secret,而不是在 UI 里手填 —— 这样凭据来源可追溯、可重建:

```shell
credentials:
  system:
    domainCredentials:
    - credentials:
      - string:
          scope: GLOBAL
          id: "registry-token"
          secret: "${REGISTRY_TOKEN}"
```

### 注意

1. **Kubernetes 插件的容器名必须是 `jnlp`**。插件靠这个名字识别哪个容器负责启动 Agent 通信;改名成 `agent` 或 `slave` 后 Pod 会起来,但永远连不上控制器,构建卡在 `Waiting for next available executor`。
2. **`jenkinsUrl` 必须是 Agent Pod 能从集群内解析的地址**。填外网 Ingress 域名是经典错误 —— 域名在集群内解析不到(或指向外部网关回不来),表现为 Agent Pod 反复重启、日志里 404 或 connection refused。集群内一律用 `http://<service>.<namespace>.svc.cluster.local:8080`。
3. **隧道端口 50000 走不通时改用 WebSocket**。控制器只暴露了 HTTP 端口、没有为 JNLP 隧道开放 Ingress 时,JNLP 协议会失败;在 Pod 模板里启用 WebSocket(或在 Chart 里设 `agent.directConnection: true`)可绕过隧道。
4. **不持久化的 Jenkins 等于一次性沙盒**。`persistence.enabled=false` 时,控制器 Pod 重建后所有任务、凭据、插件配置全部丢失。生产环境必须挂 PVC。
5. **JCasC 会覆盖 UI 改动**。开启 `controller.JCasC.defaultConfig: true` 后,每次重载配置都以 `configScripts` 为准,在 UI 里手改的云配置、安全域会在下一次 reload 时被抹掉。
6. **RBAC 缺失时 Agent Pod 创建失败**。`rbac.create: false` 又用了默认 ServiceAccount,控制器调用 API 会被拒(403),任务报 `Forbidden: User "system:serviceaccount:..." cannot create resource "pods"`。
7. **镜像 tag 用 `latest` 会让集群静默漂移**。Agent 镜像默认 `alwaysPullImage: false`,节点上缓存了新版本也不会拉取,导致同样的流水线在不同节点行为不一致 —— 应当给 Agent 镜像打固定 tag 或 digest。
8. **Pod 残留会耗尽资源**。`podRetention` 默认策略下,失败或中断的构建 Pod 会被保留用于看日志,长期运行会积累大量 `Completed`/`Error` 状态的 Pod,需要配合 `idleMinutes`、`instanceCapStr` 与定期清理。
9. **文件系统权限**。官方镜像以 uid 1000 的 `jenkins` 用户运行,`hostPath` 或未设置 `fsGroup` 的 PVC 会导致 `/var/jenkins_home` 写入失败并启动崩溃;Chart 默认用 `fsGroup: 1000` 解决这一点。
10. **`helm upgrade` 会重建控制器 Pod**,正在执行的构建随之中断(它们跑在独立的 Agent Pod 里,但会失去与控制器的心跳)。升级应安排在构建空窗期,并先把控制器置为静默(进入「Prepare for Shutdown」)。
11. **插件版本与 Jenkins 内核强绑定**。升级 Chart 时 `installPlugins` 里的插件可能要求更高版本的 Jenkins,表现为启动时报插件不兼容;应锁定插件版本,并在升级前看发布说明。另外,给控制器设置 `numExecutors: 0` 可强制所有任务走 Agent,避免构建把控制器拖死。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `helm` — Kubernetes包管理器
- `tekton` — Kubernetes原生CI/CD流水线框架
- `gitlab-runner` — GitLab CI 执行器

### 参考链接

- [Jenkins 官方文档](https://www.jenkins.io/doc/)
- [在 Kubernetes 上安装 Jenkins](https://www.jenkins.io/doc/book/installing/kubernetes/)
- [Jenkins Helm Chart 仓库](https://github.com/jenkinsci/helm-charts)
- [Kubernetes 插件文档](https://plugins.jenkins.io/kubernetes/)
- [配置即代码(JCasC)](https://www.jenkins.io/doc/book/managing/casc/)
