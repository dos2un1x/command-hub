kubectl-debug
===

Kubernetes调试插件:借debug-agent在目标节点上启动调试容器

## 补充说明

**kubectl-debug** 是一个 kubectl 插件,用于为一个**已经运行的 Pod** 拉起一个装满调试工具的容器,并让这个容器接入目标容器的网络、进程与 IPC 命名空间。它和 `kubectl exec` 解决的是同一类问题,但不受目标镜像里有没有 `sh`、`curl` 的限制。

它与 kubectl 原生方案的目标一致,实现路径却完全不同:

| 对比项 | `kubectl debug`(原生) | `kubectl-debug`(本插件) |
| --- | --- | --- |
| 实现机制 | 临时容器,经 kubelet/CRI 创建 | debug-agent 直接调用容器运行时 API 创建 |
| 是否写入 API 对象 | 是,写入 `ephemeralContainers` 子资源 | 否,容器完全不经过 kubelet |
| 是否可见 | `kubectl describe pod` 里可见 | `kubectl get pods` 与 describe 都看不到 |
| 版本门槛 | 临时容器自 1.25 起 GA | 无特殊要求 |
| 授权方式 | 服务端 RBAC | 客户端 `SelfSubjectAccessReview` |
| 支持运行时 | 任意 CRI 运行时 | 仅 docker 与 containerd |
| 维护状态 | 官方内置 | 上游已停止维护,仅存社区分支 |

需要提醒的是:原仓库 `aylei/kubectl-debug` 的 README 开头就写着「不再维护,请改用 JamesTGrant 的分支」,而该分支最后一次提交停在 2022 年,README 中也承认「已被 Kubernetes 临时容器大量取代」。**新项目应当优先使用 `kubectl debug`**,本页主要用于维护既有环境时查阅。

### 安装

```shell
# 原版(aylei):macOS
brew install aylei/tap/kubectl-debug

# 原版:直接下载二进制(Linux)
PLUGIN_VERSION=0.1.1
curl -Lo kubectl-debug.tar.gz \
  https://github.com/aylei/kubectl-debug/releases/download/v${PLUGIN_VERSION}/kubectl-debug_${PLUGIN_VERSION}_linux_amd64.tar.gz
tar -zxvf kubectl-debug.tar.gz kubectl-debug
sudo mv kubectl-debug /usr/local/bin/

# 社区分支(JamesTGrant):单文件二进制
curl -Lo kubectl-debug \
  https://github.com/JamesTGrant/kubectl-debug/releases/download/v1.0.0/kubectl-debug
chmod +x kubectl-debug && sudo mv kubectl-debug /usr/local/bin/

# 验证
kubectl plugin list | grep debug
```

**krew 里已经没有这个插件了**。`kubectl krew install debug` 早在 2021 年 4 月就被从 krew-index 中移除,当时给出的理由是「该能力已经并入 kubectl」。现在 krew 上能搜到的 `debug-*` 是另外几个不相干的项目。

部署常驻的 debug-agent(仅原版需要):

```shell
kubectl apply -f https://raw.githubusercontent.com/aylei/kubectl-debug/master/scripts/agent_daemonset.yml

# 查看
kubectl get ds -n default debug-agent
kubectl get pods -n default -l name=debug-agent
```

也可以完全跳过常驻 DaemonSet —— `--agentless` 默认为 `true`,插件会在需要时临时创建一个 debug-agent Pod,用完即删:

```shell
# 强制使用常驻 DaemonSet(需要先部署上面的 agent_daemonset.yml)
kubectl debug --agentless=false <pod-name>
```

### 常用参数

```shell
--image                      调试容器使用的镜像,默认 docker.io/nicolaka/netshoot:latest
-c, --container              目标容器名,缺省时取 Pod 中的第一个容器
-p, --port                   debug-agent 的端口,默认 10027
--debug-config               配置文件路径,默认 ~/.kube/debug-config
--port-forward               通过端口转发访问 agent,默认 true
--agentless, -a              临时创建 agent Pod 而非使用 DaemonSet,默认 true
--agent-image                agent 镜像,默认 aylei/debug-agent:latest
--agent-pull-policy          agent 镜像拉取策略,默认 IfNotPresent
--agent-pod-namespace        agent Pod 所在命名空间,默认 default
--agent-pod-name-prefix      agent Pod 名前缀,默认 debug-agent-pod
--agent-pod-cpu-requests     agent 的资源申请
--agent-pod-memory-requests
--agent-pod-cpu-limits
--agent-pod-memory-limits
--daemonset-name             常驻 agent 的 DaemonSet 名,默认 debug-agent
--daemonset-ns               常驻 agent 所在命名空间,默认 default
--fork                       复制一个 Pod 再调试
--fork-pod-retain-labels     复制 Pod 时保留的标签
--registry-secret-name       拉取私有镜像的 Secret
--registry-secret-namespace
--registry-skip-tls-verify
--enable-lxcfs               使用 lxcfs 提升容器内资源可见性,默认 true
--verbosity, -v              日志级别
-n, --namespace              目标 Pod 所在命名空间
```

注意参数名容易记错:端口参数是 `--port`(短选项 `-p`),**没有** `--agent-port`;配置文件参数是 `--debug-config`,**没有** `--config-file`。

### 基本用法

```shell
# 进入一个 Pod 的调试容器
kubectl debug my-app-7d9f8b6c5-abcde

# 指定命名空间与目标容器
kubectl debug -n dev my-app-7d9f8b6c5-abcde -c app

# 换一个自带更多工具的镜像
kubectl debug my-app-7d9f8b6c5-abcde --image=nicolaka/netshoot

# 进去之后:直连 apiserver、抓包、看目标进程
curl -k https://kubernetes.default.svc/api/v1/namespaces/dev/pods
tcpdump -i eth0 -nn port 80
ps aux
ls -l /proc/1/root/app
```

### 配置文件

默认读取 `~/.kube/debug-config`(社区分支改为 `--configfile`,默认 `/tmp/debugAgentConfigFile`),YAML 格式:

```shell
agentPort: 10027
agentless: true
agentPodNamespace: default
agentPodNamePrefix: debug-agent-pod
agentImage: aylei/debug-agent:latest
debugAgentDaemonset: debug-agent
debugAgentNamespace: default
portForward: true
image: docker.io/nicolaka/netshoot:latest
command: ["bash"]
registrySecretName: kubectl-debug-registry-secret
registrySecretNamespace: default
agentCpuRequests: ""
agentMemoryRequests: ""
agentCpuLimits: ""
agentMemoryLimits: ""
forkPodRetainLabels: []
registrySkipTLSVerify: false
verbosity: 0
```

配置文件适合固定团队内常用的镜像、命令行与资源配额,免去每次敲一长串参数。

### 工作原理

```shell
1. 插件读取目标 Pod,拿到它所在的节点、容器 ID 与容器运行时
2. 按需在该节点上创建一个 debug-agent Pod(或用已有的 DaemonSet)
3. 通过 SPDY 与 agent 建立连接,建立远程 TTY
4. agent 直接调用主机上的 docker / containerd 接口,创建一个「调试容器」
5. 调试容器加入目标容器的 network / pid / ipc 命名空间,并挂上 SYS_PTRACE、SYS_ADMIN 能力
```

第 4 步是关键:调试容器由 agent 直接在运行时里创建,**没有经过 kubelet**,因此它不占用 Pod 的资源配额,也不出现在任何 Kubernetes API 对象里。网络、进程、IPC 三个命名空间共享,意味着可以在调试容器里用 `tcpdump` 看到目标容器的流量,也可以用 `ps` 看到它的进程。

### 注意

1. **上游已经停止维护**。原仓库与社区分支的代码都停留在数年前,README 明确说明该能力已被 Kubernetes 临时容器取代。新环境请直接使用 `kubectl debug`,不要在新项目里引入本插件。
2. **调试容器在 Kubernetes 视角下完全不存在**。它由 agent 直接调用运行时创建,`kubectl get pods`、`kubectl describe pod`、`kubectl top pod` 都看不到它,占用的资源也不受 Pod 的 limits 约束。审计与配额管理都会出现盲区。
3. **授权在客户端完成,这是它与原生方案的实质差异**。插件通过 `SelfSubjectAccessReview` 检查调用者是否具备 `pods/exec` 权限,真正执行创建动作的 debug-agent 却持有节点级别的高权限。也就是说,权限校验发生在你这一侧,而不是服务端。
4. **必须部署特权容器**。debug-agent 的 `securityContext` 是 `privileged: true`,并开启 `hostPID: true`、以 `hostPort` 方式占用 10027 端口。OpenShift 等默认禁止特权容器的集群需要额外放行。
5. **只支持 docker 与 containerd**。代码中对运行时的判断写死了这两种,CRI-O 会直接报错。使用 CRI-O 的集群无法使用本插件。
6. **调试容器需要 `--port-forward` 或节点网络可达**。`--port-forward` 默认为 true,走 apiserver 转发端口,适合大多数场景;关掉它就必须保证你的机器能直连节点的 10027 端口。
7. **默认镜像很大,netshoot 不适合放到生产节点上反复拉取**。镜像拉取时间会直接变成排障时长,建议按团队需要裁剪一个精简镜像并用配置文件固定下来。
8. **`--fork` 会创建一个改过启动命令的 Pod 副本**,它会剥掉原 Pod 的所有标签以免被 Service 选中,并把容器入口替换成 `while true; do sleep 30; done;`。适合排查「启动即崩溃」的场景,但副本不受控制器管理,记得手动清理。
9. **调试容器与目标容器共享网络命名空间,端口会冲突**。在调试容器里监听目标容器已经占用的端口会失败,反过来也一样。
10. **不要把它当作长期方案**。临时容器自 Kubernetes 1.25 起 GA,由 kubelet 创建、走 CRI、有 RBAC 与服务端授权,还支持 `--profile` 精细控制权限,在这几点上都明显优于本插件。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `ephemeral-containers` — 原生方案,使用临时容器调试 Pod
- `crictl` — 容器运行时调试工具
- `kubelet` — 节点代理,原生调试容器的创建者
- `k9s` — 终端下的 Kubernetes 管理 UI

### 参考链接

- [kubectl-debug 原仓库(已停止维护)](https://github.com/aylei/kubectl-debug)
- [kubectl-debug 社区分支](https://github.com/JamesTGrant/kubectl-debug)
- [临时容器官方文档](https://kubernetes.io/docs/concepts/workloads/pods/ephemeral-containers/)
- [kubectl debug 命令参考](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_debug/)
