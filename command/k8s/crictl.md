crictl
===

CRI容器运行时调试命令行工具

## 补充说明

**crictl命令** 是 cri-tools 提供的 CRI(容器运行时接口)调试工具,用来和 containerd、CRI-O 等实现了 CRI 的运行时直接对话。可以把它理解为「kubelet 视角的 docker 命令」。

在 Kubernetes 1.24 移除 dockershim 之后,`docker ps` 再也看不到集群里的容器,`crictl` 成了在节点上排查容器问题的标准手段:容器起不来、镜像拉不动、日志看不到,第一步往往就是 `crictl ps -a`。

crictl 只与 CRI 交互,**不经过 kubelet,也不经过 apiserver**,因此它看到的是运行时的真实状态,而不是 Kubernetes 声称的状态 —— 这正是它排障价值的来源。

### 安装

```shell
# Debian/Ubuntu(cri-tools 包)
sudo apt-get install -y cri-tools

# 或下载预编译二进制(版本号应与集群小版本对齐)
VERSION="v1.31.0"
wget https://github.com/kubernetes-sigs/cri-tools/releases/download/$VERSION/crictl-$VERSION-linux-amd64.tar.gz
sudo tar zxvf crictl-$VERSION-linux-amd64.tar.gz -C /usr/local/bin
rm -f crictl-$VERSION-linux-amd64.tar.gz

# 验证
crictl --version
crictl version
```

### 配置

crictl 需要知道运行时的 socket 地址,默认从 `/etc/crictl.yaml`(也可用 `--config` 指定)读取:

```shell
cat > /etc/crictl.yaml <<'EOF'
runtime-endpoint: unix:///run/containerd/containerd.sock
image-endpoint: unix:///run/containerd/containerd.sock
timeout: 10
debug: false
EOF

# 查看当前生效的配置
crictl config
```

各运行时的 endpoint:

```shell
containerd    unix:///run/containerd/containerd.sock
CRI-O         unix:///var/run/crio/crio.sock
cri-dockerd   unix:///var/run/cri-dockerd.sock
```

临时指定,不写配置文件:

```shell
crictl --runtime-endpoint unix:///run/containerd/containerd.sock ps
```

### 语法

```shell
crictl [global options] command [command options]
```

全局参数:

```shell
--config, -c           客户端配置文件路径,默认 /etc/crictl.yaml
--runtime-endpoint, -r 运行时服务地址
--image-endpoint, -i   镜像服务地址,默认与 runtime-endpoint 相同
--timeout, -t          连接超时,默认 2s
--debug, -D            打开调试日志
--max-retries          连接重试次数,默认 3
```

常用子命令:

```shell
attach        附着到运行中的容器
config        查看或修改 crictl 自身配置
create        创建容器
events        订阅 CRI 事件
exec          在容器内执行命令
imagefsinfo   查看镜像文件系统信息
images        列出镜像
info          查看运行时信息与配置
inspect       查看容器详情
inspecti      查看镜像详情
inspectp      查看 Pod 详情
logs          查看容器日志
pods          列出 Pod(sandbox)
port-forward  把本地端口转发到 Pod
ps            列出容器
pull          拉取镜像
rm            删除容器
rmi           删除镜像
rmp           删除 Pod
run           创建并启动容器
runp          创建并启动 Pod
start         启动已创建的容器
stats         容器资源用量
statsp        Pod 资源用量
stop          停止容器
stopp         停止 Pod
update        更新容器资源限制
version       查看 CRI 版本
```

### 常用操作

```shell
# 列出容器(默认只显示运行中的,-a 显示全部)
crictl ps
crictl ps -a

# 只输出容器 ID
crictl ps -q

# 按容器名过滤
crictl ps --name kube-apiserver

# 列出 Pod sandbox
crictl pods
crictl pods --name coredns

# 先找到 Pod,再列出它下面的所有容器
crictl pods --name coredns-5dd5756b68-abcde -q
crictl ps --pod <pod-id>
```

```shell
# 查看容器日志
crictl logs <container-id>
crictl logs -f <container-id>
crictl logs --since 30m <container-id>
crictl logs -t <container-id>

# 进容器执行命令
crictl exec -it <container-id> sh
crictl exec -it <container-id> cat /etc/resolv.conf
```

```shell
# 查看容器详情
crictl inspect <container-id>
crictl inspect -o json <container-id>
crictl inspectp <pod-id>

# 只取某个字段
crictl inspect -o go-template --template '{{.status.state}}' <container-id>

# 从详情里找出进程 PID
crictl inspect <container-id> | grep -i '"pid"'
```

```shell
# 镜像相关
crictl images
crictl images -q
crictl pull nginx:1.27
crictl inspecti nginx:1.27
crictl rmi nginx:1.27
crictl imagefsinfo
```

```shell
# 资源用量
crictl stats
crictl stats -a
crictl stats <container-id>
crictl statsp
```

```shell
# 版本与运行时信息
crictl version
crictl info

# 确认 cgroup driver 等关键配置是否与 kubelet 一致
crictl info | grep -i cgroup
```

```shell
# 端口转发,不需要 kubectl
crictl port-forward <pod-id> 8080:80
```

### 排障流程

```shell
# 1. 容器状态与退出码
crictl ps -a | grep <pod-name>
crictl inspect <container-id> | grep -A5 '"exitCode"'

# 2. 镜像是否已经拉下来
crictl images | grep <image-name>

# 3. Pod sandbox 是否创建成功(失败通常是 CNI 或 pause 镜像的问题)
crictl pods | grep <pod-name>
crictl inspectp <pod-id>

# 4. 容器日志
crictl logs <container-id>

# 5. 运行时整体状态
crictl info
```

### 注意

1. **crictl 看不到 `ctr` 默认命名空间的容器**。containerd 的 CRI 插件使用 `k8s.io` 命名空间,`ctr -n default` 创建的容器 crictl 完全不可见,反之亦然。这是最容易让人困惑的一点。
2. **不要用 crictl 操作用 kubelet 管理的容器**。`crictl stop` / `crictl rm` 之后 kubelet 会认为容器崩溃并重建,导致重启计数虚高,严重时 Pod 状态与实际不符。要操作 Pod 请用 `kubectl`。
3. 用 `crictl rmp` 删掉 Pod 后 kubelet 会立刻重建它。想让它彻底消失,必须先 `kubectl delete pod` 或 `kubectl cordon` 节点。
4. 不显式配置 endpoint 时,crictl 会依次尝试一组内置的默认地址,官方已将其标记为废弃。连接失败会依次超时,命令响应很慢,生产节点务必写好 `/etc/crictl.yaml`。
5. 默认连接超时只有 **2 秒**,负载较高的节点上容易误报超时;`timeout: 10` 是更稳妥的取值。
6. `crictl ps` 默认只列运行中的容器。排查 CrashLoopBackOff 必须用 `crictl ps -a`,否则容器刚好处于重启间隙时会「什么都看不到」。
7. `crictl pull` 拉的镜像会被 kubelet 的镜像 GC 当作「无 Pod 引用」清理掉。生产环境请通过 Pod 的 `imagePullPolicy` 拉取,`crictl pull` 只适合离线导入和排障验证。
8. crictl 完全绕过 kubelet 与 apiserver,它的操作不产生 Kubernetes 事件,`kubectl describe` 里也查不到痕迹 —— 排查「谁动了这个容器」时别忘了这一点。
9. 更换运行时(containerd → CRI-O)后要同步更新 `/etc/crictl.yaml`,否则工具仍指向旧 socket,报连接被拒。
10. `crictl stats` 的数值直接来自运行时,和 `kubectl top`(来自 metrics-server)不是同一数据源,两者对不上是正常的。
11. crictl 的小版本应与集群小版本对齐,过旧的 cri-tools 会因 CRI API 版本不匹配而报错。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `ctr` — containerd 原生 CLI
- `kubelet` — 节点代理,负责启动 Pod
- `docker` — 容器管理工具

### 参考链接

- [使用 crictl 调试 Kubernetes 节点](https://kubernetes.io/docs/tasks/debug/debug-cluster/crictl/)
- [容器运行时接口 CRI](https://kubernetes.io/docs/concepts/architecture/cri/)
- [容器运行时](https://kubernetes.io/docs/setup/production-environment/container-runtimes/)
- [cri-tools 项目](https://github.com/kubernetes-sigs/cri-tools)
