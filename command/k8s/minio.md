minio
===

兼容S3协议的高性能对象存储,社区版上游已归档停更

## 补充说明

**项目已停止维护,不要用于新部署**。MinIO 社区版(MinIO CE)在过去一年多里被逐步收缩,最终于 **2026 年 2 月 12 日将代码仓库归档为只读**,官方 README 写明「THIS REPOSITORY IS NO LONGER MAINTAINED」。关键时间线:

```shell
2021-05        许可证从 Apache 2.0 改为 AGPLv3
2025-05        管理控制台从社区版中移除,桶管理、用户、IAM、策略、生命周期
               全部划归商业版 AIStor
2025-10        停止发布社区版 Docker 镜像与预编译二进制,社区版变为「仅源码分发」
               同期发布了一个关键安全更新,此后不再有官方镜像渠道
2025-12-03     仓库进入维护模式:不再接受新特性与新 PR,仅个案处理关键修复
2026-02-12     仓库正式归档为只读,issues 与 PR 全部关闭
```

对存量用户的实际影响:**不会再有官方安全补丁,也不会再有可信的官方镜像**。CVE 修复、依赖升级、供应链安全的责任全部转移到使用方自己身上。继续运行旧版本在技术上可行,但它应当被当作一项有明确迁移期限的技术债来管理。

**可选的替代方案**:

```shell
Ceph RGW        Ceph 的对象网关,企业级,与本仓库的 rook/ceph 页配套
Garage          AGPLv3,社区治理,轻量,适合中小规模自建
SeaweedFS       Apache 2.0,海量小文件场景表现好
RustFS          较新的 Rust 实现,尚不成熟,谨慎评估
Versity S3 Gateway / AIStore   特定场景的 S3 网关方案
```

**社区分支**:由于 AGPLv3 是不可撤销的许可证,归档并不能收回代码授权,社区据此创建了分支 **`pgsty/minio`**(Pigsty 作者维护,又称 Silo)。它恢复了被移除的管理控制台、重新发布 Docker 镜像与 RPM/DEB 包、修复了 CVE-2025-62506,并承诺只做供应链延续与缺陷修复、不引入新特性。使用方式是把镜像从 `minio/minio` 换成 `pgsty/minio`,其余不变。该分支与 MinIO Inc. 无关。

本页余下内容用于**维护既有集群时查阅**,以及理解分布式对象存储的通用概念。

### 部署模式

```shell
单机单盘(Single-Node Single-Drive)    一个目录,无任何冗余,仅用于开发测试
单机多盘(Single-Node Multi-Drive)     一台机器多块盘做纠删码,能扛单盘故障
分布式(Distributed)                   多节点多磁盘,跨节点纠删码,生产形态
```

### 纠删码机制

MinIO 的分布式模式依赖**纠删码(Erasure Coding)**,这是它与「把文件放进目录」最大的区别:

```shell
默认纠删码集(erasure set)大小   16 块盘
默认校验块(parity)数量          按集内盘数自动决定
  4 盘   → EC:2(可容忍 2 盘故障)
  5-6 盘 → EC:3
  7+ 盘  → EC:4
最少盘数                        4 块,低于 4 块无法启用纠删码
```

关键约束:

```shell
每块盘必须是专用磁盘,不能与其他应用共享
必须是直连的本地磁盘,官方明确不支持 NFS / CIFS / Gluster 之类的共享存储
分布式部署至少 4 个节点(每节点至少 1 块盘),推荐 4 的倍数
```

### 命令行客户端 mc

```shell
# 安装 mc 客户端
curl -O https://dl.min.io/client/mc/release/linux-amd64/mc
chmod +x mc && sudo mv mc /usr/local/bin/

# 添加一个别名(指向集群)
mc alias set myminio http://minio.example.com:9000 minioadmin minioadmin

# 常用操作
mc admin info myminio
mc admin heal myminio
mc ls myminio/mybucket
mc cp ./data.tar.gz myminio/mybucket/
mc mirror --watch ./local-dir myminio/mybucket
mc admin user add myminio appuser apppassword
mc admin policy attach myminio readwrite --user appuser
```

### 分布式部署示例(历史写法)

```shell
# 4 节点 × 4 盘,环境变量方式(旧版)
export MINIO_ROOT_USER=admin
export MINIO_ROOT_PASSWORD='ChangeMe123456'

minio server \
  http://node{1...4}/data/disk{1...4} \
  --console-address ":9001"

# 新版本改为命令行参数
minio server \
  http://node{1...4}/data/disk{1...4} \
  --address ":9000" \
  --console-address ":9001"
```

### 在 Kubernetes 中部署

MinIO 官方提供过两套方式,均随项目一起停止维护:

```shell
# 1. MinIO Operator(含 Tenant CRD)
helm repo add minio-operator https://operator.min.io
helm install operator minio-operator/operator --namespace minio-operator --create-namespace
kubectl apply -f tenant.yaml

# 2. 早期还有 kubectl minio 插件,已被移除,不要再使用
```

Tenant 自定义资源的关键字段:

```shell
apiVersion: minio.min.io/v2
kind: Tenant
metadata:
  name: myminio
  namespace: minio
spec:
  image: minio/minio:RELEASE.2025-10-15T17-29-55Z    # 官方镜像已不再更新
  pools:
    - name: pool-0
      servers: 4
      volumesPerServer: 4
      volumeClaimTemplate:
        spec:
          storageClassName: local-path
          resources:
            requests:
              storage: 100Gi
  mountPath: /export
  requestAutoCert: false
```

注意 `pools` 的设计意图:**每个 pool 一旦创建就不能缩容**,扩容只能新增 pool。上层再多加一层 `StorageClass` 也改变不了这个事实。

### 存量集群运维建议

```shell
# 1. 冻结版本,记录当前运行的镜像 digest
kubectl get pods -A -o json | jq -r '
  .items[] | select(.spec.containers[]?.image | test("minio")) |
  .metadata.namespace + "/" + .metadata.name + " " + .spec.containers[].image'

# 2. 把镜像同步到自己的私有仓库,避免上游渠道失效
skopeo copy docker://minio/minio:RELEASE.2025-10-15T17-29-55Z \
  docker://registry.internal/minio/minio:RELEASE.2025-10-15T17-29-55Z

# 3. 检查数据健康
mc admin info myminio
mc admin heal myminio --recursive

# 4. 评估迁移窗口,优先把「有备份价值」的桶迁走
mc mirror --preserve myminio/important-bucket s3/new-endpoint/important-bucket
```

### 迁移到替代方案

```shell
# 用 mc mirror 做在线迁移(几乎所有 S3 兼容存储都适用)
mc alias set old http://minio.old:9000 <ak> <sk>
mc alias set new https://s3.new-provider.com <ak> <sk>
mc mirror --preserve --watch old/bucket-a new/bucket-a

# 迁完后逐桶校验对象数量与总大小
mc du old/bucket-a
mc du new/bucket-a
```

### 注意

1. **纠删码要求至少 4 块盘,并且这些盘必须专用**。把 MinIO 的数据目录与其他应用混在一台机器、一块盘上,不仅享受不到纠删码的容错能力,还极易因为邻居写满磁盘而整体不可用。
2. **分布式模式不支持 NFS / CIFS / Gluster 等共享存储作为后端**。这是官方明确的限制 —— 纠删码的正确性依赖每块盘可被独立寻址,共享挂载点会破坏这一前提,轻则性能崩塌,重则数据损坏。
3. **server pool 只能扩容不能缩容**。要下线旧 pool 必须走 `mc admin decommission` 把数据迁移出去,直接删节点会导致数据永久丢失。规划容量时务必留出 pool 粒度。
4. **默认凭据 `minioadmin` / `minioadmin` 是真实存在的默认值**。任何暴露到网络的实例如果没改,等同于把数据公开。改用 `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD`,并确保长度符合要求(过短的密码会直接拒绝启动)。
5. **纠删码参数在集群创建后不可更改**。erasure set 大小、parity 数量都是建集群时确定的,想改只能建新集群再迁移数据。这一条在容量规划阶段就必须想清楚。
6. **对象存储不适合跑数据库**。S3 语义没有 POSIX 的锁与随机写保证,把 SQLite、MySQL 的数据目录直接放在对象存储上(或通过 s3fs 挂载)会导致数据损坏。
7. **时间同步是硬要求**。节点间时钟漂移会导致签名校验失败,而客户端收到的往往是含糊的 `SignatureDoesNotMatch`,排查方向很容易跑偏。
8. **社区版控制台自 2025 年 5 月起已被移除**,桶管理、用户与策略配置需要通过 `mc` 命令行完成。如果你的运维流程依赖 Web 控制台,升级到该时间点之后的版本会直接失去这些能力 —— 这是很多人「升级后控制台不见了」的原因。
9. **官方 Docker 镜像自 2025 年 10 月起停止发布**,`minio/minio` 上不会再出现新 tag。继续使用意味着长期停留在某个已知有漏洞的版本上,必须自行评估风险。
10. **仓库归档不等于代码消失,但等于补丁消失**。AGPLv3 授予的权利不可撤销,社区分支合法且可用;但在采用任何分支前,应确认其维护活跃度与安全响应能力,并把它当作「一个新的第三方依赖」来做评估。
11. **迁移前必须做完整备份,而不是只做镜像同步**。`mc mirror` 是对象级复制,不会保留桶策略、生命周期规则、事件通知配置与版本控制状态,这些需要单独导出后再重建。
12. **不要新建 MinIO 集群**,即使是「临时用一下」。上游已无安全响应,新建实例会在未来变成一笔需要专门立项清理的债。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `rook` — 用 Rook 部署 Ceph RGW 作为对象存储替代
- `ceph` — Ceph 的对象网关 RGW
- `storageclass` — 为 MinIO 的 PVC 提供底层存储
- `pvc` — MinIO 的数据卷申请
- `openebs` — 可作为 MinIO 底层存储的本地 PV 方案
- `longhorn` — 可作为 MinIO 底层存储的分布式块存储

### 参考链接

- [MinIO 官方文档(已停止更新)](https://min.io/docs/minio/kubernetes/upstream/)
- [MinIO 仓库(已归档)](https://github.com/minio/minio)
- [社区分支 pgsty/minio](https://github.com/pgsty/minio)
- [Ceph RGW 对象网关](https://docs.ceph.com/en/latest/radosgw/)
- [Garage 分布式对象存储](https://garagehq.deuxfleurs.fr/)
- [SeaweedFS](https://github.com/seaweedfs/seaweedfs)
