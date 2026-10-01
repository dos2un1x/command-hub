velero
===

Kubernetes集群资源与持久卷的备份恢复工具

## 补充说明

**velero命令** 是 Kubernetes 的集群备份与迁移工具。它把集群中的 API 对象导出到**对象存储**,并在需要时恢复到原集群或其他集群,同时可选地备份 PersistentVolume 中的实际数据。

Velero 由两部分组成:

- **客户端 CLI**(`velero`)— 在你本机运行,提交备份/恢复请求并查看结果。
- **服务端**(`velero` Deployment + `node-agent` DaemonSet)— 部署在集群内,真正执行资源遍历、上传与卷数据处理。

两种卷数据备份方式:

| 方式 | 机制 | 适用场景 |
| --- | --- | --- |
| 卷快照(CSI/云盘) | 调用云厂商 CSI Snapshotter 打快照 | 云上环境,速度快,不占带宽 |
| 文件系统备份(FSS) | node-agent 用 Kopia 逐文件读取并上传 | 自建存储、跨云迁移、无 CSI 快照能力 |

Velero **不是** etcd 快照的替代品,也不是 Prometheus 那样的监控工具 —— 它只负责「把集群里的声明和卷数据搬到对象存储里」。

### 安装

```shell
# 客户端 CLI(Linux)
wget https://github.com/velero-io/velero/releases/download/v1.18.2/velero-v1.18.2-linux-amd64.tar.gz
tar -xvf velero-v1.18.2-linux-amd64.tar.gz
sudo mv velero-v1.18.2-linux-amd64/velero /usr/local/bin/
velero version --client-only

# macOS
brew install velero

# 准备对象存储凭据文件 credentials-velero
cat > credentials-velero <<'EOF'
[default]
aws_access_key_id=minio
aws_secret_access_key=minio123
EOF
```

部署服务端到集群(AWS S3 为例):

```shell
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.10.0 \
  --bucket velero-backups \
  --secret-file ./credentials-velero \
  --backup-location-config region=us-east-1 \
  --use-node-agent \
  --default-volumes-to-fs-backup
```

对接 S3 兼容存储(MinIO、Ceph RGW 等):

```shell
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.10.0 \
  --bucket velero-backups \
  --secret-file ./credentials-velero \
  --use-volume-snapshots=false \
  --backup-location-config region=minio,s3ForcePathStyle=true,s3Url=http://minio.example.com:9000 \
  --use-node-agent
```

检查安装结果:

```shell
kubectl get all -n velero
velero version
velero backup-location get
velero get plugins
```

### 语法

```shell
velero [command]
```

```shell
velero backup        备份的创建、查询与删除
velero restore       恢复的创建、查询与删除
velero schedule      定时备份计划
velero backup-location   备份存储位置管理
velero snapshot-location 卷快照位置管理
velero plugin        插件管理
velero node-agent    node-agent(文件系统备份)配置
velero get           通用查询入口
velero describe      按名称查看详情
velero version       查看客户端与服务端版本
velero install       在集群内安装服务端
velero uninstall     卸载服务端
velero debug         收集诊断信息
velero client config 客户端配置(命名空间、输出格式)
```

### 备份操作

```shell
# 备份整个集群(不含卷数据)
velero backup create full-cluster

# 只备份指定命名空间
velero backup create dev-backup --include-namespaces dev,staging

# 排除命名空间
velero backup create cluster-no-kube --exclude-namespaces kube-system,kube-public

# 按标签选择资源
velero backup create app-only --selector app=nginx

# 排除特定资源类型
velero backup create no-secrets --exclude-resources secrets,events

# 包含集群级资源(CRD、ClusterRole、PV 等)
velero backup create with-cluster --include-cluster-resources=true

# 备份卷数据:文件系统备份(不依赖快照)
velero backup create dev-with-data --include-namespaces dev --default-volumes-to-fs-backup

# 备份卷数据:CSI 快照(需集群支持 CSI Snapshotter)
velero backup create dev-snapshots --include-namespaces dev \
  --snapshot-volumes=true --snapshot-move-data
```

只想备份部分卷时,在 Pod 上通过注解显式列出卷名(文件系统备份模式下生效):

```shell
metadata:
  annotations:
    backup.velero.io/backup-volumes: data,config
```

查询与检查:

```shell
velero backup get
velero backup describe dev-backup
velero backup describe dev-backup --details
velero backup logs dev-backup

# 等待备份完成
velero backup create dev-backup --wait

# 设置保留时间与快照开关
velero backup create short --ttl 24h --snapshot-volumes=false

# 删除备份数据(必须显式 --confirm)
velero backup delete dev-backup --confirm
```

### 恢复操作

```shell
# 从备份恢复
velero restore create --from-backup dev-backup

# 恢复时重命名命名空间(常用于演练)
velero restore create --from-backup dev-backup \
  --namespace-mappings dev:dev-restore

# 只恢复部分命名空间与资源
velero restore create --from-backup full-cluster \
  --include-namespaces dev --include-resources deployments,services,configmaps

# 排除节点相关资源(跨集群迁移时必做)
velero restore create --from-backup full-cluster \
  --exclude-resources nodes,events,events.events.k8s.io

# 目标资源已存在时的策略:update 表示覆盖更新
velero restore create --from-backup dev-backup \
  --existing-resource-policy=update

# 从最近一次定时备份恢复
velero restore create --from-schedule daily

# 等待并检查
velero restore create --from-backup dev-backup --wait
velero restore get
velero restore describe dev-backup-20240101020000
velero restore logs dev-backup-20240101020000
```

### 定时备份

```shell
# 每天凌晨 1 点备份 dev 命名空间,保留 30 天
velero schedule create daily-dev \
  --schedule="0 1 * * *" \
  --include-namespaces dev \
  --ttl 720h

# 每 6 小时备份全集群
velero schedule create every-6h --schedule="0 */6 * * *"

# 查看与管理
velero schedule get
velero schedule describe daily-dev
velero schedule delete daily-dev
```

### 常用维护命令

```shell
# 客户端默认操作 velero 命名空间
velero client config set namespace=velero

# 存储位置状态(PARTIALLY_VALID / UNAVAILABLE 都需警惕)
velero backup-location get
velero snapshot-location get
kubectl -n velero describe backupstoragelocation default

# 插件管理(安装后需重启服务端)
velero plugin add velero/velero-plugin-for-gcp:v1.10.0
velero plugin get
velero plugin remove velero/velero-plugin-for-aws:v1.10.0

# node-agent 的高级参数(并发线程数、超时等)通过 ConfigMap 提供
# 需在安装时用 --node-agent-configmap 引用,安装后创建无效
velero install --use-node-agent --node-agent-configmap node-agent-config ...
kubectl -n velero get configmap node-agent-config -o yaml
kubectl -n velero get ds node-agent
kubectl -n velero logs ds/node-agent --tail=50

# 收集诊断包
velero debug --namespace velero

# 卸载(保留对象存储中的数据)
velero uninstall
```

### 注意

1. **必须准备兼容的对象存储后端**。Velero 通过插件对接 AWS S3、GCS、Azure Blob、阿里云 OSS、MinIO 等;**本地磁盘目录(filesystem)只适合单机测试**,不支持高可用,且无法被其他集群访问。
2. **默认备份不包含 PVC 中的数据**。只备份资源清单时,恢复出来的 Pod 会挂载空白卷。需要数据必须启用卷快照(CSI Snapshotter + `EnableCSI` 特性门控)或文件系统备份(Kopia)。
3. **`velero backup delete --confirm` 会同时删除对象存储中的备份数据**,且不可撤销。只是想清理集群内记录而不删数据时,不要执行该命令。
4. **恢复时目标资源已存在会被跳过**。默认策略是 `none`,需要覆盖时加 `--existing-resource-policy=update`,否则恢复日志中会出现大量 `already exists` 而实际什么都没改。
5. **跨集群迁移必须排除节点与事件类资源**,否则会带着原集群的 Node 对象、`status` 字段一起恢复,污染目标集群。
6. **TTL 到期后备份会被自动清理**。`schedule` 未指定 `--ttl` 时默认 30 天,长期归档需求必须显式指定更长的 TTL 或改用外部生命周期策略。
7. **备份卡在 `InProgress` 通常是 BackupStorageLocation 不可用**,用 `velero backup-location get` 确认状态为 `Available`,再检查服务端日志与对象存储连通性。
8. **升级 Velero 时必须同步升级 node-agent DaemonSet**,版本不一致会导致卷备份失败并报协议不兼容错误。升级用 `velero install --apply`(复用原有安装参数)让 Deployment 与 DaemonSet 保持同版本,注意 `velero install` **没有** `--upgrade` 参数。
9. Velero **不能替代 etcd 快照**。etcd 快照能保证控制平面数据的完整性与一致性,Velero 则擅长按命名空间/标签做细粒度恢复与跨集群迁移,两者应配合使用。
10. 文件系统备份会**持续消耗节点 CPU 与网络带宽**,大规模集群应通过 node-agent 的 ConfigMap 限制并发线程数与超时,并避开业务高峰。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kubeadm` — Kubernetes集群安装工具
- `kustomize` — 无模板的配置定制工具
- `helm` — Kubernetes包管理器

### 参考链接

- [Velero 官方文档](https://velero.io/docs/)
- [Velero GitHub 仓库](https://github.com/velero-io/velero)
- [支持的存储提供商](https://velero.io/docs/main/supported-providers/)
- [文件系统备份与卷快照](https://velero.io/docs/main/file-system-backup/)
