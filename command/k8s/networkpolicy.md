networkpolicy
===

Kubernetes中控制Pod之间以及Pod与外部网络访问的策略对象

## 补充说明

**NetworkPolicy** 是 Kubernetes 的 Pod 级防火墙规则,用于声明「哪些 Pod 可以访问哪些 Pod 的哪些端口」。它用标签选择器圈定一组 Pod 作为策略的生效对象,再用 ingress(入站)和 egress(出站)规则描述允许的流量来源与去向。

NetworkPolicy 只是**规则声明**,执行者是 CNI 网络插件。**并非所有 CNI 都支持 NetworkPolicy** —— Calico、Cilium、Weave Net 支持,而最常用的 Flannel 默认不支持。在不支持的插件上创建 NetworkPolicy,apiserver 会正常接受,但没有任何效果,这类「静默失效」是最危险的坑。

### 支持的 CNI

```shell
Calico      支持,含全局策略 GlobalNetworkPolicy 与 DNS 策略
Cilium      支持,基于 eBPF,还提供 L7 策略与 Hubble 可观测性
Weave Net   支持
Antrea      支持
Flannel     不支持,创建策略后不生效
```

判断当前集群是否真正执行策略:

```shell
# 看集群用的什么 CNI
kubectl -n kube-system get pods | grep -Ei "calico|cilium|flannel|weave|antrea"

# 或直接看节点上的 CNI 配置
ls /etc/cni/net.d/
```

### 工作原理

```shell
1. 未匹配任何 NetworkPolicy 的 Pod  →  默认全通(可被任意来源访问,可访问任意目标)
2. 一旦某个 Pod 被策略选中         →  该 Pod 对应方向彻底变为「默认拒绝」
3. 只有被 ingress/egress 规则明确允许的流量才放行,规则之间是并集(OR)关系
```

关键点在于:**策略是白名单,不是黑名单**。选中之后先全禁,再按规则逐条放行,没有「拒绝某条」这种写法。

### 语法

```shell
kubectl get networkpolicy [名称] [选项]
kubectl describe networkpolicy [名称]
kubectl delete networkpolicy [名称]
```

### YAML 清单

默认拒绝所有入站流量(最常用的基线策略):

```shell
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: default-deny-ingress
  namespace: default
spec:
  podSelector: {}          # 空选择器表示选中命名空间内所有 Pod
  policyTypes:
    - Ingress
```

只允许来自同一命名空间内带指定标签的 Pod 访问:

```shell
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-from-frontend
  namespace: default
spec:
  podSelector:
    matchLabels:
      app: backend
  policyTypes:
    - Ingress
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: frontend
      ports:
        - protocol: TCP
          port: 8080
```

允许来自其他命名空间(注意 `namespaceSelector` 与 `podSelector` 的层级):

```shell
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-from-monitoring
  namespace: default
spec:
  podSelector:
    matchLabels:
      app: backend
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: monitoring
          podSelector:
            matchLabels:
              app: prometheus
      ports:
        - protocol: TCP
          port: 9090
```

`from` 数组中的多个元素是**并集**,写成两个元素就表示「monitoring 命名空间的任意 Pod」**或**「本命名空间内 app=frontend 的 Pod」都能访问;同一 `from` 元素内同时写 `namespaceSelector` 和 `podSelector` 则是**交集**,只放行 monitoring 命名空间里 app=prometheus 的 Pod。

按 IP 段放行,常用于放通外部负载均衡器或办公网:

```shell
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-from-cidr
spec:
  podSelector:
    matchLabels:
      app: web
  policyTypes:
    - Ingress
  ingress:
    - from:
        - ipBlock:
            cidr: 10.0.0.0/8
            except:
              - 10.10.0.0/16
      ports:
        - protocol: TCP
          port: 443
```

出站限制,只允许访问指定服务并放通 DNS:

```shell
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: backend-egress
  namespace: default
spec:
  podSelector:
    matchLabels:
      app: backend
  policyTypes:
    - Egress
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: mysql
      ports:
        - protocol: TCP
          port: 3306
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: kube-system
      ports:
        - protocol: UDP
          port: 53
```

### 常用操作

```shell
# 查看所有策略
kubectl get networkpolicy -A
kubectl get netpol -A

# 以 YAML 查看完整规则
kubectl get netpol default-deny-ingress -o yaml

# 查看某个 Pod 被哪些策略选中(需自行比对标签)
kubectl get netpol -A -o custom-columns=\
NAME:.metadata.name,NS:.metadata.namespace,SELECTOR:.spec.podSelector.matchLabels

# 测试连通性
kubectl run test --rm -it --image=busybox:1.36 --restart=Never -- sh
wget -qO- --timeout=3 http://backend-svc:8080
nc -zv mysql-svc 3306

# 使用 netshoot 工具箱排查(自带 curl/nc/dig/tcpdump)
kubectl run netshoot --rm -it --image=nicolaka/netshoot -- bash
```

### 排障

```shell
# 1. 确认 CNI 是否支持策略
kubectl -n kube-system get pods | grep -Ei "calico|cilium|flannel"

# 2. 确认 Pod 标签是否真的被策略选中
kubectl get pod backend-xxx --show-labels
kubectl get netpol allow-from-frontend -o jsonpath='{.spec.podSelector}'

# 3. Calico 用户可直接追踪策略判定过程
calicoctl get networkpolicy -A
kubectl -n kube-system logs -l k8s-app=calico-node --tail=100

# 4. Cilium 用户用 Hubble 观察丢包
kubectl -n kube-system exec ds/cilium -- hubble observe --verdict DROPPED --last 50

# 5. 验证策略前后的连通性差异,确认到底是策略生效还是服务本身不通
kubectl exec -it backend-xxx -- nc -zv mysql-svc 3306
```

### 注意

1. **策略是白名单语义,没有「拒绝」写法**。一旦 Pod 被 `podSelector` 选中且 `policyTypes` 含 `Ingress`,该 Pod 的入站就变为默认拒绝,只有 `ingress` 里列出的流量能进。写策略时要时刻想着「我禁掉了什么」。
2. **`policyTypes` 与规则要匹配**。只写了 `egress` 规则却漏写 `policyTypes: [Egress]`,出站策略不会生效;反之写了 `Egress` 却不给任何 `egress` 规则,该 Pod 的所有出站流量(含 DNS)会被全部掐断。
3. **限制出站时必须显式放通 DNS**。CoreDNS 在 `kube-system`,UDP/TCP 53 端口,漏掉这条的症状是「所有域名解析超时,但直接连 IP 是通的」。
4. **`podSelector` 与 `namespaceSelector` 的层级决定交集还是并集**。写在同一个数组元素里是 AND(该命名空间内的这些 Pod),写成数组的两个元素是 OR(这些命名空间的全部 Pod,或本命名空间内这些 Pod)。缩进错一格,语义完全相反。
5. **`namespaceSelector` 默认只认命名空间自带标签**。Kubernetes 1.21+ 会自动给每个命名空间打上 `kubernetes.io/metadata.name: <名称>`,老集群没有这个标签,需要手动 `kubectl label namespace`。
6. **策略是命名空间级别的,且不能跨命名空间生效**。NetworkPolicy 只能选中与自身同命名空间的 Pod,`podSelector` 无法选中别的命名空间的 Pod,要跨命名空间必须靠 `namespaceSelector`。
7. **被选中的 Pod 对「自己所在 Pod」的访问也受控**。同一 Deployment 的 Pod 之间互相调用同样要走规则放行,否则 Sidecar 与主容器之间、主从副本之间的通信都会被切断。
8. **NetworkPolicy 不作用于节点的 hostNetwork Pod**,也不管 kubelet 的健康检查、apiserver 到 Pod 的 webhook 调用等由节点发起的流量,具体行为依 CNI 而异。
9. **`hostNetwork: true` 的 Pod 不受策略约束**,还可能与节点上的其他流量冲突,排查时先确认这个字段。
10. **删除 NetworkPolicy 会立刻恢复全通**,而不是保持现状,生产环境变更前建议先在测试命名空间验证,并保留 YAML 便于回滚。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `service` — 被策略保护的后端访问入口
- `namespace` — 策略作用域所在的隔离单元
- `coredns` — 出站规则中必须显式放行的DNS服务
- `kubeadm` — Kubernetes集群安装与生命周期管理工具

### 参考链接

- [NetworkPolicy 官方文档](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
- [声明网络策略](https://kubernetes.io/docs/tasks/administer-cluster/declare-network-policy/)
- [NetworkPolicy API 参考](https://kubernetes.io/docs/reference/generated/kubernetes-api/v1.31/#networkpolicy-v1-networking-k8s-io)
