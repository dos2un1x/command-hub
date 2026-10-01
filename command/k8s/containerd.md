containerd
===

Kubernetes 集群最主流的容器运行时,负责镜像拉取、容器创建与生命周期管理

## 补充说明

**containerd** 是一个符合 OCI 标准的容器运行时,最初从 Docker 中拆分出来,现在是 CNCF 的毕业项目。在 Kubernetes 移除 dockershim 之后,containerd 与 CRI-O 一起成为绝大多数集群的实际运行时 —— kubeadm 生成配置时默认就选它。

理解 containerd 与 Kubernetes 的关系,关键是分清三层:

```shell
kubelet              节点代理,通过 CRI(gRPC)调用运行时
containerd           运行时本体,实现 CRI 插件,管理镜像与容器
runc / shim          真正调用 clone() 起进程的那一层
```

kubelet 从不直接操作容器,它只会对 containerd 的 CRI 服务发号施令:「把 `nginx:1.27` 拉下来」「给我创建一个 Pod sandbox」「启动这个容器」。containerd 收到请求后,再通过 containerd-shim + runc 把进程拉起来。

本页讲的是 **containerd 本体如何配置与运维**。镜像与容器的日常查看、离线导入导出请分别看 `ctr` 页和 `crictl` 页。

### 安装

```shell
# Debian/Ubuntu(官方 Docker 仓库中的 containerd.io 包)
sudo apt-get update
sudo apt-get install -y containerd.io

# 生成默认配置(这一步不能省,/etc/containerd/config.toml 默认不存在)
sudo mkdir -p /etc/containerd
containerd config default | sudo tee /etc/containerd/config.toml

# 启用并启动
sudo systemctl enable --now containerd
sudo systemctl status containerd

# 版本
containerd --version
```

### 配置文件

配置文件默认位于 `/etc/containerd/config.toml`。它有一个**版本头**,不同大版本写法完全不同,这是升级时最容易出错的地方:

```shell
version = 2    containerd 1.x 使用(插件 ID 形如 io.containerd.grpc.v1.cri)
version = 3    containerd 2.x 推荐(插件 ID 形如 io.containerd.cri.v1.runtime)
version = 1    containerd 2.0 中已移除
```

两个最常用的自检命令:

```shell
# 输出内置的默认配置(用于对比自己改了什么)
containerd config default

# 输出合并了当前配置后的完整结果(排查时看这个更准)
containerd config dump

# 只看某个插件
containerd config dump | grep -A20 'cri.v1.runtime'
```

### CRI 插件

kubelet 能不能连上 containerd,取决于 CRI 插件有没有被加载。按插件 ID 的写法分成两代:

```shell
containerd 1.x   [plugins."io.containerd.grpc.v1.cri"]
containerd 2.x   [plugins."io.containerd.cri.v1.runtime"]    运行时部分
                 [plugins.'io.containerd.cri.v1.images']     镜像部分
```

确认插件确实起来了:

```shell
# CRI 插件应显示为 ok
sudo ctr plugins ls | grep -i cri

# 运行时 socket 是否存在
ls -l /run/containerd/containerd.sock

# 用 crictl 做一次端到端验证
crictl --runtime-endpoint unix:///run/containerd/containerd.sock info
```

kubelet 侧的对应参数:

```shell
# /var/lib/kubelet/kubeadm-flags.env 中通常长这样
--container-runtime-endpoint=unix:///run/containerd/containerd.sock
```

### cgroup 驱动

containerd 与 kubelet 的 cgroup 驱动必须一致,否则节点会出现 Pod 起不来、资源限制不生效等诡异问题。驱动由 runc 的 `SystemdCgroup` 决定:

```shell
# containerd 2.x(config version 3)
[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runc.options]
  SystemdCgroup = true
```

```shell
# containerd 1.x(config version 2)
[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc.options]
  SystemdCgroup = true
```

kubelet 侧对应 `/var/lib/kubelet/config.yaml`:

```shell
cgroupDriver: systemd
```

`containerd config default` 生成的默认值是 `SystemdCgroup = false`,而 kubeadm 生成的 KubeletConfiguration 默认是 `systemd`,两者**天生不一致**,必须手动改。改完重启:

```shell
sudo systemctl restart containerd
sudo systemctl restart kubelet
```

### 镜像仓库与加速

containerd 的镜像仓库配置在 1.x 与 2.x 里也是两代写法。**推荐使用 `config_path` 的目录式配置**,它一项配置就能同时覆盖镜像加速、私有仓库、CA 证书与自签场景:

```shell
# containerd 2.x
[plugins.'io.containerd.cri.v1.images'.registry]
  config_path = "/etc/containerd/certs.d"
```

```shell
# containerd 1.x
[plugins."io.containerd.grpc.v1.cri".registry]
  config_path = "/etc/containerd/certs.d"
```

目录结构按 **registry 主机名** 划分,每个目录里放一个 `hosts.toml`:

```shell
/etc/containerd/certs.d/
├── docker.io/
│   └── hosts.toml
└── harbor.example.com/
    ├── hosts.toml
    └── ca.crt
```

`docker.io` 的镜像加速示例:

```shell
server = "https://docker.io"

[host."https://docker.m.daocloud.io"]
  capabilities = ["pull", "resolve"]
```

私有仓库配自签 CA:

```shell
server = "https://harbor.example.com"

[host."https://harbor.example.com"]
  capabilities = ["pull", "resolve", "push"]
  ca = "/etc/containerd/certs.d/harbor.example.com/ca.crt"
```

仓库只提供 HTTP(没有 TLS)时的写法 —— 把 `server` 写成 `http://`:

```shell
server = "http://registry.example.com:5000"

[host."http://registry.example.com:5000"]
  capabilities = ["pull", "resolve"]
```

旧的 `registry.mirrors` / `registry.configs` 写法已被标记为废弃,**只在不配置 `config_path` 时才生效**,两者同时出现会直接报错。

### pause 镜像

每个 Pod 都会先起一个 sandbox 容器,用的就是 pause 镜像。它拉不下来时,Pod 会一直卡在 `ContainerCreating`,而业务容器的日志里什么都看不到。

```shell
# containerd 2.x
[plugins.'io.containerd.cri.v1.images'.pinned_images]
  sandbox = 'registry.k8s.io/pause:3.10.2'
```

```shell
# containerd 1.x
[plugins."io.containerd.grpc.v1.cri"]
  sandbox_image = "registry.k8s.io/pause:3.9"
```

离线环境务必提前把 pause 镜像同步进内网仓库,或在每个节点上导入。

### 日常运维

```shell
# 服务状态与日志
sudo systemctl status containerd
sudo journalctl -u containerd -n 200 --no-pager
sudo journalctl -u containerd -f

# 查看存储占用(k8s.io 命名空间才是 Kubernetes 的数据)
sudo ctr -n k8s.io content list | wc -l
sudo ctr -n k8s.io snapshots usage

# 查看 containerd 自己的内存与连接
sudo ctr version
sudo ctr plugins ls

# 重载配置(修改 config.toml 后)
sudo systemctl restart containerd
```

### 升级注意

containerd 1.x 升 2.x 是一次**配置格式的大改**,不能直接把旧的 `config.toml` 拿过去用:

```shell
# 1. 备份旧配置
sudo cp /etc/containerd/config.toml /etc/containerd/config.toml.bak

# 2. 升级二进制
sudo apt-get update && sudo apt-get install -y containerd.io

# 3. 重新生成默认配置,再按需改回自定义项
containerd config default | sudo tee /etc/containerd/config.toml

# 4. 重启并验证 CRI 插件
sudo systemctl restart containerd
sudo ctr plugins ls | grep -i cri
kubectl get nodes
```

### 注意

1. **`disabled_plugins` 里包含 CRI 插件会导致 kubelet 完全起不来**,报 `failed to get container runtime` 或 `connection refused`。1.x 时代常见写法是 `disabled_plugins = ["cri"]`,升级时若把旧配置整份复制过来,CRI 服务就不会启动。判断方法永远是 `ctr plugins ls | grep cri`,而不是靠读配置猜。
2. **`SystemdCgroup` 必须与 kubelet 的 `cgroupDriver` 一致**。containerd 默认生成 `false`(cgroupfs),kubeadm 默认给 kubelet 的是 `systemd`。不一致时典型症状是 `failed to create containerd task: ... cgroup ...: no such file or directory`,或 Pod 反复重启。改完 containerd 必须重启 **containerd 和 kubelet 两个服务**。
3. `/etc/containerd/config.toml` **默认不存在**。没跑过 `containerd config default > /etc/containerd/config.toml` 就直接编辑,会误以为「配置改了却不生效」—— 实际上 containerd 一直在用内置默认值。
4. 修改 `config.toml` 后必须 `sudo systemctl restart containerd`。**重启 containerd 不会杀掉运行中的容器**(进程由 containerd-shim 托管),但重启窗口内 CRI 服务不可用,大量 Pod 可能被 kubelet 上报为异常,生产环境要错峰操作。
5. containerd **2.x 的插件 ID 变了**。把 1.x 的 `[plugins."io.containerd.grpc.v1.cri"...]` 段原样贴进 `version = 3` 的配置里不会报错,但也不会生效 —— 镜像加速、pause 镜像这类配置会「静默失效」,是最难查的一类问题。
6. 使用旧写法 `registry.mirrors` 的同时又配置了 `registry.config_path`,containerd **会直接启动失败**,而不是以某一个为准。迁移时务必二选一。
7. 私有仓库的凭据**不来自 containerd 配置**,而是来自 Pod 的 `imagePullSecrets`(kubelet 从 apiserver 取到后通过 CRI 传给 containerd)。在 containerd 侧配 `--user` 只对 `ctr` 手工拉取有效,对 kubelet 无效。
8. 自签证书的仓库必须把 CA 放到 `/etc/containerd/certs.d/<host>/ca.crt` 并在 `hosts.toml` 中通过 `ca =` 引用。只把 CA 装进系统信任库(`update-ca-certificates`)**不一定管用**,containerd 走的是自己那套证书目录。
9. `containerd config default` 的输出是**内置模板**,不是当前生效配置。想确认实际生效值请用 `containerd config dump`。
10. containerd 的 `content`、`snapshot` 数据默认放在 `/var/lib/containerd`,**这个目录会持续增长**。kubelet 的镜像 GC 只清理 `k8s.io` 命名空间下无引用的镜像,手工用 `ctr` 导入的内容不会被回收,需要定期检查。
11. 换用 containerd 后要同步更新 `/etc/crictl.yaml` 的 socket 地址,否则 `crictl` 仍会去连旧运行时的地址并卡在超时上。

### 相关命令

- `crictl` — CRI 容器运行时调试工具
- `ctr` — containerd 原生 CLI
- `nerdctl` — containerd 的 Docker 兼容客户端
- `kubelet` — 节点代理,通过 CRI 调用运行时
- `harbor` — 常与 containerd 搭配的私有镜像仓库

### 参考链接

- [containerd 官方文档](https://containerd.io/docs/)
- [CRI 插件配置指南](https://containerd.io/docs/2.3/cri/config/)
- [containerd 项目仓库](https://github.com/containerd/containerd)
- [容器运行时配置(Kubernetes)](https://kubernetes.io/docs/setup/production-environment/container-runtimes/)
