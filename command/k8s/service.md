service
===

Kubernetes中为一组Pod提供稳定访问入口与负载均衡的抽象资源

## 补充说明

**Service** 是 Kubernetes 对一组 Pod 的抽象,它为这些 Pod 提供一个固定的虚拟 IP 与 DNS 名称,并在后端 Pod 之间做四层负载均衡。Pod 会被反复创建销毁,IP 随之变化,而 Service 的名字和地址保持不变,调用方因此不必关心后端实例的增减。

Service 本身不是进程,也不负责转发流量。真正干活的是每个节点上的 **kube-proxy**,它监听 Service 与 EndpointSlice 的变化,把转发规则写进 iptables 或 IPVS,由内核完成 DNAT。所以 Service 不通时,排查方向通常是 selector 匹配、Endpoints 列表和 kube-proxy 规则。

### 类型

```shell
ClusterIP      默认类型,分配一个仅集群内可达的虚拟 IP,适合集群内部服务互调
NodePort       在 ClusterIP 基础上,于每个节点上开放一个静态端口(默认 30000-32767)
LoadBalancer   在 NodePort 基础上,向云厂商申请外部负载均衡器,生产环境对外暴露的标准做法
ExternalName   不做任何代理,把 Service 名称 CNAME 到集群外的域名,常用于引用外部数据库
```

此外还有一种特殊形态:**Headless Service**,即把 `clusterIP` 显式设为 `None`。它不分配虚拟 IP,不做负载均衡,DNS 查询会直接返回全部后端 Pod 的 IP 列表,供 StatefulSet 绑定固定网络标识或客户端自行选择。

### 语法

```shell
kubectl get service [名称] [选项]
kubectl expose deployment [名称] --port=80 --target-port=8080
kubectl port-forward service/[名称] [本地端口]:[服务端口]
kubectl delete service [名称]
```

### YAML 清单

ClusterIP 是最常见的形态:

```shell
apiVersion: v1
kind: Service
metadata:
  name: nginx-svc
  namespace: default
spec:
  type: ClusterIP
  selector:
    app: nginx
  ports:
    - name: http
      protocol: TCP
      port: 80            # Service 自身暴露的端口,集群内访问用的就是它
      targetPort: 8080    # 容器实际监听的端口,不写则默认等于 port
```

NodePort,集群外可通过 `<任意节点IP>:30080` 访问:

```shell
apiVersion: v1
kind: Service
metadata:
  name: nginx-nodeport
spec:
  type: NodePort
  selector:
    app: nginx
  ports:
    - port: 80
      targetPort: 8080
      nodePort: 30080     # 省略则从 30000-32767 中随机分配
```

LoadBalancer,由云控制器向厂商申请 ELB/SLB:

```shell
apiVersion: v1
kind: Service
metadata:
  name: nginx-lb
spec:
  type: LoadBalancer
  selector:
    app: nginx
  ports:
    - port: 80
      targetPort: 8080
  externalTrafficPolicy: Local   # 保留客户端真实 IP,但流量只发给本节点上的 Pod
```

Headless Service,配合 StatefulSet 使用:

```shell
apiVersion: v1
kind: Service
metadata:
  name: mysql-headless
spec:
  clusterIP: None        # 关键:不分配虚拟 IP
  selector:
    app: mysql
  ports:
    - port: 3306
      targetPort: 3306
```

不带 selector 的 Service,后端由手工维护的 EndpointSlice 提供,适合把外部中间件纳入集群管理:

```shell
apiVersion: v1
kind: Service
metadata:
  name: legacy-api
spec:
  ports:
    - port: 8080
```

```shell
apiVersion: discovery.k8s.io/v1
kind: EndpointSlice
metadata:
  name: legacy-api-1
  labels:
    kubernetes.io/service-name: legacy-api
addressType: IPv4
ports:
  - port: 8080
endpoints:
  - addresses:
      - 192.168.1.100
      - 192.168.1.101
```

### 常用操作

```shell
# 查看所有 Service(含 ClusterIP)
kubectl get svc -A
kubectl get svc -A -o wide

# 查看详情,关注 Selector 与 Events
kubectl describe svc nginx-svc

# 快速用 Deployment 暴露一个 Service
kubectl expose deployment nginx --port=80 --target-port=8080 --type=NodePort

# 查看后端 Pod 列表(推荐 EndpointSlice)
kubectl get endpoints nginx-svc
kubectl get endpointslices -l kubernetes.io/service-name=nginx-svc

# 端口转发到本地调试
kubectl port-forward svc/nginx-svc 8080:80

# 删除 Service
kubectl delete svc nginx-svc
```

### 集群内访问验证

```shell
# 起一个临时 Pod,退出后自动删除
kubectl run test --rm -it --image=busybox:1.36 --restart=Never -- sh

wget -qO- http://nginx-svc                              # 同命名空间
wget -qO- http://nginx-svc.default                      # 跨命名空间
wget -qO- http://nginx-svc.default.svc.cluster.local    # 全限定域名
nslookup nginx-svc.default.svc.cluster.local            # 只解析不请求
```

### 排障

```shell
# 1. ENDPOINTS 为 <none>:说明 selector 没匹配到任何 Ready 的 Pod
kubectl get svc nginx-svc -o wide
kubectl get endpoints nginx-svc

# 2. 对比 Pod 标签与 Service selector 是否一致
kubectl get pods --show-labels
kubectl get svc nginx-svc -o jsonpath='{.spec.selector}'

# 3. Pod 是否 Ready —— NotReady 的 Pod 会被从 Endpoints 摘除
kubectl get pods -o wide

# 4. kube-proxy 是否健康
kubectl -n kube-system get pods -l k8s-app=kube-proxy
kubectl -n kube-system logs -l k8s-app=kube-proxy --tail=50

# 5. 检查内核转发规则(iptables 模式)
sudo iptables -t nat -L KUBE-SERVICES -n | grep <ClusterIP>
```

### 注意

1. **`port` 与 `targetPort` 必须分清楚**。`port` 是 Service 对外暴露的端口,`targetPort` 是容器实际监听的端口,后者必须与容器的 `containerPort` 一致。写反的典型症状是 Service 能解析但连接超时。
2. **selector 不匹配是「Service 没反应」的第一大原因**。selector 与 Pod 的 `metadata.labels` 必须完全一致(大小写、拼写、层级),写错的 Service 不会报错,只是 Endpoints 永远为空。
3. **Pod 的 readinessProbe 失败会被从 Endpoints 摘掉**。此时 Pod 还活着、`kubectl get pods` 也看得见,但流量不会进来,排查时不能只看 Pod 状态。
4. **`type: LoadBalancer` 在自建集群里会一直 `EXTERNAL-IP: <pending>`**。它依赖云厂商的 cloud-controller-manager,裸机环境需要额外部署 MetalLB 或改用 NodePort + Ingress。
5. **未指定 `nodePort` 时由系统从 30000-32767 分配**,该范围可在 apiserver 的 `--service-node-port-range` 中调整;手动指定时要避开已占用端口,否则创建失败。
6. **Headless Service 的 DNS 返回全部 Pod IP**,客户端若只取第一个地址就是自己实现负载均衡,需要自行处理失败重试。StatefulSet 的 `serviceName` 必须指向一个已存在的 Headless Service,否则域名解析不出来。
7. **`externalTrafficPolicy: Local` 会保留客户端源 IP**,但只有运行着后端 Pod 的节点才会接收流量,节点数少于副本数时可能造成负载不均,同时健康检查失败会导致整体不可用。
8. **同一 Service 内多个端口必须各自命名**,`name` 字段必填且互不相同,否则创建时会被校验拒绝。
9. **不带 selector 的 Service 不会被自动填充 Endpoints**,必须手工维护 EndpointSlice,漏建或写错标签的表现与 selector 写错一模一样。
10. **Service 的 ClusterIP 在创建后不可修改**,需要改地址只能删除重建,重建期间业务会中断。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kube-proxy` — 实现Service转发规则的节点代理
- `coredns` — 为Service名称提供集群内DNS解析
- `ingress` — 在Service之上提供七层入口路由
- `kubeadm` — Kubernetes集群安装与生命周期管理工具

### 参考链接

- [Service 官方文档](https://kubernetes.io/docs/concepts/services-networking/service/)
- [Headless Service](https://kubernetes.io/docs/concepts/services-networking/service/#headless-services)
- [Service 与 Pod 的 DNS](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)
