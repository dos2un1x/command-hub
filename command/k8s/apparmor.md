apparmor
===

基于路径的强制访问控制,Kubernetes 中通过 securityContext.appArmorProfile 配置

## 补充说明

**AppArmor** 是 Linux 的强制访问控制(MAC)模块,思路是**给进程绑定一份策略,规定它能读哪些路径、能写哪些路径、能用哪些能力**。和 SELinux 用标签描述对象不同,AppArmor 直接用**路径**做规则,因此它的策略更直观、学习成本更低,代价是路径改名或挂载点变化就可能绕过规则。

它是 Ubuntu、Debian、SUSE 系发行版的默认 MAC(这些发行版上 SELinux 通常没启用),**AppArmor 与 SELinux 在同一节点上只能二选一**——所以「能不能用 AppArmor」是节点决定的,不是集群决定的。

在 Kubernetes 里配置的字段是 **`securityContext.appArmorProfile`**,自 **v1.31 起 stable**(对应的特性门控已移除)。v1.30 之前只能用 Pod 注解,那条路径已弃用。

### 字段结构

```shell
RuntimeDefault  使用运行时默认 profile(containerd 下通常是 cri-containerd.apparmor.d)
Localhost       使用节点上已加载的 profile,用 localhostProfile 指定
Unconfined      不做 AppArmor 限制
```

注意 **`localhostProfile` 填的是 profile 的名字,不是路径**:这一点与 seccomp 的 `localhostProfile`(相对路径)不同,是本页最容易写错的地方。

```shell
apiVersion: v1
kind: Pod
metadata:
  name: hello-apparmor
spec:
  securityContext:                       # Pod 级
    appArmorProfile:
      type: Localhost
      localhostProfile: k8s-apparmor-example-deny-write
  containers:
    - name: hello
      image: busybox:1.28
      command: ["sh", "-c", "echo ok && sleep 1h"]
      securityContext:                   # 容器级,优先于 Pod 级
        appArmorProfile:
          type: RuntimeDefault
```

### 节点准备

```shell
# 1) 节点内核是否启用了 AppArmor
cat /sys/module/apparmor/parameters/enabled
# Y

# 2) 列出已加载的 profile
sudo cat /sys/kernel/security/apparmor/profiles | sort
# cri-containerd.apparmor.d (enforce)
# docker-default (enforce)
# k8s-apparmor-example-deny-write (enforce)

# 3) 写一个策略文件并加载
sudo tee /etc/apparmor.d/k8s-apparmor-example-deny-write >/dev/null <<'EOF'
#include <tunables/global>

profile k8s-apparmor-example-deny-write flags=(attach_disconnected) {
  #include <abstractions/base>

  file,

  # 禁止一切写操作
  deny /** w,
}
EOF

sudo apparmor_parser -q /etc/apparmor.d/k8s-apparmor-example-deny-write
```

**策略要加载到集群里每一个可能被调度到的节点**。批量分发时通常用 SSH 循环或 DaemonSet:

```shell
# SSH 循环加载(官方文档的做法)
for NODE in node1 node2 node3; do
  ssh "$NODE" 'sudo apparmor_parser -q -' < ./k8s-apparmor-example-deny-write
done
```

### 验证

```shell
# 容器实际生效的 profile
kubectl exec hello-apparmor -- cat /proc/1/attr/current
# k8s-apparmor-example-deny-write (enforce)

# 触发一次违规,确认拦截生效
kubectl exec hello-apparmor -- touch /tmp/test
# touch: /tmp/test: Permission denied

# Pod 起不来时,先看 kubelet 侧的事件
kubectl describe pod hello-apparmor | tail -20
```

### 编写 profile 的要点

AppArmor 的策略语言以路径为核心,写起来比 SELinux 直观,但也有自己的陷阱:

```shell
#include <tunables/global>

profile my-app flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>     # 基础文件与库的访问集合

  # 允许读,禁止写
  /etc/myapp/** r,
  /var/lib/myapp/** rw,

  # 允许网络
  network inet stream,
  network inet6 stream,

  # 明确拒绝(deny 规则优先级高于 allow)
  deny /etc/shadow rwklx,
  deny @{PROC}/sys/kernel/** rwklx,
}
```

几个关键字:

```shell
r  读   w  写   k  锁定   l  链接   x  执行(可细分为 ix/ux/px)
flags=(complain)        只记录不拦截,调试用
flags=(attach_disconnected)  允许规则匹配到已删除文件,容器里常见
abstractions/base       官方提供的常用授权集合,避免从零写
```

### 与 SELinux 的选择

```shell
维度          AppArmor                     SELinux
规则模型      路径                          标签(type + level)
易用性        高,写路径即可                 低,需要理解类型与策略模块
隔离粒度      进程级                        进程 + 文件 + 端口 + 能力
绕过的可能    换挂载点可能绕过               标签不匹配则一律拒绝,更难绕过
发行版        Ubuntu / Debian / SUSE        RHEL / CentOS / Fedora
```

**同一条节点上两者互斥**,由发行版默认决定。跨发行版混合集群时,不能假设 AppArmor 配置在所有节点上生效——在 RHEL 节点上 `appArmorProfile` 相关的 Pod 会被 kubelet 拒绝,只能靠 nodeSelector 把工作负载钉在支持 AppArmor 的节点上。

### 调试流程

```shell
# 1) 节点上切到 complain 模式(只记录不拦截)
sudo aa-complain /etc/apparmor.d/my-app

# 2) 跑业务,收集被记录的拒绝项
sudo journalctl -k | grep -i apparmor
sudo dmesg | grep 'apparmor="DENIED"'

# 3) 根据日志补规则,或用交互式工具生成
sudo aa-logprof

# 4) 回到 enforce 模式
sudo aa-enforce /etc/apparmor.d/my-app
```

### 注意

1. **profile 没在节点上加载时,Pod 会被 kubelet 拒绝,而不是降级运行**。典型表现是 Pod 一直 `Pending`,事件里写着 `failed to generate apparmor spec opts: apparmor profile not found`。**Pod 对象能创建成功**,所以 `kubectl apply` 不会报错,问题只在调度后暴露。排查时先 `kubectl describe pod`,不要盯着镜像看。
2. **kubelet 会在准入阶段检查 AppArmor 是否开启**。节点内核没有 AppArmor(`/sys/module/apparmor/parameters/enabled` 不是 `Y`)时,显式配置了 AppArmor 的 Pod 无法运行。这也是为什么同一份 YAML 在 Ubuntu 节点上正常、到 RHEL 节点上就挂——**RHEL 系默认用 SELinux,AppArmor 根本没开**。
3. **`Localhost` 填 profile 名,不是文件路径**。写成 `/etc/apparmor.d/xxx` 或 `/sys/kernel/security/apparmor/profiles` 里的完整行都会失败。与 seccomp 的 `localhostProfile` 语义不同,两者别互相套用。
4. **注解已是历史,但还没彻底消失**。`container.apparmor.security.beta.kubernetes.io/<容器名>` 自 **v1.30 起弃用**,替代品就是本页的 `appArmorProfile` 字段(v1.31 GA)。注解在 1.30 之后的版本上仍可用但会告警,并已列入移除计划(KEP sig-node/24-apparmor)。**新代码一律不要再用注解**,存量清单要做一次全量替换;kubectl 会打印 `deprecated since v1.30; use the 'appArmorProfile' field instead`,可以据此扫描。
5. **一个注解只能写一个容器**。老写法里 Pod 有几个容器就要写几条注解,漏掉的那个容器实际是 Unconfined。改成字段形式后 Pod 级设置会自动覆盖所有容器,这本身就是迁移的理由。
6. **`RuntimeDefault` 的具体内容由运行时决定**。containerd 与 CRI-O 的默认 profile 不同,同一个 `RuntimeDefault` 在不同节点上拦下的行为可能不一样。需要确定性时用 Localhost 自己写。
7. **改 profile 需要 `apparmor_parser` 重新加载,容器不会自动重载**。已经在运行的容器继续用旧策略,**必须重建 Pod 才生效**。这与 seccomp 一样——策略在容器创建时绑定。
8. **profile 的匹配是路径级的,换挂载点就可能绕过**。AppArmor 看到的是进程视角的路径;同一个文件通过不同挂载点或 bind mount 暴露时,规则可能匹配不上。这是 AppArmor 相比 SELinux 标签的根本弱点,涉及强隔离的场景要评估。
9. **`deny` 规则比白名单更容易写错**。AppArmor 默认是「不匹配的规则按 profile 定义处理」,`file,` 一行就放开了全部文件访问。想写限制型策略必须配合 `deny` 与 profile 模式(complain/enforce)反复验证,`aa-complain` / `aa-logprof` 是常用的调试工具。
10. **complain 模式只记录不拦截**。上线前先用 complain 模式跑一段,看 `/var/log/syslog` 或 `journalctl -k` 里的 `apparmor="DENIED"` 记录,再切到 enforce。直接上 enforce 容易把生产打挂。
11. **策略文件不会自动持久化到内核之外**。`apparmor_parser` 加载是运行时的,节点重启后需要重新加载。把文件放进 `/etc/apparmor.d/` 才能通过 `apparmor.service` 开机自动加载;临时用 stdin 加载的策略重启即失效。
12. **容器内无法自行切换 profile**。切换/卸载 profile 需要特权与宿主机操作,容器里做不到。这是设计使然——策略由节点管理员掌握,不由工作负载决定。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `seccomp` — 系统调用过滤,与 AppArmor 互补
- `selinux-k8s` — 另一套强制访问控制,与 AppArmor 互斥
- `securitycontext` — appArmorProfile 所在的字段组
- `pod-security-admission` — 准入阶段对危险配置的拦截
- `pod` — 安全上下文的落点
- `node` — 节点发行版决定能否使用 AppArmor

### 参考链接

- [用 AppArmor 限制容器的操作(教程)](https://kubernetes.io/docs/tutorials/security/apparmor/)
- [AppArmor 官方文档](https://apparmor.net/)
- [AppArmor 内核文档](https://docs.kernel.org/admin-guide/LSM/apparmor.html)
- [Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/)
- [KEP sig-node/24: AppArmor](https://github.com/kubernetes/enhancements/tree/master/keps/sig-node/24-apparmor)
