cluster-backup
===

Kubernetes集群要备份哪些东西:etcd、证书、CRD与自定义资源、PV数据与集群配置

## 补充说明

**集群备份**要回答的是「清单」问题:一个 Kubernetes 集群里,到底有哪些东西丢了会让集群回不来?

答案是五类:**etcd 数据**、**控制面证书与密钥**、**CRD 定义与自定义资源**、**PV 里的实际数据**、**集群配置与集群外依赖**。只做其中一两项,恢复出来的东西一定是残缺的 —— 最常见的是「etcd 恢复了但 PV 是空的」和「资源恢复了但 CRD 没恢复」。

本页讲**备份什么、各自怎么备**;频率、保留与演练策略见 `backup-strategy`,整体方法论见 `disaster-recovery`。

### 备份清单

```shell
类别                        内容                                  备份手段
etcd 数据                   /var/lib/etcd 的一致性快照            etcdctl snapshot save
控制面证书与密钥            /etc/kubernetes/pki/**                文件级复制 + 离线加密存放
加密配置                    EncryptionConfiguration 及其密钥      文件级复制(与证书同等重要)
集群配置                    kubeadm-config / kubelet-config 等     kubectl get -o yaml
CRD 定义                    CustomResourceDefinition              kubectl get crd -o yaml
自定义资源                  CR 实例(各种 operator 的对象)       kubectl get <cr> -A -o yaml
内置 API 对象               Deployment/Service/Secret/RBAC 等     Velero 或 kubectl 导出
PV 数据                     卷里的真实字节                         CSI 快照 / Kopia / 应用级导出
集群外依赖                  镜像仓库、DNS、LB、IaC、流水线        各自体系的备份
```

### etcd 快照

etcd 保存集群全部状态,它是**唯一一份无法从其他来源重建的数据**。快照命令必须带齐证书:

```shell
ETCDCTL_API=3 etcdctl snapshot save /backup/etcd-$(date +%F-%H%M).db \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key

# 校验快照完整性(离线操作用 etcdutl,etcd 3.6 起 etcdctl 不再提供)
etcdutl snapshot status /backup/etcd-2026-09-18-1200.db --write-out=table

# 定时快照:kubeadm 不提供内置的定时快照能力,必须自己实现
# 常见做法是在 kube-system 建一个 CronJob:nodeSelector 选中控制平面节点、
# 容忍 control-plane 的 NoSchedule 污点、hostPath 只读挂载 /etc/kubernetes/pki/etcd,
# 并把 concurrencyPolicy 设为 Forbid;宿主机上也可以用 systemd timer 代替
kubectl create job --from=cronjob/etcd-backup etcd-backup-test -n kube-system
```

三个集群组件的 etcd 快照要**分别**做:每个控制平面节点上的 etcd 是独立成员,快照是各自的数据副本。恢复时通常取最近的一份即可,但保留多份能避免「最新快照恰好是损坏的那份」。

### 控制面证书与密钥

**这是最常被漏掉、又最无法重建的一类。** 集群 CA 的私钥一旦丢失,整个集群的证书体系就无法延续:

```shell
/etc/kubernetes/pki/ca.crt            集群根 CA 证书 —— kubelet 客户端证书、apiserver 证书都由它签发
/etc/kubernetes/pki/ca.key            集群根 CA 私钥 —— 丢了就无法再签发任何新证书
/etc/kubernetes/pki/sa.key             ServiceAccount token 签名私钥
/etc/kubernetes/pki/sa.pub             ServiceAccount token 验证公钥
/etc/kubernetes/pki/front-proxy-ca.*  聚合层(metrics-server、APIService)用的 CA
/etc/kubernetes/pki/etcd/ca.*         etcd 集群自己的 CA
/etc/kubernetes/pki/apiserver-etcd-client.*   apiserver 访问 etcd 的客户端证书
```

备份时用 `kubeadm` 自带的检查确认清单完整:

```shell
sudo kubeadm certs check-expiration
sudo tar czf pki-$(date +%F).tar.gz -C /etc/kubernetes pki
sha256sum pki-$(date +%F).tar.gz > pki-$(date +%F).tar.gz.sha256
```

这个 tar 包**必须加密后异地存放**。它等价于集群的最高权限 —— 拿到 `ca.key` 的人可以伪造任意身份的客户端证书。

### 加密配置

如果 apiserver 启用了静态加密(kubeadm 文档示例路径 `/etc/kubernetes/enc/encryption-config.yaml`),**配置文件里的密钥必须与 etcd 快照一起备份**:

```shell
kubectl -n kube-system get pod kube-apiserver-<node> \
  -o jsonpath='{.spec.containers[0].command}' | tr ',' '\n' | grep encryption

# 找到 --encryption-provider-config 指向的文件,连同其引用的密钥一起归档
sudo tar czf enc-$(date +%F).tar.gz -C /etc/kubernetes enc
```

只恢复 etcd 快照而不恢复加密密钥,结果是 `Secret` 全部无法解密 —— apiserver 会报解密失败,依赖 Secret 的组件全部起不来。这与「数据没备份」的后果一样严重。

### CRD 与自定义资源

自定义资源是备份里最容易只做一半的部分:**只备 CR 不备 CRD,恢复时对象会被 apiserver 直接拒绝**。

```shell
# CRD 定义(集群级)
kubectl get crd -o yaml > crds.yaml

# 逐个导出 CR 实例(先看有哪些 CRD)
kubectl get crd -o custom-columns='NAME:.metadata.name,GROUP:.spec.group,PLURAL:.spec.names.plural'
kubectl get certificates.cert-manager.io -A -o yaml > certificates.yaml
kubectl get prometheuses.monitoring.coreos.com -A -o yaml > prometheuses.yaml
```

Velero 能自动处理这两层(Velero 备份时若 `--include-cluster-resources=true`,CRD 会随备份一起走),但要注意**默认值**:不带该参数时,集群级资源可能不被包含。

### PV 数据

PV 数据的备份方式取决于存储类型,选择顺序大致是:

```shell
CSI 卷快照        有 CSI Snapshotter 时最省事,但快照与原卷同存储系统,不能当异地备份
文件级备份        Velero node-agent(Kopia)逐文件读取上传,适合自建存储、跨云
存储层复制        Longhorn 备份到 S3/NFS、Ceph RBD mirror,由存储系统负责
应用级导出        mysqldump / pg_dump / redis RDB,一致性最好但需要业务配合
```

Velero 的默认行为要特别注意:

```shell
# 默认:只备份资源清单,不备份 PV 内容
velero backup create full

# 备份 PV 内容之一:文件系统备份(需要 --use-node-agent)
velero backup create full-fs --default-volumes-to-fs-backup

# 备份 PV 内容之二:CSI 快照(需安装时带 --features=EnableCSI)
velero backup create full-csi --snapshot-volumes=true --snapshot-move-data
```

用 CSI 快照时,`VolumeSnapshotClass` 需要带标签 `velero.io/csi-volumesnapshot-class: "true"` 才会被 Velero 选中;没有这个标签,备份会「成功」但卷数据是空的。

### 集群配置

这些对象不属于任何业务命名空间,但决定了集群能否被重建:

```shell
kubectl -n kube-system get cm kubeadm-config -o yaml > kubeadm-config.yaml
kubectl -n kube-system get cm kubelet-config -o yaml > kubelet-config.yaml

# 集群级资源清单
kubectl get storageclass,priorityclass,ingressclass,csidriver,runtimeclass -o yaml > cluster-scoped.yaml
kubectl get clusterrole,clusterrolebinding -o yaml > rbac-cluster.yaml
kubectl get validatingwebhookconfiguration,mutatingwebhookconfiguration -o yaml > webhooks.yaml
kubectl get apiservice -o yaml > apiservices.yaml

# 节点的关键配置(二进制安装或手工调优过的集群)
sudo tar czf kubelet-conf-$(date +%F).tar.gz /var/lib/kubelet/config.yaml /etc/kubernetes/kubelet.conf
```

CNI 的配置也在这里:Calico/Cilium 的 `ConfigMap`、`IPPool`/`CiliumNodeConfig` 等 CR 与节点上的 `/etc/cni/net.d/` 配置,漏掉会导致新集群「Pod 起来了但互相不通」。集群外依赖同样要列进清单 —— 镜像仓库、DNS 记录、负载均衡配置、IaC 代码、CI/CD 流水线定义。

### 恢复顺序

恢复不是「一条命令把所有 YAML 灌进去」,顺序错了会失败:

```shell
1. Namespace(其他资源都要落在里面)
2. CRD 定义
3. 集群级资源:ClusterRole/ClusterRoleBinding、StorageClass、PriorityClass
4. 密钥类:Secret、ConfigMap、ServiceAccount
5. CR 实例(依赖 CRD 与 operator)
6. 工作负载:Deployment/StatefulSet/DaemonSet
7. 入口与策略:Service、Ingress、NetworkPolicy
8. 准入类:ValidatingWebhookConfiguration / MutatingWebhookConfiguration(最后)
```

第 8 步放最后是有原因的:如果先把 `failurePolicy: Fail` 的 webhook 配置恢复回去,而它的后端 Pod 还没就绪,后续所有资源创建都会被拦截,恢复过程直接卡死。

### 校验与存放

```shell
# 快照完整性
etcdutl snapshot status /backup/etcd.db --write-out=table

# 归档完整性
sha256sum -c pki-2026-09-18.tar.gz.sha256

# 至少验证一次「能打开」:把快照恢复到一个临时 data-dir,看 etcd 能否启动
etcdutl snapshot restore /backup/etcd.db --data-dir=/var/lib/etcd-verify
```

存放遵守 3-2-1:至少 3 份、2 种介质、1 份异地。备份文件本身**默认不加密**(`pki` 与 `enc` 归档除外,它们必须加密),而对象存储桶的权限往往比集群本身更容易被攻破。

### 注意

1. **etcd 快照必须连同证书一起备份**。只有 `.db` 文件而丢了 `/etc/kubernetes/pki/etcd/` 时,重建集群需要重新签发整套 etcd 证书,而且旧快照里 apiserver 的客户端证书与新 CA 不匹配,恢复过程会反复卡在 TLS 握手上。
2. **只备份 etcd 不备份 PV 数据等于没备份**。etcd 里只有 PVC/PV 的声明,卷里的字节不在其中。恢复出来的 PVC 会绑定到空卷,数据库组件能启动但数据是空的 —— 这种「恢复成功但业务数据没了」比直接失败更危险。
3. **`etcdctl snapshot restore` 在 etcd 3.6 已被移除**。etcd 3.5 起该命令标记废弃并推荐 `etcdutl`,3.6 正式删除(`etcdctl defrag --data-dir` 与 `snapshot status` 同样移除)。Kubernetes 1.34 起 kubeadm 支持 etcd 3.6,沿用老教程的 `etcdctl snapshot restore` 会直接报错。另外 etcd 官方镜像里**不含** `etcdutl`,需要在宿主机上单独下载对应版本的二进制。
4. **etcd 快照只能在同版本 etcd 上恢复**。etcd 3.5 无法启动 3.6 写出的数据,跨大版本恢复要先按官方升级路径处理,不能直接灌库。
5. **CRD 必须先于 CR 恢复**。顺序反了,apiserver 会因为「no matches for kind」丢弃这些对象,而 `kubectl apply` 在批量导入时往往只报一行错,很容易被忽略,最终表现为「恢复完了但自定义资源全没了」。
6. **恢复后 ServiceAccount token 与证书可能失效**。控制面的 `sa.key`/`sa.pub` 与快照不匹配时,已签发的 token 无法通过验证;集群 CA 变化时,原节点 kubelet 的客户端证书全部作废。跨集群恢复要用同一套 PKI,否则必须重新签发并重新加入节点。
7. **加密配置丢失会让 Secret 变成乱码**。启用了静态加密的集群,`EncryptionConfiguration` 与其密钥必须与 etcd 快照成对保存;只恢复数据的后果是 apiserver 无法解密 Secret。
8. **跨版本恢复不保证兼容**。低版本 apiserver 不认识高版本备份里的字段与 CRD schema 版本,恢复会大面积报 `unknown field` 或校验失败。目标集群版本应不低于备份来源。
9. **快照中的 Node 与 PV 对象不能直接搬**。它们带着原集群的节点名、IP、VolumeHandle,恢复到新集群后要么无效要么造成误导,跨集群恢复应排除 `nodes`、`events` 这类对象。
10. **StorageClass 名字不同会让 PVC 恢复后一直 Pending**。Velero 在目标集群发现同名 StorageClass 会跳过恢复;跨集群时若存储类名字不一致,需要改名或提前在目标集群建好同名类。
11. **备份文件默认不加密**。包含 Secret 的备份等于一份明文凭据集合,对象存储桶需要最小权限 + 服务端加密 + 版本控制,`pki`/`enc` 归档则必须先加密再上传。
12. **备份的元数据(时间、校验和、版本)要一起记录**。只留一堆 `.db` 与 `.tar.gz` 而没有时间戳与对应的集群版本,恢复时无法判断该用哪一份、能否用。

### 相关命令

- `etcd` — 控制面数据存储,快照与恢复
- `velero` — 集群资源与卷数据备份恢复
- `kubeadm` — 证书管理与集群重建
- `crd` — 自定义资源定义
- `volume-snapshot` — CSI 卷快照
- `pv` — 持久卷对象
- `longhorn` — 分布式块存储,自带备份到 S3/NFS

### 参考链接

- [Kubernetes 官方文档:etcd 备份与恢复](https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/)
- [Kubernetes 官方文档:加密静态数据](https://kubernetes.io/docs/tasks/administer-cluster/encrypt-data/)
- [kubeadm 证书管理](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-certs/)
- [Velero 文件系统备份](https://velero.io/docs/main/file-system-backup/)
- [Velero CSI 快照](https://velero.io/docs/main/csi/)
- [Announcing etcd v3.6.0(etcdctl 与 etcdutl 职责边界变化)](https://kubernetes.io/blog/2025/05/15/announcing-etcd-3.6/)
