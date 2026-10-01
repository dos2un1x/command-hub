etcd
===

Kubernetes集群的数据存储组件,保存集群全部状态

## 补充说明

**etcd命令** 是 Kubernetes 的数据库。它是一个分布式键值存储,集群里的每一个对象 —— Node、Pod、Service、Secret、ConfigMap、RBAC 规则 —— 最终都以 `/registry/...` 开头的键存在 etcd 里。etcd 丢数据,集群就等于被重置。

apiserver 是**唯一**直接读写 etcd 的组件,其他组件都通过 apiserver 间接访问。因此在 kubeadm 集群中,etcd 与 apiserver 一样以静态 Pod 运行在控制平面节点上,数据目录通过 hostPath 挂载到宿主机的 `/var/lib/etcd`。

日常运维 etcd 只需盯住三件事:**看健康状态**、**备份快照**、**恢复快照**。这三件事都靠 `etcdctl` 完成。

### 安装

etcd 本体由 kubeadm 以静态 Pod 部署,但 `etcdctl` 命令行需要单独安装:

```shell
# Debian/Ubuntu
sudo apt-get install -y etcd-client

# 或从 GitHub 下载二进制
ETCD_VER=v3.5.15
curl -LO https://github.com/etcd-io/etcd/releases/download/${ETCD_VER}/etcd-${ETCD_VER}-linux-amd64.tar.gz
tar xzf etcd-${ETCD_VER}-linux-amd64.tar.gz
sudo mv etcd-${ETCD_VER}-linux-amd64/etcdctl /usr/local/bin/

# 验证(etcd 3.4 之后默认就是 v3 API,更早的版本需要显式声明)
etcdctl version
export ETCDCTL_API=3
```

### 语法

```shell
etcdctl [global options] command [command options]
```

连接集群需要四个参数,证书就是 kubeadm 生成的 etcd 证书:

```shell
export ETCDCTL_API=3
export ETCDCTL_ENDPOINTS=https://127.0.0.1:2379
export ETCDCTL_CACERT=/etc/kubernetes/pki/etcd/ca.crt
export ETCDCTL_CERT=/etc/kubernetes/pki/etcd/server.crt
export ETCDCTL_KEY=/etc/kubernetes/pki/etcd/server.key

etcdctl endpoint health
```

写成一行(适合放进脚本和文档):

```shell
ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  endpoint health
```

### 在容器内执行

控制平面节点上不一定装了 etcdctl,可以直接进 etcd 的静态 Pod 执行:

```shell
kubectl -n kube-system exec etcd-<node-name> -- etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  endpoint health
```

这是官方文档推荐的做法,省去在宿主机装 etcdctl 的麻烦。

### 健康检查

```shell
# 单节点健康
etcdctl endpoint health

# 表格输出,一次看全
etcdctl endpoint health --write-out=table --cluster

# 成员状态:包含 leader、DB 大小、配额、RAFT 索引
etcdctl endpoint status --write-out=table --cluster

# 成员列表
etcdctl member list --write-out=table

# 通过 apiserver 检查,不需要 etcd 证书
kubectl get --raw /healthz/etcd
```

### 备份(快照)

```shell
# 保存快照(建议带时间戳)
sudo ETCDCTL_API=3 etcdctl snapshot save \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  /backup/etcd-snapshot-$(date +%Y%m%d-%H%M%S).db

# 校验快照的完整性与元数据(Revision、键总数、大小)
# 注意用 etcdutl 而非 etcdctl —— 见下方说明
etcdutl snapshot status /backup/etcd-snapshot-20260918-120000.db --write-out=table

# 证书必须一起备份,没有它快照无法恢复
sudo tar czf /backup/etcd-certs-$(date +%F).tar.gz /etc/kubernetes/pki/etcd/
```

放进 crontab 做定时备份:

```shell
# 每天 2 点备份,保留 7 天
0 2 * * * root ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  snapshot save /backup/etcd-$(date +\%F).db \
  && find /backup -name 'etcd-*.db' -mtime +7 -delete
```

### 恢复(单节点)

```shell
# 1. 移出控制平面静态 Pod 清单,停止 apiserver 与 etcd
sudo mv /etc/kubernetes/manifests/kube-apiserver.yaml /tmp/
sudo mv /etc/kubernetes/manifests/etcd.yaml /tmp/

# 2. 确认旧进程已退出
sudo crictl ps | grep -E 'etcd|kube-apiserver'

# 3. 恢复到一个全新的空目录(目录非空会直接报错)
sudo ETCDCTL_API=3 etcdutl snapshot restore /backup/etcd-snapshot.db \
  --data-dir=/var/lib/etcd-restore

# 4. 若 etcd 以非 root 用户运行,需要修正属主
sudo chown -R etcd:etcd /var/lib/etcd-restore

# 5. 把 etcd 静态 Pod 的数据目录 hostPath 指向新目录
sudo vi /tmp/etcd.yaml
#   volumes:
#   - hostPath:
#       path: /var/lib/etcd-restore
#       type: DirectoryOrCreate
#     name: etcd-data

# 6. 移回清单,恢复控制平面
sudo mv /tmp/etcd.yaml /etc/kubernetes/manifests/
sudo mv /tmp/kube-apiserver.yaml /etc/kubernetes/manifests/

# 7. 验证
kubectl get nodes
etcdctl endpoint health
```

多成员集群恢复时,需要为每个成员分别指定集群拓扑:

```shell
sudo ETCDCTL_API=3 etcdutl snapshot restore /backup/etcd-snapshot.db \
  --name=cp1 \
  --initial-cluster=cp1=https://10.0.0.11:2380,cp2=https://10.0.0.12:2380,cp3=https://10.0.0.13:2380 \
  --initial-cluster-token=etcd-cluster \
  --initial-advertise-peer-urls=https://10.0.0.11:2380 \
  --data-dir=/var/lib/etcd-restore
```

### 查看数据

```shell
# 列出所有命名空间
etcdctl get /registry/namespaces --prefix --keys-only

# 查看某个 Service 的存储内容
etcdctl get /registry/services/specs/default/kubernetes

# 统计键总数
etcdctl get /registry --prefix --keys-only | grep -c '^/registry'

# 限制返回数量
etcdctl get /registry/pods --prefix --keys-only --limit=20
```

### 维护

```shell
# 查看告警(磁盘配额写满会触发 NOSPACE)
etcdctl alarm list

# 解除告警(必须先 defrag 释放空间,否则很快会再次触发)
etcdctl alarm disarm

# 整理碎片,回收已删除键占用的空间(会阻塞该成员的读写)
etcdctl defrag --cluster

# 查看 DB 大小与配额
etcdctl endpoint status --write-out=table
```

### 注意

0. **`snapshot restore` 与 `snapshot status` 请用 `etcdutl`,不要用 `etcdctl`。** etcd **3.6 已移除** `etcdctl` 的这两个子命令,继续照旧教程写会直接报错。`snapshot save` 两个工具都能做,`etcdctl` 的那个仍可用。另需注意:**官方 etcd 容器镜像不包含 `etcdutl` 二进制**,恢复时要么用宿主机上的 etcdutl,要么从 etcd 的 release tarball 里取。Kubernetes 1.34 起 kubeadm 支持 etcd 3.6,老集群升级前请先确认这一条。

1. **绝对不要直接拷贝 `/var/lib/etcd` 目录当备份**。运行中的 etcd 数据目录包含 WAL 和正在落盘的 SST 文件,拷贝得到的是一份不一致的镜像,恢复时可能直接报错,更糟的是静默损坏。必须用 `etcdctl snapshot save`,它产生的是 MVCC 一致快照。
2. **快照必须连同 `/etc/kubernetes/pki/etcd/` 证书一起备份**。只有快照没有 CA 与成员证书,新集群无法完成认证,快照等于一张废纸。
3. `snapshot restore` 的目标 `--data-dir` **必须是空目录或不存在**,目录里已有数据会直接报错;恢复前先把旧数据移走,不要就地覆盖。
4. 恢复会**回滚到快照时刻**,该时间点之后创建的所有资源全部消失。执行前务必确认快照的时间戳与 Revision。
5. 默认配额 `--quota-backend-bytes` 为 2GiB,写满后触发 NOSPACE 告警,集群进入**只读**状态,表现为所有写操作失败。临时靠 `alarm disarm` + `defrag` 抢救,治本要调大配额或清理数据。
6. 集群成员数必须是**奇数**(1、3、5)。Raft 需要多数派才能写入,两个成员的集群容错能力与一个成员相同,却更容易脑裂。
7. `defrag` 会阻塞该成员的读写,必须**逐个成员**执行,不要同时进行,也不要放在业务高峰。
8. etcd 对磁盘延迟极其敏感,官方要求 fsync 延迟在 10ms 以内。使用机械盘或 NFS 会直接拖垮集群,表现为 apiserver 频繁超时。
9. 节点间**时间必须同步**。时钟漂移会导致选举异常,生产环境务必配置 NTP 或 chrony。
10. 快照里包含集群全部 Secret(含 ServiceAccount Token 与 TLS 私钥),拿到快照等同于拿到集群最高权限,必须加密存储并严格限制访问。
11. kubeadm 集群的 etcd 数据目录是 `/var/lib/etcd`,而 `kubeadm reset` **不会**清理它。重建集群前必须手动删除,否则会带着旧状态启动。
12. 单控制平面集群的 etcd 就是单点故障,生产环境至少应部署 3 个控制平面节点。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kubeadm` — Kubernetes集群安装工具
- `kube-apiserver` — 集群 API 服务器
- `crictl` — 容器运行时调试工具

### 参考链接

- [为 Kubernetes 运维 etcd 集群](https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/)
- [kubeadm 高可用拓扑](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/ha-topology/)
- [etcd 灾难恢复指南](https://etcd.io/docs/v3.5/op-guide/recovery/)
- [etcd 维护与压缩](https://etcd.io/docs/v3.5/op-guide/maintenance/)
