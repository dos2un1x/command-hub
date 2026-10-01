minikube
===

本地单机Kubernetes快速体验环境

## 补充说明

**minikube命令** 用于在本机快速拉起一个单节点(或多节点)的 Kubernetes 集群,面向本地开发与学习场景。它在容器或虚拟机里运行一个完整的 Kubernetes 节点,并提供了一整套配套命令来管理这个环境。

minikube 的价值在于**零配置起步**:一条 `minikube start` 就能得到带 Dashboard、Ingress、metrics-server 等可选插件的可用集群,且 `kubectl` 的上下文会被自动配置好。

支持的驱动(Driver):

```shell
docker       在 Docker 容器里运行(最推荐,macOS/Linux/Windows 通用)
podman       使用 Podman 作为运行时
kvm2         Linux 上的 KVM 虚拟机
qemu         跨平台虚拟机驱动
virtualbox   VirtualBox 虚拟机
hyperv       Windows Hyper-V
vmware       VMware Fusion / Workstation
ssh          通过 SSH 部署到远程主机
none         直接跑在宿主机上,不使用容器或虚拟机(需 root)
```

驱动选择建议:**能用 docker 就用 docker**,启动最快、资源开销最小。

### 安装

```shell
# macOS
brew install minikube

# Linux 二进制
curl -LO https://storage.googleapis.com/minikube/releases/latest/minikube-linux-amd64
sudo install minikube-linux-amd64 /usr/local/bin/minikube

# Debian / Ubuntu
curl -LO https://storage.googleapis.com/minikube/releases/latest/minikube_latest_amd64.deb
sudo dpkg -i minikube_latest_amd64.deb

# RHEL / CentOS
curl -LO https://storage.googleapis.com/minikube/releases/latest/minikube-latest.x86_64.rpm
sudo rpm -Uvh minikube-latest.x86_64.rpm

# Windows
choco install minikube
winget install Kubernetes.minikube
```

### 语法

```shell
minikube [command]
```

```shell
minikube start       启动集群
minikube stop        停止集群(保留状态)
minikube delete      删除集群
minikube status      查看集群状态
minikube dashboard   打开 Web 控制台
minikube service     暴露 Service 到宿主机浏览器
minikube tunnel      为 LoadBalancer 类型的 Service 建立隧道
minikube ssh         登录集群节点
minikube kubectl     使用与集群版本匹配的 kubectl
minikube addons      管理插件
minikube ip          查看节点 IP
minikube profile     管理多套集群配置
minikube image       构建 / 加载 / 列出镜像
minikube node        管理集群中的节点
minikube config      管理默认配置
minikube logs        查看集群日志
minikube mount       挂载宿主机目录到集群
minikube update-context  修正 kubeconfig 中的连接信息
minikube pause       暂停集群
minikube unpause     恢复暂停的集群
minikube completion  生成 shell 自动补全
```

### 启动集群

```shell
# 最简启动(自动选择驱动)
minikube start

# 指定驱动与资源
minikube start --driver=docker --cpus=4 --memory=8192 --disk-size=20g

# 指定 Kubernetes 版本(需 minikube 版本支持)
minikube start --kubernetes-version=v1.31.0

# 指定容器运行时
minikube start --driver=docker --container-runtime=containerd

# 多节点集群(1 控制平面 + 2 工作节点)
minikube start --nodes=3 --cpus=2 --memory=4096

# 使用国内镜像源(网络受限时)
minikube start --image-mirror-country=cn --image-repository=registry.cn-hangzhou.aliyuncs.com/google_containers

# 命名 profile,便于同时维护多套环境
minikube start -p dev --cpus=4
minikube start -p test --kubernetes-version=v1.30.0

# 查看与管理 profile
minikube profile list
minikube profile dev
minikube delete -p test
```

### 日常操作

```shell
# 状态与生命周期
minikube status
minikube stop
minikube pause
minikube unpause
minikube delete
minikube delete --all --purge      # 删除全部 profile 并清空 ~/.minikube

# kubectl 集成
kubectl get nodes
minikube kubectl -- get pods -A    # 不依赖本机 kubectl
alias kubectl="minikube kubectl --"

# 节点 IP 与连接信息
minikube ip
minikube update-context

# 进入节点
minikube ssh
minikube ssh -n minikube-m02       # 多节点时指定节点
minikube node list
minikube node add                  # 动态添加工作节点

# 查看集群日志(排查启动失败的首要手段)
minikube logs
minikube logs --file=minikube.log
```

### 访问服务

```shell
# 打开 Dashboard
minikube dashboard
minikube dashboard --url           # 只输出地址,不打开浏览器

# 把 Service 映射到宿主机浏览器(命令会阻塞,可加 --url)
minikube service my-service
minikube service my-service -n dev
minikube service --all
minikube service my-service --url

# LoadBalancer 类型 Service 需要隧道(需要 sudo,单独终端常驻)
minikube tunnel

# 获取集群内可达的 URL
minikube service my-service --url -n dev
```

### 镜像与本地构建

```shell
# 方式一:把宿主机镜像直接加载进集群
minikube image load my-app:latest
minikube image ls

# 方式二:把宿主机 Docker 环境指向集群内的守护进程
eval $(minikube docker-env)
docker build -t my-app:latest .
# 之后 Pod 中使用 my-app:latest 且 imagePullPolicy 需为 IfNotPresent 或 Never
eval $(minikube docker-env -u)     # 用完后恢复

# 方式三:在集群内直接构建
minikube image build -t my-app:latest .

# Podman 用户
eval $(minikube podman-env)
```

### 插件

```shell
minikube addons list
minikube addons enable ingress
minikube addons enable metrics-server
minikube addons enable dashboard
minikube addons enable registry
minikube addons disable ingress
```

常用插件:`dashboard`、`ingress`、`ingress-dns`、`metrics-server`、`registry`、`storage-provisioner`、`default-storageclass`。

### 默认配置

```shell
# 持久化默认值,避免每次输入参数
minikube config set driver docker
minikube config set cpus 4
minikube config set memory 8192
minikube config set kubernetes-version v1.31.0

minikube config view
minikube config unset memory
```

### 注意

1. **必须先有可用的驱动**。macOS 上最省事的是 Docker Desktop 或 OrbStack;若 `minikube start` 卡在 `Pulling base image`,多半是驱动没装好或镜像拉取被墙。
2. **`--nodes` 多节点会成倍占用资源**。每个节点都是独立容器,默认每节点 2 CPU / 2 GB,宿主机资源不足时会启动失败并报 `RSRC_INSUFFICIENT`。
3. **`--kubernetes-version` 不能随意指定**。minikube 只支持其内置的若干版本,超出范围会报错,可用 `minikube start --kubernetes-version=stable` 或直接省略。
4. **`minikube tunnel` 需要 sudo 且必须常驻运行**。关闭终端后 LoadBalancer 的 EXTERNAL-IP 会立刻消失,建议单独开一个终端窗口跑。
5. **`minikube delete --all --purge` 会清空 `~/.minikube`**,包括所有 profile、缓存镜像与证书,不可恢复。
6. **`none` 驱动会直接修改宿主机**,需要 root,且会绕过容器隔离,只建议在一次性 CI 虚拟机上使用。
7. **用 `eval $(minikube docker-env)` 构建的镜像,`imagePullPolicy` 必须是 `IfNotPresent` 或 `Never`**。若保持默认的 `Always`,kubelet 会尝试从远程仓库拉取同名镜像,直接 `ImagePullBackOff`。
8. **`minikube start` 会把 kubeconfig 的 current-context 切到 minikube**。同时管理生产集群时要留意,用 `kubectl config use-context` 切回,或用 `-p` 多 profile 隔离。
9. **`minikube service` 命令默认会阻塞终端并占用前台**,脚本里请加 `--url` 只取地址。
10. **`minikube stop` 只是停止,数据仍在**;容器停止后 IP 可能变化,恢复后需执行 `minikube update-context` 修正 kubeconfig。
11. minikube 面向**本地开发与学习**,不具备高可用,不要用于生产环境;生产部署请使用 `kubeadm` 或托管集群。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kind` — 用 Docker 运行本地集群
- `kubeadm` — Kubernetes集群安装工具
- `k9s` — 终端下的 Kubernetes 管理 UI

### 参考链接

- [minikube 官方文档](https://minikube.sigs.k8s.io/docs/)
- [minikube 驱动说明](https://minikube.sigs.k8s.io/docs/drivers/)
- [minikube 命令参考](https://minikube.sigs.k8s.io/docs/commands/)
- [minikube GitHub 仓库](https://github.com/kubernetes/minikube)
