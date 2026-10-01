hostpath
===

将宿主机文件或目录直接挂载进容器的原生卷类型,危险但常用

## 补充说明

**hostPath** 是 Kubernetes 原生卷类型之一,功能极其直白:把节点上的某个文件或目录,原样挂进容器。它不涉及任何存储系统,也没有供给、绑定、回收这套流程 —— 卷源就是一行路径。

Kubernetes 官方文档对它的评价毫不含糊:**「hostPath 卷有很多安全风险,在大多数场景下都不应该使用」**。原因在于它绕过了 Kubernetes 所有的隔离机制:Pod 能摸到宿主机的真实文件系统,Pod 之间也不再有任何存储边界。

既然如此为什么还在用?因为它解决的是**只有节点本身才知道的信息**这类问题:读取节点的日志目录、访问 `/dev` 下的设备、让 DaemonSet 组件接触宿主机的运行时 socket。这类场景的共性是 **DaemonSet + 每个节点只看自己的数据**,此时 hostPath 是合理选择;而一旦是普通业务 Pod 想「持久化数据」,hostPath 几乎总是错误答案。

**它不是存储方案,而是节点访问机制**。需要持久化请用 `pvc`,需要本地持久化请用 `local-path-provisioner` 或 `openebs` 的 Local PV。

### 语法

```shell
apiVersion: v1
kind: Pod
metadata:
  name: hostpath-demo
spec:
  containers:
    - name: app
      image: nginx:1.27
      volumeMounts:
        - name: host-data
          mountPath: /usr/share/nginx/html
  volumes:
    - name: host-data
      hostPath:
        path: /data/web
        type: DirectoryOrCreate
```

### type 取值

`type` 是 hostPath 最容易被忽略、也最容易导致故障的字段。它决定 kubelet 在挂载前做哪些检查、是否自动创建:

```shell
""              空字符串(默认)。不做任何检查,路径不存在时挂载行为未定义
DirectoryOrCreate  目录存在则直接用;不存在则以 0755 权限、kubelet 属主创建
Directory          目录必须已存在,否则挂载失败
FileOrCreate       文件存在则直接用;不存在则以 0644 权限创建,父目录必须已存在
File               文件必须已存在,否则挂载失败
Socket             UNIX socket 必须已存在
CharDevice         字符设备必须已存在
BlockDevice        块设备必须已存在
```

**留空 `type` 是最常见的写法,也是最糟的写法** —— 它让「路径不存在」从明确的报错变成了难以定位的挂载异常。生产清单里应当总是显式写出类型。

### 常见用途

```shell
# 1. 读取宿主机日志
volumes:
  - name: varlog
    hostPath:
      path: /var/log
      type: Directory

# 2. 让节点级组件访问容器运行时(日志采集器、监控代理)
volumes:
  - name: docker-sock
    hostPath:
      path: /var/run/docker.sock
      type: Socket

# 3. 访问宿主机的设备文件(存储、GPU 相关)
volumes:
  - name: dev
    hostPath:
      path: /dev
      type: Directory

# 4. 访问 kubelet 的目录(CSI node 插件必需)
volumes:
  - name: pods-mount-dir
    hostPath:
      path: /var/lib/kubelet/pods
      type: Directory
```

判断一个 hostPath 用法是否合理,标准是:**这个 Pod 是不是每个节点都要跑一个、且只关心自己所在节点的数据?** 是则合理,否则大概率应该换方案。

一个典型的「合理用法」是这样写的:

```shell
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: log-collector
  namespace: logging
spec:
  selector:
    matchLabels:
      app: log-collector
  template:
    metadata:
      labels:
        app: log-collector
    spec:
      tolerations:
        - operator: Exists            # DaemonSet 要覆盖所有节点
      containers:
        - name: collector
          image: fluent/fluent-bit:3.1
          volumeMounts:
            - name: varlog
              mountPath: /var/log
              readOnly: true          # 采集器只读,降低风险
      volumes:
        - name: varlog
          hostPath:
            path: /var/log
            type: Directory
```

注意这里的三处细节:DaemonSet 而非 Deployment(保证每节点一份)、`readOnly: true`(只读挂载)、显式的 `type: Directory`(路径不存在时立刻报错而不是行为未定义)。

### 与 PodSecurity 的冲突

**PodSecurity 的 `baseline` 与 `restricted` 两级策略都禁止 hostPath 卷**。启用强制 PodSecurity 后,任何带 hostPath 的 Pod 都会被准入控制器直接拒绝:

```shell
# 报错形如
Error from server (Forbidden): error when creating "pod.yaml":
pods "hostpath-demo" is forbidden: violates PodSecurity "baseline:latest":
hostPath volumes (volume "host-data")
```

集群内确实需要 hostPath 的组件(CSI node 插件、日志采集器、监控代理)必须给它所在的命名空间打豁免标签:

```shell
kubectl label namespace kube-system \
  pod-security.kubernetes.io/enforce=privileged \
  pod-security.kubernetes.io/audit=privileged \
  pod-security.kubernetes.io/warn=privileged
```

历史上还有 `PodSecurityPolicy` 的 `allowedHostPaths` 字段可以做路径白名单,但 **PSP 已在 v1.25 被移除**,现在只能靠 PodSecurity Admission 加第三方准入控制器(OPA Gatekeeper、Kyverno)来实现细粒度的路径限制。

### 排查集群中的 hostPath 用量

```shell
# 列出所有使用 hostPath 的 Pod 及其路径
kubectl get pods -A -o json | jq -r '
  .items[] | select(.spec.volumes[]?.hostPath) |
  .metadata.namespace + "/" + .metadata.name + " -> " +
  ([.spec.volumes[] | select(.hostPath) | .hostPath.path] | join(", "))'

# 只关心特权命名空间之外的
kubectl get pods -A -o json | jq -r '
  .items[] | select(.metadata.namespace != "kube-system") |
  select(.spec.volumes[]?.hostPath) |
  .metadata.namespace + "/" + .metadata.name'
```

在准备启用 PodSecurity 或做安全审计前,先用这两条命令摸清家底,否则强制策略上线当天会打挂一批业务。

### 替代方案

```shell
emptyDir              同一 Pod 内容器间共享临时数据,随 Pod 销毁,安全且推荐
configMap / secret    只读配置注入,比挂宿主机的配置文件安全得多
pvc                   真正的持久化存储,受 StorageClass 管理
local-path-provisioner  本地目录但走动态供给,至少按 PVC 做了目录隔离
openebs Local PV      本地盘的「正规军」,有 CRD 管理、有调度约束
csi                   CSI node 插件访问宿主机路径的标准方式
```

一个经验判断:**如果你的 hostPath 是为了「让数据留下来」,那就用错了**;如果是为了「让 Pod 看见节点」,才可能是对的。

### 注意

1. **数据完全不隔离,Pod 迁移后看不到原来的数据**。hostPath 的数据属于节点而非 Pod。Pod 重建后被调度到另一台机器,读到的是一份全新的、空的数据 —— 而且不会有任何报错,应用只是「莫名回到了初始状态」。这是 hostPath 最隐蔽的杀伤方式。
2. **挂载 `/`、`/etc`、`/var/lib/kubelet`、`/var/run/docker.sock` 等于把节点交给容器**。挂载宿主机根目录可以读写节点上任意文件(kubelet 凭据、etcd 数据、其他租户的 Secret 落盘副本);挂载容器运行时 socket 则可以直接在节点上创建特权容器,实现彻底逃逸。**这些路径在多租户集群里是绝对红线**。
3. **PodSecurity 的 `baseline` 与 `restricted` 都禁止 hostPath**,启用强制策略前必须先把存量用法梳理出来并给必要的命名空间打豁免,否则准入会被直接拦下。PSP 移除后,细粒度路径白名单只能靠 Gatekeeper / Kyverno 这类准入控制器实现。
4. **必须手工配合 `nodeSelector` 或 `nodeAffinity`**。hostPath 只表明「挂载本节点的这个路径」,调度器完全不知道数据在哪台机器上。不写节点约束的话,重建后的 Pod 有极大概率落到没有数据的节点上。
5. **`type` 留空时不创建目录,行为不确定**。路径不存在时不同容器运行时的表现可能不同(有的是挂载失败,有的是 kubelet 在宿主机上默默造一个),这类问题几乎没有可读的事件提示,务必显式写类型。
6. **`FileOrCreate` 要求父目录必须已存在**,而且**不会创建多级目录**。写成 `/data/app/config.yaml` 而 `/data/app` 不存在时,创建同样会失败。需要先由 DaemonSet 的初始化逻辑或节点配置管理工具把目录准备好。
7. **多 Pod 挂同一路径会有写冲突**。hostPath 没有任何锁或一致性保证,两个副本同时写同一个日志文件或同一个 SQLite 文件,结果是数据交错甚至损坏。它只适合读,或者「一个节点只有一个 Pod 写」的场景。
8. **不参与 `ResourceQuota` 与 `LimitRange`**。写进这个目录的数据不算在任何 PVC 配额里,节点磁盘被写满时 Kubernetes 的配额体系不会提前拦住 —— 只会以 `DiskPressure` 的形式把所有 Pod 一起驱逐。
9. **`tmpfs` 挂载点上的 hostPath 会随重启消失**。`/tmp`、`/run` 等在某些发行版上是内存文件系统,节点重启即清空。把它们当作持久目录使用是一类典型的「测试环境正常、生产重启丢数据」故障。
10. **SELinux / AppArmor 环境下需要额外处理标签**。启用了 SELinux 的节点(RHEL 系常见)上,宿主机目录的标签与容器进程的域不匹配时,挂载成功但读写被拒绝,排查起来很容易误判为应用权限问题。
11. **hostPath 卷不受 PV/PVC 管理**,既不能动态供给,也不会有 `Retain`/`Delete` 之类的回收策略。删除 Pod 不会删除宿主机上的数据 —— 这既是好处也是隐患,长期运行会积累大量无人认领的目录。
12. **`local-path-provisioner` 内部也用 hostPath 机制,但它比裸 hostPath 安全得多**。至少它按 PVC 做了目录隔离、带 `nodeAffinity`、有动态供给与回收流程。要本地持久化时应该选它而不是手写 hostPath。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `pv` — 手工挂载宿主机目录时配套创建的持久卷
- `pvc` — 持久化的正确入口
- `local-path-provisioner` — 把本地目录包装成动态供给的轻量方案
- `openebs` — 提供 Local PV 的容器原生存储
- `csi` — CSI node 插件正是通过 hostPath 访问节点目录的
- `daemonset` — hostPath 最主要的合理使用场景

### 参考链接

- [hostPath 卷官方文档](https://kubernetes.io/docs/concepts/storage/volumes/#hostpath)
- [本地卷与 hostPath 的取舍](https://kubernetes.io/docs/concepts/storage/volumes/#local)
- [Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/)
- [PodSecurity Admission 迁移指南](https://kubernetes.io/docs/tasks/configure-pod-container/migrate-from-psp/)
