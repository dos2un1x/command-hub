multus
===

让KubernetesPod挂载多张网卡的CNI元插件

## 补充说明

**Multus** 是一个 CNI **元插件(meta-plugin)**:它自己不做转发,而是"调用其他 CNI 插件的插件"。默认情况下每个 Pod 只有一张网卡(外加 loopback),Multus 让你在不放弃现有集群网络的前提下,再给 Pod 挂上第二张、第三张网卡 —— 这些额外网卡可以接在存储网络、管理网络、SR-IOV 高速网卡或完全隔离的二层网络上。

它在这些场景里几乎是标配:KubeVirt 虚拟机需要管理网 + 存储网 + 业务网三张卡;电信/边缘场景需要 SR-IOV 或 DPDK 直通;存储组件需要走独立的存储网段;NFV 场景需要多张物理网卡分流。

两个术语要先分清:

```shell
默认网络(default network)   集群原有 CNI(Calico/Cilium/Flannel)提供的 eth0,每个 Pod 都有
辅助网络(additional network) 由 NetworkAttachmentDefinition 描述,通过注解挂载,依次叫 net1、net2……
```

Multus 自 4.0 起提供两种部署形态:

```shell
thick plugin(厚插件)  DaemonSet 里常驻 multus-daemon,加上轻量的 multus-shim 二进制
                      通过 Unix socket 通信,功能完整、有指标、支持热插拔,官方推荐
thin plugin(薄插件)   单个二进制,每次调用现起进程,资源占用低,适合资源紧张的环境
```

项目当前仍在活跃维护,4.2.x 为稳定线。

### 安装

前提:集群**已经装好一个默认 CNI**,否则节点会 NotReady,Multus 也无从接管。

```shell
# 推荐:厚插件
kubectl apply -f https://raw.githubusercontent.com/k8snetworkplumbingwg/multus-cni/master/deployments/multus-daemonset-thick.yml

# 薄插件(资源受限环境)
kubectl apply -f https://raw.githubusercontent.com/k8snetworkplumbingwg/multus-cni/master/deployments/multus-daemonset.yml

# 生产环境请固定版本,不要用 master
kubectl apply -f https://raw.githubusercontent.com/k8snetworkplumbingwg/multus-cni/v4.2.4/deployments/multus-daemonset-thick.yml

kubectl -n kube-system get pods -l name=kube-multus-ds -o wide
```

安装后节点上的变化:

```shell
/etc/cni/net.d/00-multus.conf         Multus 自动生成,内容是把请求委托给"默认网络"的配置
/etc/cni/net.d/multus.d/              证书与配置目录(厚插件使用)
/opt/cni/bin/multus-shim              轻量入口二进制
/run/multus/multus.sock               厚插件的本地 socket
```

`00-multus.conf` 是**根据 `/etc/cni/net.d` 里字典序第一个非 Multus 配置文件自动生成**的,默认网络的改动会被它带过去,因此不要手工编辑这个文件。

### 定义辅助网络

辅助网络用 `NetworkAttachmentDefinition`(简称 NAD)描述:

```shell
apiVersion: k8s.cni.cncf.io/v1
kind: NetworkAttachmentDefinition
metadata:
  name: macvlan-conf
  namespace: default
spec:
  config: |-
    {
      "cniVersion": "1.0.0",
      "type": "macvlan",
      "master": "eth0",
      "mode": "bridge",
      "ipam": {
        "type": "host-local",
        "subnet": "192.168.1.0/24",
        "rangeStart": "192.168.1.200",
        "rangeEnd": "192.168.1.216",
        "gateway": "192.168.1.1"
      }
    }
```

`spec.config` 里的内容就是一段标准 CNI 配置,`type` 指定用哪个插件(`macvlan`、`ipvlan`、`bridge`、`sriov`、`host-device` 等),对应的二进制必须在节点的 `/opt/cni/bin` 里存在。

基于 bridge 的辅助网络(同一节点上的 Pod 通过新网桥互通):

```shell
apiVersion: k8s.cni.cncf.io/v1
kind: NetworkAttachmentDefinition
metadata:
  name: bridge-conf
  namespace: default
spec:
  config: |-
    {
      "cniVersion": "1.0.0",
      "type": "bridge",
      "bridge": "br-tenant1",
      "ipam": {
        "type": "host-local",
        "subnet": "10.10.0.0/24"
      }
    }
```

SR-IOV 场景通常配合 SR-IOV Network Operator 生成 NAD,`type` 为 `sriov`,并指定 `deviceID`、`resourceName` 等字段。

### 挂载到 Pod

用注解声明需要挂载的辅助网络:

```shell
apiVersion: v1
kind: Pod
metadata:
  name: multi-homed
  annotations:
    k8s.v1.cni.cncf.io/networks: macvlan-conf
spec:
  containers:
    - name: app
      image: nicolaka/netshoot
      command: ["sleep", "infinity"]
```

挂载多个,逗号分隔:

```shell
  annotations:
    k8s.v1.cni.cncf.io/networks: macvlan-conf,bridge-conf
```

跨命名空间必须写全 `namespace/name`,不写命名空间时默认找 `kube-system`:

```shell
  annotations:
    k8s.v1.cni.cncf.io/networks: default/macvlan-conf
```

用 JSON 形式可以指定接口名、MAC 与静态 IP:

```shell
  annotations:
    k8s.v1.cni.cncf.io/networks: |-
      [
        {
          "name": "macvlan-conf",
          "namespace": "default",
          "interface": "net1",
          "ips": ["192.168.1.205/24"]
        }
      ]
```

替换默认网络(把某张辅助网卡变成 Pod 的 eth0):

```shell
  annotations:
    v1.multus-cni.io/default-network: default/macvlan-conf
```

Multus 会把挂载结果写进只读注解,便于排查与采集:

```shell
kubectl get pod multi-homed -o jsonpath='{.metadata.annotations.k8s\.v1\.cni\.cncf\.io/network-status}' | jq
```

```shell
[
  {
    "name": "calico",
    "interface": "eth0",
    "ips": ["10.244.1.15"],
    "mac": "0a:1b:2c:3d:4e:5f",
    "default": true
  },
  {
    "name": "macvlan-conf",
    "interface": "net1",
    "ips": ["192.168.1.205"],
    "mac": "0a:1b:2c:3d:4e:60"
  }
]
```

### 常用操作

```shell
# 查看 NAD
kubectl get network-attachment-definitions -A
kubectl get net-attach-def -A
kubectl describe net-attach-def macvlan-conf

# 查看 Multus 是否在每个节点就绪
kubectl -n kube-system get pods -l name=kube-multus-ds -o wide
kubectl -n kube-system logs -l name=kube-multus-ds --tail=100

# 确认节点上的委托配置
ls -l /etc/cni/net.d/
cat /etc/cni/net.d/00-multus.conf

# 进 Pod 检查网卡
kubectl exec -it multi-homed -- ip addr
kubectl exec -it multi-homed -- ip route
kubectl exec -it multi-homed -- ip -d link show net1
```

### 排障

```shell
# 1. Pod 卡在 ContainerCreating
kubectl describe pod multi-homed | tail -20
#    常见报错:failed to find plugin "macvlan" in path [/opt/cni/bin]
#              network-attachment-definition not found
kubectl -n kube-system logs -l name=kube-multus-ds | grep -i error | tail -30

# 2. 注解里的 NAD 是否存在、命名空间是否写对
kubectl get net-attach-def -A

# 3. 辅助网卡的 IPAM 是否耗尽
ls /var/lib/cni/networks/<nad-name>/ | head
cat /var/lib/cni/networks/<nad-name>/last_reserved_ip.0

# 4. 接口起来了但不通:先看 master 网卡是否存在
ip link show eth0
ip link show | grep -E "macvlan|ipvlan|sriov"

# 5. 厚插件 Pod 被 OOMKilled
kubectl -n kube-system get pod -l name=kube-multus-ds \
  -o jsonpath='{.items[*].status.containerStatuses[*].lastState}'
```

### 注意

1. **Multus 不是 CNI,它需要一个默认 CNI 才能工作**。先装 Calico/Cilium/Flannel,再装 Multus;反过来的话节点会一直 NotReady。
2. **默认网络取决于 `/etc/cni/net.d` 里的字典序**。Multus 读取第一个非 Multus 的配置文件并生成 `00-multus.conf` 委托给它;手工改 `00-multus.conf` 会在下次重启时被覆盖,要改就改原始的 Calico/Cilium 配置。
3. **注解里不带命名空间时默认查 `kube-system`**。NAD 建在业务命名空间、注解里只写名字,会直接报「找不到网络」,必须写成 `namespace/name`。
4. **辅助网卡不归 Kubernetes 网络模型管**。ClusterIP、Service、NetworkPolicy 都是针对默认网络(eth0)的,net1 上的流量通常不受 NetworkPolicy 约束,不要指望用它来做安全隔离。
5. **接口名按注解顺序分配,重建后会变**。想稳定拿到 `net1`,就在注解里用 JSON 形式显式写 `"interface": "net1"`。
6. **macvlan 需要节点上有真实可用的 master 接口**,且 macvlan 子接口**与宿主机的同网卡通常无法互相通信**(内核限制),需要与宿主机互访时改用 `ipvlan`。
7. **厚插件默认内存上限偏小**。官方清单里的 50Mi 在多个 NAD、Pod 数量多时会被 OOMKilled,建议上调到 200Mi 以上;OOM 后症状是「部分 Pod 突然挂不上辅助网卡」。
8. **主辅组合有兼容性差异**。Calico/Cilium 作为默认网络、macvlan 作为辅助网络是常见且稳定的组合;反过来把 macvlan 设为默认网络、Calico 作为辅助网络时,曾出现 Calico 连通性异常,生产环境不要轻易这样配。
9. **NAD 变更不需要重启 kubelet**,但只对新建 Pod 生效,存量 Pod 必须重建;`kubectl rollout restart` 会触发滚动重建。
10. **`type` 对应的二进制必须存在于所有节点**。只在一部分节点装了 `sriov` 或 `macvlan` 插件,会导致调度到这些节点的 Pod 创建失败,而其他节点一切正常。
11. **SR-IOV 类网卡依赖设备插件与厂商驱动**,资源名(`resources.requests` 里的 `openshift.io/sriov` 之类)必须与节点上暴露的资源一致,否则 Pod 会一直 Pending。
12. **旧的状态注解已被移除**。Multus 4.0 起使用 `k8s.v1.cni.cncf.io/network-status`,依赖老注解 `networks-status` 的监控采集脚本需要同步升级,否则指标会突然变空。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `cni` — Multus所依赖的容器网络接口规范
- `calico` — 常作为Multus的默认网络
- `cilium` — 常作为Multus的默认网络
- `networkpolicy` — 只作用于默认网络,不覆盖辅助网卡
- `pod` — 通过注解挂载辅助网卡的对象

### 参考链接

- [Multus CNI 项目仓库](https://github.com/k8snetworkplumbingwg/multus-cni)
- [Multus 快速开始](https://github.com/k8snetworkplumbingwg/multus-cni/blob/master/docs/quickstart.md)
- [Multus 厚插件说明](https://github.com/k8snetworkplumbingwg/multus-cni/blob/master/docs/thick-plugin.md)
- [网络附加定义(NetworkAttachmentDefinition)约定](https://github.com/k8snetworkplumbingwg/multi-net-spec)
- [Kubernetes 网络插件文档](https://kubernetes.io/docs/concepts/extend-kubernetes/compute-storage-net/network-plugins/)
