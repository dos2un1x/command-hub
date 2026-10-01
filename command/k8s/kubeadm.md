kubeadm
===

Kubernetes集群安装与生命周期管理工具

## 补充说明

**kubeadm命令** 是 Kubernetes 官方提供的集群部署工具,用于快速创建一个符合最佳实践的最小可用集群。它负责初始化控制平面、将节点加入集群,以及集群升级等生命周期操作。

kubeadm 只处理集群的「骨架」部分:证书、控制平面组件、kubelet 配置、网络插件的接入点。它**不负责**安装 CNI 网络插件和 kubelet 本身,这两项需要用户自行完成 —— 这也是初次部署最容易卡住的地方。

### 安装

```shell
# 添加 Kubernetes 官方仓库(Debian/Ubuntu)
sudo apt-get update
sudo apt-get install -y apt-transport-https ca-certificates curl gpg

curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.31/deb/Release.key | \
  sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg

echo 'deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/v1.31/deb/ /' | \
  sudo tee /etc/apt/sources.list.d/kubernetes.list

sudo apt-get update
sudo apt-get install -y kubelet kubeadm kubectl
sudo apt-mark hold kubelet kubeadm kubectl

# 关闭 swap(必须,否则 kubelet 无法启动)
sudo swapoff -a
sudo sed -i '/ swap / s/^/#/' /etc/fstab

# 加载内核模块
sudo modprobe overlay
sudo modprobe br_netfilter
```

### 语法

```shell
kubeadm [command]
```

常用子命令:

```shell
kubeadm init          初始化控制平面节点
kubeadm join          将工作节点加入集群
kubeadm reset         还原本机上的 kubeadm 改动
kubeadm upgrade       升级集群
kubeadm token         管理引导令牌
kubeadm config        管理集群配置
kubeadm certs         管理集群证书
kubeadm kubeconfig    管理 kubeconfig 文件
kubeadm version       查看版本
```

### 初始化控制平面

```shell
# 使用默认配置初始化
sudo kubeadm init --pod-network-cidr=10.244.0.0/16

# 指定 Kubernetes 版本
sudo kubeadm init --kubernetes-version=v1.31.0

# 单机测试用:去除控制平面节点的污点,允许调度业务 Pod
sudo kubeadm init --pod-network-cidr=10.244.0.0/16 --control-plane-endpoint=10.0.0.10

# 提前生成配置再修改
kubeadm config print init-defaults > kubeadm-config.yaml
sudo kubeadm init --config kubeadm-config.yaml

# 初始化成功后配置 kubectl
mkdir -p $HOME/.kube
sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config
```

### 加入节点

```shell
# 在控制平面查询加入命令
kubeadm token create --print-join-command

# 工作节点上执行(输出格式)
sudo kubeadm join 10.0.0.10:6443 --token abcdef.0123456789abcdef \
  --discovery-token-ca-cert-hash sha256:xxxxx

# 加入新的控制平面节点
sudo kubeadm join 10.0.0.10:6443 --token abcdef.0123456789abcdef \
  --discovery-token-ca-cert-hash sha256:xxxxx \
  --control-plane --certificate-key xxxxx

# 生成新的证书密钥
kubeadm init phase upload-certs --upload-certs

# 查看令牌列表
kubeadm token list
```

### 集群升级

```shell
# 1. 升级 kubeadm 自身
sudo apt-get update && sudo apt-get install -y kubeadm=1.31.0-1.1
kubeadm version

# 2. 查看可升级版本
sudo kubeadm upgrade plan

# 3. 升级控制平面
sudo kubeadm upgrade apply v1.31.0

# 4. 腾空节点后升级 kubelet
kubectl drain <node-name> --ignore-daemonsets
sudo apt-get install -y kubelet=1.31.0-1.1 kubectl=1.31.0-1.1
sudo systemctl daemon-reload && sudo systemctl restart kubelet
kubectl uncordon <node-name>

# 工作节点升级
sudo kubeadm upgrade node
```

### 重置与清理

```shell
# 还原本机 kubeadm 改动(危险操作,会清空集群数据)
sudo kubeadm reset

# 一并清理 CNI 配置与 iptables
sudo kubeadm reset --cri-socket=unix:///run/containerd/containerd.sock
sudo rm -rf /etc/cni/net.d
sudo iptables -F && sudo iptables -t nat -F && sudo iptables -t mangle -F
```

### 证书管理

```shell
# 查看证书到期时间
sudo kubeadm certs check-expiration

# 续期全部证书
sudo kubeadm certs renew all

# 续期单个证书
sudo kubeadm certs renew apiserver

# 续期后需重启控制平面组件
sudo systemctl restart kubelet
```

### 注意

1. **kubeadm 不安装 CNI 插件**。init 完成后节点会处于 `NotReady`,必须另行部署 Calico、Flannel 或 Cilium 等网络插件。
2. 必须先关闭 swap,kubelet 默认拒绝在开启 swap 的机器上启动。
3. 集群节点间需要放行 6443(API Server)、10250(kubelet)、2379-2380(etcd)等端口。
4. 证书默认有效期 1 年,`kubeadm certs renew all` 后需重启控制平面组件才生效。
5. 生产环境建议使用 `--control-plane-endpoint` 指向负载均衡器,便于后续扩展多控制平面。
6. `kubeadm reset` 不会清理 etcd 数据目录,重建集群前需手动删除 `/var/lib/etcd`。
7. 升级时必须逐个小版本进行,不支持跨小版本跳跃。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kubelet` — 节点代理,负责启动 Pod
- `crictl` — 容器运行时调试工具
- `kube-proxy` — 集群网络代理

### 参考链接

- [kubeadm 官方文档](https://kubernetes.io/docs/reference/setup-tools/kubeadm/)
- [使用 kubeadm 创建集群](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/create-cluster-kubeadm/)
- [升级 kubeadm 集群](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-upgrade/)
