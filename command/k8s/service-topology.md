service-topology
===

Service拓扑感知路由,让流量优先落到同可用区或同节点的后端

## 补充说明

默认情况下,Kubernetes 的 Service 是**集群范围**的负载均衡:任何一个后端 Pod 都可能收到来自任何节点的流量。在多可用区(zone)集群里,这意味着大量请求会跨区传输 —— 跨区带宽要钱、延迟更高,还容易在 zone 故障时把流量打到错误的区域。

**拓扑感知路由**(Topology Aware Routing)让流量优先落在与客户端**同一拓扑域**的后端上,从而减少跨区传输。

它经历过一次接口演进,今天有**两套并存的机制**:

```shell
旧机制  注解 service.kubernetes.io/topology-mode: Auto
        由 EndpointSlice 控制器写入 hints 字段,kube-proxy 读取
        在 1.27 之前叫 Topology Aware Hints

新机制  Service 的 spec.trafficDistribution 字段
        在 Service 上直接表达「偏好」,更直观,是推荐的写法
```

### 旧机制:topology-mode 注解

```shell
apiVersion: v1
kind: Service
metadata:
  name: my-svc
  annotations:
    service.kubernetes.io/topology-mode: "Auto"
spec:
  selector:
    app: my-app
  ports:
    - port: 80
      targetPort: 8080
```

开启后,EndpointSlice 控制器会给每个 endpoint 打上「建议在哪个 zone 使用」的提示:

```shell
endpoints:
  - addresses: ["10.244.1.5"]
    conditions:
      ready: true
    zone: zone-a
    hints:
      forZones:
        - name: "zone-a"
```

kube-proxy 读取这些 hints,来自 zone-a 节点的请求就优先转发到带 `forZones: zone-a` 的 endpoint。

关键特性:**它是一份「hints」(提示),不是硬约束。** 一旦条件不满足,整套机制会**整体回退到集群范围的负载均衡**,而不是部分生效。

会触发回退的条件:

```shell
- endpoint 数量少于 zone 数量
- 无法做到均衡分配(某个 zone 分不到 endpoint)
- 有节点缺少 topology.kubernetes.io/zone 标签
- 有节点缺少可分配 CPU 信息
- 任意一个 endpoint 没有 zone 提示
- kube-proxy 自己所在的 zone 没有任何可用的提示 endpoint
```

这些条件意味着:**只要有一个节点没打 zone 标签,整个 Service 的拓扑路由就会失效**。这是在混合节点池集群里最常见的「配了但没效果」。

几条额外的约束:

```shell
- 使用了 internalTrafficPolicy: Local 的 Service 不再走这套机制
- 未就绪的 endpoint 与带控制平面标签的节点【会被忽略】
- 不考虑 tolerations
- 假设流量与各 zone 的节点容量成比例 —— 这是它最不牢靠的假设
- 与自动伸缩配合时表现可能很差（见下文「注意」）
```

### 新机制:trafficDistribution

```shell
apiVersion: v1
kind: Service
metadata:
  name: my-svc
spec:
  selector:
    app: my-app
  trafficDistribution: PreferSameZone
  ports:
    - port: 80
      targetPort: 8080
```

三种取值:

```shell
PreferSameZone   优先把流量送到与客户端【同一个 zone】的 endpoint
                 显式版本：语义清楚，推荐使用

PreferSameNode   优先把流量送到与客户端【同一个节点】的 endpoint
                 适合 DaemonSet 形态的本地代理 / 缓存场景

PreferClose      历史别名，等价于 PreferSameZone
                 名称有歧义（Close 到底是同节点还是同 zone 不清楚）,
                 因此【已废弃】，新配置不要再用
```

版本演进(这是选型时必须核对的):

```shell
spec.trafficDistribution 字段（特性门控 ServiceTrafficDistribution）
  alpha   1.30（默认 false）
  beta    1.31（默认 true）
  stable  1.33（默认 true，已锁定）

PreferSameZone / PreferSameNode 两个新取值（特性门控 PreferSameTrafficDistribution）
  alpha   1.33（默认 false）
  beta    1.34（默认 true）
  stable  1.35（默认 true，已锁定）
```

也就是说:**要到 1.35 及以上,`PreferSameZone` / `PreferSameNode` 才是无条件可用的**。1.33/1.34 上需要确认特性门控状态;更早的版本只能用 `PreferClose`。

两个重要行为:

```shell
1. 该字段【没有默认值】
   不设置时,由具体实现（kube-proxy 的模式等）决定默认行为,
   Kubernetes 不承诺任何具体分布策略

2. 它是【偏好】而非保证
   与 internalTrafficPolicy: Local 不同,它【永远不会丢包】
   本区没有可用 endpoint 时会正常回退到其他 zone 的 endpoint
```

### 与 Traffic Policy 的关系

这三个字段容易混淆,理清层次就好记:

```shell
internalTrafficPolicy        决定【哪些 endpoint 有资格】
externalTrafficPolicy: Local    Cluster = 全集群可用
                                Local   = 只有本节点上的 endpoint 可用,
                                          没有就【丢包】

trafficDistribution          决定在【有资格的 endpoint 中如何选择】
                              只做偏置,不做过滤,不会丢包
```

**Traffic Policy 的优先级更高**:设置 `internalTrafficPolicy: Local` 时,候选集已经只剩本节点 endpoint,`trafficDistribution` 没有多少发挥空间;而且使用了 `Local` 的 Service 也不走拓扑感知路由那套 hints 机制。

### 新老机制对比与共存

```shell
                     topology-mode 注解        trafficDistribution 字段
接口                 注解（字符串）            一等字段（枚举）
可控粒度             只能整体开关              可表达同 zone / 同节点偏好
回退行为             条件不满足则整体回退       始终是偏好，自然回退
当前状态             Beta 时代产物，将被移除     GA（1.33 起）
推荐度               仅在必须兼容旧版本时使用    推荐
```

**注意两者的优先级**:官方明确说明,**`service.kubernetes.io/topology-mode` 注解目前优先于 `spec.trafficDistribution` 字段**,并且该注解"将在未来的版本中被废弃并移除"。也就是说,同时配置两者时,注解说了算。迁移时记得把注解删掉,否则新字段不生效。

另外,新字段**并不完全复刻 `topology-mode=Auto` 的行为**,不能假设二者可以 1:1 替换。

还有一个已废弃的历史字段:

```shell
spec.topologyKeys     自 Kubernetes 1.21 起废弃
                      从未 GA,不要在任何新配置里使用
```

### 验证

```shell
# 1. 看 Service 的字段是否写进去了
kubectl get svc my-svc -o jsonpath='{.spec.trafficDistribution}{"\n"}'

# 2. 看 EndpointSlice 里有没有 hints（旧机制的关键证据）
kubectl get endpointslices -l kubernetes.io/service-name=my-svc -o yaml | grep -A5 hints

# 3. 确认节点有 zone 标签（缺一个就会整体回退）
kubectl get nodes -L topology.kubernetes.io/zone
kubectl get nodes -o json | \
  jq -r '.items[] | "\(.metadata.name)\t\(.metadata.labels["topology.kubernetes.io/zone"] // "NO-ZONE")"'

# 4. 确认 Pod 分布在多个 zone（只有分布均匀才有效果）
kubectl get pods -l app=my-app -o custom-columns=\
NAME:.metadata.name,NODE:.spec.nodeName --no-headers | \
while read p n; do echo "$p $(kubectl get node $n -o jsonpath='{.metadata.labels.topology\.kubernetes\.io/zone}')"; done

# 5. 从某个 zone 的节点上验证实际落点
kubectl run tmp --rm -it --image=nicolaka/netshoot \
  --overrides='{"spec":{"nodeSelector":{"topology.kubernetes.io/zone":"zone-a"}}}' \
  -- sh -c 'for i in $(seq 1 20); do curl -s my-svc | grep -o "zone=[a-z]*"; done | sort | uniq -c'
```

### 注意

1. **拓扑感知路由只影响「新连接」的选择,不改变已建立的连接**。长连接负载(数据库连接池、gRPC 长连接、HTTP/2)配上它意义有限 —— 连接一旦建立,后续所有请求都走原路。要做效果必须让客户端定期重连或使用 L7 负载均衡。
2. **流量可能集中到少数 endpoint,反而变慢**。这是最常见的反效果:本 zone 只有 2 个 Pod,却承担了本 zone 全部流量,排在队列里的时间远超跨区的那点延迟差。开启前先确认**每个 zone 都有足够的副本**,并配合 topologySpreadConstraints 让副本均匀分布。
3. **同 zone 不等于延迟最低**。云上同一 region 的不同 AZ 之间延迟差异可能很小,而本 AZ 的 Pod 恰好负载很高或资源紧张。此时拓扑路由会「稳定地把请求送到更慢的地方」。**上线前务必做 A/B 对比**,不要凭直觉认为同区一定更快。
4. **`PreferSameNode` 在节点资源不均时同样会放大问题**。它把流量锁到本节点的 Pod 上,如果本节点的 Pod 正被 CPU 限流,延迟会显著上升。它主要适合 DaemonSet 形态的本地代理、本地缓存这类**本就期望节点内闭环**的场景。
5. **只要有一个节点没有 zone 标签,整个 Service 就回退**。混合节点池、边缘节点、手工 join 的节点最容易漏打标签。排查「配置了却没效果」时,这是第一个要检查的点。
6. **`PreferClose` 这个名字有误导性**。它表达的是**同 zone**,不是同节点,也不是「更近的任意拓扑」。正是因为语义不清才被 `PreferSameZone` 取代。看到老配置里的 `PreferClose`,不要按字面理解。
7. **注解优先于字段**。同时存在 `service.kubernetes.io/topology-mode` 与 `spec.trafficDistribution` 时,**注解生效**。迁移到新字段时必须先删注解,否则会以为新字段没生效而反复排查。
8. **新字段不承诺任何默认行为**。不设置 `trafficDistribution` 时,具体分布由实现决定。不要依赖「不设置会怎样」的假设写业务逻辑。
9. **与 HPA / Cluster Autoscaler 的配合可能很糟**。hints 是按「各区节点容量比例」分配的,而伸缩是全局决策。可能出现「A 区扩容了但流量没涨、B 区流量堆积但不扩容」的错配。跨区伸缩场景建议用**按 zone 分别配置的 HPA**,而不是一个集群级 HPA。
10. **它不会丢包,这与 `externalTrafficPolicy: Local` 有本质区别**。`Local` 在本节点没有 endpoint 时会**直接丢弃**流量;`trafficDistribution` 只是偏好,一定会回退。需要「本节点没有就拒绝」的语义时,不要指望这个字段。
11. **版本要核对清楚**。`spec.trafficDistribution` 在 1.33 才 GA,`PreferSameZone` / `PreferSameNode` 要到 1.35 才稳定可用。写进平台的通用模板前,先确认目标集群的最低版本。
12. **kube-proxy 的实现模式会影响实际效果**。iptables/nftables/ipvs 各模式对 hints 的支持与实现细节不同,而 IPVS 模式本身已在废弃进程中(见 `ipvs` 页)。升级 kube-proxy 模式后,拓扑路由的实际行为可能变化,变更后要重新验证。

### 相关命令

- `service` — trafficDistribution 字段的宿主对象
- `cluster-autoscaler` — 跨区伸缩与拓扑路由的配合问题
- `kube-proxy` — 消费 hints 并决定实际转发目标
- `affinity` — 用拓扑分布约束保证副本在各 zone 均匀
- `ipvs` — kube-proxy 的实现模式,影响实际效果

### 参考链接

- [Topology Aware Routing](https://kubernetes.io/docs/concepts/services-networking/topology-aware-routing/)
- [Service 概念:流量分布控制](https://kubernetes.io/docs/concepts/services-networking/service/#traffic-distribution)
- [Virtual IPs 与 Service 代理](https://kubernetes.io/docs/reference/networking/virtual-ips/)
- [KEP-4444:Service 流量分布](https://kep.k8s.io/4444)
- [KEP-3015:PreferSameZone 与 PreferSameNode](https://kep.k8s.io/3015)
