nerdctl
===

containerd 的 Docker 兼容命令行客户端,支持 Compose、构建与 Kubernetes 命名空间

## 补充说明

**nerdctl** 是 containerd 官方社区的客户端工具,目标是把 `docker` 命令行的使用体验搬到 containerd 上。它和 `ctr` 是同一层的工具(都直连 containerd,不经过 CRI),但定位完全不同:

```shell
ctr       面向调试与底层操作,命令繁琐,不追求易用
nerdctl   面向日常使用,命令与 docker 基本一一对应
```

官方对它的定位说得很直白:「competing with Docker is not the goal」—— 它是用来试验 Docker 所没有的特性的,不是要取代 Docker,因此**有大量命令和参数尚未实现**。

它与 Kubernetes 的关系体现在一个非常实用的点上:**containerd 的 `k8s.io` 命名空间里就是 kubelet 创建的所有容器**。只要加上 `-n k8s.io`,nerdctl 就能用 `docker ps` 一样的手感查看、查看日志、进容器,比 `ctr` 顺手得多。

但必须记住 **nerdctl 不经过 CRI,也不理解 Pod 这个概念**:它能列出节点上的容器,却看不到 Pod 的划分;它启动的容器也不会出现在 apiserver 里。要按 Pod 维度排障仍然要用 `crictl`。

### 安装

```shell
# 完整版:内置 CNI、BuildKit、RootlessKit 等依赖,推荐用于单机与节点
VERSION="v2.3.5"
wget https://github.com/containerd/nerdctl/releases/download/$VERSION/nerdctl-full-$VERSION-linux-amd64.tar.gz
sudo tar Cxzvvf /usr/local nerdctl-full-$VERSION-linux-amd64.tar.gz

# 精简版:只有二进制,依赖需自行准备
wget https://github.com/containerd/nerdctl/releases/download/$VERSION/nerdctl-$VERSION-linux-amd64.tar.gz
sudo tar Cxzvvf /usr/local/bin nerdctl-$VERSION-linux-amd64.tar.gz

nerdctl --version
```

```shell
# macOS 走 Lima,macOS 上不支持 brew 直装 nerdctl
brew install lima
limactl start
limactl shell default nerdctl --version

# Windows
scoop install nerdctl
```

### 依赖组件

nerdctl 本体只是一个客户端,**能力取决于背后装了什么**:

```shell
containerd      必需,nerdctl 直连它的 socket
CNI plugins     nerdctl run 需要,建议 v1.1.0 以上
BuildKit        nerdctl build 需要,buildkitd 必须在运行,建议 v0.11.0 以上
RootlessKit     rootless 模式需要,建议 v3.0.0 以上
```

精简版 tar 包里**不含**这些依赖,完整版(`nerdctl-full-*`)含。节点上如果已经有 containerd 却没装 CNI 插件,`nerdctl run` 会报错而 `nerdctl ps` 正常 —— 这正是判断「缺哪个依赖」的线索。

### 配置

配置文件可以放两处,也可以用 `--config` 显式指定:

```shell
/etc/nerdctl/nerdctl.toml                  全局配置
$XDG_CONFIG_HOME/nerdctl/nerdctl.toml      用户级配置(默认 ~/.config/nerdctl/nerdctl.toml)
```

最常用的一项是把默认命名空间改成 `k8s.io`,省得每条命令都带 `-n`:

```shell
namespace = "k8s.io"
```

其他常用项:

```shell
address          = "/run/containerd/containerd.sock"
namespace        = "default"
data_root        = "/var/lib/nerdctl"
cni_path         = "/opt/cni/bin"
buildkit_host    = "unix:///run/buildkit/buildkitd.sock"
insecure_registry = true
```

### 命名空间

这是 nerdctl 在 Kubernetes 节点上最先要搞懂的概念。containerd 的 namespace 与 Kubernetes 的 namespace **完全无关**,它用来隔离不同的使用者:

```shell
k8s.io     kubelet 通过 CRI 创建的所有容器和镜像,不论它们属于哪个 Kubernetes 命名空间
default    nerdctl / ctr 手工操作时默认落在的命名空间
moby       由 Docker 创建的对象
```

```shell
# 列出所有命名空间
nerdctl namespace ls

# 查看 Kubernetes 的容器(必须显式指定 -n k8s.io)
nerdctl -n k8s.io ps -a
nerdctl -n k8s.io images ls
nerdctl -n k8s.io logs <container-id>
nerdctl -n k8s.io inspect <container-id>

# 默认命名空间
nerdctl ps
```

### 常用命令

与 Docker 的对应关系几乎是一对一:

```shell
nerdctl run -d -p 8080:80 nginx:1.27
nerdctl ps -a
nerdctl images
nerdctl pull nginx:1.27
nerdctl exec -it <name> sh
nerdctl logs -f <name>
nerdctl inspect <name>
nerdctl stats
nerdctl rm -f <name>
nerdctl rmi nginx:1.27
nerdctl system prune -a
```

nerdctl 相较 Docker 的额外能力:

```shell
# 惰性拉取(Stargz / Nydus / OverlayBD / SOCI),大幅缩短大镜像的启动等待
nerdctl run --snapshotter nydus nginx:1.27

# cosign 签名与校验
nerdctl pull --verify cosign:none registry.example.com/app:v1

# 拉取全部平台的镜像
nerdctl pull --all-platforms nginx:1.27
```

### 构建镜像

`nerdctl build` **依赖 BuildKit**,不是 nerdctl 自己实现的:

```shell
# 前提:buildkitd 正在运行
sudo systemctl status buildkit
nerdctl build -t registry.example.com/app:v1 .

# 指定 buildkitd 地址
nerdctl build --buildkit-host unix:///run/buildkit/buildkitd.sock -t app:v1 .

# rootless 下的 buildkitd
nerdctl build --buildkit-host unix:///run/user/1000/buildkit/buildkitd.sock -t app:v1 .
```

在已装 containerd 的 Kubernetes 节点上,最常见的问题是 **buildkitd 没有装或没起**,表现为 `buildkitd not running` 或连接 socket 被拒。

### Compose

```shell
nerdctl compose up -d
nerdctl compose ps
nerdctl compose logs -f
nerdctl compose down -v
```

与 `docker compose` 的兼容度较高,但并非 100%,复杂的 compose 文件仍可能需要调整。

### rootless 模式

```shell
# 安装 rootless containerd 与 buildkitd(完整版 tar 包自带)
sudo containerd-rootless-setuptool.sh install
sudo containerd-rootless-setuptool.sh install-buildkit

# 启动
systemctl --user start containerd
systemctl --user status containerd

# 使用
export CONTAINERD_ADDRESS=/run/user/1000/containerd/containerd.sock
nerdctl run -d -p 8080:80 nginx:1.27
```

### 镜像归档

```shell
# 保存为 Docker 格式归档(可交给 docker load)
nerdctl save -o app.tar registry.example.com/app:v1

# 保存为 OCI 格式
nerdctl save --format oci -o app-oci.tar registry.example.com/app:v1

# 载入
nerdctl load -i app.tar

# 专门为离线导入 Kubernetes 节点准备(指定 k8s.io 命名空间)
nerdctl -n k8s.io load -i app.tar
```

最后一条是 nerdctl 相对 `ctr` 最实在的优势之一:`ctr images import` 的归档格式限制多,而 nerdctl 能直接吃 `docker save` 出来的归档。

### 在节点上排障

```shell
# 1. 确认能连上 containerd
nerdctl info

# 2. 看 Kubernetes 的容器(比自己拼 ctr 命令方便得多)
nerdctl -n k8s.io ps -a

# 3. 按镜像名筛出容器
nerdctl -n k8s.io ps -a --filter ancestor=registry.example.com/app:v1

# 4. 看日志
nerdctl -n k8s.io logs --since 10m <container-id>

# 5. 进容器
nerdctl -n k8s.io exec -it <container-id> sh

# 6. 确认镜像在不在、有没有拉全
nerdctl -n k8s.io images ls
```

### 注意

1. **不带 `-n k8s.io` 就看不到任何 Kubernetes 的容器和镜像**。nerdctl 默认用 `default` 命名空间,而 kubelet 用的是 `k8s.io`,两者完全隔离。在节点上敲 `nerdctl ps` 空无一物却又有 Pod 在跑,原因一定是这个。
2. **nerdctl 与 crictl 互相看不见对方的对象**。nerdctl 不走 CRI,`crictl` 只显示 CRI 管理的容器。二者是两套并行的视图,不要用其中一个的结果去否定另一个。
3. **nerdctl 不显示 Pod**。它能列出容器,却没有 Pod 的概念;`nerdctl -n k8s.io` 里的容器就是 kubelet 管理的容器,想按 Pod 维度看只能用 `crictl pods`。如果刚好在 `k8s.io` 命名空间里 `nerdctl run` 了一个容器,**它会出现在 kubelet 的视野里却不属于任何 Pod**,可能被后续的 GC 清掉,还可能干扰排障。
4. **`nerdctl build` 需要 BuildKit**。没装 buildkitd 时构建直接不可用,这一点与 Docker 内置 build 的体验落差很大,很多人在节点上第一次用 nerdctl 就卡在这里。
5. **`nerdctl run` 需要 CNI 插件**。缺插件时容器起不来且报错信息不一定直观。精简版 tar 包不含 CNI,请用 `nerdctl-full-*`。
6. **`nerdctl -n k8s.io load` 导入的镜像同样会被 kubelet 的镜像 GC 回收**。它只是「手工塞进节点」,没有任何 Pod 引用它,GC 触发后就没了。生产上仍应通过 registry 拉取,手工导入只适合离线应急。
7. **命名空间只影响可见性,不改变归属**。用 `nerdctl -n k8s.io` 启动的容器**不会**出现在 `kubectl get pods` 里,apiserver 对它一无所知。
8. **rootless 与 root 的 containerd 是两套独立实例**,socket 地址不同(`/run/user/1000/containerd/containerd.sock` vs `/run/containerd/containerd.sock`),镜像存储也不共享。切换用户后看到「空环境」是正常现象。
9. **nerdctl 是非核心子项目**,命令与参数缺口较多,脚本里用到冷门参数前先 `nerdctl <command> --help` 确认,不要照搬 docker 的写法。
10. **macOS 上通过 Lima 使用时,`nerdctl` 操作的是虚拟机里的 containerd**,挂载路径、端口、网络都与宿主机不同,不能直接复现 Kubernetes 节点上的行为。
11. 用 `nerdctl save` 导出、再到别处 `load` 时,**默认格式是 Docker 归档**;若目标环境只认 OCI,需要显式 `--format oci`,反过来也一样。格式不匹配时的报错往往很含糊。
12. 升级 nerdctl 的小版本通常安全,但**跨大版本(1.x → 2.x)后命令与配置项有变化**,节点上批量升级前先在测试机验证。

### 相关命令

- `ctr` — containerd 原生 CLI,更底层
- `crictl` — CRI 容器运行时调试工具,按 Pod 维度排障
- `containerd` — nerdctl 背后的运行时
- `podman` — 另一个 Docker 替代品,但不依赖 containerd
- `docker` — 容器管理工具

### 参考链接

- [nerdctl 项目仓库](https://github.com/containerd/nerdctl)
- [nerdctl 命令参考](https://github.com/containerd/nerdctl/blob/main/docs/command-reference.md)
- [nerdctl 配置文件说明](https://github.com/containerd/nerdctl/blob/main/docs/nerdctl.toml.md)
- [containerd 命名空间说明](https://github.com/containerd/nerdctl/blob/main/docs/namespaces.md)
