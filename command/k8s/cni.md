cni
===

Kubernetes容器网络接口规范与CNI插件的配置调用方式

## 补充说明

**CNI**(Container Network Interface)是一套容器网络配置的规范与调用约定,由 containernetworking 社区维护。它定义了「容器运行时如何调用一个可执行文件,为容器配上网络」这件事的最小契约 —— 运行时负责在创建容器网络命名空间后调用插件,插件负责把网卡塞进去、分配 IP、写回结果。

理解 CNI 的关键是分清三层:

```shell
CNI 规范(spec)      一纸约定,规定插件的输入输出格式与调用时机,版本号独立演进
CNI 插件(plugin)    实现规范的可执行文件,放在 /opt/cni/bin,被运行时按需调用
CNI 配置(conflist)  放在 /etc/cni/net.d 的 JSON 文件,决定用哪些插件、按什么顺序调
```

Kubernetes 本身**不实现 CNI**,它只是规定「集群必须有 CNI 才能让 Pod 拿到 IP」:kubelet 通过 CRI 让容器运行时(containerd、CRI-O)去调用 CNI,自己不再直接碰 CNI 配置(1.24 移除 dockershim 后,kubelet 的 `--cni-conf-dir`、`--cni-bin-dir` 等参数一并移除)。

**集群没有 CNI,节点会一直 `NotReady`**,这是自建集群最常见的第一个坑。

### 版本

```shell
CNI 规范           1.1.0(当前发布版本),新增 GC 与 STATUS 两个操作
参考插件           1.9.x(containernetworking/plugins),与规范版本各自独立演进
conflist 里的字段  "cniVersion" 由插件声明支持的规范版本,如 "1.0.0"、"1.1.0"
```

规范版本与插件版本没有对应关系:插件 1.9.x 不等于规范 1.9.x。老配置里的 `"cniVersion": "0.3.0"` 至今仍在大量生产配置中出现,不需要强行升级。

### 目录约定

```shell
/etc/cni/net.d/           CNI 配置文件目录,运行时按文件名字典序取第一个(或前 N 个)
/opt/cni/bin/              CNI 插件二进制目录
/run/flannel/subnet.env   某些插件(如 Flannel)落盘的运行时信息,供其他插件读取
/var/lib/cni/             部分插件(如 host-local IPAM)保存的 IP 分配数据库
/var/log/                 插件与运行时的报错日志,kubelet 日志里常能看到调用失败原因
```

### 五种操作

```shell
ADD      为容器网络命名空间配置网络,返回分配的 IP 与路由
DEL      拆除网络、释放 IP
CHECK    校验既有配置是否仍然有效(规范 0.4.0 起)
VERSION  查询插件支持的规范版本
GC       回收插件持有的垃圾数据(规范 1.1.0 起)
STATUS   查询插件自身健康状态(规范 1.1.0 起)
```

插件从 stdin 读取 JSON 配置、从环境变量读取 `CNI_COMMAND`、`CNI_CONTAINERID`、`CNI_NETNS`、`CNI_IFNAME`、`CNI_ARGS`、`CNI_PATH`,执行结果以 JSON 从 stdout 返回 —— 所以插件本质就是「读 JSON、写 JSON」的可执行文件,用 shell 脚本也能实现。

### 配置文件格式

单插件配置(`.conf`),最简形式:

```shell
{
  "cniVersion": "1.0.0",
  "name": "mynet",
  "type": "bridge",
  "bridge": "cni0",
  "isGateway": true,
  "ipMasq": true,
  "ipam": {
    "type": "host-local",
    "ranges": [
      [{ "subnet": "10.244.0.0/16" }]
    ],
    "routes": [
      { "dst": "0.0.0.0/0" }
    ]
  }
}
```

插件链配置(`.conflist`),按 `plugins` 数组顺序依次调用,这是 CNI 生态里最常用的形式:

```shell
{
  "cniVersion": "1.0.0",
  "name": "k8s-pod-network",
  "plugins": [
    {
      "type": "calico",
      "log_level": "info",
      "ipam": {
        "type": "calico-ipam"
      }
    },
    {
      "type": "portmap",
      "capabilities": { "portMappings": true }
    },
    {
      "type": "bandwidth",
      "capabilities": { "bandwidth": true }
    }
  ]
}
```

`capabilities` 声明插件支持哪些运行时能力(PortMapping、Bandwidth、IPRanges 等),运行时只有在能力被声明时才会把对应字段传进来。

### 参考插件

```shell
main  接口类    bridge、ptp、macvlan、ipvlan、vlan、loopback、host-device、dummy
IPAM  IP 分配   host-local、dhcp、static
meta  辅助类    portmap、bandwidth、firewall、tuning、sbr
```

日常排障最常用的三个 meta 插件:`portmap`(让 hostPort/NodePort 生效)、`bandwidth`(限速)、`tuning`(改 sysctl,如给 Pod 网卡配 MTU)。

### 安装参考插件

```shell
# 下载官方参考插件二进制
curl -fsSL -o cni-plugins.tgz \
  https://github.com/containernetworking/plugins/releases/download/v1.9.1/cni-plugins-linux-amd64-v1.9.1.tgz

sudo mkdir -p /opt/cni/bin
sudo tar -C /opt/cni/bin -xzf cni-plugins.tgz

# 确认二进制就位
ls /opt/cni/bin/
```

### 运行时侧配置

containerd 1.x 的配置路径:

```shell
[plugins."io.containerd.grpc.v1.cri".cni]
  bin_dir = "/opt/cni/bin"
  conf_dir = "/etc/cni/net.d"
  max_conf_num = 1
```

containerd 2.x 改名为 `io.containerd.cri.v1.runtime`,且 `bin_dir` 自 2.1 起被 `bin_dirs`(数组)取代:

```shell
[plugins.'io.containerd.cri.v1.runtime'.cni]
  bin_dirs = ['/opt/cni/bin']
  conf_dir = '/etc/cni/net.d'
  max_conf_num = 1
```

`max_conf_num` 决定取几个配置文件:值为 1 表示只取目录里字典序第一个,装了多个 CNI 又不清理旧文件时,生效的可能不是你以为的那个。

```shell
# 查看运行时实际生效的配置
containerd config dump | grep -A5 -i "cni"
sudo systemctl restart containerd
```

### 常用操作

```shell
# 当前节点用的是哪个 CNI
ls -l /etc/cni/net.d/
cat /etc/cni/net.d/*.conflist | head -40

# 插件二进制是否齐全(type 字段对应的可执行文件必须存在)
ls /opt/cni/bin/

# 节点是否因为缺 CNI 而 NotReady
kubectl get nodes
kubectl describe node <node-name> | grep -i -A3 "NetworkUnavailable\|cni"

# 查看 Pod 的网络命名空间与网卡(需要进入容器所在节点)
crictl pods
crictl inspectp <pod-id> | grep -i netns
nsenter -t <pid> -n ip addr

# 用 cnitool 手工调用插件调试配置(不依赖 Kubernetes)
sudo CNI_PATH=/opt/cni/bin cnitool add mynet /var/run/netns/test
sudo CNI_PATH=/opt/cni/bin cnitool del mynet /var/run/netns/test
```

### 排障

```shell
# 1. 节点 NotReady 且描述里提到 network plugin not ready
kubectl describe node <node-name> | grep -i -B2 -A5 "NotReady"

# 2. kubelet 日志里的 CNI 报错(最常见的三句)
journalctl -u kubelet -n 200 | grep -i cni
#    "cni config uninitialized"        /etc/cni/net.d 下没有任何配置
#    "failed to find plugin ... in path"   二进制不在 /opt/cni/bin
#    "no IP addresses available in range"  IPAM 地址池耗尽

# 3. 宿主机上看插件调用失败的详细原因
journalctl -u containerd -n 200 | grep -i cni

# 4. 确认 IPAM 的分配数据库(host-local 插件)
sudo cat /var/lib/cni/networks/<network-name>/last_reserved_ip.0
sudo ls /var/lib/cni/networks/<network-name>/ | head

# 5. 跨节点 Pod 不通时,先看路由与封装接口是否存在
ip route | grep -E "10.244|cali|flannel|cni"
ip -d link show | grep -E "vxlan|tunl0|flannel|cali"
```

### 注意

1. **CNI 必须在 `kubeadm init` 之后立刻安装**,否则节点永远处于 `NotReady`,CoreDNS 等系统 Pod 也会一直 Pending。这是自建集群卡住的头号原因,与 kubeadm 本身无关。
2. **切换 CNI 必须先清理旧配置**。`/etc/cni/net.d` 下的旧 conflist 不会自动删除,新插件的文件名若排在旧文件之后,运行时仍会加载旧的;正确做法是删掉旧配置与旧二进制、清理 `/var/lib/cni/` 和节点上的残留网卡(如 `cni0`、`flannel.1`、`cali*`),再重启运行时。
3. **`type` 字段对应的是可执行文件名**。写了 `"type": "calico"` 就必须存在 `/opt/cni/bin/calico`,否则 Pod 会卡在 `ContainerCreating` 并报 "failed to find plugin"。手工拷贝插件时别忘了可执行权限。
4. **插件的 `name` 字段在集群内应保持一致**,IPAM 的分配记录以 `name` 为目录名保存;不同节点用不同 `name` 会导致地址冲突或重复分配。
5. **CNI 只负责 Pod 的连通性,不负责 Service**。访问 ClusterIP 不通应该查 kube-proxy 或 Cilium 的 kube-proxy replacement,而不是 CNI —— 这条边界能省下大量排查时间。
6. **不是所有 CNI 都支持 NetworkPolicy**。Flannel 默认不支持、Cilium/Calico/Antrea 支持,选了不支持的插件时 NetworkPolicy 对象能创建成功但完全静默失效。
7. **`cniVersion` 不要随手改大**。老插件可能只声明支持到 `0.3.1`,把配置写成 `1.1.0` 会让插件直接拒绝加载,表现为 Pod 网络配置失败。
8. **CNI 配置变更不需要重启 kubelet**。配置在创建/删除 Pod 时才被读取,改动只对新 Pod 生效,存量 Pod 需要重建 —— 这也是「改了 CNI 配置老 Pod 没变化」的原因。
9. **删除 Pod 时 DEL 调用失败会留下脏数据**。IP 未释放、网卡未删除都会累积,最终触发 IPAM 地址耗尽;`/var/lib/cni/networks/` 下的残留记录需要在确认无容器占用后手工清理。
10. **MTU 不一致是隐蔽杀手**。CNI 的 MTU 通常要比物理网卡小(VXLAN 减 50、IPIP 减 20、WireGuard 减 60),配置不当的症状是「小包正常、大包卡死」,ping 通但传文件失败。
11. **Pod 的 `hostNetwork: true` 完全不经过 CNI**,这类 Pod 用的是节点网络命名空间,拿不到 Pod IP,排查网络问题时先确认这个字段。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kubelet` — 通过CRI调用容器运行时,间接触发CNI
- `crictl` — 容器运行时调试工具,可查看Pod网络命名空间
- `networkpolicy` — 由CNI插件负责执行的网络策略
- `kube-proxy` — 负责Service转发,与CNI职责分离
- `kubeadm` — 集群安装工具,不负责安装CNI

### 参考链接

- [CNI 规范](https://github.com/containernetworking/cni/blob/main/SPEC.md)
- [CNI 官方网站](https://www.cni.dev/)
- [参考插件仓库](https://github.com/containernetworking/plugins)
- [集群网络(Cluster Networking)](https://kubernetes.io/docs/concepts/cluster-administration/networking/)
- [网络插件(Network Plugins)](https://kubernetes.io/docs/concepts/extend-kubernetes/compute-storage-net/network-plugins/)
