selinux-k8s
===

在 Kubernetes 中配置 SELinux 标签,以及卷标签带来的性能与兼容问题

## 补充说明

**SELinux** 是 Linux 的强制访问控制实现,用**标签**(而不是路径)描述主体与客体。每个进程与文件都带一个安全上下文(security context),形如:

```shell
system_u:system_r:container_t:s0:c123,c456
└─user──┘└─role─┘└─type──┘└─level/MCS─┘
```

四段分别是 **user、role、type、level**。日常打交道最多的是 **type**(决定能访问什么)与 **level** 里的 MCS 类别(用于容器之间互相隔离)。**这也是 Kubernetes 里 `seLinuxOptions` 的四个字段的由来**。

在 Kubernetes 中的配置入口是 **`securityContext.seLinuxOptions`**,Pod 级与容器级都能写,容器级优先。**需要先纠正一个广泛流传的说法**:

```shell
错误说法  "SELinux 与 k8s 的集成在 1.25 之后从注解改成了 securityContext.seLinuxOptions"
          —— Kubernetes 从来没有过 SELinux 注解。

真实情况  1.25 移除的是 seccomp 注解
          (seccomp.security.alpha.kubernetes.io/pod 等),
          与 SELinux 无关。
          seLinuxOptions 一直是唯一的配置入口,只是早期
          教程少、文档分散,给人文案变过的错觉。
```

### 配置

```shell
apiVersion: v1
kind: Pod
metadata:
  name: selinux-demo
spec:
  securityContext:                 # Pod 级,所有容器继承
    seLinuxOptions:
      level: "s0:c123,c456"        # MCS 类别,用于容器间隔离
      type: container_t            # 通常由运行时自动设置,一般不需要写
  containers:
    - name: app
      image: nginx:alpine
      securityContext:             # 容器级,覆盖 Pod 级
        seLinuxOptions:
          user: system_u
          role: system_r
          type: container_t
          level: "s0:c123,c456"
```

字段与含义:

```shell
user     SELinux 用户,通常 system_u
role     角色,通常 system_r
type     SELinux 类型(域);容器默认由运行时选择(如 container_t / svirt_sandbox_file_t)
level    MLS/MCS 级别,容器场景下就是 MCS 类别集合,写成 s0:cN,cM
```

**不给容器指定 label 时,容器运行时会自动为每个容器生成一组不同的 MCS 类别**(`c1,c2` 之类),从而让同一节点上的容器互相看不到对方的文件。这是 SELinux 在容器场景下最有价值的一条默认行为——**大多数情况下你不需要写 `seLinuxOptions`,默认就够用**。

需要覆盖的典型场景只有两类:

```shell
容器要访问宿主机上的特定资源    显式指定 type(如 spc_t 表示不受限的超级特权容器)
调度到同一节点且需要共享文件    显式指定相同的 level
```

### 排障

SELinux 的报错在应用层往往只是 `Permission denied`,必须到节点上看 AVC 日志:

```shell
# 节点状态
getenforce                      # Enforcing / Permissive / Disabled
sestatus

# 查看文件标签
ls -Z /var/lib/kubelet/pods/
ls -Z /var/lib/containers/

# 查看拒绝日志(最有用的一条)
sudo ausearch -m avc -ts recent
sudo ausearch -m avc -ts today | audit2why

# 容器内的进程标签
kubectl exec selinux-demo -- cat /proc/self/attr/current
# system_u:system_r:container_t:s0:c123,c456

# 临时把节点切到 permissive 定位问题(不要在生产长期保留)
sudo setenforce 0
```

如果确认是标签问题,正确的修法是给**文件**打上合适的标签,而不是给容器放开权限:

```shell
# 给宿主机目录设置容器可读的标签,并持久化规则
sudo semanage fcontext -a -t container_file_t "/data/volumes(/.*)?"
sudo restorecon -Rv /data/volumes

# 查看现有规则
sudo semanage fcontext -l | grep /data
```

### 卷标签与 SELinuxMount

当一个卷挂进 Pod 时,卷里的文件必须带上该 Pod 的 SELinux 标签,否则容器读不了。传统做法是 **kubelet 递归地给整个卷重新打标签(relabel)**,文件多时非常慢,而且对 `ReadWriteMany` 卷根本不可行(多个 Pod 要不同标签)。

Kubernetes 的演进方向是**用挂载选项代替递归打标签**:

```shell
SELinuxMountReadWriteOncePod
  alpha 1.25 → beta 1.27 → 1.28 默认启用 → 1.36 GA 并锁定为默认
  只对 ReadWriteOncePod 卷生效

SELinuxChangePolicy
  alpha 1.32 → beta 1.33 → 1.36 GA
  Pod 级字段,值为 Recursive 或 MountOption,用来显式声明走哪条路径

SELinuxMount
  alpha 1.30 → beta 1.33(默认关闭)→ 1.37 起默认启用
  扩展 MountOption 到更多卷类型
```

因为 **`SELinuxMount` 在 1.37 起默认启用**,官方在 2026-04 专门发了博客提醒这可能是一个破坏性变更。判断与应对:

```shell
# 集群里是否还有依赖递归打标签的工作负载(审计用)
kubectl get pods -A -o json | jq -r '
  .items[] | select(.spec.securityContext.seLinuxOptions != null)
  | "\(.metadata.namespace)/\(.metadata.name)"'

# 需要维持旧行为时,在 Pod 上显式声明
spec:
  securityContext:
    seLinuxChangePolicy: Recursive
```

### 与 AppArmor 的对比

```shell
维度          SELinux                        AppArmor
规则模型      标签(type + MCS level)          路径
隔离粒度      进程、文件、端口、能力            主要是文件路径与能力
容器隔离      自动分配 MCS 类别,容器互不可见   无等价机制
绕过的可能    很难(标签不匹配直接拒)          换挂载点可能绕过
复杂度        高,需要策略模块与工具链          低,写路径即可
发行版        RHEL / CentOS / Fedora          Ubuntu / Debian / SUSE
```

SELinux 的 MCS 类别是它在多租户容器场景下的独特价值:**同一节点上的两个容器即使以同一个 UID 运行,也会因为类别不同而互相看不到对方的文件**。AppArmor 没有对应能力。

### 注意

1. **「1.25 之后从注解改为 seLinuxOptions」是错的**。Kubernetes 没有 SELinux 注解。1.25 移除的是 **seccomp** 注解(`seccomp.security.alpha.kubernetes.io/pod`、`container.seccomp.security.alpha.kubernetes.io/<name>`);AppArmor 注解是另一条线(1.30 弃用,替代字段 1.31 GA)。SELinux 的 `seLinuxOptions` 从早期版本就是唯一入口。看到把这三者混为一谈的文章,其余内容也需要重新核对。
2. **节点必须是 SELinux 启用状态,而且通常是 Enforcing**。`getenforce` 返回 `Disabled` 时,写多少 `seLinuxOptions` 都不会有任何效果——**静默失效**。RHEL/CentOS/Fedora 系默认启用 SELinux;Ubuntu/Debian 系默认用 AppArmor,**两者互斥**,不要把 SELinux 的配置照搬到 Ubuntu 节点上。
3. **容器的 `type` 一般不要手写**。容器运行时(containerd/CRI-O)会为容器选择正确的域与 MCS 类别。手工写死 `container_t` 往往与运行时的默认一致却失去了 MCS 隔离;真正需要放松时才考虑 `spc_t`(super privileged container type),但那等于放弃 SELinux 保护。
4. **`seLinuxOptions` 只管进程标签,不管卷的标签**。挂载卷的标签由 kubelet 与 CSI 驱动按 `seLinuxChangePolicy` 的规则处理。以为「在 Pod 里写了 level 就能让容器访问挂载目录」是常见误解——目录本身的标签不匹配照样被拒。
5. **递归打标签在大卷上会让你输错密码**。几万个文件的卷每次挂载都 relabel,挂载时间可能到分钟级,Pod 启动超时。这正是 `SELinuxMount` 要解决的问题,升级到 1.37 前先评估手上有没有这类卷。
6. **`SELinuxMount` 在 1.37 默认开启是破坏性变更**。开启后卷以 `context=` 挂载选项方式打标签,依赖「卷内文件标签」的工作负载可能行为改变。官方建议在 1.36 就完成审计,并用 `seLinuxChangePolicy: Recursive` 给需要旧行为的 Pod 显式逃生。
7. **`ReadWriteMany` 卷与递归打标签天然冲突**。多个 Pod 需要不同 MCS 标签时,递归 relabel 无法同时满足。用 RWX 卷的工作负载要么统一标签,要么走 MountOption 路径。
8. **排障永远先看 AVC 日志**。应用层只报 `Permission denied`,和普通权限错误无法区分。`ausearch -m avc -ts recent` 是定位 SELinux 问题的第一现场;`audit2why` 会把原始拒绝翻译成人话。
9. **`setenforce 0` 只是临时手段**。切到 permissive 后 SELinux 只记录不拦截,能快速验证「是不是 SELinux 的问题」,但**不要把它当成修复**——重启或策略重载就可能回到 enforcing,而且期间没有任何保护。
10. **修改标签要用 `semanage fcontext` + `restorecon`,不要用 `chcon`**。`chcon` 直接改文件的当前标签,遇到 `restorecon` 或策略重载就会被还原。持久化规则必须写进 fcontext。
11. **OpenShift 用 SCC 自动分配标签**。在 OpenShift 上不要手工写 `seLinuxOptions`,它由 SecurityContextConstraints 统一下发,手写反而会与 SCC 冲突导致 Pod 被拒。这也是同一份 YAML 在原生 k8s 能跑、在 OpenShift 上跑不了的原因之一。
12. **它和 seccomp、AppArmor 是互补的三层**。seccomp 管「能用哪些系统调用」,AppArmor/SELinux 管「能访问哪些对象」。`restricted` 级别的 Pod Security Standards 强制要求 seccomp,但不强制 SELinux——所以**没写 `seLinuxOptions` 不等于没有 SELinux 保护**,运行时的默认标签仍在生效。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `seccomp` — 系统调用过滤
- `apparmor` — 另一套强制访问控制(与 SELinux 互斥)
- `securitycontext` — seLinuxOptions 所在的字段组
- `pod-security-admission` — 准入阶段的策略拦截
- `pvc` — 卷标签问题的高发场景
- `csi` — 卷挂载与标签处理的落点
- `openshift` — SCC 自动分配 SELinux 标签的平台

### 参考链接

- [为容器分配 SELinux 标签](https://kubernetes.io/docs/tasks/configure-pod-container/security-context/)
- [SELinux 卷标签变更进入 GA 阶段(Kubernetes 博客)](https://kubernetes.io/blog/2026/04/22/breaking-changes-in-selinux-volume-labeling/)
- [KEP-1710: SELinux Mount](https://github.com/kubernetes/enhancements/tree/master/keps/sig-storage/1710-selinux-relabeling)
- [SELinux 项目文档](https://selinuxproject.org/page/Main_Page)
- [Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/)
