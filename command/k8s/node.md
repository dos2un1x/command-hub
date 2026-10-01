node
===

Kubernetes节点运维:封锁、驱逐、污点与节点状态管理

## 补充说明

**节点(Node)运维** 是集群日常维护中最高频的一类操作。本页讲的是 **kubectl 视角**下的节点管理:查看节点状态、把节点从调度中摘除、安全地驱逐其上的 Pod,以及节点 NotReady 时按什么顺序排查。

节点在 Kubernetes 中是一个 API 对象(`v1/Node`),由所在机器上的 kubelet 注册并持续上报心跳。控制平面看到的「节点」始终是 kubelet 的一面镜子 —— 机器活着但 kubelet 挂了,节点照样是 `NotReady`。

三个高频动作的关系:

| 动作 | 作用 | 对已运行 Pod 的影响 |
| --- | --- | --- |
| `cordon` | 标记节点不可调度 | 无,已有 Pod 继续运行 |
| `drain` | 先 cordon,再逐出节点上的 Pod | 有,Pod 被驱逐到别处重建 |
| `uncordon` | 解除不可调度标记 | 无,新 Pod 可重新调度上来 |

`cordon` 本质上就是给节点打上 `node.kubernetes.io/unschedulable:NoSchedule` 污点,所以「封锁」和「污点」是同一套机制的两种用法。

### 语法

```shell
kubectl cordon <node>
kubectl uncordon <node>
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data
kubectl taint nodes <node> <key>=<value>:<effect>
```

### 查看节点状态

```shell
# 概览:STATUS 列反映节点是否健康
kubectl get nodes
kubectl get nodes -o wide

# 带标签查看(定位节点池、可用区、机型)
kubectl get nodes --show-labels
kubectl get nodes -l node-role.kubernetes.io/control-plane=
kubectl get nodes -L topology.kubernetes.io/zone

# 单个节点的完整信息:地址、容量、可分配资源、Conditions、Taints、已分配资源
kubectl describe node <node-name>

# 只看 Conditions
kubectl get node <node-name> -o jsonpath='{.status.conditions[*].type}{"\n"}'
kubectl get node <node-name> -o json | jq '.status.conditions'

# 节点上的 Pod:按 spec.nodeName 过滤,而不是按命名空间
kubectl get pods -A --field-selector spec.nodeName=<node-name>
kubectl get pods -A --field-selector spec.nodeName=<node-name>,status.phase=Running

# 节点资源用量(需要 metrics-server)
kubectl top node
kubectl top node --sort-by=memory
```

### Node Conditions

kubelet 与节点控制器会持续维护一组 Conditions,`kubectl describe node` 里的 `Conditions` 段就是它们。任一 Condition 异常,节点都可能被判定为不适合继续承载工作负载:

| Condition | 含义 | 异常后的动作 |
| --- | --- | --- |
| `Ready` | `True` 表示 kubelet 健康且可接收 Pod | 打 `not-ready`/`unreachable` 污点 |
| `MemoryPressure` | 节点内存不足 | 打 `memory-pressure:NoSchedule` 污点并驱逐 Pod |
| `DiskPressure` | 节点文件系统或镜像分区空间/inode 不足 | 打 `disk-pressure:NoSchedule` 污点并驱逐 Pod |
| `PIDPressure` | 可用 PID 不足 | 打 `pid-pressure:NoSchedule` 污点并驱逐 Pod |
| `NetworkUnavailable` | 节点网络未就绪 | 通常表示 CNI 插件未安装或未就绪 |

注意 `NetworkUnavailable` **不由 kubelet 维护**,而是由 CNI 网络插件写入。全新集群里节点几乎都显示 `NetworkUnavailable=True`,装好网络插件才会转为 `False`。

```shell
# 快速判断节点为何 NotReady
kubectl get node <node-name> -o jsonpath='{range .status.conditions[*]}{.type}{"\t"}{.status}{"\t"}{.reason}{"\n"}{end}'

# 查看节点上的污点(kubelet 施加的压力污点也会出现在这里)
kubectl describe node <node-name> | grep -A5 Taints
kubectl get node <node-name> -o jsonpath='{.spec.taints}'
```

### 封锁与驱逐

```shell
# 封锁:标记不可调度,已运行的 Pod 不受影响
kubectl cordon <node-name>

# 解除封锁
kubectl uncordon <node-name>

# 驱逐:先自动 cordon,再逐个安全驱逐 Pod(默认走 Eviction API)
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data

# 只驱逐匹配标签的 Pod
kubectl drain <node-name> --ignore-daemonsets --pod-selector='app=nginx'

# 先看会发生什么,再决定是否执行
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data --dry-run=server
```

常用标志:

```shell
--ignore-daemonsets            忽略 DaemonSet 管理的 Pod(drain 不会删除它们)
--delete-emptydir-data         允许驱逐使用 emptyDir 的 Pod(本地数据会丢失)
--force                        允许驱逐没有控制器管理的「裸 Pod」
--grace-period=-1              优雅终止时间,负数表示沿用 Pod 自身设置
--timeout=0                    整体超时,0 表示不限制
--disable-eviction             改用 DELETE 直接删除,绕过 PodDisruptionBudget(慎用)
--dry-run=server               只走服务端校验,不真正驱逐
--pod-selector                 只驱逐匹配标签的 Pod
--skip-wait-for-delete-timeout 等待删除超过 N 秒后跳过
--chunk-size=500               分批返回列表,避免大集群下一次拉取过多
```

### 污点与容忍

污点(Taint)打在节点上,容忍(Toleration)写在 Pod 上,二者匹配才能调度上去。

```shell
# 添加污点
kubectl taint nodes <node-name> dedicated=gpu:NoSchedule
kubectl taint nodes <node-name> dedicated=gpu:NoExecute

# 删除污点:键后面加一个减号
kubectl taint nodes <node-name> dedicated=gpu:NoSchedule-
kubectl taint nodes <node-name> dedicated-

# 修改已有污点必须加 --overwrite
kubectl taint nodes <node-name> dedicated=cpu:NoSchedule --overwrite

# 查看
kubectl get node <node-name> -o jsonpath='{.spec.taints}'
```

三种 effect 的行为差异:

| effect | 对已运行 Pod | 对新调度 Pod |
| --- | --- | --- |
| `NoSchedule` | 不驱逐 | 不容忍则不调度 |
| `PreferNoSchedule` | 不驱逐 | 尽量不调度(软约束) |
| `NoExecute` | 不容忍则立即驱逐 | 不容忍则不调度 |

对应的容忍写法:

```shell
tolerations:
- key: "dedicated"
  operator: "Equal"
  value: "gpu"
  effect: "NoSchedule"
- key: "dedicated"
  operator: "Exists"
  effect: "NoExecute"
  tolerationSeconds: 3600
```

### 集群内置污点

这些污点由控制平面或 kubelet 自动维护,排查调度问题时优先看它们:

| 污点 | effect | 来源 |
| --- | --- | --- |
| `node.kubernetes.io/not-ready` | `NoExecute` | 节点控制器,节点 NotReady 时 |
| `node.kubernetes.io/unreachable` | `NoExecute` | 节点控制器,无法与节点通信时 |
| `node.kubernetes.io/memory-pressure` | `NoSchedule` | kubelet,内存压力 |
| `node.kubernetes.io/disk-pressure` | `NoSchedule` | kubelet,磁盘压力 |
| `node.kubernetes.io/pid-pressure` | `NoSchedule` | kubelet,PID 压力 |
| `node.kubernetes.io/network-unavailable` | `NoSchedule` | 网络插件,网络未就绪 |
| `node.kubernetes.io/unschedulable` | `NoSchedule` | `kubectl cordon` |
| `node.kubernetes.io/out-of-service` | `NoExecute` | 管理员手动添加,用于节点非体面关机 |

普通 Pod 会被自动注入 `not-ready` 与 `unreachable` 的容忍,`tolerationSeconds` 默认为 300 秒 —— 这正是「节点失联 5 分钟后 Pod 才开始被驱逐」的原因。

### 节点维护流程

标准的「下线一台机器做维护」流程:

```shell
# 1. 确认节点上没有不能被中断的工作负载
kubectl get pods -A --field-selector spec.nodeName=<node-name>

# 2. 封锁并驱逐(drain 会自动先 cordon)
kubectl drain <node-name> --ignore-daemonsets --delete-emptydir-data

# 3. 确认 Pod 已迁走,此时通常只剩 DaemonSet 的 Pod
kubectl get pods -A --field-selector spec.nodeName=<node-name>

# 4. 执行机器维护(重启、换内核、扩容磁盘等)

# 5. 恢复调度
kubectl uncordon <node-name>
kubectl get nodes
```

若机器维护后需要重新加入集群,务必确认 kubelet 已启动、容器运行时正常、CNI 配置仍然存在。

### 节点 NotReady 排查

按下面的顺序逐层收敛,不要一上来就重启 kubelet:

```shell
# 1. 节点自身的 Conditions
kubectl describe node <node-name> | grep -A20 Conditions
kubectl get node <node-name> -o jsonpath='{.status.conditions[?(@.type=="Ready")]}'

# 2. 登录节点看 kubelet 日志(最直接的线索)
sudo journalctl -u kubelet -n 100 --no-pager
sudo journalctl -u kubelet -p err --since "10 minutes ago"

# 3. 容器运行时是否可用
sudo systemctl status containerd
sudo crictl info

# 4. kubelet 是否在正常续约
kubectl get lease -n kube-node-lease | grep <node-name>

# 5. 磁盘是否写满(最常见的隐性原因)
df -h /var/lib/kubelet /var/lib/containerd

# 6. 证书是否过期
sudo openssl x509 -in /var/lib/kubelet/pki/kubelet-client-current.pem -noout -dates

# 7. 是否存在资源压力
kubectl describe node <node-name> | grep -i pressure
```

常见根因排序:kubelet 进程挂掉 > 容器运行时挂掉 > 磁盘写满触发 DiskPressure > 客户端证书过期 > 网络分区导致心跳中断 > CNI 异常。

### 注意

1. **`cordon` 不影响已经在运行的 Pod**。它只阻止新 Pod 调度过来,已有 Pod 照常提供服务,也不会有任何通知。
2. **`drain` 默认不驱逐 DaemonSet 的 Pod**,不加 `--ignore-daemonsets` 会直接报错退出;而且**即使加了这个标志,DaemonSet 的 Pod 也不会被删除** —— 删了也会被 DaemonSet 控制器立刻在同一个节点上重建。
3. **`drain` 遇到使用 `emptyDir` 的 Pod 会中止**,必须显式加 `--delete-emptydir-data`。该标志的旧名字是 `--delete-local-data`,老脚本里见到不要当成另一个参数。
4. **`drain` 会尊重 PodDisruptionBudget,可能永久阻塞**。PDB 的 `minAvailable` / `maxUnavailable` 不允许再少一个副本时,驱逐请求会一直返回 429,`drain` 就一直卡住不返回。此时应先用 `kubectl get pdb -A` 检查,而不是加 `--disable-eviction` 硬来 —— 后者绕过 PDB,会把可用副本直接打到水位以下。
5. **没有控制器管理的「裸 Pod」必须加 `--force` 才能驱逐**。这类 Pod 删掉后不会被重建,`drain` 默认拒绝执行以免误删。
6. **一次只 drain 一个节点**,不要写成一条命令带多个节点名。需要并行下线多台机器时,应对不同节点分别执行命令,由 PDB 来兜住整体可用性。
7. **`node.kubernetes.io/out-of-service` 只能在确认机器已关机或断电后添加**。机器还活着时打这个污点,可能出现同一个 Pod 在两个节点上同时运行,导致文件系统损坏;恢复后必须手动移除该污点。
8. **节点失联后 Pod 的默认驱逐延迟是 300 秒**,由 `not-ready`/`unreachable` 容忍的 `tolerationSeconds` 决定。调小这个值能加快故障转移,但也会让网络抖动的节点被误判。
9. **`MemoryPressure`/`DiskPressure`/`PIDPressure` 为 True 时 kubelet 会主动驱逐 Pod**,而且**不遵守 PodDisruptionBudget、也不遵守 `terminationGracePeriodSeconds`**;使用硬驱逐阈值时宽限期固定为 0 秒,Pod 会被立即杀掉。
10. **`uncordon` 不会把 Pod 迁回来**。被驱逐的 Pod 已由各自的控制器在别处重建,恢复调度只影响之后新建的 Pod。
11. **删除 Node 对象不等于关机**。`kubectl delete node` 只是把对象从 API 中移除;如果机器上的 kubelet 仍在运行且能连上 apiserver,它会重新注册该节点。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kubelet` — 节点代理,汇报节点状态并管理 Pod
- `kubeadm` — Kubernetes集群安装工具
- `crictl` — 容器运行时调试工具
- `etcd` — 集群数据存储,Node 对象最终落在这里

### 参考链接

- [节点官方文档](https://kubernetes.io/docs/concepts/architecture/nodes/)
- [安全驱逐节点上的 Pod](https://kubernetes.io/docs/tasks/administer-cluster/safely-drain-node/)
- [污点与容忍](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/)
- [kubectl drain 命令参考](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_drain/)
- [已知标签、注解与污点](https://kubernetes.io/docs/reference/labels-annotations-taints/)
- [节点压力驱逐](https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/)
- [节点关闭](https://kubernetes.io/docs/concepts/cluster-administration/node-shutdown/)
