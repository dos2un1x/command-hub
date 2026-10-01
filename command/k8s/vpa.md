vpa
===

Kubernetes中自动调整Pod资源请求与上限的垂直扩缩容组件

## 补充说明

**VerticalPodAutoscaler(简称 VPA)** 通过观测 Pod 的历史资源用量,自动调整其 `resources.requests` 与 `resources.limits`。它调整的是**每个 Pod 的大小**,与调整副本数的 HPA 方向不同:

```shell
HPA   横向扩缩   改副本数      "3 个 Pod 不够,加到 6 个"
VPA   纵向扩缩   改 requests   "每个 Pod 只申请了 100m,实际用了 800m,提高申请量"
```

VPA 由三个组件构成,理解它们的职责是排查问题的前提:

```shell
recommender          采集历史用量,计算出推荐值,写入 VPA 对象的 status
updater              对比推荐值与实际值,决定是否需要更新(在 Recreate 类模式下驱逐 Pod)
admission-controller 一个 Mutating Webhook,在 Pod 创建时把推荐值写入新的 Pod
```

关键点在于:**真正把值写进 Pod 的是准入 Webhook**,而不是 updater。updater 只负责「让 Pod 重建」,重建后的新 Pod 在创建时被 Webhook 改写。因此即使 updater 被停掉,新建的 Pod 依然会拿到推荐值。

VPA 的推荐值来自历史数据,因此对一个刚部署、还没有历史的应用,**最初几分钟不会有任何推荐**,`status.recommendation` 为空属于正常现象。

### 语法

```shell
kubectl get verticalpodautoscaler [名称] [选项]
kubectl describe verticalpodautoscaler [名称]
kubectl delete verticalpodautoscaler [名称]
```

常用简写为 `vpa`:

```shell
kubectl get vpa
kubectl get vpa -A
kubectl describe vpa my-app-vpa
```

### 安装

VPA 不是 Kubernetes 内置组件,需要单独部署:

```shell
git clone https://github.com/kubernetes/autoscaler.git
cd autoscaler/vertical-pod-autoscaler

# 一键部署三个组件
./hack/vpa-up.sh

# 验证
kubectl get pods -n kube-system | grep vpa
# vpa-admission-controller-xxx   1/1   Running
# vpa-recommender-xxx            1/1   Running
# vpa-updater-xxx                1/1   Running
```

VPA 依赖 metrics-server 提供基础指标,未部署时推荐值会一直为空。卸载使用 `./hack/vpa-down.sh`。

### YAML 清单

```shell
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: my-app-vpa
  namespace: default
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-app
  updatePolicy:
    updateMode: Recreate
    minReplicas: 2
  resourcePolicy:
    containerPolicies:
      - containerName: "*"
        minAllowed:
          cpu: 100m
          memory: 128Mi
        maxAllowed:
          cpu: "2"
          memory: 2Gi
        controlledValues: RequestsAndLimits
      - containerName: istio-proxy
        mode: "Off"
```

创建并查看:

```shell
kubectl apply -f vpa.yaml

kubectl get vpa
# NAME         MODE       CPU    MEM        PROVIDED   AGE
# my-app-vpa   Recreate   100m   262144k    True       30s

kubectl describe vpa my-app-vpa
kubectl get vpa my-app-vpa -o yaml
```

`kubectl get vpa` 的 `CPU` 与 `MEM` 两列是最有用的信息,它们显示的是**当前推荐值**;`PROVIDED: True` 表示推荐已经计算完成。

### updateMode 的取值

```shell
Off                  不施加任何变更,但 recommender 仍会计算推荐值
                     是"只观察不动作"的安全模式,上线前建议先用它跑几天

Initial              只在 Pod 创建时写入推荐值,之后不再调整
                     适合"启动时资源需求高、运行后稳定"的应用

Recreate             默认值。创建时写入,并在推荐值变化时通过驱逐重建 Pod 来更新

InPlaceOrRecreate    优先尝试原地调整,失败时回退到驱逐重建
                     需要集群开启 InPlacePodVerticalScaling 特性门控

InPlace              只做原地调整,绝不驱逐;失败时依赖 kubelet 自动重试
                     同样需要 InPlacePodVerticalScaling 特性门控

Auto                 已废弃。目前与 Recreate 等价,新配置不要使用
```

`Auto` 曾经的含义是「创建时赋值 + 之后重建更新」,现在官方已明确它等价于 `Recreate` 并将在未来移除。老文档里把它当成独立模式来讲解的写法已经过时。

### resourcePolicy 字段

```shell
containerPolicies:
  - containerName: "*"        # 通配符,对所有容器生效
    mode: Auto                # Auto(默认)或 Off,Off 表示该容器不接受调整
    minAllowed:               # 推荐值的下限,防止被调得过小
      cpu: 100m
      memory: 128Mi
    maxAllowed:               # 推荐值的上限,防止被调得过大
      cpu: "2"
      memory: 2Gi
    controlledResources:      # 参与调整的资源,默认 [cpu, memory]
      - cpu
      - memory
    controlledValues: RequestsAndLimits
```

`controlledValues` 的两个取值:

```shell
RequestsAndLimits   默认。同时调整 request 与 limit,并保持两者原有的比例
RequestsOnly        只调整 request,limit 保持不变
```

`RequestsOnly` 适合那些 limit 有明确外部约束(如 JVM 堆大小、许可证限制)的场景。

### 推荐值的结构

```shell
kubectl get vpa my-app-vpa -o jsonpath='{.status.recommendation}' | jq .

# {
#   "containerRecommendations": [
#     {
#       "containerName": "my-app",
#       "lowerBound": {"cpu": "250m", "memory": "262144k"},
#       "target":     {"cpu": "588m", "memory": "320000k"},
#       "upperBound": {"cpu": "1",    "memory": "480000k"},
#       "uncappedTarget": {"cpu": "588m", "memory": "320000k"}
#     }
#   ]
# }
```

```shell
lowerBound       再低就可能影响性能的下限
target           当前实际写入 Pod 的值
upperBound       再高就属于浪费的上限
uncappedTarget   未受 minAllowed/maxAllowed 约束时的原始推荐值
```

`uncappedTarget` 与 `target` 的差异能直观反映出「是不是被 maxAllowed 卡住了」,是调参时的重要参考。

### 与 HPA 的关系

```shell
允许   HPA 基于 CPU + VPA 基于内存;或 HPA 基于自定义指标 + VPA 基于 CPU
禁止   HPA 基于 CPU  + VPA 基于 CPU    两者会互相抢夺同一指标
禁止   HPA 基于内存 + VPA 基于内存
```

官方明确要求:**VPA 不应与 HPA 作用于同一项资源指标**。同时作用于 CPU 时,HPA 按利用率扩容、VPA 又在抬高 requests,两者互相干扰,副本数与资源量都会持续震荡。

### 常用操作

```shell
# 查看所有 VPA 及其当前推荐值
kubectl get vpa -A
kubectl get vpa -A -o wide

# 查看完整推荐详情
kubectl describe vpa my-app-vpa
kubectl get vpa my-app-vpa -o jsonpath='{.status.recommendation}' | jq .

# 切换模式(改 updateMode 会触发一次 Pod 重建)
kubectl patch vpa my-app-vpa --type=merge \
  -p '{"spec":{"updatePolicy":{"updateMode":"Off"}}}'

# 查看 VPA 组件日志
kubectl logs -n kube-system deployment/vpa-recommender --tail=100
kubectl logs -n kube-system deployment/vpa-updater --tail=100
kubectl logs -n kube-system deployment/vpa-admission-controller --tail=100

# 查看因 VPA 驱逐而产生的 Pod 事件
kubectl get events -A | grep -i vpa
```

### 排障

```shell
# 1. 推荐值一直为空
kubectl get vpa my-app-vpa -o yaml | grep -A10 status
# 常见原因
#   metrics-server 未部署或不可用
#   VPA 的 targetRef 指向的对象不存在
#   Pod 刚创建,历史数据还不够

# 2. Pod 没有被更新
kubectl logs -n kube-system deployment/vpa-updater | grep -i "not updating"
# 常见原因
#   updateMode 为 Off 或 Initial
#   Pod 不受控制器管理,updater 不会动它
#   PodDisruptionBudget 不允许驱逐;容器级的 mode 被设为 Off

# 3. 新 Pod 拿不到推荐值(检查准入 Webhook 是否生效)
kubectl get pod my-app-xxx -o jsonpath='{.spec.containers[*].resources}'
kubectl get mutatingwebhookconfiguration | grep vpa
```

### 注意

1. **VPA 与 HPA 不能作用于同一项指标**。官方文档明确要求二者不应基于同一资源(CPU 或内存)。同时作用于 CPU 会形成「HPA 扩容 → 单副本压力下降 → VPA 调小 requests → HPA 又认为利用率过高 → 继续扩容」的震荡。若确需并用,必须让它们基于不同指标。

2. **`Auto` 模式已废弃,当前等价于 `Recreate`**。很多资料仍把它描述成一种独立的、更完善的模式,这是过时信息。新配置应直接写 `Recreate` 或 `InPlaceOrRecreate`。

3. **Recreate 类模式会驱逐 Pod 来应用推荐值**。只要推荐值发生变化且超出容忍范围,updater 就会驱逐 Pod,单副本服务会因此出现中断。生产环境务必配合 PodDisruptionBudget,并优先用 `Off` 模式观察一段时间再切换。

4. **`Off` 模式仍然计算推荐值**。它只是不把值写进 Pod,`status.recommendation` 照常更新。这是评估 VPA 效果最安全的方式:先用 `Off` 跑一两周,对比推荐值与人工设定的差距,再决定是否开启自动调整。

5. **`Initial` 模式不会改动已存在的 Pod**。它只在 Pod 创建时生效,想让老 Pod 用上推荐值必须手动触发一次重建(如 `kubectl rollout restart`)。

6. **多个 VPA 同时匹配同一个 Pod 时行为未定义,且 VPA 不会更新不受控制器管理的裸 Pod**。官方文档明确说明前者未定义;后者是因为没有控制器就无法通过重建来应用新值。给一个工作负载只配一个 VPA,并且不要用在裸 Pod 上。

7. **推荐值不考虑集群剩余容量**。recommender 只根据历史用量计算,完全不管集群里还有没有空闲资源。推荐值调大后若超出节点可分配资源,Pod 会直接变成 Pending。缓解手段是配合 cluster-autoscaler,或者用 `maxAllowed` 把上限压在单节点能承载的范围内。

8. **VPA 与 Pod 级资源(`spec.resources`)不兼容**。使用 Pod 级资源声明的负载启用 VPA 后,准入控制器写入的容器级限制可能与 Pod 级限制冲突,导致 **Pod 无法创建**;容器级 requests 之和超出 Pod 级 request 时同样会创建失败。

9. **准入 Webhook 可能与其他 Webhook 冲突**。VPA 的 admission-controller 是一个 Mutating Webhook,若集群里还有别的 Webhook 也在改写 `resources` 字段,最终结果取决于 Webhook 的调用顺序。出现「VPA 显示已生效但 Pod 里的值不对」时,先检查 Webhook 链。

10. **删除 VPA 对象不会还原 Pod 的资源值**。Pod 会保留最后一次被写入的 requests/limits;若希望回到原始值,需要手动改回清单再重建。

11. **VPA 不适合用量剧烈波动的应用**。它基于历史数据做推荐,采样与平滑需要时间,对秒级突发的流量响应远不如 HPA 及时。这类场景应当用 HPA 处理突发,用 VPA 只做长期的基线校准。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `hpa` — 横向扩缩容,与VPA的作用维度不同
- `deployment` — VPA最常用的目标工作负载
- `statefulset` — 有状态工作负载,VPA需谨慎使用
- `poddisruptionbudget` — VPA驱逐Pod时的可用性保护
- `qos` — requests与limits的取值决定QoS等级
- `metrics-server` — VPA推荐值的数据来源
- `resource-quota` — 限制VPA可调整的资源上限

### 参考链接

- [Vertical Pod Autoscaler 项目](https://github.com/kubernetes/autoscaler/tree/master/vertical-pod-autoscaler)
- [Vertical Pod Autoscaler API 参考](https://github.com/kubernetes/autoscaler/blob/master/vertical-pod-autoscaler/docs/api.md)
- [VPA 已知限制](https://github.com/kubernetes/autoscaler/blob/master/vertical-pod-autoscaler/docs/known-limitations.md)
- [为容器管理资源](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
