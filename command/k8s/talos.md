talos
===

不可变Kubernetes专用操作系统,全部通过API声明式管理

## 补充说明

**Talos Linux** 是 Sidero Labs 推出的**专为 Kubernetes 而生的操作系统**。它与 k3s、k0s 这类「在通用 Linux 上装 Kubernetes」的发行版走的是相反路线:把整个操作系统做成不可变的、只读的、没有 SSH 的固件,机器上除了 Kubernetes 需要的东西之外什么都没有。

Talos 的核心主张是**消除配置漂移**:

- **没有 SSH**:不提供 shell,也无法登录。所有操作通过 gRPC API 与 `talosctl` 完成。
- **没有包管理器**:无法 `apt install` 任何东西,机器状态不可能被手工改动。
- **根文件系统只读**:`/usr` 与 `/` 以只读方式挂载,运行时数据都在 tmpfs 或独立分区。
- **声明式机器配置**:每台机器的全部配置是一份 YAML(MachineConfig),替换它即完成变更。
- **一切皆 API**:升级内核、打补丁、改网络、装扩展,都是 API 调用。

这种设计带来的收益很直接:节点是「宠物」变「牛群」的极端形态,任何一台机器坏了直接重装,不需要登录进去排查配置差异。代价是学习曲线陡峭,以及必须接受「不能登进去看一眼」的运维习惯改变。

支持的平台覆盖主流云厂商、裸金属、虚拟化(Proxmox、vSphere、KVM)与单板机(树莓派等),也可以在 Docker 里跑本地测试集群。

### 安装 talosctl

```shell
# macOS / Linux(Homebrew,会自动更新)
brew tap siderolabs/tap
brew trust siderolabs/tap
brew install siderolabs/tap/talosctl

# 通用安装脚本
curl -sL https://talos.dev/install | sh

# 指定版本手动下载
curl -sL https://github.com/siderolabs/talos/releases/download/v1.14.1/talosctl-$(uname -s | tr '[:upper:]' '[:lower:]')-amd64 \
  -o /usr/local/bin/talosctl
chmod +x /usr/local/bin/talosctl

talosctl version --client
```

**talosctl 的版本应与节点上运行的 Talos 版本一致**,跨大版本使用可能因 API 变更而失败。

### 本地测试集群

```shell
# 在 Docker 里拉起一个完整的 Talos 集群(需要 Docker)
talosctl cluster create docker

# 查看节点
kubectl get nodes -o wide
talosctl --nodes 172.20.0.2 get members

# 销毁
talosctl cluster destroy
```

macOS 上如果报 `Cannot connect to the Docker daemon`,是 Docker Desktop 的 socket 路径与 Talos 期望的不一致:

```shell
sudo ln -s "$HOME/.docker/run/docker.sock" /var/run/docker.sock
```

### 生成集群配置

裸金属或虚拟机上,先让节点从 ISO 启动。节点在**维护模式(maintenance mode)**下会监听一个未认证的 API,用于投放第一份配置:

```shell
# 在维护模式下探查磁盘名(此时必须加 --insecure)
talosctl get disks --insecure --nodes $CONTROL_PLANE_IP

# 生成集群配置
export CLUSTER_NAME=my-cluster
export DISK_NAME=sda
talosctl gen config $CLUSTER_NAME https://$CONTROL_PLANE_IP:6443 \
  --install-disk /dev/$DISK_NAME
```

命令会生成三个文件:`controlplane.yaml`、`worker.yaml` 与 `talosconfig`。

更严谨的做法是把集群密钥单独生成并妥善保管,便于日后重建:

```shell
talosctl gen secrets -o secrets.yaml
talosctl gen config my-cluster https://$CONTROL_PLANE_IP:6443 \
  --with-secrets secrets.yaml \
  --install-disk /dev/sda
```

### 应用配置

```shell
# 控制平面节点
talosctl apply-config --insecure --nodes $CONTROL_PLANE_IP --file controlplane.yaml

# 工作节点
talosctl apply-config --insecure --nodes $WORKER_IP --file worker.yaml

# 配置 talosconfig 的默认端点与节点
talosctl --talosconfig=./talosconfig config endpoints $CONTROL_PLANE_IP
talosctl --talosconfig=./talosconfig config nodes $CONTROL_PLANE_IP
export TALOSCONFIG=./talosconfig
```

`--insecure` 只用于节点还没有配置、处于维护模式时。节点一旦接受配置,后续所有操作都必须经过 mTLS 认证。

### 引导 etcd

```shell
# 只在第一个控制平面节点上执行一次,之后其余节点会自动加入
talosctl bootstrap --nodes $CONTROL_PLANE_IP

# 等待集群健康
talosctl health --nodes $CONTROL_PLANE_IP

# 取出 kubeconfig
talosctl kubeconfig --nodes $CONTROL_PLANE_IP
export KUBECONFIG=~/.kube/config
kubectl get nodes
```

把 kubeconfig 写到独立文件而不合并进默认配置:

```shell
talosctl kubeconfig ./talos-kubeconfig --nodes $CONTROL_PLANE_IP
export KUBECONFIG=./talos-kubeconfig
```

### 日常查看

没有 SSH,但 `talosctl` 提供了等价甚至更强的能力:

```shell
# 集群成员与角色
talosctl get members
talosctl get nodename

# 资源视图(Talos 内部资源模型)
talosctl get routes
talosctl get addresses
talosctl get disks
talosctl get extensions

# 日志
talosctl logs machined
talosctl logs kubelet
talosctl dmesg
talosctl memory

# 查看文件(只读)
talosctl read /proc/cmdline

# 实时控制台仪表盘
talosctl dashboard
```

### 修改机器配置

```shell
# 查看当前生效的配置
talosctl get machineconfig -o yaml

# 用 patch 增量修改(推荐,避免覆盖其他字段)
talosctl patch machineconfig --patch @patch.yaml --nodes $NODE_IP

# 也可以整份替换
talosctl apply-config --nodes $NODE_IP --file controlplane.yaml
```

一份常见的 patch 长这样:

```shell
machine:
  install:
    disk: /dev/sda
    image: ghcr.io/siderolabs/installer:v1.14.1
  kubelet:
    extraArgs:
      rotate-server-certificates: "true"
cluster:
  allowSchedulingOnControlPlanes: true
  apiServer:
    certSANs:
      - api.example.com
```

### 升级

Talos 的升级分两条线:**操作系统**与**Kubernetes**,两者独立进行。

```shell
# 升级 Talos 本体(默认保留数据分区)
talosctl upgrade --nodes $NODE_IP \
  --image ghcr.io/siderolabs/installer:v1.14.1

# 一次性升级全部控制平面节点
talosctl upgrade --nodes $CP1,$CP2,$CP3 \
  --image ghcr.io/siderolabs/installer:v1.14.1

# 升级 Kubernetes(只对控制平面执行一次)
talosctl upgrade-k8s --to 1.37.0
```

升级工作节点可以配合 `kubectl cordon`/`drain` 手动编排,或直接依赖 Talos 的滚动策略。

### 重置与重装

```shell
# 清空节点,回到维护模式
talosctl reset --nodes $NODE_IP --graceful=false --reboot

# 只重置系统分区,保留数据分区
talosctl reset --nodes $NODE_IP --system-labels-to-wipe EPHEMERAL
```

### 系统扩展

Talos 不可变,但可以**在构建时**把额外能力编进镜像(例如 iSCSI 工具、`util-linux` 工具、GPU 驱动):

```shell
# 查看当前已安装的扩展
talosctl get extensions

# 用官方 Image Factory 生成带扩展的安装镜像
# https://factory.talos.dev/ 上勾选扩展后得到 schematic id
talosctl upgrade --nodes $NODE_IP \
  --image factory.talos.dev/installer/<schematic-id>:v1.14.1
```

### 注意

1. **Talos 上没有 SSH,也不会有**。这是设计而非缺陷:所有排障必须换用 `talosctl logs`、`talosctl read`、`talosctl dmesg`、`talosctl dashboard`。第一次上手最容易被「登不进去」卡住,请先接受这个前提再选型。
2. **`--insecure` 只对维护模式有效**。节点一旦接受过配置,再加 `--insecure` 会连接失败。反过来,对处于维护模式的节点不加 `--insecure` 同样连不上,两者是互斥的。
3. **`talosctl bootstrap` 只能执行一次,且只能在第一个控制平面节点上**。多执行几次或对多个节点执行会导致 etcd 集群状态异常,恢复相当麻烦。其余节点是靠 MachineConfig 自动加入 etcd 的,不需要手工引导。
4. **节点能启动不等于配置正确**。`apply-config` 成功返回只是说明配置被接受,磁盘写入与重启是异步的。要判断是否真的就绪,用 `talosctl health` 而不是看命令返回值。
5. **talosctl 与节点版本必须匹配**。节点升级后记得同步升级本机的 talosctl,否则新 API 字段在旧客户端上不可见。
6. **`talosctl upgrade` 默认会保留 EPHEMERAL 分区**,因此本地数据还在;但这**不保证**工作负载安全,升级会重启节点,必须先 `kubectl drain` 或用 PDB 保护业务。
7. **不可变意味着不能临时装工具**。需要 `iscsiadm`、`nvme-cli`、GPU 驱动这类东西时,唯一的办法是通过 Image Factory 构建带扩展的镜像并升级整机,不能 `exec` 进去装。
8. **集群密钥(`secrets.yaml`)丢了就无法重建同名集群**。`talosctl gen config` 默认把密钥内联进生成的配置里,一旦文件丢失,后续想扩容同集群只能重新生成配置,而新配置的证书与现有集群不匹配。生产环境务必单独 `talosctl gen secrets` 并妥善保管。
9. **控制平面节点默认不调度业务负载**。需要单机跑业务时要在 MachineConfig 里打开 `cluster.allowSchedulingOnControlPlanes: true`。
10. **`talosctl reset` 是破坏性操作**,会清空系统分区并可选择清空数据分区,节点随即回到维护模式。执行前确认节点上确实没有需要保留的数据。
11. Talos 的 API 端口(50000/50001)是运维入口,丢了 `talosconfig` 且没有备份,基本等同于失去对节点的控制权 —— kubeconfig 只能管 Kubernetes,管不了机器本身。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kubeadm` — Kubernetes集群安装工具
- `k3s` — 轻量级 Kubernetes 发行版
- `k0s` — 单二进制 Kubernetes 发行版
- `crictl` — 容器运行时调试工具

### 参考链接

- [Talos Linux 官方文档](https://docs.siderolabs.com/talos/)
- [Talos 快速开始](https://docs.siderolabs.com/talos/v1.13/getting-started/quickstart)
- [talosctl 使用说明](https://docs.siderolabs.com/talos/v1.13/getting-started/talosctl)
- [Talos Image Factory](https://factory.talos.dev/)
- [Talos GitHub 仓库](https://github.com/siderolabs/talos)
