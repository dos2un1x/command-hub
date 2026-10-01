kube-scheduler
===

Kubernetes默认调度器,负责为新创建的Pod选择运行的节点

## 补充说明

**kube-scheduler** 是 Kubernetes 的默认调度器。它监听 API Server 中 `spec.nodeName` 为空的 Pod,经过过滤与打分选出一个最合适的节点,再把绑定结果写回 API Server。

调度器**不负责启动容器**。它只做「决策」,真正拉起容器的是目标节点上的 kubelet。因此调度失败时 Pod 会一直停在 `Pending`,而调度成功但容器起不来则属于 kubelet 或容器运行时的问题 —— 这两类故障必须分开排查。

在 kubeadm 部署的集群中,kube-scheduler 以**静态 Pod** 的形式运行在控制平面节点,清单文件是 `/etc/kubernetes/manifests/kube-scheduler.yaml`。修改该文件后 kubelet 会自动重建调度器,无需手工重启。

### 调度流程

```shell
1. queueSort   把待调度队列按 PriorityClass 优先级排序,同优先级按创建时间先后
2. preFilter   预处理 Pod 与集群信息,可提前判定 Pod 不可调度
3. filter      遍历所有节点,剔除不满足条件的节点(等价于旧版的 Predicates)
4. preScore    打分前的信息准备
5. score       给通过过滤的节点打分(0-100),按插件权重加权求和
6. reserve     为选中的节点预留资源(如 VolumeBinding 的卷绑定)
7. permit      允许或延迟绑定
8. preBind     绑定前的准备工作
9. bind        把 Pod 与节点绑定,写回 spec.nodeName
10. postBind   绑定完成后的收尾通知
```

若第 3 步过滤后**没有任何可用节点**,调度器会进入 `postFilter`,默认由 `DefaultPreemption` 插件尝试**抢占**:驱逐节点上优先级更低的 Pod 来腾出空间。

### 语法

```shell
kube-scheduler [flags]
```

常用参数:

```shell
--config string                     调度器配置文件的路径
--kubeconfig string                 连接 API Server 的 kubeconfig(已不推荐,改用配置文件)
--authentication-kubeconfig string  用于 TokenReview 的 kubeconfig,可选
--authorization-kubeconfig string   用于 SubjectAccessReview 的 kubeconfig,可选
--bind-address string               监听地址,默认 0.0.0.0
--secure-port int                   安全端口,默认 10259
--leader-elect                       多副本时启用领导者选举,默认 true
--feature-gates                      以 key=value 形式开关特性门控
--v Level                            日志详细程度
```

### 配置文件

调度器的行为几乎全部由 **KubeSchedulerConfiguration** 描述,当前稳定版本为 `v1`(`v1beta3` 在 v1.26 弃用、v1.29 移除):

```shell
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
parallelism: 16
leaderElection:
  leaderElect: true
  resourceNamespace: kube-system
  resourceName: kube-scheduler
clientConnection:
  kubeconfig: /etc/kubernetes/scheduler.conf
profiles:
  - schedulerName: default-scheduler
    plugins:
      score:
        disabled:
          - name: NodeResourcesBalancedAllocation
        enabled:
          - name: NodeResourcesFit
            weight: 2
    pluginConfig:
      - name: NodeResourcesFit
        args:
          scoringStrategy:
            type: LeastAllocated
            resources:
              - name: cpu
                weight: 1
              - name: memory
                weight: 1
```

`profiles` 是配置的核心:一个调度器实例可以同时运行**多个 profile**,每个 profile 有自己的插件组合与名字。Pod 通过 `spec.schedulerName` 选择使用哪个 profile,不写则用 `default-scheduler`。

### 扩展点与默认插件

每个扩展点上都挂着一批插件,默认启用的主要有:

```shell
queueSort       PrioritySort
preFilter       NodeAffinity、NodePorts、NodeResourcesFit、PodTopologySpread、VolumeBinding
filter          TaintToleration、NodeAffinity、NodeName、NodeUnschedulable、NodeResourcesFit
                PodTopologySpread、InterPodAffinity、VolumeBinding、VolumeRestrictions
                VolumeZone、NodeVolumeLimits
postFilter      DefaultPreemption
preScore        TaintToleration、PodTopologySpread、InterPodAffinity
score           NodeResourcesFit、NodeResourcesBalancedAllocation、ImageLocality
                NodeAffinity、PodTopologySpread、InterPodAffinity、TaintToleration
reserve         VolumeBinding
preBind         VolumeBinding
bind            DefaultBinder
```

`NodeResourcesFit` 的打分策略由 `scoringStrategy.type` 决定,可选:

```shell
LeastAllocated          默认。优先选资源使用率最低的节点,让负载尽量打散
MostAllocated           优先选使用率最高的节点,适合装箱、省成本
RequestedToCapacityRatio 按自定义的利用率-得分曲线打分
```

### 只控制部分节点参与打分

大集群里给每个节点打分开销很高,可以用 `percentageOfNodesToScore` 让调度器只抽样一部分节点:

```shell
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
percentageOfNodesToScore: 30
profiles:
  - schedulerName: default-scheduler
```

该值设为 `0`(默认)时按公式 `50 - 节点数/125` 自动计算,下限为 5%。100 个节点的集群会扫描约 49% 的节点。

### 部署第二个调度器

同一个集群可以跑多个调度器,只需给 profile 起不同的名字:

```shell
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
profiles:
  - schedulerName: my-scheduler
    plugins:
      score:
        disabled:
          - name: '*'
        enabled:
          - name: NodeResourcesFit
```

Pod 端指定使用它:

```shell
spec:
  schedulerName: my-scheduler
  containers:
    - name: app
      image: myapp:1.0
```

`schedulerName` 拼写错误不会报错,Pod 只会一直 `Pending` 并在事件里提示 `no nodes available`,排查时先确认这个名字。

### 常用操作

```shell
# 查看调度器 Pod(静态 Pod,名字带节点名后缀)
kubectl get pods -n kube-system -l component=kube-scheduler
kubectl get pods -n kube-system -o wide | grep scheduler

# 查看调度器日志
kubectl logs -n kube-system kube-scheduler-<node-name>
kubectl logs -n kube-system -l component=kube-scheduler --tail=100

# 查看调度器使用的配置(以 kubeadm 集群为例)
sudo cat /etc/kubernetes/manifests/kube-scheduler.yaml
sudo cat /etc/kubernetes/scheduler.conf

# 查看调度器暴露的指标
kubectl get --raw /metrics | grep scheduler

# 查看 Pod 为何没被调度(最有用的手段)
kubectl describe pod <pod-name>
kubectl get events --field-selector involvedObject.name=<pod-name>

# 查看节点当前的污点与可分配资源
kubectl describe node <node-name> | grep -A3 Taints
kubectl describe node <node-name> | grep -A6 "Allocated resources"
```

### 排障

```shell
# 1. Pod 长期 Pending,先看事件里的原因
kubectl describe pod <pod-name> | sed -n '/Events/,$p'

# 常见原因对照
#  0/3 nodes are available: 3 Insufficient cpu      资源不足
#  0/3 nodes are available: 3 node(s) had taint ... 污点未容忍
#  0/3 nodes are available: 3 node(s) didn't match  亲和性不匹配
#  0/3 nodes are available: 3 node(s) were unschedulable  节点被 cordon

# 2. 确认调度器本身是否健康
kubectl get pods -n kube-system -l component=kube-scheduler
kubectl logs -n kube-system kube-scheduler-<node> --tail=50

# 3. 提高日志等级,观察完整的调度决策过程
#    编辑 /etc/kubernetes/manifests/kube-scheduler.yaml
#    在 command 段中加入 - --v=5
sudo vi /etc/kubernetes/manifests/kube-scheduler.yaml

# 4. 检查是否有 Pod 被抢占(事件里会出现 Preempted)
kubectl get events -A --field-selector reason=Preempted
```

### 注意

1. **`requiredDuringSchedulingIgnoredDuringExecution` 只在调度那一刻生效**。名字里的 `IgnoredDuringExecution` 表示节点标签在 Pod 运行后发生变化时,Pod **不会被驱逐**,只是后续新 Pod 不再匹配。不要把它当成持续性的约束。

2. **调度失败与启动失败是两回事**。`Pending` 说明调度器还没能选出节点,问题在资源、亲和性、污点或配额;一旦 `spec.nodeName` 被写上,后续失败就归 kubelet 管,应去看 `kubectl describe pod` 中的 `FailedScheduling` 之外的事件。

3. **默认调度器不感知「真实负载」**。它只看 `requests`,不看节点上的实际 CPU/内存使用率。所有工作负载都不写 `requests` 时,调度器会认为节点是空的,从而把大量 Pod 塞到同一节点,造成资源争抢。

4. **抢占只对优先级生效**。所有 Pod 优先级相同(都为 0)时,新 Pod 无法抢占任何 Pod,只能一直等待。若确实需要抢占能力,必须引入 PriorityClass。

5. **抢占是「尽力而为」,不保证成功**。调度器会尽量避开会违反 PodDisruptionBudget 的候选者,但 PDB 并不能阻止抢占发生。高优先级 Pod 仍可能挤掉受 PDB 保护的 Pod。

6. **不要删除或改动静态 Pod 清单中的 `--config` 路径指向的文件而未同步更新**。kubeadm 集群里调度器配置来自 `/etc/kubernetes/manifests/kube-scheduler.yaml` 的启动参数,直接改 ConfigMap 或别处的文件不会生效。

7. **`kubectl cordon` 并不会驱逐已有 Pod**。它只给节点打上 `node.kubernetes.io/unschedulable:NoSchedule` 污点,阻止新 Pod 调度;要让已有 Pod 迁走必须配合 `kubectl drain`。

8. **`count` 类型的资源与分数无关**。`NodeResourcesFit` 只对 cpu、memory 等可压缩/可计量的资源计分,扩展资源(如 `nvidia.com/gpu`)只在过滤阶段起作用,不会参与打分。

9. **调度器是单点决策组件**。默认只有一个实例真正工作(靠 `--leader-elect` 选出),调度器挂掉时已有 Pod 不受影响,但**新 Pod 会全部卡在 Pending**,这属于控制平面故障而不是业务故障。

10. **`percentageOfNodesToScore` 调得过低会影响调度质量**。抽样比例越小,越可能错过真正合适的节点,只应在节点数很多且调度吞吐跟不上时才下调。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kubelet` — 节点代理,真正启动被调度的Pod
- `kube-apiserver` — 调度器监听与写回的入口
- `pod` — 被调度的最小单元
- `affinity` — 影响调度器选点的亲和性规则
- `taints-tolerations` — 影响调度器选点的污点与容忍
- `priority-class` — 决定调度与抢占的优先级

### 参考链接

- [kube-scheduler 官方文档](https://kubernetes.io/docs/concepts/scheduling-eviction/kube-scheduler/)
- [调度器配置](https://kubernetes.io/docs/reference/scheduling/config/)
- [调度框架](https://kubernetes.io/docs/concepts/scheduling-eviction/scheduling-framework/)
- [kube-scheduler 命令行参考](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-scheduler/)
