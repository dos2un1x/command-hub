securitycontext
===

Pod与容器级安全上下文,控制运行用户、能力与权限

## 补充说明

**SecurityContext** 不是一条命令,而是 Pod 清单里的两组字段,决定容器以什么身份、带着哪些权限运行。它是 Kubernetes 安全加固的落点 —— Pod Security Standards、各类准入策略最终检查的都是这些字段。

两个位置,职责不同:

| 位置 | 字段名 | 作用范围 |
| --- | --- | --- |
| Pod 级 | `spec.securityContext` | Pod 内**所有**容器共享 |
| 容器级 | `spec.containers[].securityContext` | 仅该容器 |

字段划分(决定你该往哪一层写):

```shell
仅 Pod 级可写   fsGroup、fsGroupChangePolicy、supplementalGroups、
                supplementalGroupsPolicy、sysctls
仅容器级可写    allowPrivilegeEscalation、capabilities、privileged、
                readOnlyRootFilesystem、procMount
两级都可写      runAsUser、runAsGroup、runAsNonRoot、seccompProfile、
                seLinuxOptions、appArmorProfile
```

两级都可写的字段,**容器级覆盖 Pod 级**;仅 Pod 级的字段在所有容器上生效,无法单独覆盖。

### 语法

```shell
spec:
  securityContext: { ... }              # PodSecurityContext
  containers:
  - name: <名称>
    securityContext: { ... }            # SecurityContext
```

### Pod 级完整示例

```shell
apiVersion: v1
kind: Pod
metadata:
  name: security-context-demo
spec:
  securityContext:                 # 对 Pod 内所有容器生效
    runAsUser: 1000                # 有效 UID
    runAsGroup: 3000               # 有效主 GID
    runAsNonRoot: true             # 强制非 root 启动
    fsGroup: 2000                  # 挂载卷的属组
    supplementalGroups: [4000]     # 附加组
    seccompProfile:
      type: RuntimeDefault
  containers:
  - name: sec-ctx-demo
    image: busybox:1.28
    command: ["sh", "-c", "id && sleep 1h"]
    securityContext:
      allowPrivilegeEscalation: false
      capabilities:
        drop: ["ALL"]
      readOnlyRootFilesystem: true
    volumeMounts:
    - name: data
      mountPath: /data/demo
  volumes:
  - name: data
    emptyDir: {}
```

运行结果:`id` 返回 `uid=1000 gid=3000 groups=2000,3000,4000` —— `gid` 来自 `runAsGroup`,组列表则合并了 `fsGroup`、`supplementalGroups` 与镜像 `/etc/group` 中的组。

### 运行身份

```shell
runAsUser    容器内进程的 UID
runAsGroup   容器内进程的主 GID;不写则主 GID 为 0(root)
runAsNonRoot 布尔值,要求有效用户不能是 root
```

与镜像 `USER` 指令的优先级关系容易记混:

```shell
未设置 runAsUser        →  用镜像 USER 指定的用户;镜像没写 USER 则用 root(0)
设置了 runAsUser        →  覆盖镜像 USER,容器级的值优先于 Pod 级
```

`runAsNonRoot: true` 是对**有效用户**的校验,不是对镜像 `USER` 的字符串检查:

- `runAsUser: 0` 与 `runAsNonRoot: true` 同时存在,**准入阶段直接拒绝**。
- 没写 `runAsUser`,但镜像 `USER` 解析出来是 root(或写成用户名而无法判定为数字),kubelet 会**拒绝启动容器**,报 `container has runAsNonRoot and image will run as root`。
- 镜像 `USER` 只影响 UID,不影响 GID —— 这就是省略 `runAsGroup` 时主 GID 仍是 0 的原因。

### 卷权限

```shell
fsGroup                    挂载的卷(以及新建文件)归属到该 GID
fsGroupChangePolicy        OnRootMismatch(默认,仅在属主不符时递归改) / Always
supplementalGroups         进程的附加组列表
supplementalGroupsPolicy   Merge(默认,合并镜像 /etc/group) / Strict(仅用显式列表)
```

大卷上 `fsGroup` 的递归 chown 会造成明显的挂载延迟,这时应改用 `fsGroupChangePolicy: OnRootMismatch`,或让 CSI 驱动接管属主设置。

### Linux 能力(capabilities)

```shell
securityContext:
  capabilities:
    drop: ["ALL"]            # 先丢掉全部
    add: ["NET_BIND_SERVICE"]  # 只加回确实需要的那一个
```

语义要点:

- `drop` 与 `add` **不对称** —— `add` 只能加回 `drop` 之后仍在「可加白名单」内的能力,不能凭空获得宿主机不允许的能力。
- 不写 `capabilities` 时,容器默认持有 Docker/CRI 运行时给的那一份默认能力集(包含 `CHOWN`、`SETUID`、`NET_RAW` 等),远比多数应用需要的多。
- `capabilities` **只有容器级**,Pod 级写不了。要批量统一,只能逐个容器写或用准入策略注入。
- 加了 `privileged: true` 就等同于拿到**全部**能力,此时 `drop` 形同虚设。

### 提权与只读根文件系统

```shell
allowPrivilegeEscalation    默认 true,对应内核的 no_new_privs 取反
privileged                  特权容器,几乎等同于宿主机 root
readOnlyRootFilesystem      根文件系统只读
procMount                   Default / Unmasked(仅特权场景)
```

- `allowPrivilegeEscalation: false` 是 `restricted` 基线的硬性要求,它阻止 setuid/setgid 程序与文件能力提升权限。
- `allowPrivilegeEscalation: false` **不能**与 `privileged: true` 或 `CAP_SYS_ADMIN` 共存,同时设置会被拒绝。
- `readOnlyRootFilesystem: true` 常被忽略的一点是:应用若需要写临时目录,要显式挂一个 `emptyDir` 到 `/tmp`,否则容器启动即崩。

### seccomp、AppArmor 与 SELinux

```shell
seccompProfile:
  type: RuntimeDefault        # 推荐;运行时默认过滤危险系统调用
  # type: Localhost
  # localhostProfile: profiles/audit.json   # 需先放到 kubelet 的 seccomp 目录
appArmorProfile:
  type: RuntimeDefault        # 新版字段;旧写法是注解 container.apparmor.security.beta.kubernetes.io/*
seLinuxOptions:
  level: "s0:c123,c456"
  type: container_t
```

seccomp 与 AppArmor 都可在 Pod 级或容器级设置,容器级覆盖 Pod 级。`seccompProfile` 留空**不等于**安全 —— 留空表示不做 seccomp 过滤(等价于 `Unconfined`),这恰好是 `restricted` 会拒绝的写法。

### 一份 restricted 合规的最小片段

```shell
spec:
  securityContext:
    runAsNonRoot: true
    seccompProfile:
      type: RuntimeDefault
  containers:
  - name: app
    image: registry.example.com/app@sha256:xxxx
    securityContext:
      allowPrivilegeEscalation: false
      capabilities:
        drop: ["ALL"]
      readOnlyRootFilesystem: true
```

### 查看生效值

```shell
# 看 Pod 上实际记录的安全上下文字段
kubectl get pod <pod> -o jsonpath='{.spec.securityContext}'
kubectl get pod <pod> -o jsonpath='{.spec.containers[*].securityContext}'

# 进容器验证有效身份与能力
kubectl exec -it <pod> -- id
kubectl exec -it <pod> -- cat /proc/1/status | grep -E 'Uid|Gid|CapEff'
kubectl exec -it <pod> -- cat /proc/self/status | grep NoNewPrivs

# 用服务端 dry-run 预检会不会被 PSA 拦
kubectl apply --dry-run=server -f pod.yaml
```

`CapEff` 是一串十六进制位掩码,`0000000000000000` 表示能力已被全部丢弃;`NoNewPrivs: 1` 说明 `allowPrivilegeEscalation: false` 已生效。

### 注意

1. **Pod 级字段不是「默认值」,而是对全部容器的强制约束**。`spec.securityContext.runAsUser` 会让 Pod 内每个容器都以该 UID 运行,包括你可能没意识到的 sidecar;想只改一个容器,就写到容器级。
2. **容器级只能覆盖「两级都可写」的字段**。在容器里写 `fsGroup` 或 `supplementalGroups` 会被 API 校验直接拒绝 —— 它们不属于容器级 SecurityContext。
3. **`runAsNonRoot: true` 拦不住镜像里的 root 用户组**。它只管 UID,`fsGroup: 0` 或 `runAsGroup: 0` 依然合法,而 root 组本身就能读写不少文件。
4. **`runAsUser` 改的是进程身份,不改文件属主**。挂载卷里的文件若属主是 root 且权限为 `0600`,改了 UID 反而会让应用读不到文件 —— 这类问题要靠 `fsGroup` 或 initContainer 预先 chown 解决。
5. **`allowPrivilegeEscalation` 默认是 `true`**。不写就等于允许,这是 `restricted` 里最常被判违规的一条。
6. **`allowPrivilegeEscalation: false` 与 `privileged: true`、`CAP_SYS_ADMIN` 互斥**,同时写会被 API Server 拒绝,报错信息指向 no_new_privs。
7. **`capabilities.add` 不是任意加**。加回 `SYS_ADMIN` 之类的宽泛能力会同时破坏 `baseline` 与 `restricted`;`NET_RAW` 虽在 `baseline` 白名单外,却是很多网络工具的必需项,需按实际评估。
8. **`readOnlyRootFilesystem: true` 需要配套可写目录**。Java 的临时目录、Nginx 的缓存路径、Python 的 `__pycache__` 都会因根文件系统只读而失败,需显式挂载 `emptyDir`。
9. **`seccompProfile` 不写等于不限制**。这与「不写就用运行时的默认 seccomp」是两回事,部分运行时的默认 profile 本身就是 `Unconfined`。
10. **改了 SecurityContext 必须重建 Pod**。这些字段不可原地修改,`kubectl apply` 之后要等滚动更新完成才生效,直接 `kubectl edit` 会报 `field is immutable`。
11. **特权容器会架空以上全部设置**。`privileged: true` 的容器可以访问宿主机设备、修改内核参数,任何 `drop`/`readOnlyRootFilesystem` 都失去意义,这类容器应有独立的命名空间与准入约束。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `pod` — Pod 管理与调试
- `pod-security-admission` — 按命名空间强制安全基线
- `serviceaccount` — 服务账户与 Pod 身份
- `networkpolicy` — 网络访问控制

### 参考链接

- [为 Pod 或容器配置安全上下文](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/)
- [SecurityContext API 参考](https://kubernetes.io/docs/reference/generated/kubernetes-api/v1.37/#securitycontext-v1-core)
- [Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/)
- [Linux 内核能力(capabilities)说明](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/#set-capabilities-for-a-container)
- [Seccomp 与 Pod 安全](https://kubernetes.io/docs/tutorials/security/seccomp/)
