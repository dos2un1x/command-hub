kube-apiserver
===

KubernetesAPI服务器,集群的唯一入口

## 补充说明

**kube-apiserver命令** 是 Kubernetes 控制平面的前端,对外暴露 REST API,是集群中**唯一**直接读写 etcd 的组件。`kubectl`、kubelet、controller-manager、scheduler 以及所有 Operator 发出的请求,最终都落在它身上。

apiserver 是**无状态**的:所有状态都存在 etcd 里,自身可以横向扩展成多个实例。它同时承担认证、授权、准入控制、API 版本转换、watch 分发等职责,是整个集群名副其实的守门人。

在 kubeadm 集群中,apiserver 以静态 Pod 运行,清单文件是 `/etc/kubernetes/manifests/kube-apiserver.yaml`,由 kubelet 直接拉起 —— 这也意味着它的生死并不完全掌握在 Kubernetes 自己手里。

### 安装

apiserver 由 kubeadm 自动部署,通常无需手工安装:

```shell
# 查看静态 Pod 清单
sudo cat /etc/kubernetes/manifests/kube-apiserver.yaml

# 查看运行状态
kubectl get pods -n kube-system -l component=kube-apiserver
sudo crictl ps | grep kube-apiserver

# 二进制方式部署时可以直接查看帮助
kube-apiserver --help
```

### 语法

```shell
kube-apiserver [flags]
```

kubeadm 生成的清单里包含的常用标志:

```shell
--advertise-address=10.0.0.10                  对外通告的地址
--bind-address=0.0.0.0                         监听地址
--secure-port=6443                             HTTPS 端口
--etcd-servers=https://127.0.0.1:2379          etcd 地址
--etcd-cafile=/etc/kubernetes/pki/etcd/ca.crt
--client-ca-file=/etc/kubernetes/pki/ca.crt    校验客户端证书的 CA
--tls-cert-file=/etc/kubernetes/pki/apiserver.crt
--tls-private-key-file=/etc/kubernetes/pki/apiserver.key
--service-account-key-file=/etc/kubernetes/pki/sa.pub
--service-account-signing-key-file=/etc/kubernetes/pki/sa.key
--authorization-mode=Node,RBAC                 授权模式
--enable-admission-plugins=NodeRestriction     准入插件
--service-cluster-ip-range=10.96.0.0/12        Service 网段
--kubelet-preferred-address-types=InternalIP,ExternalIP,Hostname
--request-timeout=60s                          默认请求超时
--v=2                                          日志级别
```

### 健康检查

```shell
# 通过 kubectl 访问(需要认证)
kubectl get --raw /healthz
kubectl get --raw /livez
kubectl get --raw /readyz

# 带细节输出,定位到底哪一项不健康
kubectl get --raw "/livez?verbose"
kubectl get --raw "/readyz?verbose"

# 检查到 etcd 的连通性
kubectl get --raw /healthz/etcd

# 直接 curl(自签证书需要 -k)
curl -k https://127.0.0.1:6443/livez
curl -k https://127.0.0.1:6443/version
```

### 认证与授权排查

```shell
# 查看自己当前的身份
kubectl auth whoami

# 检查某个动作是否被允许
kubectl auth can-i create pods
kubectl auth can-i delete nodes --as=system:node:node1
kubectl auth can-i '*' '*' --all-namespaces

# 列出当前身份的全部权限
kubectl auth can-i --list
```

### 常用操作

```shell
# 查看聚合 API 是否可用(metrics-server 等依赖它)
kubectl get apiservices
kubectl get --raw /apis/metrics.k8s.io/v1beta1

# 查看 API 资源与版本
kubectl api-resources
kubectl api-versions
kubectl explain pod.spec.containers

# 用本地代理直接调用 REST API(kubectl 会替你带上凭据)
kubectl proxy --port=8001 &
curl -s http://127.0.0.1:8001/api/v1/namespaces/default/pods | head

# 查看请求优先级与公平性配置(高负载下保护 apiserver 的机制)
kubectl get flowschemas
kubectl get prioritylevelconfigurations
```

### 修改启动参数

```shell
# 1. 先备份,这一步不能省
sudo cp /etc/kubernetes/manifests/kube-apiserver.yaml /root/kube-apiserver.yaml.bak

# 2. 编辑;kubelet 监测到文件变化会自动重建静态 Pod
sudo vi /etc/kubernetes/manifests/kube-apiserver.yaml

# 3. 观察重建结果
kubectl get pods -n kube-system -l component=kube-apiserver -w
sudo crictl ps -a | grep kube-apiserver
sudo journalctl -u kubelet -n 50

# 4. 起不来就回滚
sudo cp /root/kube-apiserver.yaml.bak /etc/kubernetes/manifests/kube-apiserver.yaml
```

### 审计日志

在清单中追加以下标志即可开启审计:

```shell
--audit-policy-file=/etc/kubernetes/audit/policy.yaml
--audit-log-path=/var/log/kubernetes/audit.log
--audit-log-maxage=30
--audit-log-maxbackup=10
--audit-log-maxsize=100
```

审计策略文件示例:

```shell
apiVersion: audit.k8s.io/v1
kind: Policy
rules:
  - level: Metadata
    resources:
      - group: ""
        resources: ["secrets", "configmaps"]
  - level: RequestResponse
    verbs: ["create", "update", "patch", "delete"]
  - level: None
    users: ["system:kube-proxy"]
```

注意:审计日志目录还需要在清单的 `volumes` / `volumeMounts` 中从宿主机挂进容器,否则文件写不出来。

### 注意

1. **apiserver 是集群的单点**,它挂掉后 kubectl、kubelet 上报、控制器全部失灵,但**已运行的 Pod 和业务流量不受影响**。控制面故障不等于业务故障,先别慌。
2. **修改静态 Pod 清单前务必备份**。YAML 写错会导致 apiserver 起不来,而那时 kubectl 也连不上,你只能靠 `crictl` 和 `journalctl -u kubelet` 救场。
3. 8080 非安全端口从 1.20 起已彻底移除,`curl http://localhost:8080` 一定是连接被拒,所有请求都要走 6443 并携带认证。
4. `--service-cluster-ip-range` 创建后**不可更改**,且不能与节点网段、Pod 网段重叠,必须在规划阶段就定好。
5. `--authorization-mode` 必须包含 `Node`,否则 kubelet 无法上报节点状态,所有节点会集体变成 `NotReady`。
6. `--kubelet-preferred-address-types` 配置不当会让 `kubectl logs`、`exec`、`port-forward` 全部超时 —— 因为 apiserver 需要反向连上 kubelet 的 10250。
7. 多实例部署时 apiserver 之间不直接通信,靠 etcd 保证一致性,前端必须有负载均衡;kubeconfig 与 kubelet 的 `--control-plane-endpoint` 都应指向 LB 地址而不是某个具体实例。
8. `--request-timeout` 默认 60 秒,大规模 list 或慢客户端可能被中断,但盲目调大会造成连接堆积,应优先用分页(`--limit` + `continue`)解决。
9. 审计日志会产生大量磁盘 IO 和空间占用,生产环境必须配置轮转,并把 `--audit-log-path` 指向独立磁盘。
10. 开启 `PodSecurity` 等准入插件后,不合规的 Pod 会被直接拒绝。升级后突然「创建不了 Pod」,优先怀疑准入控制器。
11. apiserver 重建后需要一段时间(通常十几秒到一分钟)才 Ready,期间 kubectl 报 `connection refused` 属于正常现象。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `etcd` — 集群数据存储
- `kubelet` — 节点代理,负责启动 Pod
- `kubeadm` — Kubernetes集群安装工具
- `kubeconfig` — 集群访问配置

### 参考链接

- [kube-apiserver 命令行参考](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-apiserver/)
- [控制集群的访问](https://kubernetes.io/docs/concepts/security/controlling-access/)
- [准入控制器参考](https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/)
- [审计](https://kubernetes.io/docs/tasks/debug/debug-cluster/audit/)
- [聚合 API 扩展](https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/apiserver-aggregation/)
