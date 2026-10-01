ephemeral-containers
===

Kubernetes临时容器:向运行中的Pod注入调试容器

## 补充说明

**临时容器(Ephemeral Container)** 是一种可以注入到**已存在且正在运行**的 Pod 中的特殊容器,专门用于排障。它解决了两个长期痛点:

- 容器镜像里没有 `sh`、`curl`、`ps` 等工具(尤其是 distroless 与 scratch 镜像),`kubectl exec` 进去什么也做不了。
- 容器处于 `CrashLoopBackOff`,进程根本没起来,`kubectl exec` 连都连不进去。

临时容器**自 Kubernetes v1.25 起 GA**,不再是需要开启特性门控的实验功能。

它不是 Pod spec 的一部分,而是通过专门的 `ephemeralcontainers` 子资源添加,因此 **`kubectl edit pod` 无法添加临时容器**;同理,临时容器一旦加入就**不能修改、也不能移除**,只能删掉整个 Pod 重建。

与普通容器的差异:

| 特性 | 普通容器 | 临时容器 |
| --- | --- | --- |
| `resources`(资源限制) | 支持 | 不允许,Pod 的资源配额不可变 |
| `ports`(端口) | 支持 | 不允许 |
| `livenessProbe` / `readinessProbe` | 支持 | 不允许 |
| 自动重启 | 按 `restartPolicy` | 永不重启 |
| 添加方式 | 创建 Pod 时定义 | 运行时通过子资源注入,不写入 `pod.spec` |
| 移除方式 | 修改 spec 或重建 Pod | 无法移除,只能重建 Pod |
| 静态 Pod | 支持 | **不支持** |

正因为不能设置资源限制,临时容器的用量**不纳入 Pod 的 requests/limits,也不参与调度计算**,滥用会悄悄挤占节点资源。

### 语法

```shell
kubectl debug (POD | TYPE[[.VERSION].GROUP]/NAME) [ -- COMMAND [args...] ]
```

`kubectl debug` 三种工作模式:

```shell
kubectl debug  <pod> --image=<img> [--target=<container>]   向运行中的 Pod 注入临时容器
kubectl debug  <pod> --copy-to=<name> --image=<img>         复制出一个新 Pod 再调试
kubectl debug node/<node> -it --image=<img>                  在节点上创建调试 Pod
```

### 注入临时容器

这是最常用的模式,原 Pod 完全不受影响:

```shell
# 最简用法:注入一个 busybox 并立即进入交互式 shell
kubectl debug -it my-app-7d9f8b6c5-abcde --image=busybox

# 为调试容器命名,便于后续 kubectl logs / exec 引用
kubectl debug -it my-app-7d9f8b6c5-abcde --image=busybox -c debugger

# 带命令直接执行,不进入交互
kubectl debug my-app-7d9f8b6c5-abcde --image=busybox -- cat /etc/os-release

# 从文件里定义的 Pod 调试
kubectl debug -f pod.yaml -it --image=busybox

# 跨命名空间
kubectl debug -it my-app-7d9f8b6c5-abcde -n dev --image=busybox
```

### --target:共享目标容器的进程空间

`--target` 指向 Pod 中**已有的某个容器名**,让临时容器加入该容器的进程命名空间。这是排查「容器里有什么进程、进程为什么卡住」的关键:

```shell
# 进入目标容器的进程命名空间,可以看到它的所有进程
kubectl debug -it my-app-7d9f8b6c5-abcde --image=busybox --target=app

# 进去之后可以直接对目标进程操作
ps aux
ls -l /proc/1/root
```

不加 `--target` 时,临时容器拥有**独立的 PID 命名空间**,只能看到自己的进程;若 Pod 本身设置了 `shareProcessNamespace: true`,则所有容器共享进程空间,`--target` 的意义就不大了。

### 调试 profile

`--profile` 决定注入容器拿到哪些 Linux capability,默认 `general`:

```shell
--profile=general     默认,无特权
--profile=baseline    最小权限集
--profile=restricted  比 baseline 更严格
--profile=netadmin    带 NET_ADMIN 等网络相关能力,抓包排障用
--profile=sysadmin    带 SYS_ADMIN、SYS_PTRACE 等,权限最高
```

```shell
# 抓包 / 看网络配置
kubectl debug -it my-app-7d9f8b6c5-abcde --image=nicolaka/netshoot --profile=netadmin

# 需要 SYS_PTRACE 之类的重度调试
kubectl debug -it my-app-7d9f8b6c5-abcde --image=busybox --profile=sysadmin
```

也可以用一个 YAML/JSON 片段自定义 profile:

```shell
kubectl debug -it my-app-7d9f8b6c5-abcde --image=busybox --custom=profile.yaml
```

目标 Pod 整体配置了非 root 用户时,profile 授予的部分 capability 可能无法生效。

### 复制 Pod 调试(--copy-to)

当 Pod 已经崩溃到无法注入临时容器,或者需要改动镜像/命令时,用 `--copy-to` 克隆一个 Pod 出来:

```shell
# 克隆一个新 Pod,并注入调试容器
kubectl debug my-app-7d9f8b6c5-abcde -it --image=busybox --copy-to=my-debugger

# 把原 Pod 的容器镜像整体换成带调试工具的版本
kubectl debug my-app-7d9f8b6c5-abcde --copy-to=my-debugger --set-image=*=busybox

# 只替换指定容器,同时注入一个调试容器
kubectl debug my-app-7d9f8b6c5-abcde -it --copy-to=my-debugger --image=debian --set-image=app=app:debug

# 换回上一个版本的镜像重跑,用于验证「是不是这次发布引入的问题」
kubectl debug my-app-7d9f8b6c5-abcde -it --copy-to=my-debugger --set-image=app=my-app:1.2.3

# 副本调度到同一个节点上(便于对比节点侧因素)
kubectl debug my-app-7d9f8b6c5-abcde -it --copy-to=my-debugger --image=busybox --same-node
```

`--copy-to` 相关的辅助标志:

```shell
--replace            创建副本后删除原 Pod(危险,见「注意」)
--same-node          副本调度到与原 Pod 相同的节点
--share-processes    副本内开启进程命名空间共享,默认 true
--keep-labels        保留原 Pod 的标签
--keep-annotations   保留原 Pod 的注解
--keep-init-containers  运行原 Pod 的 init 容器,默认 true
--keep-liveness      保留存活探针
--keep-readiness     保留就绪探针
--keep-startup       保留启动探针
```

副本默认**不带**原 Pod 的标签与注解,因此不会被 Service 选中,也不会被原控制器接管 —— 这是刻意设计,避免调试副本被误当成业务实例接流量。

### 在节点上调试

`node/` 形式会创建一个运行在**主机命名空间**、并把宿主文件系统挂载到 `/host` 的 Pod,用于排查 kubelet、容器运行时、磁盘等问题:

```shell
# 创建节点调试 Pod 并进入
kubectl debug node/worker-1 -it --image=busybox

# 进去之后:宿主根文件系统在 /host 下
chroot /host
systemctl status kubelet
journalctl -u kubelet -n 50
crictl ps -a
df -h /host/var/lib/kubelet
```

该 Pod 会以 `node-debugger-<节点名>-<随机后缀>` 的形式创建在**当前命名空间**,以特权方式运行,使用完应主动删除:

```shell
kubectl get pods | grep node-debugger
kubectl delete pod node-debugger-worker-1-xxxxx
```

### 查看与清理临时容器

```shell
# 临时容器不在 kubectl get pods 的 READY 列中,但会出现在 describe 里
kubectl describe pod my-app-7d9f8b6c5-abcde | grep -A10 Ephemeral

# 列出临时容器
kubectl get pod my-app-7d9f8b6c5-abcde -o jsonpath='{.spec.ephemeralContainers[*].name}'

# 查看临时容器状态
kubectl get pod my-app-7d9f8b6c5-abcde -o jsonpath='{.status.ephemeralContainerStatuses}'

# 查看临时容器的日志
kubectl logs my-app-7d9f8b6c5-abcde -c debugger

# 重新进入一个已存在的临时容器
kubectl exec -it my-app-7d9f8b6c5-abcde -c debugger -- sh

# 直接操作子资源(手工注入,一般不需要)
kubectl get pod my-app-7d9f8b6c5-abcde -o json > /tmp/pod.json
# 编辑 /tmp/pod.json 中的 ephemeralContainers 后:
kubectl replace --raw /api/v1/namespaces/default/pods/my-app-7d9f8b6c5-abcde/ephemeralcontainers -f /tmp/pod.json
```

临时容器**无法移除**。用完想彻底清掉,只能删除整个 Pod(`kubectl delete pod ...`),由控制器重建一个新的干净 Pod。

### 注意

1. **需要 Kubernetes v1.25 及以上**。1.25 之前需要开启 `EphemeralContainers` 特性门控,而且 `kubectl debug` 当时还是 `kubectl alpha debug`。
2. **临时容器通过 CRI 实现,依赖容器运行时支持**。containerd、CRI-O 等主流 CRI 运行时都支持;已被移除的 dockershim 不支持,老集群若仍在使用它,`kubectl debug` 会直接失败。
3. **静态 Pod 不支持临时容器**。控制平面组件(kube-apiserver、etcd 等)以静态 Pod 运行,无法用 `kubectl debug` 注入,**只能靠节点上的 `crictl` 或日志排查**。
4. **临时容器不能设置 `resources`**,既不受 Pod 的 limit 约束,也不参与调度时的资源核算。在资源紧张的节点上,一个吃内存的调试容器可能把业务 Pod 挤到被驱逐。
5. **临时容器一旦注入就无法移除**,`kubectl edit`、`kubectl apply` 都改不动它。调试完务必删除 Pod 重建,否则它会一直挂在 Pod 里,直到下次重建。
6. **`--copy-to` 创建的是全新 Pod,不是原地调试**。原 Pod 依旧在跑,副本不会被控制器管理,也不会被 Service 选中,所以副本上的行为不一定能复现原 Pod 的问题(尤其是依赖 Service 发现、环境变量注入或 PVC 独占挂载的场景)。
7. **`--replace` 要格外小心**。它会在创建副本后删除原 Pod,原 Pod 的控制器随即再建一个新 Pod 补位,结果是「原 Pod + 副本 + 新建 Pod」的混乱局面;对有状态或用 `ReadWriteOnce` 卷的应用还可能引发卷争抢。
8. **`--target` 指定的容器必须存在**。名字写错会直接报错;而且 `--target` 只共享进程空间,**不共享文件系统**,想读目标容器的文件要写 `/proc/<pid>/root/`。
9. **节点调试 Pod 是特权容器**。它能访问宿主机的文件系统与命名空间,安全风险等同于拿到节点 root,生产集群应限制 RBAC 权限并对这类操作留痕。
10. **临时容器没有 requests,不会改变 HPA 的利用率分母**,但它的实际用量会计入 Pod 的 CPU/内存指标;长期挂着调试容器可能让 HPA 误判为负载升高而扩容。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kubectl-debug` — 早期通过 debug-agent 实现同类能力的插件
- `kubelet` — 节点代理,负责创建临时容器
- `crictl` — 容器运行时调试工具,静态 Pod 排障的替代手段
- `k9s` — 终端下的 Kubernetes 管理 UI

### 参考链接

- [临时容器官方文档](https://kubernetes.io/docs/concepts/workloads/pods/ephemeral-containers/)
- [调试运行中的 Pod](https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/)
- [kubectl debug 命令参考](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_debug/)
- [Pod API 参考(含 EphemeralContainer)](https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/pod-v1/)
- [Kubernetes 调试任务总览](https://kubernetes.io/docs/tasks/debug/)
