kind
===

用Docker容器运行本地Kubernetes集群

## 补充说明

**kind**(Kubernetes IN Docker)把每个 Kubernetes 节点都跑成一个 Docker 容器,从而在单机上拉起多节点的真实集群。它最初是 Kubernetes 官方为自身 e2e 测试而开发的工具,如今是 CI 流水线与本地验证的事实标准之一。

与 minikube 的区别:

| 对比项 | kind | minikube |
| --- | --- | --- |
| 节点实现 | 每个节点是一个 Docker 容器 | 默认单节点容器/虚拟机 |
| 多节点 | 原生支持,配置驱动 | 支持,但资源开销更大 |
| 启动速度 | 快,适合频繁创建销毁 | 相对较慢 |
| 插件生态 | 无内置插件,需自行部署 | 内置 Dashboard/Ingress 等插件 |
| 定位 | CI、e2e 测试、精确复现 | 本地开发体验 |

kind 的节点镜像(`kindest/node`)里已经预装好 kubelet、containerd 与 kubeadm,集群通过 kubeadm 在容器内初始化,因此**它跑的是货真价实的 Kubernetes**,而不是精简模拟。

### 安装

```shell
# macOS / Linux (Homebrew)
brew install kind

# Go 安装(可指定版本)
go install sigs.k8s.io/kind@v0.24.0

# 下载二进制(Linux)
curl -Lo ./kind https://kind.sigs.k8s.io/dl/v0.24.0/kind-linux-amd64
chmod +x ./kind
sudo mv ./kind /usr/local/bin/kind

# macOS 二进制
curl -Lo ./kind https://kind.sigs.k8s.io/dl/v0.24.0/kind-darwin-arm64
chmod +x ./kind && sudo mv ./kind /usr/local/bin/kind

# Windows
choco install kind

kind version
```

前置条件:宿主机需安装 **Docker**(或 Podman),且当前用户有权限访问 Docker 守护进程。

### 语法

```shell
kind [command]
```

```shell
kind create cluster   创建集群
kind delete cluster   删除集群
kind get clusters     列出集群
kind get nodes        列出集群节点(容器名)
kind get kubeconfig   输出集群的 kubeconfig
kind export kubeconfig  导出并合并 kubeconfig
kind export logs      导出节点日志,排障必备
kind load docker-image  把宿主机镜像加载进集群
kind load image-archive 把镜像归档文件加载进集群
kind build node-image   自行构建节点镜像
kind completion       生成 shell 自动补全
kind version          查看版本
```

### 创建集群

```shell
# 最简创建(集群名默认为 kind)
kind create cluster

# 指定名称与节点镜像版本
kind create cluster --name dev --image kindest/node:v1.31.0

# 使用配置文件
kind create cluster --config kind-config.yaml

# 创建后保留节点容器,便于事后调试
kind create cluster --name debug --retain

# 把 kubeconfig 写到独立文件,避免污染默认上下文
kind create cluster --name dev --kubeconfig ./dev-kubeconfig

# 等待创建完成
kind create cluster --name dev --wait 120s
```

### 集群配置示例

多节点 + 端口映射 + 节点标签的典型配置:

```shell
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
name: dev
networking:
  apiServerAddress: "127.0.0.1"
  apiServerPort: 6443
  podSubnet: "10.244.0.0/16"
  serviceSubnet: "10.96.0.0/12"
nodes:
- role: control-plane
  kubeadmConfigPatches:
  - |
    kind: InitConfiguration
    nodeRegistration:
      kubeletExtraArgs:
        node-labels: "ingress-ready=true"
  # 把节点容器端口映射到宿主机,创建后不可修改
  extraPortMappings:
  - containerPort: 80
    hostPort: 80
    protocol: TCP
  - containerPort: 443
    hostPort: 443
    protocol: TCP
- role: worker
- role: worker
```

启用特性门控与运行时配置:

```shell
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
featureGates:
  DynamicResourceAllocation: true
runtimeConfig:
  api/alpha: "true"
```

### 常用操作

```shell
# 查看与切换
kind get clusters
kubectl config get-contexts
kubectl config use-context kind-dev

# 节点与 kubeconfig
kind get nodes --name dev
kind get kubeconfig --name dev
kind export kubeconfig --name dev --kubeconfig ./dev-config

# 节点本身就是容器,可以直接用 docker 查看
docker ps --filter "label=io.x-k8s.kind.cluster=dev"
docker exec -it dev-control-plane bash

# 删除
kind delete cluster --name dev
kind delete clusters --all

# 导出日志(集群异常时的第一手资料)
kind export logs --name dev ./kind-logs
```

### 加载本地镜像

```shell
# 直接加载宿主机 Docker 中的镜像
kind load docker-image my-app:latest --name dev

# 从归档文件加载
docker save my-app:latest -o my-app.tar
kind load image-archive my-app.tar --name dev

# 多节点集群会加载到所有节点
kind load docker-image my-app:latest --name dev --nodes dev-worker,dev-worker2
```

配套的 Pod 必须设置拉取策略,否则 kubelet 仍会去远程仓库找同名镜像:

```shell
spec:
  containers:
  - name: app
    image: my-app:latest
    imagePullPolicy: IfNotPresent    # 或 Never
```

### 部署 Ingress 与 LoadBalancer

```shell
# 1. 用带 extraPortMappings 的配置创建集群(见上文)

# 2. 部署适配 kind 的 ingress-nginx
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/main/deploy/static/provider/kind/deploy.yaml

# 3. 等待就绪
kubectl wait --namespace ingress-nginx \
  --for=condition=ready pod \
  --selector=app.kubernetes.io/component=controller \
  --timeout=90s

# 4. 现在可以通过 http://localhost 访问 Ingress

# LoadBalancer 类型 Service 需要额外组件
# 方案一:MetalLB
kubectl apply -f https://raw.githubusercontent.com/metallb/metallb/v0.14.8/config/manifests/metallb-native.yaml
# 方案二:cloud-provider-kind(为 kind 提供云控制器)
```

### CI 中的典型用法

```shell
# 创建 -> 加载镜像 -> 部署 -> 测试 -> 销毁
kind create cluster --name ci --config kind-config.yaml
kind load docker-image my-app:${GIT_SHA} --name ci
kubectl apply -k overlays/test
kubectl rollout status deployment/my-app --timeout=120s
kubectl get pods -o wide
kind delete cluster --name ci
```

### 注意

1. **必须提前安装 Docker 或 Podman**。kind 本身只是一个编排器,没有容器运行时无法创建任何节点。
2. **`kindest/node` 镜像的版本要与 kind 版本匹配**。每个 kind 版本都有对应的默认节点镜像,跨版本乱用可能初始化失败;不确定时省略 `--image` 用默认值。
3. **`extraPortMappings` 只在创建集群时生效**,创建后无法修改。要改端口必须删除集群重建,这是最常见的返工点。
4. **`kind load docker-image` 加载的镜像必须配合 `imagePullPolicy: IfNotPresent` 或 `Never`**。默认的 `Always` 会让 kubelet 无视本地镜像去远程拉取,直接 `ImagePullBackOff`。
5. **kind 会改写 kubeconfig 并把 current-context 切到新集群**。同时管理多个集群时请用 `--kubeconfig` 指定独立文件,或用 `kind export kubeconfig` 后再手工合并。
6. **节点是容器,不是虚拟机**。`kubectl get nodes` 看到的节点名对应一个 Docker 容器,容器重启等同于节点重启,集群数据可能丢失。
7. **kind 默认没有动态存储供应器**。需要 PVC 的场景要自行安装 local-path-provisioner 或其他 CSI 插件。
8. **LoadBalancer 类型的 Service 不会拿到外部 IP**,除非额外部署 MetalLB 或 cloud-provider-kind。裸用时会一直停在 `<pending>`。
9. **`kind delete cluster` 会一并删除节点容器和集群数据**,`--retain` 创建的节点容器不会被自动清理,需手工 `docker rm`。
10. kind 是**为测试与 CI 设计的**,没有高可用控制平面,不适合承载任何生产流量;生产环境请使用 `kubeadm` 或托管 Kubernetes 服务。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `minikube` — 本地Kubernetes开发环境
- `kubeadm` — Kubernetes集群安装工具
- `k9s` — 终端下的 Kubernetes 管理 UI

### 参考链接

- [kind 官方文档](https://kind.sigs.k8s.io/)
- [kind 快速上手](https://kind.sigs.k8s.io/docs/user/quick-start/)
- [kind 配置参考](https://kind.sigs.k8s.io/docs/user/configuration/)
- [kind GitHub 仓库](https://github.com/kubernetes-sigs/kind)
