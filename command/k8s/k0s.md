k0s
===

单二进制Kubernetes发行版,控制器与工作节点角色可分离部署

## 补充说明

**k0s** 是 Mirantis 主导的开源 Kubernetes 发行版,主打「零摩擦」:**一个二进制文件、零依赖**,控制器与工作节点都由同一个 `k0s` 可执行文件承担,区别只在启动参数。它已捐给 CNCF 进入 Sandbox,同时仍由 Mirantis 提供商业支持。

k0s 与 K3s 常被放在一起比较,两者的取舍并不相同:

```shell
对比项          k0s                          K3s
打包形式        单个二进制,零系统依赖        单个二进制 + 安装脚本
默认数据存储    单节点 SQLite,多节点 etcd    单节点 SQLite,多节点需切 etcd
默认 CNI        Calico(内置清单)             Flannel(内置)
默认 Ingress    无                           Traefik(内置)
默认 LoadBalancer 无(提供 MetalLB 扩展)     ServiceLB(内置)
角色分离        controller / worker 显式分离   server / agent
配置方式        k0s.yaml 或 CLI 参数          config.yaml 或 CLI 参数
```

k0s 的一个显著设计取向是**克制**:它不自带 Ingress、不自带 LoadBalancer 实现,装完就是一个干净的 Kubernetes,需要什么自己加。这让它更适合被集成进别人的平台,而不是拿来做「一键 Demo」。

### 架构与角色

同一个二进制有三种运行形态:

```shell
k0s controller           只跑控制平面(API Server、调度器、控制器、etcd)
k0s worker               只跑工作负载(kubelet、containerd、kube-proxy)
k0s controller --enable-worker   控制平面同时承担工作负载(单机常用)
```

k0s 的进程模型与常见发行版不同:**所有控制平面组件都作为子进程跑在同一个 `k0s controller` 进程下**,由 k0s 自己监督,而不是每个组件一个 systemd 单元。因此排障时看的是 `k0s` 的日志,而不是一堆 `kube-apiserver.service`。

### 安装

```shell
# 官方脚本(安装到 /usr/local/bin/k0s)
curl --proto '=https' --tlsv1.2 -sSf https://get.k0s.sh | sudo sh

# 确认版本
k0s version

# 查看默认配置(可作为 k0s.yaml 的起点)
sudo k0s config create
```

### 单节点集群

```shell
# 安装为系统服务(默认 systemd,OpenRC 亦可)
sudo k0s install controller --single

# 启动
sudo k0s start

# 查看状态
sudo k0s status

# k0s 自带 kubectl,无需另装
sudo k0s kubectl get nodes
sudo k0s kubectl get pods -A
```

`--single` 会用 kine + SQLite 作为数据存储,适合单机。如果之后想再往集群里加节点,就应该改用:

```shell
# 控制平面同时承载工作负载,且去掉 NoSchedule 污点
sudo k0s install controller --enable-worker --no-taints
```

### 多节点集群

```shell
# 1. 在第一个 controller 上生成 worker 的加入令牌
sudo k0s token create --role=worker

# 2. 把令牌保存到文件并复制到工作节点
sudo k0s token create --role=worker > worker-token.txt

# 3. 在工作节点上安装并启动
sudo k0s install worker --token-file /path/to/worker-token.txt
sudo k0s start

# 4. 增加更多 controller 以实现控制平面高可用
sudo k0s token create --role=controller
sudo k0s install controller --token-file /path/to/controller-token.txt
```

### 用 k0sctl 部署集群

手工逐台执行适合学习,真实部署应使用官方工具 **k0sctl**,它通过 SSH 完成全流程:

```shell
# 安装
curl -sSLf https://github.com/k0sproject/k0sctl/releases/latest/download/k0sctl-$(uname -s | tr '[:upper:]' '[:lower:]')-amd64 \
  -o /usr/local/bin/k0sctl && chmod +x /usr/local/bin/k0sctl

# 生成配置模板
k0sctl init > k0sctl.yaml

# 部署
k0sctl apply --config k0sctl.yaml

# 取 kubeconfig
k0sctl kubeconfig --config k0sctl.yaml > ~/.kube/config
```

k0sctl.yaml 的核心结构:

```shell
apiVersion: k0sctl.k0sproject.io/v1beta1
kind: Cluster
metadata:
  name: k0s-cluster
spec:
  hosts:
    - role: controller
      ssh:
        address: 10.0.0.11
        user: root
      installFlags:
        - --debug
    - role: worker
      ssh:
        address: 10.0.0.21
        user: root
  k0s:
    version: v1.36.4+k0s.0
```

### 数据存储

k0s 支持两种存储后端,由 `spec.storage.type` 决定:

```shell
spec:
  storage:
    type: etcd
    etcd:
      peerAddress: 10.0.0.11
```

- **etcd**:多节点默认选项,k0s 会在所有 controller 之间自动组建 etcd 集群。
- **kine**:通过 `spec.storage.kine.dataSource` 指定数据库,单节点场景下落到 SQLite,也支持 MySQL 与 PostgreSQL。

外部已有 etcd 时,可以用 `spec.storage.etcd.externalCluster` 接入,此时 k0s **不会**自行管理 etcd:

```shell
spec:
  storage:
    type: etcd
    etcd:
      externalCluster:
        endpoints:
          - https://10.0.0.100:2379
        etcdPrefix: k0s-cluster-1
        caFile: /etc/k0s/etcd-ca.crt
        clientCertFile: /etc/k0s/etcd-client.crt
        clientKeyFile: /etc/k0s/etcd-client.key
```

### 配置管理

```shell
# 生成默认配置
mkdir -p /etc/k0s
sudo k0s config create > /etc/k0s/k0s.yaml

# 用配置文件安装(注意短参数是 -c)
sudo k0s install controller -c /etc/k0s/k0s.yaml

# 改完配置后重启生效
sudo k0s stop && sudo k0s start
```

部分配置是合法的,k0s 会对缺失字段使用默认值。

### 网络与扩展

```shell
# k0s 内置了 Calico 与 kube-router 两种 CNI 清单,默认使用 Calico
# 安装时可切换
sudo k0s install controller --single --cni kube-router

# 自带指标服务清单
kubectl apply -f /var/lib/k0s/manifests/metrics-server/

# 查看内置扩展清单目录
ls /var/lib/k0s/manifests/
```

k0s 还提供了 MetalLB 与 NGINX Ingress 的扩展清单,通过 `k0s.yaml` 的 `spec.extensions` 打开:

```shell
spec:
  extensions:
    helm:
      repositories:
        - name: stable
          url: https://charts.helm.sh/stable
      charts:
        - name: metallb
          chartname: bitnami/metallb
          namespace: default
          version: 4.7.3
```

### 备份与恢复

```shell
# 备份控制平面(etcd 快照 + 证书 + 配置)
sudo k0s backup --save-path /backup

# 从备份恢复
sudo k0s restore /backup/k0s-backup-20260918-120000.tar.gz
```

### 卸载

```shell
sudo k0s stop
sudo k0s reset
# 官方建议重置后重启一次主机,以清理网络命名空间与挂载
```

### 注意

1. **单节点与多节点的数据存储不同**。`--single` 走 kine + SQLite,**无法直接横向扩展成多 controller**;计划未来扩容的集群,一开始就该用 `k0s install controller --enable-worker --no-taints` 让默认的 etcd 生效。
2. **controller 与 worker 是两个独立的服务角色**,不是同一套参数换个名字。`k0s install controller` 装出来的是 `k0scontroller` 服务,`k0s install worker` 装的是 `k0sworker`,卸载与重置要分别处理;角色搞错时表现是节点加入后一直不 Ready。
3. **`k0s install` 只是注册服务,不会自动启动**。装完必须 `k0s start`(或在 install 时加 `--start`),否则会以为安装失败。
4. **`--enable-worker` 出来的节点仍带 NoSchedule 污点**,单机跑业务必须再加 `--no-taints`,否则业务 Pod 永远 Pending。
5. **k0s 不自带 Ingress 与 LoadBalancer 实现**。这与 K3s 差别最大:装完 `kubectl get pods -A` 会非常干净,LoadBalancer 类型的 Service 会一直停在 `<pending>`,需要自行安装 MetalLB 或云厂商 CCM。
6. **所有控制平面组件由 k0s 进程托管**,没有独立的 systemd 单元。想重启单个 apiserver 只能重启整个 k0s 服务,排障时看不到 `kubectl get pods -n kube-system` 里的静态 Pod(它们的镜像确实在跑,但不由 kubelet 管理)。
7. **`sudo k0s reset` 会清空 `/var/lib/k0s`**,包含 etcd 数据、证书与容器数据,不可恢复。执行前先 `k0s backup`。
8. **升级用 `k0sctl apply` 或重跑安装脚本,不要手工替换二进制**。手工替换会让服务单元与版本元数据不一致,后续 `k0sctl apply` 可能报状态漂移。
9. **配置改动必须重启服务才会生效**,`/etc/k0s/k0s.yaml` 没有热加载。改完是 `k0s stop` 再 `k0s start`,不是 `systemctl reload`。
10. **k0s 的版本号带 `+k0s.N` 后缀**(如 `v1.36.4+k0s.0`),写 CI 脚本或 k0sctl 配置时要带全,只写 `v1.36.4` 会拉不到对应产物。
11. 相比 K3s,k0s 的生态与文档量更小,社区问答也少;选型时如果团队更看重「出问题能搜到答案」,这一点值得权衡。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `k3s` — 另一款单二进制轻量发行版
- `kubeadm` — Kubernetes集群安装工具
- `rancher` — 多集群管理平台
- `k9s` — 终端下的 Kubernetes 管理 UI

### 参考链接

- [k0s 官方文档](https://docs.k0sproject.io/)
- [k0s 安装指南](https://docs.k0sproject.io/stable/install/)
- [k0s 配置参考](https://docs.k0sproject.io/stable/configuration/)
- [k0sctl GitHub 仓库](https://github.com/k0sproject/k0sctl)
- [k0s GitHub 仓库](https://github.com/k0sproject/k0s)
