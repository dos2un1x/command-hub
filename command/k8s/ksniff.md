ksniff
===

kubectl插件:把静态编译的tcpdump注入Pod,抓包直接送进本地Wireshark

## 补充说明

**ksniff** 是一个 `kubectl` 插件,用一条命令对集群里任意 Pod 抓包:它把一个**静态编译的 tcpdump 二进制**上传进目标容器,在容器的网络命名空间里执行抓包,再把 pcap 流回本地交给 Wireshark 打开。

```shell
kubectl sniff <pod> [-n 命名空间] [-c 容器] [-i 网卡] [-f 过滤表达式] [-o 输出文件]
```

**维护状态(重要):** 项目已基本停止维护。最后一个 release 是 **v1.6.2(2022-02-14)**,最后一次提交停在 **2022-08-05** —— 截至 2026-09 已有约四年没有代码更新。仓库**并未归档**、仍可安装使用,但官方 README 同时写明「**ksniff 目前还不是生产就绪状态**,不建议对生产负载使用」。它仍是一个称手的调试工具,只是要有心理准备:遇到新版本 Kubernetes 或新运行时的问题,大概率等不到修复。

作者自己给出的方向也值得注意:README 的 Future Work 第一条就是「不再上传静态 tcpdump,改用 `kubectl debug` 临时容器」—— 这正是今天推荐的替代路径。

### 它到底做了什么

理解执行流程,才能看懂它的权限要求与失败现象:

```shell
1. 读取目标 Pod 的 spec,拿到它所在节点与容器运行时(docker / containerd / CRI-O)
2. 在目标 Pod 所在节点上创建一个临时 Pod(特权,能访问节点的容器运行时 socket)
3. 该临时 Pod 把静态编译的 tcpdump 二进制拷进目标容器的文件系统
4. 在目标容器的网络命名空间里执行 tcpdump,输出 pcap 流
5. 本地的 ksniff 接收这个流,交给 Wireshark 或写入文件
6. 清理:结束抓包,并删掉临时 Pod 与上传的二进制
```

由此可以推出几个结论:

```shell
- 不需要节点上预装 tcpdump(第 3 步自带)
- 必须有权限在目标命名空间创建 Pod(第 2 步)
- 目标容器的文件系统必须可写(第 3 步要落文件)
- 用的是 Pod 的网络命名空间,不是容器(第 4 步)
```

### 安装

```shell
# 推荐:通过 krew 安装
kubectl krew install sniff

# 手工安装
unzip ksniff.zip
make install
```

```shell
# 确认插件已就绪
kubectl krew list | grep sniff
kubectl sniff --help
```

### 常用参数

```shell
-n <namespace>        目标 Pod 所在命名空间
-c <container>        只抓某个容器,缺省抓 Pod 里第一个容器
-i <interface>        Pod 的网卡名,缺省抓全部网卡
-f "<filter>"         tcpdump 抓包过滤表达式
-o <file>             pcap 写到本地文件;用 -o - 表示写 stdout
-l <path>             本地 tcpdump 二进制路径
-r <path>             上传到容器里的远端路径
-p                    特权模式,用于 scratch / 非特权容器
--image <image>       air-gap 环境下替换默认容器镜像
--tcpdump-image <img> air-gap 环境下替换 tcpdump 镜像
```

### 基本用法

```shell
# 抓某个 Pod 的全部流量,自动拉起本地 Wireshark
kubectl sniff nginx-6f8b9c-x7k2p

# 指定命名空间与容器
kubectl sniff backend-0 -n prod -c app

# 加过滤表达式(引号不能省)
kubectl sniff backend-0 -n prod -f "port 8080 and host 10.244.1.7"

# 只抓 eth0
kubectl sniff backend-0 -n prod -i eth0

# 写到文件而不是拉起 Wireshark
kubectl sniff backend-0 -n prod -o /tmp/backend.pcap

# 管道给 tshark(无图形界面服务器上的常用姿势)
kubectl sniff backend-0 -n prod -f "port 80" -o - | tshark -r -
```

### 非特权容器与 scratch 容器

很多生产容器以非 root 运行,甚至是 scratch(没有 shell、没有可写目录)。这时用 `-p`:

```shell
kubectl sniff backend-0 -n prod -p
```

`-p` 模式会**额外创建一个特权 Pod**,该 Pod 能访问节点上的容器运行时(docker / containerd),用它把 tcpdump 拷进目标容器的文件系统,再在目标容器的网络命名空间里执行抓包。

这解释了 ksniff 的一个关键设计:**它自带 tcpdump,不依赖节点上有没有装 tcpdump**。「在节点上装 tcpdump」不是 ksniff 的前置条件。

### air-gap 环境

```shell
kubectl sniff backend-0 -n prod \
  --image <私有仓库>/docker \
  --tcpdump-image <私有仓库>/tcpdump
```

也可以用环境变量:`KUBECTL_PLUGINS_LOCAL_FLAG_IMAGE`、`KUBECTL_PLUGINS_LOCAL_FLAG_TCPDUMP_IMAGE`。

### 排查 ksniff 自身的问题

```shell
# 权限够不够(需要能 create pod / get pod / exec)
kubectl auth can-i create pods -n prod
kubectl auth can-i create pods --subresource=exec -n prod

# 看 ksniff 到底做了什么(它会在目标命名空间里创建临时 Pod)
kubectl get pods -n prod -w

# 目标容器的文件系统是不是可写(不可写就用 -p)
kubectl exec -it backend-0 -n prod -- touch /tmp/probe

# Wireshark 版本
wireshark --version
```

### 替代方案

```shell
# 1. 临时容器(1.25+ 默认可用,推荐)
kubectl debug -it backend-0 --image=nicolaka/netshoot --target=app
# 进去之后自己在共享网络命名空间里抓
tcpdump -i eth0 -nn port 8080 -w /tmp/cap.pcap

# 2. 直接在节点上抓(能看到 veth 与宿主机侧)
nsenter -t <pid> -n tcpdump -i any -nn port 8080

# 3. 有 CNI 可观测性时用它,不抓包也能看丢包原因
kubectl -n kube-system exec ds/cilium -- cilium-dbg monitor --type drop

# 4. 只想看 L7 请求内容时,用服务网格或 Sidecar 的 access log
kubectl logs backend-0 -n prod --tail=100
```

### 注意

1. **不需要在节点上安装 tcpdump —— 这是个流传很广的误解**。ksniff 会把一个**静态编译的 tcpdump 二进制上传到目标容器**再执行,节点上有没有 tcpdump 完全无关。真正的前置条件是:目标容器的文件系统可写(否则用 `-p`),以及你有权限在目标命名空间里创建 Pod。
2. **项目自 2022-08 起没有任何提交,最后 release 停在 2022-02 的 v1.6.2**。仓库未归档,但事实上已停更约四年;官方 README 明确写着「不是生产就绪」。把它当作调试工具可以,但不要写进任何自动化流程或长期依赖的运维手册。
3. **`-p` 特权模式会创建一个能访问节点容器运行时的特权 Pod**,它绕过了 Pod 的安全边界。在开启 Pod Security Admission 的命名空间里,这个 Pod 会被策略直接拒绝;在安全审计里也是高风险动作,生产环境使用前请确认授权。
4. **Wireshark 必须 ≥ 3.4.0**。旧版本读 ksniff 生成的 pcap 会报 `pcap: network type 276 unknown or unsupported`,Protocol 列显示 UNKNOWN。Ubuntu LTS 自带版本常常偏低,需要换官方 PPA。
5. **ksniff 会往业务容器里写文件**。这是它的工作原理,副作用是可能触发容器的文件完整性监控、留下垃圾文件,只读根文件系统的容器则直接失败。用完记得确认没有残留。
6. **抓包位置是 Pod 的网络命名空间**,不是「容器」。同一 Pod 多容器共享 netns,所以 `-c` 只影响在哪个容器里执行 tcpdump,不影响能看到哪些流量;要区分容器,只能靠端口与进程信息。
7. **它抓不到加密流量里的内容**。mTLS、Service Mesh 的 Sidecar 之间都是加密的,抓出来只有 TLS 记录层。要看 L7 内容,得在 Sidecar 的出/入口抓,或者用网格自己的可观测性。
8. **RBAC 要求不低**。除了读 Pod,还要能在目标命名空间创建 Pod,`-p` 模式下创建的还是特权 Pod。很多团队的默认 `edit` 角色并不包含这些权限。
9. **现代集群优先用 `kubectl debug` 临时容器**。它不往业务容器写文件、不需要额外镜像、由 kubelet 原生支持;配合 `nicolaka/netshoot` 这类自带 tcpdump 的镜像,能覆盖 ksniff 的绝大部分场景。这也是 ksniff 作者自己指的方向。
10. **抓包会带来 CPU 与丢包风险**。高流量 Pod 上用默认的 snaplen 抓全量包,可能自己把节点 CPU 打满、并且丢包导致分析结论错误。记得用 `-f` 收窄过滤条件。
11. **看不到节点侧的 veth 与封装后流量**。Pod netns 里抓的是进入 Pod 之前的形态;要看 VXLAN/IPIP 封装、要判断 MTU 与重传,得在节点上抓宿主机侧网卡。

### 相关命令

- `kubectl` — ksniff是它的插件
- `kubectl-debug` — 同类思路的调试工具
- `ephemeral-containers` — 推荐的现代替代方案
- `network-troubleshooting` — 抓包在排查流程中的位置
- `mtu` — 抓包判断大包是否被丢弃
- `crictl` — 定位容器与节点上的运行时
- `hubble` — 不抓包也能看流量的方案

### 参考链接

- [ksniff 仓库](https://github.com/eldadru/ksniff)
- [kubectl debug(临时容器)](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/#ephemeral-container)
- [krew 插件管理器](https://krew.sigs.k8s.io/)
- [Wireshark 官方下载](https://www.wireshark.org/download.html)
- [tcpdump 手册](https://www.tcpdump.org/manpages/tcpdump.1.html)
