kubelet
===

Kubernetes节点代理,负责维护节点上的Pod生命周期

## 补充说明

**kubelet命令** 是运行在每个节点上的代理程序,负责接收 kube-apiserver 下发的 PodSpec,并确保这些 Pod 描述的容器处于运行且健康的状态。它是集群中唯一直接与容器运行时(containerd、CRI-O)打交道的组件。

kubelet 不是一个用完就退出的命令行工具,而是一个由 systemd 托管的常驻服务:它通过 CRI 调用容器运行时,通过 CNI 配置网络,并把节点与 Pod 的状态上报给 apiserver。`kubectl get nodes` 里看到的每一行,本质上都是 kubelet 上报的结果。

理解 kubelet 的关键在于:它**不接受**「直接创建容器」的请求,只认 apiserver 里的 PodSpec(静态 Pod 除外)。因此绕过 apiserver 手工创建的容器,kubelet 既不感知也不会回收。

### 安装

kubelet 通常随 kubeadm 一起安装,不需要单独部署:

```shell
sudo apt-get update
sudo apt-get install -y kubelet kubeadm kubectl
sudo apt-mark hold kubelet kubeadm kubectl

# 关闭 swap(kubelet 的硬性前提)
sudo swapoff -a
sudo sed -i '/ swap / s/^/#/' /etc/fstab

# 查看版本
kubelet --version
```

自建节点也可以只装 kubelet,再用 `kubeadm join` 接入集群。

### 服务管理

kubelet 由 systemd 管理,不在 Pod 里运行 —— 这也是「谁来看管看门人」的答案:

```shell
# 开机自启与启停
sudo systemctl enable kubelet
sudo systemctl start kubelet
sudo systemctl status kubelet
sudo systemctl restart kubelet

# 查看日志(排查节点 NotReady 的第一站)
sudo journalctl -u kubelet -f
sudo journalctl -u kubelet --since "10 minutes ago"
sudo journalctl -u kubelet -p err -n 100
```

### 语法

```shell
kubelet [flags]
```

kubelet 的行为几乎全部由配置文件或命令行标志决定,常用标志:

```shell
--config=/var/lib/kubelet/config.yaml    配置文件路径(kubeadm 集群的默认方式)
--kubeconfig=/etc/kubernetes/kubelet.conf   访问 apiserver 的凭据
--container-runtime-endpoint=unix:///run/containerd/containerd.sock   容器运行时 socket
--node-ip=10.0.0.20                      节点 IP(多网卡时必须显式指定)
--hostname-override=node1                覆盖节点名(主机名不可解析时使用)
--register-node=true                     是否向 apiserver 注册自己
--fail-swap-on=false                     允许在开启 swap 的机器上运行(不推荐)
--v=4                                    日志详细程度
```

给 kubeadm 集群追加标志的标准做法是改 systemd 的 drop-in 文件:

```shell
sudo vi /etc/systemd/system/kubelet.service.d/10-kubeadm.conf
# 追加一行:
# Environment="KUBELET_EXTRA_ARGS=--node-ip=10.0.0.20"

sudo systemctl daemon-reload
sudo systemctl restart kubelet
```

### 配置文件

kubeadm 部署的集群中,kubelet 通过 `/var/lib/kubelet/config.yaml` 加载配置:

```shell
sudo cat /var/lib/kubelet/config.yaml
```

```shell
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
address: 0.0.0.0
port: 10250
cgroupDriver: systemd
clusterDNS:
  - 10.96.0.10
clusterDomain: cluster.local
rotateCertificates: true
evictionHard:
  memory.available: "100Mi"
  nodefs.available: "10%"
```

改完重启服务即可生效:

```shell
sudo systemctl restart kubelet
```

### 静态 Pod

放在 `/etc/kubernetes/manifests/` 下的 YAML 会被 kubelet 直接读取并创建为静态 Pod,kube-apiserver、etcd、scheduler 等控制平面组件都是这样运行的:

```shell
# 查看静态 Pod 清单目录
ls /etc/kubernetes/manifests/

# 静态 Pod 的名字会自动带上节点名后缀
kubectl get pods -n kube-system

# 重启某个控制平面组件:移出清单再移回,kubelet 会自动删除并重建
sudo mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/
sudo mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/
```

### 常用操作

```shell
# 查看节点状态与 Conditions
kubectl get nodes -o wide
kubectl describe node <node-name>

# 查看 kubelet 实际生效的配置
kubectl get --raw "/api/v1/nodes/<node-name>/proxy/configz" | python3 -m json.tool

# 查看节点资源用量摘要(来自 cAdvisor)
kubectl get --raw "/api/v1/nodes/<node-name>/proxy/stats/summary" | python3 -m json.tool

# 直接访问 kubelet 端口
curl -k https://<node-ip>:10250/healthz
curl http://<node-ip>:10248/healthz

# 查看节点租约(kubelet 靠它续约,决定节点是否 Ready)
kubectl get lease -n kube-node-lease

# 维护前禁止调度,维护后恢复
kubectl cordon <node-name>
kubectl uncordon <node-name>
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data
```

### 证书与端口

kubelet 自己也持有证书,默认自动轮换:

```shell
# 客户端证书(访问 apiserver 用,由 kubelet 自动轮换)
ls -l /var/lib/kubelet/pki/kubelet-client-current.pem

# 服务端证书(默认自签名,kubectl logs/exec 会提示证书不受信任)
ls -l /var/lib/kubelet/pki/kubelet.crt

# 查看有效期
sudo openssl x509 -in /var/lib/kubelet/pki/kubelet-client-current.pem -noout -dates
```

涉及的端口:

```shell
10250  kubelet API,kubectl logs / exec / port-forward 都走这里
10248  /healthz 健康检查,只监听本机
10255  只读端口,已在 1.16 之后废弃
```

### 资源驱逐

节点资源紧张时 kubelet 会主动驱逐 Pod,阈值在配置文件的 `evictionHard` / `evictionSoft` 中定义:

```shell
# 查看驱逐事件
kubectl get events -A --field-selector reason=Evicted

# 查看 kubelet 打上的压力污点
kubectl describe node <node-name> | grep -A5 Taints

# 查看节点上的临时存储用量
kubectl get --raw "/api/v1/nodes/<node-name>/proxy/stats/summary" | grep -i imagefs
```

### 注意

1. **必须关闭 swap**,或显式设置 `failSwapOn: false`。默认情况下 kubelet 拒绝在开启 swap 的节点上启动,表现为节点一直 `NotReady` 而日志里只有一句含糊的报错。
2. **cgroup driver 必须与容器运行时一致**。kubelet 用 `systemd` 而 containerd 用 `cgroupfs` 时,cgroup 管理会混乱,典型症状是 Pod 频繁重启、资源限制不生效。containerd 需在 `config.toml` 中设置 `SystemdCgroup = true`。
3. kubelet **不是** Pod,不受 Deployment 管理,也不会自我修复。它挂了只能靠 systemd 拉起,`systemctl restart kubelet` 是最常用的操作。
4. kubelet 只管理自己创建的容器。用 `crictl` 或 `ctr` 手工启动的容器不在它的管辖范围内,不会被回收,也不会上报给 apiserver。
5. `--hostname-override` 必须与集群期望的节点名一致,否则节点会以错误的名字注册,导致 `kubectl logs` 找不到节点。
6. 修改 `/var/lib/kubelet/config.yaml` 只需重启 kubelet;修改 systemd 的 `10-kubeadm.conf` 则必须先 `systemctl daemon-reload`,否则改动静默失效。
7. `/var/lib/kubelet` 不能是共享存储(如 NFS)。kubelet 会在其上创建 Pod 的挂载点,共享目录会导致挂载互相污染甚至节点卡死。
8. 节点 `NotReady` 的排查顺序:先 `journalctl -u kubelet` 看报错,再确认容器运行时是否可用,最后检查 CNI 是否就绪。
9. kubelet 的驱逐分「软驱逐」和「硬驱逐」两套阈值:软驱逐有宽限期,硬驱逐立即执行。只配了 `evictionHard` 时 Pod 会毫无缓冲地被杀,配置时容易混淆。
10. 控制平面节点的 kubelet 一旦挂掉,静态 Pod 也会随之消失,整个集群会失联 —— 但已运行的业务 Pod 不受影响。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kubeadm` — Kubernetes集群安装工具
- `crictl` — 容器运行时调试工具
- `ctr` — containerd 原生 CLI
- `kube-proxy` — 集群网络代理

### 参考链接

- [kubelet 命令行参考](https://kubernetes.io/docs/reference/command-line-tools-reference/kubelet/)
- [使用配置文件设置 kubelet 参数](https://kubernetes.io/docs/tasks/administer-cluster/kubelet-config-file/)
- [静态 Pod](https://kubernetes.io/docs/tasks/configure-pod-container/static-pod/)
- [节点压力驱逐](https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/)
- [Kubelet 配置 API 参考](https://kubernetes.io/docs/reference/config-api/kubelet-config.v1beta1/)
