coredns
===

Kubernetes集群内提供服务发现与域名解析的DNS服务器

## 补充说明

**CoreDNS** 是 Kubernetes 默认的集群 DNS,以 Deployment 形式运行在 `kube-system` 命名空间,通过一个名为 `kube-dns` 的 Service 对外提供服务。它监听 Service 与 EndpointSlice 的变化,为集群内的 Service 和 Pod 动态生成 DNS 记录,是所有服务间通过域名互相调用的基础。

CoreDNS 用插件链(Corefile)组织功能:每个插件负责一类查询,依次处理。默认配置里最关键的三个插件是 `kubernetes`(处理集群内域名)、`forward`(转发外部域名到上游 DNS)、`cache`(缓存)。

**集群 DNS 一挂,几乎所有服务间调用都会失败**,因为业务代码里写的是 `http://order-svc:8080` 而不是 IP。它属于典型的「平时无感,坏了就是 P0」的组件。

### 域名解析规则

```shell
<service>.<namespace>.svc.cluster.local     普通 Service,返回 ClusterIP
<pod-ip-dashed>.<namespace>.pod.cluster.local   Pod 记录,IP 中的点换成横线
<service>.<namespace>.svc                   同命名空间可省略后缀
<service>                                   同命名空间内直接用服务名
```

以 `default` 命名空间中的 `nginx-svc` 为例:

```shell
nginx-svc                                   # 同命名空间
nginx-svc.default                           # 跨命名空间
nginx-svc.default.svc                       # 更完整
nginx-svc.default.svc.cluster.local         # FQDN,绝对可靠
```

Headless Service(`clusterIP: None`)的 A 记录会返回全部后端 Pod IP;StatefulSet 的每个 Pod 还会得到 `<pod-name>.<service-name>.<namespace>.svc.cluster.local` 这样的稳定域名。

### 部署结构

```shell
kube-system/coredns          Deployment,默认 2 副本
kube-system/kube-dns         Service,ClusterIP,DNS 查询指向它
kube-system/coredns          ConfigMap,存放 Corefile
kube-system/coredns-autoscaler  按节点规模自动调整副本数
```

### 语法

```shell
kubectl -n kube-system get configmap coredns -o yaml
kubectl -n kube-system rollout restart deployment coredns
kubectl -n kube-system edit configmap coredns
```

### Corefile 配置

默认的 Corefile,全部配置都在一个 ConfigMap 里:

```shell
apiVersion: v1
kind: ConfigMap
metadata:
  name: coredns
  namespace: kube-system
data:
  Corefile: |
    .:53 {
        errors                      # 错误记录到日志
        health {                    # 健康检查端点
            lameduck 5s
        }
        ready                       # 就绪探针端点
        kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods insecure           # Pod 记录模式:insecure 允许任意 Pod 查询
            fallthrough in-addr.arpa ip6.arpa
            ttl 30
        }
        prometheus :9153            # 暴露监控指标
        forward . /etc/resolv.conf  # 外部域名转发给节点上的 DNS
        cache 30                    # 缓存 30 秒
        loop                        # 检测转发环路
        reload                      # ConfigMap 变更后自动重载
        loadbalance                 # 轮询返回多个 A 记录
    }
```

自定义内部域名解析,把公司内网域名交给指定 DNS:

```shell
data:
  Corefile: |
    .:53 {
        errors
        health
        ready
        kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods insecure
            fallthrough
            ttl 30
        }
        prometheus :9153
        forward . /etc/resolv.conf
        cache 30
        loop
        reload
        loadbalance
    }
    corp.example.com:53 {
        errors
        cache 30
        forward . 10.0.0.53 10.0.0.54
    }
```

静态 hosts 记录,用于临时把某个域名指向固定 IP:

```shell
data:
  Corefile: |
    .:53 {
        errors
        health
        hosts custom.hosts {
            10.0.0.100 internal.example.com
            10.0.0.101 legacy.example.com
            fallthrough
        }
        kubernetes cluster.local in-addr.arpa ip6.arpa {
            pods insecure
            fallthrough
            ttl 30
        }
        forward . /etc/resolv.conf
        cache 30
        reload
    }
  custom.hosts: |
    10.0.0.100 internal.example.com
```

### 常用操作

```shell
# 查看 CoreDNS 运行状态
kubectl -n kube-system get pods -l k8s-app=kube-dns -o wide
kubectl -n kube-system get svc kube-dns

# 查看配置
kubectl -n kube-system get configmap coredns -o yaml

# 修改配置后重载(需几秒到半分钟生效)
kubectl -n kube-system edit configmap coredns
kubectl -n kube-system rollout restart deployment coredns

# 查看 DNS 查询日志(需在 Corefile 中加 log 插件)
kubectl -n kube-system logs -l k8s-app=kube-dns --tail=100 -f

# 查看副本数与自动扩缩状态
kubectl -n kube-system get deployment coredns
kubectl -n kube-system get deployment coredns-autoscaler -o yaml
```

### 解析测试

```shell
# 起一个带 dig 的调试 Pod(推荐 nicolaka/netshoot)
kubectl run dnsutils --rm -it --image=nicolaka/netshoot -- bash

# 集群内域名
dig nginx-svc.default.svc.cluster.local
nslookup nginx-svc.default.svc.cluster.local

# 指定 DNS 服务器测试
dig @10.96.0.10 nginx-svc.default.svc.cluster.local

# 外部域名(验证 forward 插件是否正常)
dig www.baidu.com

# 查看 Pod 实际使用的 DNS 配置
cat /etc/resolv.conf
```

Pod 中的 `/etc/resolv.conf` 典型内容:

```shell
search default.svc.cluster.local svc.cluster.local cluster.local
nameserver 10.96.0.10
options ndots:5
```

### 排障

```shell
# 1. CoreDNS Pod 是否存活
kubectl -n kube-system get pods -l k8s-app=kube-dns
kubectl -n kube-system describe pod -l k8s-app=kube-dns

# 2. CoreDNS 日志中的错误
kubectl -n kube-system logs -l k8s-app=kube-dns --tail=200

# 3. kube-dns Service 的后端是否正常
kubectl -n kube-system get endpoints kube-dns

# 4. 从业务 Pod 验证解析链路
kubectl exec -it <pod> -- cat /etc/resolv.conf
kubectl exec -it <pod> -- nslookup kubernetes.default

# 5. 常见报错 "no such host" 或 "i/o timeout"
#    前者多为域名拼写或命名空间错误,后者多为 NetworkPolicy 掐断了到 53 端口的出站流量
kubectl get networkpolicy -A

# 6. CoreDNS 是否被 OOMKilled(内存上限过低)
kubectl -n kube-system get pod -l k8s-app=kube-dns \
  -o jsonpath='{.items[*].status.containerStatuses[*].lastState}'
```

### 注意

1. **CoreDNS 不是 Kubernetes 自带的唯一选择,但改回去很麻烦**。`kube-dns` 这个 Service 名字被 kubelet 硬编码用于注入 `nameserver`,即使换成别的 DNS 实现也要保留该名称。
2. **`options ndots:5` 是性能问题的常见来源**。域名中点少于 5 个时,解析器会先挨个拼接 search 域,导致一次 `www.baidu.com` 查询实际产生多次无效查询。对外部域名建议在业务里写带结尾点的 FQDN(`www.baidu.com.`)绕开搜索域。
3. **不是所有 Pod 都走 CoreDNS**。`dnsPolicy: Default` 的 Pod 直接用节点 DNS;`dnsPolicy: None` 的 Pod 完全自定义;只有默认的 `ClusterFirst` 才由 CoreDNS 解析。
4. **`hostNetwork: true` 的 Pod 无法使用集群 DNS**,因为它的 `/etc/resolv.conf` 继承自节点。这类 Pod 里访问 Service 域名会直接失败,必须改用 ClusterIP 或开启 `dnsPolicy: ClusterFirstWithHostNet`。
5. **修改 Corefile 后重载有延迟**。`reload` 插件轮询 ConfigMap 变更,通常需要 30 秒左右;急着生效就 `rollout restart`,但会短暂中断解析,生产环境建议至少 2 副本。
6. **NetworkPolicy 限制出站时最容易忘掉 DNS**。默认拒绝出站的策略必须放通到 `kube-system` 的 UDP/TCP 53,否则表现是「所有域名解析超时,但用 IP 直连一切正常」。
7. **CoreDNS 副本数不足会成为集群瓶颈**。大集群需要靠 `coredns-autoscaler` 扩容,单副本时 Pod 重启期间全集群解析会抖动。
8. **CoreDNS 内存随 Service/Pod 数量增长**。集群规模上万 Pod 时默认的 170Mi 内存上限会导致频繁 OOMKilled,表现为随机性的解析失败。
9. **`pods insecure` 允许任何客户端查询任意 Pod 的 A 记录**,存在轻微信息泄露风险;安全要求高时可改为 `pods disabled`。
10. **DNS 故障会伪装成业务故障**。大量服务同时报「连接超时」而 IP 直连正常时,应优先怀疑 DNS 而不是网络插件。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `service` — CoreDNS解析的目标对象
- `networkpolicy` — 限制出站时须放行DNS端口
- `configmap` — 存放Corefile配置
- `kubeadm` — Kubernetes集群安装与生命周期管理工具

### 参考链接

- [Service 与 Pod 的 DNS](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)
- [使用 CoreDNS 进行服务发现](https://kubernetes.io/docs/tasks/administer-cluster/coredns/)
- [调试 DNS 解析](https://kubernetes.io/docs/tasks/administer-cluster/dns-debugging-resolution/)
- [CoreDNS 官方文档](https://coredns.io/manual/toc/)
