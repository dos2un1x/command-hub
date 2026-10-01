k3s
===

轻量级Kubernetes发行版,单二进制适合边缘与资源受限环境

## 补充说明

**K3s** 是 Rancher(SUSE)推出的轻量级 Kubernetes 发行版。它把控制平面、kubelet、容器运行时(containerd)与网络组件全部打包进**一个不到 100 MB 的二进制**,用一条脚本就能拉起集群。它是通过 CNCF 一致性认证的**完整 Kubernetes**,不是模拟或阉割版,业务侧的 YAML 写法与上游完全一致。

K3s 的适用场景很明确:

- **边缘与 IoT**:ARM 设备、工控机、门店网关,资源常在 1-2 核 / 512 MB-2 GB。
- **CI 与本地开发**:启动快、卸载干净,被 k3d 等工具封装成容器里的集群。
- **小规模生产**:单节点或三节点即可上线,运维成本远低于 kubeadm 自建。
- **离线/气隙环境**:单个二进制加一个镜像包就能完成部署。

### 与上游 Kubernetes 的差异

K3s 没有修改 Kubernetes 的 API 语义,它做的是「换掉外围实现、砍掉不常用的部分」:

```shell
组件            上游默认                  K3s 默认
数据存储        etcd                      SQLite(经 kine 翻译层)
容器运行时      containerd(需自装)        containerd(内置)
CNI             需自行安装                Flannel(内置)
Ingress         无(自行部署)              Traefik(内置)
LoadBalancer    依赖云厂商                ServiceLB(原名 Klipper,内置)
云厂商集成      in-tree cloud provider    已移除,改用外部 CCM
存储插件        in-tree 存储插件          已移除,统一走 CSI
```

被移除的还有大部分 Alpha 特性门控、部分用不到的 controller 与调度插件。换句话说,K3s 保留了你写业务 YAML 需要的一切,砍掉的是「只有大规模云环境才用得上」的部分。

### 安装

```shell
# 单节点:安装后即作为一个完整集群启动
curl -sfL https://get.k3s.io | sh -

# 指定版本
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION=v1.37.0+k3s1 sh -

# 走国内镜像源(网络受限时)
curl -sfL https://get.k3s.io | INSTALL_K3S_MIRROR=cn sh -

# 安装后确认
sudo systemctl status k3s
sudo k3s kubectl get nodes
```

脚本会把 K3s 注册为 systemd(或 openrc)服务,并额外安装 `kubectl`、`crictl`、`ctr`、`k3s-killall.sh`、`k3s-uninstall.sh` 这几个工具。

### 单节点常用参数

安装脚本通过 `INSTALL_K3S_EXEC` 把参数透传给 `k3s server`:

```shell
# 关闭内置 Traefik(准备自建 Ingress Controller 时)
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--disable traefik" sh -

# 关闭 ServiceLB(准备改用 MetalLB 时)
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--disable servicelb" sh -

# 一次关掉多个内置组件
curl -sfL https://get.k3s.io | \
  INSTALL_K3S_EXEC="--disable traefik --disable servicelb --disable metrics-server" sh -
```

参数也可以写进配置文件 `/etc/rancher/k3s/config.yaml`,比改命令行更好维护:

```shell
disable:
  - traefik
  - servicelb
write-kubeconfig-mode: "0644"
tls-san:
  - "k3s.example.com"
```

### 加入工作节点

```shell
# 在 server 节点取出 token
sudo cat /var/lib/rancher/k3s/server/node-token

# 在 agent 节点执行
curl -sfL https://get.k3s.io | \
  K3S_URL=https://<server-ip>:6443 K3S_TOKEN=<token> sh -
```

只要带了 `K3S_URL`,脚本就会把本机装成 agent 而不是 server。

### 高可用:嵌入式 etcd

默认的 SQLite 只适合单节点。要多 server 就必须换数据存储,K3s 内置了嵌入式 etcd:

```shell
# 第一个 server:--cluster-init 把 SQLite 切换为嵌入式 etcd
curl -sfL https://get.k3s.io | K3S_TOKEN=SECRET sh -s - server --cluster-init

# 第二、三个 server:指向已有的 server
curl -sfL https://get.k3s.io | K3S_TOKEN=SECRET sh -s - server \
  --server https://<server1-ip>:6443

# agent 指向任意一个 server 即可
curl -sfL https://get.k3s.io | K3S_TOKEN=SECRET sh -s - agent \
  --server https://<server-ip>:6443
```

etcd 需要**奇数个 server** 才能维持多数派(`(n/2)+1`)。把 3 节点扩成 4 节点,容错能力反而下降,这是 etcd 的固有特性而非 K3s 的问题。

所有 server 之间的 `--cluster-cidr`、`--service-cidr`、`--cluster-dns`、`--disable-*`、`--secrets-encryption` 必须保持一致,否则节点无法正常加入。

外部数据库(SQLite/MySQL/PostgreSQL)也可以通过 `--datastore-endpoint` 接入,适合不想自建 etcd 的场景。

### kubeconfig

```shell
# 默认位置(权限 0600,属主 root)
sudo cat /etc/rancher/k3s/k3s.yaml

# 在本机使用时必须改掉 server 地址
mkdir -p ~/.kube
sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
sudo chown $(id -u):$(id -g) ~/.kube/config
sed -i 's/127.0.0.1/<server-ip>/' ~/.kube/config

# 也可以在安装时直接放宽权限并写入外部地址
# INSTALL_K3S_EXEC="--write-kubeconfig-mode=0644 --tls-san=<server-ip>"
```

### 内置的服务与负载均衡

```shell
# 查看默认部署的组件
sudo k3s kubectl get pods -n kube-system
sudo k3s kubectl get svc -n kube-system

# Traefik 的默认值文件(不要直接改,重启会被覆盖)
sudo cat /var/lib/rancher/k3s/server/manifests/traefik.yaml
```

要定制 Traefik 应使用 HelmChartConfig,而不是编辑上面的文件:

```shell
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik
  namespace: kube-system
spec:
  valuesContent: |-
    service:
      type: NodePort
```

### 升级

```shell
# 方式一:重跑安装脚本并指定版本(单节点最常用)
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION=v1.37.0+k3s1 sh -

# 方式二:system-upgrade-controller 声明式升级(多节点推荐)
kubectl apply -f https://github.com/rancher/system-upgrade-controller/releases/latest/download/system-upgrade-controller.yaml
kubectl apply -f https://github.com/rancher/system-upgrade-controller/releases/latest/download/crb.yaml
```

再定义一个 Plan 描述目标版本与升级顺序:

```shell
apiVersion: upgrade.cattle.io/v1
kind: Plan
metadata:
  name: server-plan
  namespace: system-upgrade
spec:
  concurrency: 1
  cordon: true
  nodeSelector:
    matchExpressions:
    - key: node-role.kubernetes.io/control-plane
      operator: Exists
  serviceAccountName: system-upgrade
  upgrade:
    image: rancher/k3s-upgrade
  version: v1.37.0+k3s1
```

### 卸载

```shell
# server 节点
/usr/local/bin/k3s-uninstall.sh

# agent 节点
/usr/local/bin/k3s-agent-uninstall.sh
```

### 注意

1. **默认数据存储是 SQLite,不是 etcd**。SQLite 只适合单节点,且没有高可用;要多 server 必须在第一个节点上带 `--cluster-init` 切到嵌入式 etcd。已经用 SQLite 初始化过的节点,磁盘上存在 etcd 数据后,再加 datastore 相关参数会被直接忽略。
2. **kubeconfig 里的 server 地址默认是 `127.0.0.1`**。文件在 `/etc/rancher/k3s/k3s.yaml`,直接拷到本机会连不上,必须改成 server 真实 IP 或域名,并在安装时用 `--tls-san` 把该地址写进证书 SAN,否则会报 x509 证书不匹配。
3. **自带的 ServiceLB 会抢占宿主机 80/443 端口**。ServiceLB 为每个 LoadBalancer 类型的 Service 在每个节点上起一个 hostPort Pod,Traefik 又默认用 80/443,于是这两个端口在全集群都被占住,其他用 hostPort/NodePort 的组件会调度失败。要跑 MetalLB 等替代方案,必须在**所有 server** 上加 `--disable=servicelb`。
4. **内置 Traefik 与自建 Ingress Controller 会打架**。两者都会声明 IngressClass 并抢占 80/443。用 nginx-ingress 或 Higress 时应先 `--disable traefik`;注意从 `ingress-nginx` 迁移过来的用户还要留意,K3s 新版本把 Traefik chart 升到了 v40 系列,其中 `kubernetesIngressNginx` 配置项改名为 `kubernetesIngressNGINX`,老配置直接套用会失效。
5. **Traefik 的默认值文件重启即被覆盖**。`/var/lib/rancher/k3s/server/manifests/traefik.yaml` 由 K3s 在每次启动时重新渲染,任何手工修改都会丢失。定制请用 `HelmChartConfig`。
6. **K3s 移除了 in-tree 的云厂商与存储插件**。依赖 `kubernetes.io/aws-ebs` 这类老 StorageClass 的清单无法直接迁移,需要换成对应的 CSI 驱动。
7. **agent 节点的主机名必须唯一**。否则会出现节点覆盖或注册失败;重复时用 `K3S_NODE_NAME` 显式指定。
8. **升级不能跨小版本跳跃**,且要先把 server 升完再升 agent。多节点用 system-upgrade-controller 时,Plan 的 `concurrency` 建议设为 1,让它逐个节点滚动。
9. **`k3s-uninstall.sh` 会删除数据目录 `/var/lib/rancher/k3s`**,包括 etcd 数据与本地存储卷,不可恢复。生产环境务必先做 etcd 快照:`k3s etcd-snapshot save`。
10. **镜像拉取不走容器运行时的默认配置**。要配置镜像加速或私有仓库,应在 `/etc/rancher/k3s/registries.yaml` 里配置,K3s 会在启动时把它渲染成 containerd 的配置。
11. K3s 是**完整且可上生产**的发行版,但仍需自行评估:默认没有高可用控制平面、没有备份策略、没有证书轮换的自动编排,这些都要运维补上。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kubeadm` — Kubernetes集群安装工具
- `k3d` — 用Docker运行K3s集群
- `traefik` — K3s默认内置的Ingress Controller
- `rancher` — 多集群管理平台

### 参考链接

- [K3s 官方文档](https://docs.k3s.io/)
- [K3s 快速开始](https://docs.k3s.io/quick-start)
- [K3s 嵌入式 etcd 高可用](https://docs.k3s.io/datastore/ha-embedded)
- [K3s 网络服务(ServiceLB 与 Traefik)](https://docs.k3s.io/networking/networking-services)
- [K3s GitHub 仓库](https://github.com/k3s-io/k3s)
