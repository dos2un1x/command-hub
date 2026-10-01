kured
===

Kubernetes节点重启编排:逐台安全重启以应用内核与系统更新

## 补充说明

**kured(Kubernetes Reboot Daemon)** 是以 DaemonSet 形式运行在集群里的节点重启编排器。它解决的是这样一个问题:Linux 发行版的自动更新(如 Ubuntu 的 `unattended-upgrades`)装完内核或 glibc 之后,会在机器上留下一个「需要重启」的标记文件,但**重启时机会直接影响业务** —— 手动逐台重启既枯燥又容易出错。

kured 把这个过程自动化,并且保证**一次只重启一台**:

```shell
1. 每个节点上的 kured 按 --period(默认 1 小时)检查哨兵文件是否存在
2. 存在则先抢占集群级别的锁(锁是写在 kured DaemonSet 上的一个注解)
3. 抢到锁的节点:cordon → drain(走 Eviction API) → 执行重启命令
4. 等节点重新 Ready 后 uncordon,释放锁
5. 其他节点继续竞争锁,依次重启
```

它**不负责**安装更新,也**不负责**判断有哪些更新。发现更新是发行版更新工具的职责,kured 只负责「看到哨兵文件之后,安全地重启」。

### 安装

```shell
# 方式一:Helm(官方 chart)
helm repo add kubereboot https://kubereboot.github.io/charts
helm repo update
helm install kured kubereboot/kured --namespace kube-system

# 也可以通过 OCI 仓库安装
helm install kured oci://ghcr.io/kubereboot/charts/kured --namespace kube-system

# 方式二:官方合并清单
latest=$(curl -s https://api.github.com/repos/kubereboot/kured/releases | jq -r '.[0].tag_name')
kubectl apply -f "https://github.com/kubereboot/kured/releases/download/$latest/kured-$latest-combined.yaml"
```

验证:

```shell
kubectl get ds -n kube-system kured
kubectl get pods -n kube-system -l name=kured
kubectl logs -n kube-system ds/kured --tail=50
```

### 常用参数

```shell
--period=1h                      检查哨兵文件的间隔,默认 1 小时
--reboot-sentinel=/var/run/reboot-required  哨兵文件路径
--reboot-sentinel-command=""     改用命令返回值判断是否需要重启
--reboot-command="/bin/systemctl reboot"    实际执行的重启命令
--reboot-method=command          重启方式:command 或 signal
--reboot-signal=39               使用 signal 方式时的信号(SIGRTMIN+5)
--reboot-delay=0                 重启前的额外等待
--reboot-days=su,mo,tu,we,th,fr,sa          允许重启的星期
--start-time=0:00                维护窗口开始时间
--end-time=23:59:59              维护窗口结束时间
--time-zone=UTC                  维护窗口使用的时区
--lock-ttl=0                     锁的超时时间,0 表示永不过期
--lock-release-delay=0           持锁后延迟释放,用于给重启限速
--concurrency=1                  同时重启的节点数,默认 1
--prefer-no-schedule-taint=""    重启期间给节点打上的软污点
--blocking-pod-selector          节点上存在匹配的 Pod 时不重启
--prometheus-url=""              对接 Prometheus,按告警触发重启
--alert-filter-regexp            过滤参与判断的告警名
--notify-url=""                  重启前后发送通知
--annotate-nodes                 在节点上留下重启相关注解
--drain-timeout=0                drain 超时,0 表示不限制
--ds-namespace=kube-system       锁所在 DaemonSet 的命名空间
--ds-name=kured                  锁所在 DaemonSet 的名字
```

所有参数都可以用 `KURED_` 前缀的环境变量提供,例如 `KURED_REBOOT_SENTINEL`、`KURED_NOTIFY_URL`。

### 哨兵文件与触发条件

kured 只在满足下面任一条件时才考虑重启节点:

```shell
# 1. 哨兵文件存在(默认)
ls -l /var/run/reboot-required

# 2. 哨兵命令返回 0 —— 配置后哨兵文件被完全忽略
--reboot-sentinel-command='sh -c "! needs-restarting --reboothint"'
```

Debian / Ubuntu 系的 `unattended-upgrades` 会自动写入 `/var/run/reboot-required`;RHEL 系没有这个文件,需要改用哨兵命令 —— `needs-restarting --reboothint` 在需要重启时返回 1,所以要包一层 `sh -c` 并用 `!` 取反。

官方清单把宿主机的 `/var/run` 挂载到容器内的 `/sentinel`,并显式传入 `--reboot-sentinel=/sentinel/reboot-required`。自定义路径时务必一并调整挂载,否则容器里看到的路径与宿主机不一致。

### 维护窗口

只在周末凌晨重启:

```shell
--reboot-days=sat,sun \
--start-time=0:00 \
--end-time=6:00 \
--time-zone=Asia/Shanghai
```

窗口之外 kured 什么都不做,并且会移除已经打上的 `--prefer-no-schedule-taint`。窗口设置得较窄时应当同时调小 `--period`,否则哨兵文件可能要等好几个小时才被检查到。

Helm 安装时用 `configuration` 下的同名键传入:

```shell
helm upgrade kured kubereboot/kured -n kube-system \
  --set configuration.rebootSentinelCommand='sh -c "! needs-restarting --reboothint"'
```

### 锁机制与手动暂停

kured 用**注解**实现集群级互斥锁,注解写在 kured 自己的 DaemonSet 上(不是节点上):

```shell
# 查看当前锁
kubectl -n kube-system get ds kured -o jsonpath='{.metadata.annotations}'

# 手动加锁,暂停所有自动重启
kubectl -n kube-system annotate ds kured weave.works/kured-node-lock='{"nodeID":"manual"}'

# 手动解锁(末尾的减号表示删除该注解)
kubectl -n kube-system annotate ds kured weave.works/kured-node-lock-
```

节点重启期间,被操作的节点上会出现下面两个注解(需要开启 `--annotate-nodes`):

```shell
weave.works/kured-reboot-in-progress          重启进行中,重启成功后自动删除
weave.works/kured-most-recent-reboot-needed   最近一次需要重启的时间戳
```

`--lock-ttl` 默认是 0,即**锁永不过期**。这在使用 cluster-autoscaler 的场景下有风险:持锁节点被缩容掉之后,注解会永远留在 DaemonSet 上,整个集群再也不会自动重启。生产环境建议设置一个合理的 TTL。

### 观察重启过程

kured 的整个编排过程都是可以旁观的,排查「为什么这台节点迟迟不重启」时按下面的顺序看:

```shell
# 1. 谁在持锁(锁的 JSON 里带 nodeID)
kubectl -n kube-system get ds kured -o jsonpath='{.metadata.annotations.weave\.works/kured-node-lock}'

# 2. 节点是否已被 cordon
kubectl get node <node-name> -o jsonpath='{.spec.unschedulable}'

# 3. 节点上是否标记了「重启进行中」
kubectl get node <node-name> \
  -o jsonpath='{.metadata.annotations.weave\.works/kured-reboot-in-progress}'

# 4. 跟随节点状态变化
kubectl get nodes -w
```

其中第 3 步的注解在重启成功后会被自动删除,因此「注解还在、节点却已经 Ready」通常意味着 kured 没能完成收尾,需要人工 `uncordon`。

### 监控

```shell
# kured 暴露的核心指标:节点是否需要重启
kubectl -n kube-system port-forward ds/kured 8080:8080
curl -s localhost:8080/metrics | grep kured_reboot_required

# 典型告警:需要重启但 24 小时内没有完成
# max(kured_reboot_required) != 0  持续 24h
```

如果同时让 kured 消费 Prometheus 的告警(`--prometheus-url`),必须用 `--alert-filter-regexp=^RebootRequired$` 把过滤条件限定到重启告警上,否则 kured 会因为自己发出的 `RebootRequired` 告警而陷入自锁。

### 注意

1. **kured 不会自己产生重启需求**。哨兵文件(或哨兵命令)不存在时,它永远什么都不做,也不会有任何超时升级机制。真正「需要重启」的信号来自发行版的更新工具,必须自行确认更新策略已经生效。
2. **`--force-reboot` 的语义容易被误解**。它的作用是「即使 drain 失败或超时也照样重启」,**不是**「没有哨兵文件也可以重启」。需要重启的判定条件在加不加这个标志时都一样。
3. **drain 与 `--drain-timeout` 的默认值组合有风险**。kured 走的是 Eviction API,PodDisruptionBudget 由 API Server 强制执行;而 `--drain-timeout` 默认是 0(不超时),当某个 PDB 长期不允许中断时,这台节点会一直卡在 drain 阶段,锁也不会释放,整个集群的重启进度随之停摆。
4. **kured 的 drain 是「强制模式」**。它在内部固定设置了 `force`、`delete-emptydir-data`、`ignore-daemonsets`,因此**会连同 `emptyDir` 的本地数据一起删掉**,也不会为「没有控制器管理的裸 Pod」停下来确认。这与手工执行 `kubectl drain` 的保守默认值不同,迁移前要充分评估。
5. **锁在 DaemonSet 上,不在节点上**。用 `kubectl annotate ds` 加锁才是官方认可的暂停方式;直接删 Pod、停 DaemonSet 都会绕过锁机制,可能让多个节点同时重启。
6. **`--concurrency` 大于 1 在生产环境不安全**。官方明确说明并发重启时,同时重启的节点上的工作负载没有任何额外保护。多节点同时下线很可能击穿剩余容量。
7. **默认一次只重启一台,大集群会很慢**。100 个节点、`--period` 为 1 小时的情况下,一轮完整重启可能跨越数天。缩短 `--period` 会让所有节点更频繁地争抢锁,但不会提高并行度。
8. **`--reboot-command` 默认假定系统使用 systemd**。kured 会进入宿主机的 mount namespace 执行 `systemctl reboot`;非 systemd 的发行版需要改用 `--reboot-method=signal` 或自定义 `--reboot-command`。
9. **`--blocking-pod-selector` 是「一票否决」而不是排队**。节点上只要有匹配的 Pod,这台节点的重启就一直不会发生,而且不会有任何提示。用了这个机制就必须同时配置 `RebootRequired` 告警,否则可能长期静默不重启。
10. **控制平面节点默认会被重启**。官方清单里 kured 容忍了 `node-role.kubernetes.io/control-plane` 与 `node-role.kubernetes.io/master` 的 `NoSchedule` 污点,并且会 drain 控制平面节点。多控制平面集群尚可,单控制平面集群需要显式排除。
11. **kured 只负责重启,不校验重启结果**。它等待节点重新变为 Ready 后 uncordon,但如果重启后 kubelet 没能恢复,该节点会一直处于 NotReady,drain 阶段的锁也不会释放。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `node` — kubectl 视角的节点封锁、驱逐与状态管理
- `kubelet` — 节点代理,重启后负责重新注册节点
- `kubeadm` — Kubernetes集群安装工具,升级节点时也涉及 cordon/drain
- `node-problem-detector` — 把节点故障暴露为 Condition,与 kured 互补

### 参考链接

- [kured 官方文档](https://kured.dev/docs/)
- [kured GitHub 仓库](https://github.com/kubereboot/kured)
- [kured 配置参数](https://kured.dev/docs/configuration/)
- [kured 运维说明(锁与手动暂停)](https://kured.dev/docs/operation/)
- [kured Helm Chart](https://github.com/kubereboot/charts)
