microk8s
===

Canonical出品的snap打包Kubernetes,插件化开箱即用

## 补充说明

**MicroK8s** 是 Canonical(Ubuntu 背后的公司)推出的 Kubernetes 发行版,**只以 snap 包形式分发**。它的定位是「单命令安装、插件化扩展」:一条 `snap install` 得到完整集群,再按需 `microk8s enable` 打开 Ingress、存储、监控、GPU 等能力。

与 K3s、k0s 放在一起看,三者的路线差异很明显:

```shell
对比项        MicroK8s                K3s                     k0s
分发形式      snap 包(仅 Linux)       单个二进制 + 脚本        单个二进制
数据存储      dqlite(内置 HA)          SQLite / 嵌入式 etcd     SQLite / etcd
高可用        多节点自动组成 dqlite     需切嵌入式 etcd          多 controller 组 etcd
扩展方式      addon 体系              自带 Traefik/ServiceLB   基本不带
上手门槛      低,Ubuntu 上一条命令      低                       中
```

MicroK8s 最大的优点是**插件生态**:从 `dns`、`storage` 到 `gpu`、`knative`、`kubeflow`,几十个 addon 覆盖了绝大多数「装完集群后要装什么」的问题,一条命令即可启用。最大的限制则来自 snap 本身:它几乎只能在支持 snapd 的 Linux 上跑(Ubuntu 系最顺),Windows 与 macOS 需要借助 Multipass 虚拟机。

MicroK8s 用 **dqlite**(Canonical 自研的分布式 SQLite)作为数据存储,多节点时会自动组成带高可用的 dqlite 集群,这一点比 K3s 的单节点 SQLite 更省心。

### 安装

```shell
# 安装指定版本通道(推荐显式指定,避免自动跨版本升级)
sudo snap install microk8s --classic --channel=1.36/stable

# 把当前用户加入 microk8s 组,避免每条命令都加 sudo
sudo usermod -a -G microk8s $USER
mkdir -p ~/.kube
chmod 0700 ~/.kube
su - $USER          # 重新登录使组权限生效

# 确认状态
microk8s status --wait-ready
```

`--channel` 支持 `1.36/stable`、`1.35/stable`、`latest/stable` 以及各类 `edge` / `beta` 通道。

### 访问集群

MicroK8s 自带 kubectl,但**不会**自动写入 `~/.kube/config`:

```shell
# 通过内置 kubectl 操作
microk8s kubectl get nodes
microk8s kubectl get pods -A

# 设置别名,当成普通 kubectl 用
alias kubectl='microk8s kubectl'
echo "alias kubectl='microk8s kubectl'" >> ~/.bash_aliases

# 导出 kubeconfig 给外部工具(如 Helm、k9s、Lens)
microk8s config > ~/.kube/config
microk8s config --server 10.0.0.10 > ~/.kube/config
```

### 插件体系

```shell
# 查看所有插件及启用状态
microk8s status
microk8s status --wait-ready

# 启用插件
microk8s enable dns
microk8s enable hostpath-storage
microk8s enable ingress
microk8s enable registry
microk8s enable metrics-server
microk8s enable cert-manager
microk8s enable prometheus

# 关闭插件
microk8s disable ingress
```

新装集群**默认已启用**的插件是:`dns`、`ha-cluster`、`helm`、`metrics-server`。

常用插件一览:

```shell
dns                CoreDNS,默认启用
ha-cluster         多节点高可用,默认启用
helm               Helm 3,默认启用
metrics-server     资源指标,默认启用
hostpath-storage   基于本地目录的 StorageClass,不适用于生产
ingress            Ingress Controller,1.35 起默认使用 Traefik
registry           内置私有镜像仓库,监听 32000 端口
cert-manager       证书自动签发
prometheus         监控栈
gpu                NVIDIA GPU 支持
istio              服务网格
```

### 从宿主机访问插件服务

```shell
# Ingress:先看它监听在哪个端口
microk8s kubectl get svc -n ingress

# registry:默认 32000
microk8s kubectl get svc -n container-registry

# 需要把 Service 暴露到宿主机时
microk8s kubectl port-forward -n ingress svc/traefik 8080:80
```

### 多节点高可用

```shell
# 1. 在已有节点上生成加入指令(输出里包含一条完整的 microk8s join 命令)
microk8s add-node

# 2. 在新节点执行输出的指令(端口 25000 是集群通信端口)
microk8s join 10.0.0.10:25000/<token>

# 3. 查看节点
microk8s kubectl get nodes

# 4. 节点下线
microk8s leave
microk8s remove-node 10.0.0.21
```

三个及以上节点即可获得控制平面高可用。集群的 CNI 在 1.19 之后固定为 **Calico**。

### 维护与排障

```shell
# 生命周期
microk8s stop
microk8s start

# 一键体检(收集日志、服务状态、端口占用,排查问题的第一站)
microk8s inspect

# 查看组件日志
microk8s kubectl logs -n kube-system deploy/coredns
journalctl -u snap.microk8s.daemon-kubelite

# 重置集群(清空所有工作负载,回到初始状态)
microk8s reset

# 完全卸载
sudo snap remove microk8s
```

### 升级

```shell
# 查看当前通道与版本
snap info microk8s
microk8s version

# 切换通道即触发升级
sudo snap refresh microk8s --channel=1.36/stable

# 关闭自动刷新,避免生产集群被自动升级
sudo snap refresh --hold microk8s
sudo snap refresh --unhold microk8s
```

### 注意

1. **MicroK8s 只以 snap 分发,必须用 snap 管理**。不要试图把它当普通程序,升级、回滚、通道切换全部通过 `snap refresh` / `snap revert` 完成;在 CentOS、RHEL 这类默认不带 snapd 的系统上要先自行安装 snapd,体验会明显打折。
2. **snap 默认会自动刷新,可能在你不知情的时候升级集群**。生产环境务必执行 `sudo snap refresh --hold microk8s` 锁住版本,并配合 `--channel` 显式指定;否则某天早上会发现 Kubernetes 被自动升了一个小版本。
3. **kubeconfig 不会自动写到 `~/.kube/config`**。这与 minikube、kind 的行为不同,Helm、k9s、IDE 等工具都会连不上,需要手工 `microk8s config > ~/.kube/config`。
4. **组权限变更要重新登录才生效**。`usermod -a -G microk8s $USER` 之后不 `su - $USER`(或重新登录),每条命令仍要加 `sudo`。
5. **`ingress` 插件在 1.35 起改用 Traefik**。网上大量教程还在按 NGINX 写注解(`nginx.ingress.kubernetes.io/...`),在新版本上是无效的;IngressClass 也从 `nginx` 变成了 `public`,旧清单需要同步调整。启用后宿主机不会自动开放 80/443,要自己确认 Service 端口。
6. **`dashboard` 插件在 1.36 已被移除**。跟随上游 Kubernetes 弃用 Dashboard 的决定,MicroK8s 1.36 同时删掉了 `dashboard` 核心插件、`dashboard-ingress` 社区插件与 `microk8s dashboard-proxy` 命令。要 Web 控制台只能用 1.35 及更早版本,或自行部署其他 UI。
7. **`hostpath-storage` 不是生产级存储**。它的名字在旧文档里叫 `storage`,底层就是节点上的本地目录,Pod 漂移到别的节点后数据不可见。生产请换成 Ceph、Longhorn、OpenEBS 等真正的 CSI 方案。
8. **GPU 插件在 1.36 有破坏性变更**。addon 不再强制把 NVIDIA runtime 设为 containerd 默认运行时,使用 GPU 的 Pod 必须显式声明 `runtimeClassName: nvidia`,否则会拿不到设备。
9. **`microk8s reset` 会删除所有工作负载与本地存储卷**,不可恢复。执行前请确认已备份;而 `sudo snap remove microk8s` 连数据目录一起清掉。
10. **不要在同一个节点上重复执行 `microk8s join`**。加入指令里的 token 是一次性的,重复使用会报错;需要重新加入时先在旧节点 `microk8s leave`。
11. **MicroK8s 的 addon 是 Canonical 打包的固定版本**,升级节奏跟随 MicroK8s 通道而非上游 chart。想用最新的 Ingress Controller 或监控组件版本时,可能得关掉 addon 改用 Helm 自行部署。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `k3s` — 轻量级 Kubernetes 发行版
- `k0s` — 单二进制 Kubernetes 发行版
- `kubeadm` — Kubernetes集群安装工具
- `helm` — Kubernetes包管理工具

### 参考链接

- [MicroK8s 官方文档](https://canonical.com/microk8s/docs)
- [MicroK8s 快速开始](https://canonical.com/microk8s/docs/getting-started)
- [MicroK8s 插件列表](https://canonical.com/microk8s/docs/addons)
- [MicroK8s 高可用说明](https://canonical.com/microk8s/docs/high-availability)
- [MicroK8s GitHub 仓库](https://github.com/canonical/microk8s)
