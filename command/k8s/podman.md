podman
===

无守护进程的容器引擎,可构建与运行容器,并能直接跑 Kubernetes YAML

## 补充说明

**Podman** 是 Red Hat 主导的无守护进程(daemonless)容器引擎,是 Docker 命令行最接近的替代品 —— 绝大多数 `docker` 命令把 `docker` 换成 `podman` 就能用。但它与 Kubernetes 的关系经常被误解,这一点必须先说清楚:

```shell
Podman      容器引擎,面向开发与单机场景,不是 CRI 运行时
CRI-O       Kubernetes 的 CRI 运行时,OpenShift 默认使用
```

**Podman 不能作为 kubelet 的容器运行时**。kubelet 只认 CRI 接口,而实现 CRI 的是 CRI-O 或 containerd,不是 Podman。社区里偶尔出现的「CRIPO」写法通常指的就是 CRI-O,它是与 Podman 同源但完全独立的项目。

Podman 在 Kubernetes 场景里的真实价值是这三件事:

1. **本地构建镜像**,再推送到 registry 供集群拉取;
2. **用 `podman kube play` 直接跑 Kubernetes YAML**,在没有集群的机器上做验证;
3. **作为开发环境**,用 Quadlet 把容器交给 systemd 管理。

Podman、Buildah、Skopeo、CRI-O 同属 containers 项目家族,**共享同一套 `containers/storage` 与 `containers/image` 库**。这意味着在启用了 CRI-O 的节点上,root 身份用 podman 拉取的镜像,CRI-O 往往能直接看到。

### 安装

```shell
# Debian/Ubuntu
sudo apt-get update
sudo apt-get install -y podman

# RHEL / CentOS Stream / Fedora
sudo dnf install -y podman

# 版本
podman --version
podman info
```

```shell
# macOS / Windows 需要先起一台 Linux 虚拟机
podman machine init
podman machine start
podman machine list
```

### 基础命令

与 Docker 的对应关系:

```shell
podman run -d -p 8080:80 nginx:1.27        等价于 docker run
podman ps -a                              列出容器
podman images                             列出镜像
podman pull nginx:1.27                    拉取镜像
podman exec -it <name> sh                 进容器
podman logs -f <name>                     查看日志
podman inspect <name>                     查看详情
podman stats                              资源用量
podman rm -f <name>                       删除容器
podman rmi nginx:1.27                     删除镜像
podman system prune -a                    清理无用资源
```

```shell
# Pod 概念:Podman 原生支持「容器组」
podman pod create --name mypod -p 8080:80
podman run -d --pod mypod nginx:1.27
podman run -d --pod mypod redis:7.2
podman pod ps
podman pod stop mypod
podman pod rm mypod
```

### rootless 模式

Podman 的招牌能力是**默认就可以以普通用户身份运行容器**,靠的是 user namespace 与 subuid/subgid 映射。

```shell
# 查看映射范围(为空则 rootless 起不来)
grep $USER /etc/subuid
grep $USER /etc/subgid

# 追加映射(示例)
sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $USER
podman system migrate

# 在用户命名空间中执行命令
podman unshare cat /proc/self/uid_map

# rootless 下的 --privileged 只是用户命名空间里的 root,不等于宿主机 root
podman run --privileged docker.io/library/alpine:3.20 id
```

rootless 下的常用存储与网络参数:

```shell
# 存储驱动:内核 overlay 不允许非特权用户时自动退化为 fuse-overlayfs
podman info | grep -i -A3 graphDriver

# 网络后端:默认 pasta(旧版本为 slirp4netns)
podman run --network pasta -p 8080:80 docker.io/library/nginx:1.27
```

### 与 Kubernetes 互通

这是 Podman 最值得掌握的进阶用法:**把本地一组容器导出成 Kubernetes YAML,或者反过来把集群里的 YAML 拿到本地跑一遍**。

```shell
# 从运行中的容器/Pod 生成 Kubernetes YAML(旧写法 `podman generate kube` 已废弃)
podman kube generate mypod > mypod.yaml
podman kube generate --service -f mypod.yaml mypod

# 直接用 Kubernetes YAML 在本地起 Pod
podman kube play mypod.yaml
podman kube play --publish 8080:80 mypod.yaml

# 停止并清理
podman kube down mypod.yaml
```

需要清楚 `podman kube play` 只实现了 Kubernetes YAML 的一个**子集**:

```shell
支持   Pod、Deployment、ConfigMap、Secret、PersistentVolumeClaim
不支持 Service、Ingress、RBAC、HPA、NetworkPolicy、CRD 等依赖集群组件的对象
```

### Quadlet 与 systemd

Podman 曾经提供 `podman generate systemd`,该命令**已被废弃**,取而代之的是 Quadlet —— 用声明式单元文件让 systemd 直接管理容器。

```shell
# 单元文件放在这两个目录之一
/etc/containers/systemd/            系统级
~/.config/containers/systemd/       用户级
```

```shell
# ~/.config/containers/systemd/web.container
[Container]
Image=docker.io/library/nginx:1.27
PublishPort=8080:80
Volume=web-data:/usr/share/nginx/html:Z

[Service]
Restart=always

[Install]
WantedBy=default.target
```

```shell
# 加载并启动
systemctl --user daemon-reload
systemctl --user start web
systemctl --user status web
journalctl --user -u web -f
```

`.kube` 单元可以把 `podman kube play` 也交给 systemd:

```shell
# ~/.config/containers/systemd/webapp.kube
[Kube]
Yaml=webapp.yaml
```

### Docker 兼容接口

有些工具只会说 Docker API,这时可以让 Podman 把 socket 暴露出来:

```shell
# 用户级 socket
systemctl --user enable --now podman.socket
export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/podman/podman.sock

# 直接前台提供 API 服务
podman system service --time=0 unix:///tmp/podman.sock
```

注意这是**兼容层而非等价实现**,`docker compose` 之类工具的部分行为仍可能不一致。

### 与 Kubernetes 的兼容性现状

```shell
作为 kubelet 的运行时      不支持,Podman 不实现 CRI
与 CRI-O 共享镜像存储      支持,root 身份的 podman 与 CRI-O 共用 containers/storage
本地验证 k8s YAML          支持,podman kube play 覆盖常用对象子集
rootless 跑 k8s 节点组件   Kubernetes 侧仍是 alpha(KubeletInUserNamespace),需 cgroup v2
macOS / Windows 开发       支持,通过 podman machine 虚拟机
```

Kubernetes 官方的 rootless 节点方案要求 **cgroup v2**(cgroup v1 不支持),需要委派 cgroup 子树,并且 kube-proxy 与网络配置都要另做调整。它适合做实验与开发,不建议作为生产节点的默认形态。

### 注意

1. **Podman 不是 CRI 运行时**。把 `kubelet --container-runtime-endpoint` 指向 Podman 是无效的,节点必须装 containerd 或 CRI-O。搜索时看到的「CRIPO」多半是 CRI-O 的误写。
2. **rootless 与 root 的 storage 是两套**。普通用户 `podman pull` 下来的镜像存在 `~/.local/share/containers`,root 的 `podman` 与 CRI-O 根本看不到。想让节点上的运行时复用,镜像必须由 root 拉取,或老老实实推到 registry 再拉一次。
3. **rootless 容器不能绑定 1024 以下的端口**,除非内核 `net.ipv4.ip_unprivileged_port_start` 已调整。把 rootless 容器直接映射到 80/443 会失败。
4. rootless 下 **`--privileged` 与 `sudo` 都不能用**(sudo 会被 Podman 主动拒绝),需要真实特权时只能切到 root 或在宿主机上操作。
5. **`podman generate kube` 与 `podman generate systemd` 都已废弃**,分别被 `podman kube generate` 与 Quadlet 取代。照着旧博客操作会看到废弃警告。
6. `podman kube play` **不支持的字段会被静默忽略**,不会报错。用集群里的完整 YAML 做本地验证时,不要以为「本地跑通了」就代表线上没问题 —— Service、Ingress 这类对象它压根没处理。
7. **Quadlet 要求 Podman 4.4 以上**(`.kube` 单元需要 4.6 以上),且必须先 `systemctl daemon-reload` 才会生成服务单元。改完单元文件不 reload,`systemctl start` 会找不到服务。
8. **Quadlet 生成的服务名与文件名不同**:`web.container` 对应的服务是 `web.service`,不要直接 `systemctl start web.container`。
9. `podman machine` 出来的虚拟机**默认不暴露任意端口**,从宿主机访问需要额外做端口转发;而且 macOS 上的 `podman machine` 与 Linux 原生行为并不完全一致,别用它复现节点问题。
10. Podman 的 `podman.socket` 只是 Docker API 的兼容层,**不是完整的 Docker 实现**。依赖 Docker 特有行为的工具(部分 CI Runner、部分 compose 特性)仍可能失败。
11. 同一台机器上同时装 Docker 与 Podman,两者的镜像存储完全独立,`docker images` 看不到 `podman images` 的内容,清理磁盘时两个目录都要管。

### 相关命令

- `buildah` — 与 Podman 同源的镜像构建工具
- `skopeo` — 与 Podman 同源的镜像搬运工具
- `docker` — 容器管理工具
- `crictl` — CRI 容器运行时调试工具
- `containerd` — Kubernetes 最主流的容器运行时

### 参考链接

- [Podman 官方文档](https://docs.podman.io/)
- [Podman 项目主页](https://podman.io/)
- [podman-kube-play 手册](https://docs.podman.io/en/latest/markdown/podman-kube-play.1.html)
- [Podman Quadlet 文档](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html)
- [以非 root 用户身份运行 Kubernetes 节点组件](https://kubernetes.io/docs/tasks/administer-cluster/kubelet-in-userns/)
