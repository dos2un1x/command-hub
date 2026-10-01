cert-rotation
===

Kubernetes集群证书轮换,涵盖kubeadm证书续期、kubelet证书自动轮换与CA替换

## 补充说明

Kubernetes 集群是一套**全量基于 TLS 的分布式系统**,控制平面组件之间、kubelet 与 apiserver 之间、etcd 成员之间全部靠证书互相认证。证书过期是自建集群最经典的「到点集体趴窝」故障:`kube-apiserver` 起不来、`kubectl` 报 `x509: certificate has expired`、节点集体 `NotReady`。

kubeadm 集群的证书分三类,轮换方式完全不同:

| 类别 | 位置 | 默认有效期 | 谁负责轮换 |
| --- | --- | --- | --- |
| 控制平面证书 | `/etc/kubernetes/pki/`、`*.conf` | 1 年 | `kubeadm certs renew`(手工或随 upgrade) |
| CA 证书 | `/etc/kubernetes/pki/ca.crt`、`etcd/ca.crt` | 10 年 | kubeadm **不自动轮换**,需手工流程 |
| kubelet 证书 | `/var/lib/kubelet/pki/` | 1 年 | kubelet 自己轮换(客户端证书默认开) |

控制平面证书的完整清单:

```shell
/etc/kubernetes/pki/ca.crt                       集群根 CA(签发 apiserver、kubelet 客户端等)
/etc/kubernetes/pki/apiserver.crt                kube-apiserver 服务端证书
/etc/kubernetes/pki/apiserver-kubelet-client.crt apiserver 访问 kubelet 的客户端证书
/etc/kubernetes/pki/apiserver-etcd-client.crt    apiserver 访问 etcd 的客户端证书
/etc/kubernetes/pki/front-proxy-ca.crt           front-proxy 专用 CA
/etc/kubernetes/pki/front-proxy-client.crt       aggregation 层客户端证书
/etc/kubernetes/pki/etcd/ca.crt                  etcd 独立 CA
/etc/kubernetes/pki/etcd/server.crt              etcd 服务端证书
/etc/kubernetes/pki/etcd/peer.crt                etcd 成员间通信证书
/etc/kubernetes/pki/etcd/healthcheck-client.crt  etcd 健康检查客户端证书
/etc/kubernetes/pki/sa.key  /etc/kubernetes/pki/sa.pub   ServiceAccount token 签名密钥

/etc/kubernetes/admin.conf           集群管理员 kubeconfig
/etc/kubernetes/super-admin.conf     super-admin kubeconfig(1.29 起新增)
/etc/kubernetes/kubelet.conf          kubelet 用的 kubeconfig(内含客户端证书)
/etc/kubernetes/controller-manager.conf
/etc/kubernetes/scheduler.conf
```

### 查看有效期

```shell
# 一次性列出所有证书的到期时间与剩余天数,最常用的巡检命令
sudo kubeadm certs check-expiration

# 输出形如:
# CERTIFICATE                EXPIRES                  RESIDUAL TIME   CERTIFICATE AUTHORITY   EXTERNALLY MANAGED
# admin.conf                 Sep 01, 2027 08:00 UTC   364d            ca                      no
# apiserver                  Sep 01, 2027 08:00 UTC   364d            ca                      no
# apiserver-kubelet-client   Sep 01, 2027 08:00 UTC   364d            ca                      no
# front-proxy-client         Sep 01, 2027 08:00 UTC   364d            front-proxy-ca          no
# etcd-server                Sep 01, 2027 08:00 UTC   364d            etcd-ca                 no

# 用 openssl 逐个核对(不依赖 kubeadm)
sudo openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -dates -subject -issuer
sudo openssl x509 -in /etc/kubernetes/pki/ca.crt -noout -dates

# 检查 kubelet 自己的证书
sudo openssl x509 -in /var/lib/kubelet/pki/kubelet-client-current.pem -noout -dates
```

### kubeadm certs 子命令

```shell
kubeadm certs check-expiration                   查看所有证书状态
kubeadm certs renew <name>                       续期单个证书
kubeadm certs renew all                          续期全部叶子证书
kubeadm certs certificate-key                    生成 --certificate-key(用于 join 上传证书)
kubeadm certs generate-csr                       只生成 CSR,交给外部 CA 签
```

`renew` 可接受的 <name> 完整列表:

```shell
all
admin.conf
apiserver
apiserver-etcd-client
apiserver-kubelet-client
controller-manager.conf
etcd-healthcheck-client
etcd-peer
etcd-server
front-proxy-client
scheduler.conf
super-admin.conf
```

注意这个列表里**没有 `ca`** —— CA 不在 `renew` 的范围内,这是设计使然,不是遗漏。

### 手动续期

```shell
# 1. 备份(CA 私钥丢了就是灾难)
sudo cp -a /etc/kubernetes/pki /etc/kubernetes/pki.bak
sudo cp -a /etc/kubernetes/*.conf /etc/kubernetes/conf.bak

# 2. 续期
sudo kubeadm certs renew all

# 3. 必须重启控制平面组件(静态 Pod),否则仍在用旧证书
sudo systemctl restart kubelet
kubectl -n kube-system delete pod -l component=kube-apiserver
kubectl -n kube-system delete pod -l component=kube-controller-manager
kubectl -n kube-system delete pod -l component=kube-scheduler
kubectl -n kube-system delete pod -l component=etcd

# 4. 更新本地 kubeconfig(admin.conf 变了)
sudo cp /etc/kubernetes/admin.conf ~/.kube/config
sudo chown $(id -u):$(id -g) ~/.kube/config

# 5. 复查
sudo kubeadm certs check-expiration
```

`renew` 的行为是**无条件续期**,不看是否临近过期;SAN 等属性沿用已有证书文件的内容,不需要重新提供。

### 自动续期:kubeadm upgrade

`kubeadm upgrade apply` / `kubeadm upgrade node` 会**顺带续期所有 kubeadm 管理的证书**,所以保持版本跟进本身就是一种轮换策略。长期不升级的集群,证书到期就会集体失效。

也可以把续期挂到定时任务上:

```shell
# /etc/cron.d/kubeadm-cert-renew
0 3 1 * * root kubeadm certs renew all && systemctl restart kubelet
```

### kubelet 证书轮换

kubelet 有两套证书,轮换机制完全不同 —— 这是最容易被混淆的地方:

```shell
# 客户端证书:访问 apiserver 时证明「我是这个节点」
/var/lib/kubelet/pki/kubelet-client-current.pem     ← 软链接,指向当前证书
/var/lib/kubelet/pki/kubelet-client-2026-01-01-00-00-00.pem

# 服务端证书:kube-apiserver 反向访问 kubelet(exec/logs/port-forward)时用
/var/lib/kubelet/pki/kubelet.crt                    ← 默认是自签名的
/var/lib/kubelet/pki/kubelet.key
```

客户端证书由 `KubeletConfiguration` 的 `rotateCertificates` 控制:

```shell
# kubeadm 生成的 /var/lib/kubelet/config.yaml 里默认就有这一行
sudo grep -n "rotateCertificates" /var/lib/kubelet/config.yaml
# rotateCertificates: true
```

轮换流程:证书剩余有效期进入 **30%–10%** 区间时,kubelet 用 bootstrap token 或已有凭据发起 CSR,由 kube-controller-manager 自动批准并签发新证书(签发时长由 `--cluster-signing-duration` 决定,默认 1 年)。

服务端证书由另一个开关控制,且**默认关闭**:

```shell
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
serverTLSBootstrap: true      # 默认 false,kubeadm 不会帮你打开
```

打开后 kubelet 会发起 `kubernetes.io/kubelet-serving` 类型的 CSR,这类 CSR **不会被自动批准**,需要人工放行:

```shell
kubectl get csr
# NAME        AGE   SIGNERNAME                     REQUESTOR              CONDITION
# csr-abc12   10s   kubernetes.io/kubelet-serving  system:node:node1      Pending

kubectl describe csr csr-abc12 | grep -A5 "Subject\|DNS Names\|IP Addresses"
kubectl certificate approve csr-abc12
```

### CA 轮换

kubeadm **不提供** CA 轮换命令,只能手工做。核心思路是「先双向信任,再逐点切换」:

```shell
# 1. 生成新 CA
sudo openssl genrsa -out /etc/kubernetes/pki/ca-new.key 4096
sudo openssl req -x509 -new -nodes -key /etc/kubernetes/pki/ca-new.key \
  -subj "/CN=kubernetes" -days 3650 -out /etc/kubernetes/pki/ca-new.crt

# 2. 合并新旧 CA 成一个信任包(过渡期两边都认)
cat /etc/kubernetes/pki/ca.crt /etc/kubernetes/pki/ca-new.crt > /etc/kubernetes/pki/ca-combined.crt

# 3. 把合并后的信任包分发到【所有节点】(含 kubelet 的 ca.crt)
sudo cp /etc/kubernetes/pki/ca.crt /etc/kubernetes/pki/ca.crt.old
sudo cp /etc/kubernetes/pki/ca-combined.crt /etc/kubernetes/pki/ca.crt
sudo systemctl restart kubelet

# 4. 用新 CA 重签所有组件证书(此时 ca.crt 是合并包,ca-new.key 是新私钥)
sudo kubeadm init phase certs all --config kubeadm-config.yaml

# 5. 验证一切正常后,收敛为只剩新 CA,再滚动重启所有节点
```

### 注意

1. **kubeadm 签发的叶子证书默认只有 1 年**,CA 是 10 年。可用 `certificateValidityPeriod` 与 `caCertificateValidityPeriod`(Go duration 格式,单位最长到 `h`)在 `ClusterConfiguration` 中调整。视图里的 `Sep 01, 2027` 就是一年后的时间点。
2. **`kubeadm certs renew` 之后必须重启控制平面组件**。kube-apiserver、controller-manager、scheduler、etcd 都是以静态 Pod 运行的进程,证书文件被替换后进程不会自动重载 —— 不重启的话,续期等于没做,到期照样挂。官方 `kubeadm certs renew` 的说明里明确写了 "restart control-plane components"。
3. **`--rotate-certificates` 与 `--rotate-server-certificates` 是两回事**。前者管 kubelet 访问 apiserver 的**客户端**证书,后者管 kubelet 对外提供服务的**服务端**证书。kubeadm 默认只开前者,后者对应配置文件里的 `serverTLSBootstrap: true`,而且它产生的 CSR 需要 `kubectl certificate approve` 才会生效。
4. **这两个特性早已 GA,不再是特性门控**。`RotateKubeletClientCertificate` / `RotateKubeletServerCertificate` 在 1.19 就已 GA 并锁定为 true,老教程里让你加 `--feature-gates=RotateKubeletServerCertificate=true` 的写法完全过时。今天的开关是 kubelet 配置文件里的两个布尔字段。
5. **`renew` 不会动 CA**。`kubeadm certs renew all` 只是用现有 CA 重签叶子证书;CA 本身到期(10 年)或私钥泄露,必须走上文的手工 CA 轮换流程,那是一次需要停机窗口的**重大变更**。
6. **CA 轮换必须把新 CA 分发到所有节点**。kubelet 用 `/etc/kubernetes/pki/ca.crt` 校验 apiserver 证书,只换控制平面不换节点,节点会立刻 `NotReady`,日志里是 `x509: certificate signed by unknown authority`。过渡期务必用「合并信任包」而不是直接替换。
7. **外部 CA 模式下 kubelet 客户端证书无法自动轮换**。若集群是用 `--external-ca` 建的、`/etc/kubernetes/pki/ca.key` 已删除,则 kube-controller-manager 无法签发 kubelet 客户端证书,轮换链条断裂,证书到期需要人工重新签发并分发。
8. **`kubectl` 报 `x509: certificate has expired or is not yet valid` 不一定是集群挂了**。先看是本地 `~/.kube/config` 里的管理员证书过期,还是 apiserver 服务端证书过期 —— 前者只要 `kubeadm certs renew admin.conf` 并更新本地 kubeconfig,后者才需要重启控制平面。
9. **HA 集群要逐台滚动续期**。多控制平面节点上,`kubeadm certs renew all` 加重启要**一次一台、从主节点开始**做,避免同时重启导致 apiserver 全挂。所有控制平面节点都要执行,漏掉任何一台都会在到期日出现单点故障。
10. **续期前先备份 `/etc/kubernetes/pki` 与 `*.conf`**。CA 私钥一旦损坏且无备份,整个集群只能重建 —— 这不是夸张,是自建集群最常见的不可恢复事故。
11. **`super-admin.conf` 是 1.29 新增的**。它用 `system:masters` 组身份直连 apiserver,不经过本地 kubeconfig 的 `admin.conf`;`renew` 列表里单独有一项,漏续它会留下一个到期就失效的应急入口。
12. **`kubeadm certs certificate-key` 生成的 key 是敏感凭据**。`kubeadm join --certificate-key` 用它解密上传到 `kube-system/kubeadm-certs` Secret 的证书;这个 Secret 默认有效期 2 小时,过期后 join 会报 `the certificate key is invalid`。

### 相关命令

- `kubeadm` — 集群安装与证书管理的主要工具
- `kubelet` — 节点代理,客户端证书自带轮换
- `kubectl` — 查看与批准 CSR
- `etcd` — 独立 CA 与成员间证书
- `serviceaccount` — SA 签名密钥与证书体系的关联

### 参考链接

- [Certificate Management with kubeadm](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-certs/)
- [kubeadm certs 命令参考](https://kubernetes.io/docs/reference/setup-tools/kubeadm/kubeadm-certs/)
- [kubelet TLS 引导](https://kubernetes.io/docs/reference/access-authn-authz/kubelet-tls-bootstrapping/)
- [TLS 证书轮换](https://kubernetes.io/docs/tasks/tls/certificate-rotation/)
- [PKI 证书与要求](https://kubernetes.io/docs/setup/best-practices/certificates/)
