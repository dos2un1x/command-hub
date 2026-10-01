ctr
===

containerd原生命令行客户端

## 补充说明

**ctr命令** 是 containerd 自带的命令行客户端,直接与 containerd 的 gRPC 接口通信,不经过 CRI,也不经过 Kubernetes。它比 `crictl` 更底层:镜像、容器、任务、快照、内容块、租约,containerd 的每一层对象都可以直接操作。

`ctr` 的主要用途有两个:一是**离线导入导出镜像**,内网环境批量分发镜像时它几乎是唯一选择;二是**查看 containerd 的真实存储状态** —— 镜像在不在、blob 有没有下全、快照占了多少空间,这些是 `kubectl` 和 `crictl` 都看不到的。

请务必记住一条:**`ctr` 创建的对象 kubelet 一无所知**。用 ctr 跑的容器不受调度、不被回收,也不会出现在 apiserver 里。

### 安装

`ctr` 随 containerd 一起安装,不需要单独获取:

```shell
# 确认 containerd 已安装并运行
containerd --version
sudo systemctl status containerd

# ctr 就在同一个包里
ctr --version
ctr version

# 生成默认配置
sudo containerd config default > /etc/containerd/config.toml
sudo systemctl restart containerd
```

### 全局参数

ctr 的全局参数必须写在子命令**之前**:

```shell
--address, -a    containerd 的 socket 地址,默认 /run/containerd/containerd.sock
--namespace, -n  命名空间,默认 default
--debug          输出调试日志
--timeout        请求超时
```

命名空间是 ctr 最重要的概念,漏掉 `-n k8s.io` 是新手的第一号错误:

```shell
# 列出所有命名空间
ctr namespaces list
ctr ns ls

# Kubernetes 使用的命名空间
ctr -n k8s.io images list

# 默认命名空间,手工操作时用
ctr -n default images list
```

### 语法

```shell
ctr [global options] command [command options]
```

常用子命令:

```shell
namespaces  命名空间管理(list / create / remove)
images      镜像管理(list / pull / push / export / import / tag / remove / check)
containers  容器对象管理(list / create / delete / info)
tasks       运行中的任务(list / start / kill / delete / exec / ps)
snapshots   快照管理(list / usage / tree / info / remove / prepare / commit)
content     内容块(blob)管理(list / get / fetch)
leases      租约管理(list / create / delete)
plugins     插件列表
version     版本信息
events      订阅 containerd 事件
run         创建并启动一个容器
```

### 镜像管理

```shell
# 列出镜像(-n k8s.io 才是 Kubernetes 用的)
ctr -n k8s.io images list
ctr -n k8s.io i ls -q

# 拉取镜像(必须写完整引用,docker.io/library/nginx 不能简写成 nginx)
ctr -n k8s.io images pull docker.io/library/nginx:1.27

# 指定平台
ctr -n k8s.io images pull --platform linux/amd64 docker.io/library/nginx:1.27

# 从私有仓库拉取
ctr -n k8s.io images pull --user admin:password registry.example.com/app:v1

# 使用自定义证书目录
ctr -n k8s.io images pull --hosts-dir /etc/containerd/certs.d registry.example.com/app:v1

# 跳过证书校验(仅用于自签测试环境)
ctr -n k8s.io images pull --skip-verify registry.example.com/app:v1

# 打标签
ctr -n k8s.io images tag docker.io/library/nginx:1.27 registry.example.com/app/nginx:1.27

# 删除
ctr -n k8s.io images remove registry.example.com/app/nginx:1.27

# 校验镜像内容是否完整(局域网传输后必做)
ctr -n k8s.io images check
```

### 离线导入导出

这是 ctr 在运维中最不可替代的用途:

```shell
# 导出为归档文件
ctr -n k8s.io images export --platform linux/amd64 nginx-1.27.tar \
  docker.io/library/nginx:1.27

# 一次导出多个镜像到一个归档
ctr -n k8s.io images export bundle.tar \
  docker.io/library/nginx:1.27 docker.io/library/redis:7.2

# 导入
ctr -n k8s.io images import nginx-1.27.tar

# 只导入内容,不解压快照(更快,首次运行时才展开)
ctr -n k8s.io images import --no-unpack nginx-1.27.tar

# 推送
ctr -n k8s.io images push registry.example.com/app/nginx:1.27
```

### 容器与任务

containerd 里「容器」和「任务」是分开的:容器只是元数据,任务才是真正运行的进程。

```shell
# 列出容器对象
ctr -n default containers list
ctr -n default c ls

# 列出运行中的任务
ctr -n default tasks list
ctr -n default t ls

# 查看容器详情
ctr -n default containers info demo-nginx

# 前台运行一个容器,退出即结束
sudo ctr -n default run --rm -t docker.io/library/alpine:3.20 /bin/sh

# 后台运行并共享主机网络
sudo ctr -n default run -d --net-host docker.io/library/nginx:1.27 demo-nginx

# 查看任务进程
sudo ctr -n default tasks ps demo-nginx

# 进入容器执行命令
sudo ctr -n default tasks exec --exec-id shell1 -t demo-nginx /bin/sh

# 发送信号
sudo ctr -n default tasks kill --signal SIGTERM demo-nginx

# 删除:必须先删任务,再删容器
sudo ctr -n default tasks delete demo-nginx
sudo ctr -n default containers delete demo-nginx
```

### 快照与内容

```shell
# 查看快照(容器的可写层与镜像层)
ctr -n k8s.io snapshots list
ctr -n k8s.io snapshots usage
ctr -n k8s.io snapshots tree

# 查看内容块(镜像 blob)
ctr -n k8s.io content list
ctr -n k8s.io content list | wc -l

# 查看租约,Kubernetes 用它管理镜像的生命周期
ctr -n k8s.io leases list
```

### 插件与诊断

```shell
# 查看已加载的插件(containerd 的插件化架构在这里一目了然)
ctr plugins list

# 查看版本
ctr version

# 订阅事件
ctr events

# 确认 cgroup driver 配置(应与 kubelet 一致)
grep -i systemdcgroup /etc/containerd/config.toml
```

### 注意

1. **不指定 `-n k8s.io` 就看不到任何 Kubernetes 的镜像和容器**。ctr 默认使用 `default` 命名空间,而 CRI 插件用的是 `k8s.io`,两者的存储完全隔离。同理,`crictl` 也看不到 `default` 命名空间里 ctr 创建的东西。
2. **ctr 创建的容器 kubelet 完全不知情**,不会被调度、不会被 GC,也不会上报给 apiserver。反过来,不要在 ctr 里删除 kubelet 管理的容器,那只会触发一轮重建。
3. `-n` 是全局参数,必须写在子命令**前面**。`ctr images list -n k8s.io` 是错的,会被解析成子命令的参数。
4. `ctr run` 默认在前台运行,且**不做端口映射、不配置网络**(除非加 `--net-host`),不适合跑长期服务。要跑服务请交给 Kubernetes。
5. 镜像引用必须写全。`ctr i pull nginx` 会按默认 registry 解析并可能失败,应写成 `docker.io/library/nginx:1.27` 这样的完整形式。
6. 用 `ctr` 拉取但未被任何 Pod 使用的镜像,kubelet 的镜像 GC 会把它清理掉;离线导入后应立即被 Pod 引用,或接受它可能消失。
7. 删除容器前必须先删除对应的任务(`ctr tasks delete`),否则容器删不掉。
8. 修改 `/etc/containerd/config.toml` 后必须 `sudo systemctl restart containerd`。重启 containerd **不会**杀掉运行中的容器 —— 它们由 shim 进程托管,但重启期间 CRI 服务短暂不可用,kubelet 可能上报节点异常。
9. `ctr images export` 默认只导出当前平台的镜像,多架构镜像需要显式加 `--platform`,否则在异构节点上会出现「导入了却跑不起来」。
10. ctr 没有 `docker save` 那样的压缩,导出的 tar 会很大,传输前建议自行 gzip 并校验 `ctr images check`。

### 相关命令

- `crictl` — CRI 容器运行时调试工具
- `kubelet` — 节点代理,负责启动 Pod
- `kubectl` — Kubernetes集群管理工具
- `docker` — 容器管理工具

### 参考链接

- [containerd 官方文档](https://containerd.io/docs/)
- [containerd 项目仓库](https://github.com/containerd/containerd)
- [容器运行时配置](https://kubernetes.io/docs/setup/production-environment/container-runtimes/)
- [使用 crictl 调试 Kubernetes 节点](https://kubernetes.io/docs/tasks/debug/debug-cluster/crictl/)
