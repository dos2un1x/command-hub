api-priority-fairness
===

Kubernetes API 优先级与公平性,防止单个客户端打垮 apiserver

## 补充说明

**api-priority-fairness**(API Priority and Fairness,简称 APF)是 kube-apiserver 内置的过载保护机制。在它出现之前,apiserver 只用一个全局并发计数器挡请求 —— 所有客户端共享同一个名额池,一个跑飞的 Operator、一段疯狂 list 的脚本,或者一批正在滚动的节点,就能把名额占满,连 kubelet 上报心跳、控制器选主都排不进来,集群随之"假死"。

APF 把这个池子拆成两级结构:

- `FlowSchema`(流模式):按请求的**身份**与**目标资源**给请求分类,决定它属于哪一条流;
- `PriorityLevelConfiguration`(优先级):给每一档请求分配**独立的并发额度**(座位,seat),并用公平排队算法避免少数流把同档的其他流挤死。

于是"某个客户端打垮 apiserver"从全局饿死变成了"只有它自己那一档被限流",kubelet、控制器、系统组件彼此之间有硬隔离。

该特性自 **v1.29 起 GA(Stable)**,API 组为 `flowcontrol.apiserver.k8s.io/v1`;`kube-apiserver` 的 `--enable-priority-and-fairness` **默认为 true**,要关掉必须显式写 `=false`。

### 核心概念

| 概念 | 含义 |
|---|---|
| Seat(座位) | 一个并发单位。一个请求可能占用多个座位,`list` 这类昂贵请求占得更多,单个请求最多 10 个座位 |
| FlowSchema | 把请求分类到某个优先级;同一 FlowSchema 内还会按 distinguisher 再拆成多条"流" |
| PriorityLevelConfiguration | 定义这一档的名义座位数(nominalConcurrencyShares)和超限后的动作(排队或拒绝) |
| Distinguisher | 分流依据,`ByUser` 或 `ByNamespace`;不设置则不区分流(所有请求共享一个队列集合) |
| 队列(Queue) | 只有 `limitResponse.type: Queue` 的档位才有队列,队列满或等待超时才拒绝 |

### 并发额度是怎么算的

开启 APF 之后,`--max-requests-inflight` 与 `--max-mutating-requests-inflight` **不再各自作为上限**,两者的和成为服务器的总并发上限(ServerCL),再按各优先级的 `nominalConcurrencyShares`(NCS)按比例切分:

```shell
NominalCL(i) = ceil( ServerCL * NCS(i) / sum(NCS) )
```

默认 400 + 200 = 600 个座位,内置优先级 NCS 合计 245,因此 global-default 的名义并发为 `ceil(600 * 20 / 245) = 49`。

名义额度还会随负载**动态借用**:`lendablePercent` 决定这一档最多能借出多少比例给别的档,`borrowingLimitPercent` 限制它自己能借入多少;不设置 `borrowingLimitPercent` 相当于借入无上限。

### 内置的 PriorityLevelConfiguration

| 名称 | 类型 | NCS | lendablePercent | 超限行为 |
|---|---|---|---|---|
| exempt | Exempt | 0 | 0 | 不限流、不排队 |
| node-high | Limited | 40 | 25 | Queue 64 队列 / handSize 6 / 队长 50 |
| system | Limited | 30 | 33 | Queue 64 / 6 / 50 |
| leader-election | Limited | 10 | 0 | Queue 16 / 4 / 50 |
| workload-high | Limited | 40 | 50 | Queue 128 / 6 / 50 |
| workload-low | Limited | 100 | 90 | Queue 128 / 6 / 50 |
| global-default | Limited | 20 | 50 | Queue 128 / 6 / 50 |
| catch-all | Limited | 5 | 0 | **Reject**(直接拒绝,不排队) |

`exempt` 与 `catch-all` 是**强制(mandatory)**对象,apiserver 保证它们的 spec 存在;其余为**建议(suggested)**对象。

### 内置的 FlowSchema

| 名称 | matchingPrecedence | distinguisher | 指向的优先级 |
|---|---|---|---|
| exempt | 1 | 无 | exempt(仅 system:masters 组) |
| probes | 2 | 无 | exempt(/healthz、/readyz、/livez 的 GET) |
| system-leader-election | 100 | ByUser | leader-election |
| system-node-high | 400 | ByUser | node-high |
| system-nodes | 500 | ByUser | system |
| kube-controller-manager | 800 | ByNamespace | workload-high |
| kube-scheduler | 800 | ByNamespace | workload-high |
| kube-system-service-accounts | 900 | ByNamespace | workload-high |
| service-accounts | 9000 | ByUser | workload-low |
| global-default | 9900 | ByUser | global-default |
| catch-all | 10000 | ByUser | catch-all |

### 查看配置

```shell
# 列出全部流模式与优先级
kubectl get flowschemas
kubectl get prioritylevelconfigurations

# 看某一个的完整 spec
kubectl get flowschema system-nodes -o yaml
kubectl get prioritylevelconfiguration workload-low -o yaml

# 按 precedence 排序,观察匹配顺序
kubectl get flowschemas -o custom-columns=\
NAME:.metadata.name,PRECEDENCE:.spec.matchingPrecedence,PLC:.spec.priorityLevelConfiguration.name

# 确认版本与是否启用
kubectl api-resources | grep flowcontrol
kubectl get --raw /apis/flowcontrol.apiserver.k8s.io/v1 | head
```

### 排查:请求被分到了哪一档

apiserver 的每个响应都带两个响应头,分别指向命中的 FlowSchema 与优先级:

```shell
X-Kubernetes-PF-FlowSchema-UID: <uid>
X-Kubernetes-PF-PriorityLevel-UID: <uid>

# UID 到名字的映射(响应头里故意不写名字,避免泄露对象信息)
kubectl get flowschemas -o custom-columns="uid:{metadata.uid},name:{metadata.name}"
kubectl get prioritylevelconfigurations -o custom-columns="uid:{metadata.uid},name:{metadata.name}"
```

调试端点会实时导出 APF 内部状态:

```shell
# 每个优先级的执行/排队/拒绝计数
kubectl get --raw /debug/api_priority_and_fairness/dump_priority_levels

# 每个队列的状态(座位占用、队首等待时间)
kubectl get --raw /debug/api_priority_and_fairness/dump_queues

# 当前所有请求(含用户名、动词、资源),排障时最有用
kubectl get --raw '/debug/api_priority_and_fairness/dump_requests?includeRequestDetails=1'
```

关键指标(前缀 `apiserver_flowcontrol_`):

```shell
apiserver_flowcontrol_rejected_requests_total{priority_level,flow_schema,reason}
apiserver_flowcontrol_dispatched_requests_total{priority_level,flow_schema}
apiserver_flowcontrol_current_inqueue_requests{priority_level,flow_schema}
apiserver_flowcontrol_current_executing_requests{priority_level,flow_schema}
apiserver_flowcontrol_current_executing_seats{priority_level,flow_schema}
apiserver_flowcontrol_request_queue_length_after_enqueue{priority_level,flow_schema}
apiserver_flowcontrol_request_wait_duration_seconds{priority_level,flow_schema,execute}
apiserver_flowcontrol_nominal_limit_seats{priority_level}
apiserver_flowcontrol_current_limit_seats{priority_level}
```

```shell
# 最近 5 分钟被限流最多的档位
topk(5, sum by (priority_level, flow_schema) (
  rate(apiserver_flowcontrol_rejected_requests_total[5m])))

# 排队等待 p99 是否已经变差
histogram_quantile(0.99, sum by (le, priority_level) (
  rate(apiserver_flowcontrol_request_wait_duration_seconds_bucket[5m])))
```

### 自定义 FlowSchema

给某个租户或某个 Operator 单独划一档,避免它和其他工作负载互相影响:

```shell
# 先建优先级:给 20 个名义座位,允许借出 50%
apiVersion: flowcontrol.apiserver.k8s.io/v1
kind: PriorityLevelConfiguration
metadata:
  name: ci-runners
spec:
  type: Limited
  limited:
    nominalConcurrencyShares: 20
    lendablePercent: 50
    limitResponse:
      type: Queue
      queuing:
        queues: 64
        handSize: 6
        queueLengthLimit: 50
```

```shell
# 再把 CI 命名空间里的服务账号导到这一档
# precedence 取 5000:比 service-accounts(9000)优先,但排在系统组件之后
apiVersion: flowcontrol.apiserver.k8s.io/v1
kind: FlowSchema
metadata:
  name: ci-runners
spec:
  matchingPrecedence: 5000
  priorityLevelConfiguration:
    name: ci-runners
  distinguisherMethod:
    type: ByNamespace
  rules:
    - subjects:
        - kind: ServiceAccount
          serviceAccount:
            namespace: ci
            name: "*"
      resourceRules:
        - verbs: ["*"]
          apiGroups: ["*"]
          resources: ["*"]
          clusterScope: true
        - verbs: ["*"]
          apiGroups: ["*"]
          resources: ["*"]
          namespaces: ["*"]
```

### 注意

1. **`matchingPrecedence` 数值越小优先级越高**,取值范围 `[1,10000]`,不填默认 1000。多个 FlowSchema 同时匹配时,取数值**最小**的那一个 —— 很多人按"数字大 = 重要"的直觉写,结果自定义规则永远抢不过内置规则。
2. **内置的 suggested 对象带 `apf.kubernetes.io/autoupdate-spec: "true"` 注解**,apiserver 会周期性地把它们的 spec 拉回默认值:你手工改的 `global-default`、`service-accounts` 在 apiserver 重启后可能被覆盖。要长期生效,先把注解改成 `"false"` 再改 spec。
3. `exempt` 与 `catch-all` 是 **mandatory** 对象,apiserver 强制执行自动更新:删掉会被重建,改 spec 会被覆盖;唯一被允许修改的是 `exempt` 的 `nominalConcurrencyShares` 与 `lendablePercent`。不要试图绕过它们。
4. **关掉 APF 的后果是回到全局单一限额**:`--enable-priority-and-fairness=false` 之后,`--max-requests-inflight` 与 `--max-mutating-requests-inflight` 重新变成各自独立的上限,隔离性消失。反过来,开了 APF 却只调这两个 flag,调的是**总座位数**而不是某一档的份额。
5. 两个 in-flight flag 之和必须为正,否则 apiserver 直接启动失败,报错形如 `invalid configuration: MaxRequestsInFlight=0 and MaxMutatingRequestsInFlight=0; they must add up to something positive`。这类"改了 flag 起不来"的问题要到 `journalctl -u kubelet` / 静态 Pod 日志里看。
6. **新增自定义优先级会稀释所有档位**。因为 `NominalCL(i) = ceil(ServerCL * NCS(i) / sum(NCS))`,每加一个 NCS,分母就变大。给自定义档位写一个很大的 NCS(比如 1000),等于从 system 和 node-high 嘴里抢座位。
7. `catch-all` 的 `limitResponse.type` 是 **Reject**,不是 Queue —— 没被任何 FlowSchema 匹配到的流量在过载时会**直接收到 429**,而不是排队等待。如果你的自定义 FlowSchema 漏掉了某类请求,它们就会掉进这里。
8. **长时请求(exec / attach / port-forward / `logs -f`)不受 APF 限制**,它们绕过过滤器;而 **watch 请求受 APF 限制**(跳过 APF 时反而连 in-flight 限额也不管)。所以"apiserver 很卡但 APF 指标正常"时,先看看是不是堆了一大把 exec。
9. 小心**优先级反转**:聚合 apiserver(`APIService`)、admission webhook 回调本集群 apiserver 时,处理请求的座位被占满,而回调又需要新的座位,两边互等就是死锁。官方给出的缓解手段是给回调方的请求单独提优先级、设为 exempt,或者在 B 集群上关掉 APF。
10. 排查限流一定要看 `reason` 标签:`queue-full`(队列已满)、`concurrency-limit`、`time-out`(排队超时)、`estimated-seats` 等含义完全不同,直接决定是调大队列还是调大座位数。
11. **多实例 apiserver 之间不共享队列**,每个副本各自维护一套座位与队列。副本数翻倍不等于总并发翻倍 —— 客户端的连接可能集中在某一个副本上,反而更容易撞上单副本的限额。
12. `flowcontrol.apiserver.k8s.io/v1beta3` 在 v1.29 已废弃。若还有旧工具依赖它,用 `--runtime-config=flowcontrol.apiserver.k8s.io/v1beta3=false` 显式关闭,而不要指望它能一直存在。
13. APF 只保护 apiserver 自身,**保护不了 etcd**。它让请求在 apiserver 层排队,但如果所有档位都在大量写入、etcd 扛不住,要去看 etcd 的 `backend_commit` 延迟和 compaction 设置,而不是继续调 APF。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kube-apiserver` — 集群 API 服务器
- `etcd` — 集群数据存储
- `kubelet` — 节点代理,负责启动 Pod
- `priority-class` — Pod 调度优先级,与 APF 不是一回事
- `resource-quota` — 命名空间级资源配额,与 APF 互补

### 参考链接

- [API 优先级和公平性](https://kubernetes.io/docs/concepts/cluster-administration/flow-control/)
- [流控调试参考](https://kubernetes.io/docs/reference/debug-cluster/flow-control/)
- [kube-apiserver 命令行参考](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-apiserver/)
- [FlowSchema API 参考](https://kubernetes.io/docs/reference/kubernetes-api/flow-control-resources/)
