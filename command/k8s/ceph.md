ceph
===

统一的分布式存储系统,同时提供块、文件与对象三种存储接口

## 补充说明

**Ceph** 是开源的统一分布式存储系统,用一套 RADOS 集群同时支撑三种使用形态:

```shell
RBD     块设备,给虚拟机、数据库、Kubernetes 的 PVC 用,对应 ReadWriteOnce
CephFS  POSIX 兼容的共享文件系统,支持多节点同时挂载,对应 ReadWriteMany
RGW     RADOS Gateway,提供 S3 / Swift 对象接口,替代对象存储
```

三种形态共享同一份底层数据分布逻辑:所有数据被切成对象,经 **CRUSH 算法**分布到各个 **OSD** 上,由 **MON** 维护集群地图,由 **MGR** 提供监控与管理接口。这种「一套集群三种接口」的设计是 Ceph 最大的价值 —— 不必为块、文件、对象分别维护三套存储。

在 Kubernetes 语境下,Ceph 有两种出场方式:**用 Rook 在集群内编排**(见 `rook` 页),或者**集群外独立部署 Ceph,集群内只装 ceph-csi 驱动**。前者运维一体化但把存储与业务的生命周期绑在一起,后者更符合「存储与计算分离」的架构,生产上两者都很常见。

本页讲 **Ceph 本身**的原理与运维命令;Kubernetes 侧的编排请见 `rook` 页。

### 版本与生命周期

Ceph 采用「字母序命名 + 偶数版本稳定」的发布模式,每个稳定系列有约 2 年生命周期:

```shell
Tentacle   v20.x   当前最新稳定系列,最新补丁 v20.2.4 (2026-08)
Squid      v19.x   上一个稳定系列,最新补丁 v19.2.6 (2026-08)
Umbrella   v21.x   开发中,处于特性冻结阶段
Reef       v18.x   已停止维护
Quincy     v17.x   已停止维护
Pacific    v16.x   已停止维护
```

**升级不能跨大版本跳跃**:官方明确说明从 Quincy 直接升到 Tentacle 不受支持,必须先升到 Squid 再升 Tentacle。已被淘汰的系列不再收到安全修复,继续使用等于把存储层暴露在已知漏洞下。

### 核心组件

```shell
MON   Monitor    维护集群地图(cluster map)与仲裁,数量必须为奇数,生产至少 3 个
MGR   Manager    提供指标、Dashboard、编排模块(pg_autoscaler、balancer),建议 2 个
OSD   Object Storage Daemon   每块磁盘一个,负责数据的实际读写与副本复制
MDS   Metadata Server  只有 CephFS 才需要,active + standby 才能做 HA
RGW   RADOS Gateway    对象网关,提供 S3/Swift 接口,可水平扩展多实例
```

### 数据分布:CRUSH 与 PG

Ceph 不维护「文件在哪台机器」的索引表,而是靠 **CRUSH 算法**在客户端本地算出数据应该落在哪些 OSD 上,中间层是 **PG(Placement Group)**:对象 → 哈希 → PG → CRUSH → 一组 OSD。

**PG 数量是 Ceph 调优的核心参数**,经验公式:

```shell
pg_num ≈ (OSD 总数 × 100) / 副本数

例:12 块 OSD、三副本 → pg_num ≈ 12 × 100 / 3 = 400,取最近的 2 的幂 512
```

PG 太少会看到 `too few PGs per OSD` 告警,性能和均衡性都上不去;PG 太多则每个 OSD 的内存与 CPU 开销急剧上升。开启 `pg_autoscaler` 模块可以让 Ceph 自动调整,但自动均衡期间集群会持续重平衡,不要在业务高峰动手。

### 部署方式

```shell
cephadm       官方推荐的容器化部署方式,把每个守护进程跑成一个容器,由 cephadm 编排
Rook          Kubernetes 内以 Operator 方式部署,见 rook 页
发行版软件包    apt/yum 安装的传统方式,新集群不推荐
MicroCeph     Canonical 的 snap 化单机部署,适合边缘与测试
```

### cephadm 引导集群

```shell
# 1. 准备免密登录(cephadm 需要 SSH 到各节点)
ssh-keygen -t ed25519 && ssh-copy-id root@node2 && ssh-copy-id root@node3

# 2. 在第一个节点上引导集群
apt-get install -y cephadm
cephadm bootstrap --mon-ip 10.0.0.10 --initial-dashboard-password 'ChangeMe123'

# 3. 进入 cephadm shell(后续所有 ceph 命令都在这个容器里跑)
cephadm shell

# 4. 添加其余节点,并部署 MON 与 MGR
ceph orch host add node2 10.0.0.11
ceph orch host add node3 10.0.0.12
ceph orch apply mon --placement="3 node1 node2 node3"
ceph orch apply mgr --placement="2 node1 node2"

# 5. 把空闲磁盘全部用作 OSD
ceph orch device ls
ceph orch apply osd --all-available-devices
```

### 常用命令

```shell
# 集群总览(第一眼永远看这个)
ceph status && ceph health detail && ceph versions

# OSD 与容量
ceph osd tree
ceph osd df
ceph osd pool ls detail
ceph df
rados df

# MON / MGR
ceph mon stat && ceph quorum_status && ceph mgr stat

# 编排(cephadm 专属)
ceph orch ps && ceph orch device ls && ceph orch ls
```

### 存储池与 PG

```shell
# 创建池(容量单位是 PG 数,不是 GB)
ceph osd pool create k8s-pool 128 128
ceph osd pool set k8s-pool size 3
ceph osd pool set k8s-pool min_size 2

# 开启应用标签(新版本强制要求,否则健康检查报错)
ceph osd pool application enable k8s-pool rbd

# 配额与自动调优
ceph osd pool set-quota k8s-pool max_bytes 1099511627776
ceph osd pool set k8s-pool pg_autoscale_mode on

# 删除池(需要双重确认,危险)
ceph osd pool delete k8s-pool k8s-pool --yes-i-really-really-mean-it
```

### 认证与密钥

Ceph 使用 **CephX** 做认证,客户端凭 keyring 访问:

```shell
# 创建给 Kubernetes 用的客户端密钥
ceph auth get-or-create client.k8s \
  mon 'profile rbd' osd 'profile rbd pool=k8s-pool' mgr 'profile rbd pool=k8s-pool' \
  -o /etc/ceph/ceph.client.k8s.keyring

ceph auth ls                    # 查看已有密钥
ceph auth print-key client.k8s  # 导出给 ceph-csi 使用
```

### 在 Kubernetes 中使用

Ceph 本身不认识 Kubernetes,需要 **ceph-csi** 这层驱动。已经用 Rook 部署时驱动会被自动装好(见 `rook` 页);独立部署 Ceph 时则需手工安装驱动,并把上面导出的密钥做成 Secret 交给集群:

```shell
kubectl -n ceph-csi create secret generic ceph-csi-secret \
  --from-literal=userID=k8s \
  --from-literal=userKey="$(ceph auth print-key client.k8s)"
```

之后写一个指向 `rbd.csi.ceph.com` 的 StorageClass 即可供给块存储,需要多 Pod 共享文件时改用 `cephfs.csi.ceph.com`。完整的 StorageClass 参数写法见 `storageclass` 页 —— 关键是 `clusterID` 必须是 Ceph 的 fsid,且 `pool` 要指向真实存在的存储池。

### 扩容

```shell
lsblk -f                                          # 1. 加新磁盘,确认是无文件系统的裸设备

ceph orch daemon add osd node4:/dev/sdb           # 2. 加入 OSD
ceph orch apply osd --all-available-devices       #    或让 cephadm 自动接管空闲盘

ceph -s && ceph osd tree                          # 3. 观察重平衡(期间性能会下降)

ceph osd pool set k8s-pool pg_num 256             # 4. 必要时调整 PG 数
ceph osd pool set k8s-pool pgp_num 256
```

### 升级

```shell
ceph versions                                  # 1. 当前版本
ceph orch upgrade check quay.io/ceph/ceph:v20.2.4   # 2. 检查目标版本是否可直达

ceph orch upgrade start --image quay.io/ceph/ceph:v20.2.4   # 3. 开始升级(MON/MGR 先,OSD 后)
ceph orch upgrade status && ceph -s            # 4. 观察进度
```

### 维护模式

```shell
# 计划内重启某台机器前,先停掉数据重平衡,避免无谓的数据搬动
ceph osd set noout
ceph osd set norebalance
ceph osd set noscrub
ceph osd set nodeep-scrub

# 维护完成后务必恢复,否则集群不会自动自愈
ceph osd unset noout
ceph osd unset norebalance
ceph osd unset noscrub
ceph osd unset nodeep-scrub
ceph -s
```

### 排障

```shell
ceph health detail && ceph -s                 # 1. 集群不健康,先看具体项

ceph pg stat                                  # 2. 有 PG 卡住
ceph pg dump_stuck inactive
ceph pg dump_stuck unclean
ceph osd blocked-by

ceph df && ceph osd df tree                   # 3. 集群拒写(满了)—— 最紧急的一类故障
# 满水位默认为 85%(nearfull)与 95%(full),full 时集群停止接受写入

ceph osd perf                                 # 4. 慢请求
ceph health detail | grep -i slow

systemctl status ceph-osd@0                   # 5. OSD 起不来
cephadm ls

ceph time-sync-status && chronyc tracking     # 6. 时钟漂移
```

### 注意

1. **集群容量到 `full` 比例(默认 95%)会整体停止接受写入**,而且此时连删除数据都可能失败 —— 因为删除本身也需要写日志。生产环境必须把 `nearfull`/`full` 水位调低并在监控里提前告警,绝不能让存储池真的用满。
2. **PG 数量与 OSD 数量必须匹配**。按「每 OSD 约 100 个 PG」估算,过少会出现 `too few PGs per OSD` 且数据分布严重不均,过多则每个 OSD 的内存消耗成倍增长。开启 `pg_autoscaler` 后仍要定期检查是否有池长期不收敛。
3. **故障域在池创建时就固化,事后无法修改**。`failureDomain` 设为 `host` 表示三副本分散在三台主机,能扛单机故障;若三块 OSD 挤在同一台机器而故障域写成 `osd`,这台机器宕机就是数据全失。建池前的容量与拓扑规划比事后调优重要得多。
4. **MON 数量必须为奇数,生产至少 3 个**。2 个 MON 的可用性比 1 个更糟 —— 挂掉任意一个集群就失去仲裁,连读都会受影响。MON 的 `store` 所在磁盘要保证低延迟,否则整个集群的操作都会变慢。
5. **升级不能跨大版本,必须先升到中间版本**。官方明确不支持 Quincy → Tentacle 的直达升级,必须经过 Squid。升级顺序是先 MON/MGR 再 OSD,且升级过程中不要同时做扩容或改 PG 数,否则故障难以归因。
6. **v19.2.6 / v20.2.4 起引入了新的 CephX 密钥类型 `aes256k`**(修复 CVE-2025-30156 认证绕过)。升级后守护进程密钥需要轮换,cephadm 与 Rook 会自动处理,但**自建部署必须按官方文档手工轮换**,否则可能升级后无法认证。
7. **RGW multisite 用户升级前需先设置 `rgw_sigv4_insecure = true`**(与 CVE-2026-54330 相关),否则升级后跨站点同步会中断。这类「升级前置开关」在 Ceph 的 CVE 公告里经常出现,升级前务必通读 release notes。
8. **每块 OSD 建议至少 4GB 内存**(`osd_memory_target` 默认即 4GiB),再按每 1TB 存储追加约 1GB 估算。内存不足时 OSD 会被 OOM Killer 杀掉,表现是集群反复告警而不是一条清晰的「内存不足」。
9. **所有节点必须严格时间同步**。MON 之间时钟漂移超限会拒绝服务,而客户端收到的报错往往指向「认证失败」,极易误导排查方向。部署 Ceph 的第一步就应该是配好 chrony 并持续监控。
10. **`ceph osd pool delete` 需要显式加 `--yes-i-really-really-mean-it`**,这是刻意的防误删设计。但更危险的是卸载 Ceph 时忘了这个保护、直接清掉 `/var/lib/ceph` —— 那等于把集群地图一起删除,数据将无法再被挂载。
11. **不要在生产集群上同时跑差异极大的工作负载而不做隔离**。虚拟机镜像与小文件元数据密集型的负载混在同一个池里会互相拖累,应当用不同的池、甚至不同的 CRUSH rule 与设备类别(`device class`)做隔离。
12. **BlueStore 是当前唯一推荐的 OSD 后端**,老旧的 FileStore 已被移除。从旧集群迁移时必须重建 OSD,不能原地转换。
13. **Ceph 的网络要求常被低估**。副本复制、重平衡、客户端读写都走网络,1GbE 在生产环境基本不可用;有条件应把 `public network` 与 `cluster network` 分开,避免重平衡流量挤占业务带宽。
14. **`noout` / `norebalance` 这类维护开关用完必须及时恢复**。忘记 `unset` 会让集群在磁盘故障后不做自愈,而且不会有任何显式告警,等到发现时往往已经丢了一个副本。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `rook` — 在 Kubernetes 上编排部署 Ceph
- `csi` — ceph-csi 是 Ceph 与 Kubernetes 之间的桥
- `storageclass` — 定义 RBD/CephFS 的供给参数
- `longhorn` — 更轻量的分布式块存储方案

### 参考链接

- [Ceph 官方文档](https://docs.ceph.com/en/latest/)
- [Ceph 架构说明](https://docs.ceph.com/en/latest/architecture/)
- [CRUSH 映射](https://docs.ceph.com/en/latest/rados/operations/crush-map/)
- [PG 数量与自动调优](https://docs.ceph.com/en/latest/rados/operations/placement-groups/)
- [cephadm 部署](https://docs.ceph.com/en/latest/cephadm/)
