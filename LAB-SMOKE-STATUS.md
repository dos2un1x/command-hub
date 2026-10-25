# Lab 实跑状态（2026-10-25）

本页记录 35 个故障演练的实际执行程度，区分“命令跑通”“只做静态审查”和“尚未实跑”。站点上的 Lab 页会显示同样状态；本页保留完整说明和验证限制。环境为 macOS + Docker 29.9.2 + Compose 5.6.1；本机没有 kind，也没有 GNU `timeout`，部分实跑用临时包装脚本替代。

## 状态定义

| 状态 | 含义 |
| --- | --- |
| 实跑通过 | 按文档顺序执行，关键写入、切换、恢复和验证项均通过 |
| 部分通过 | 核心链路跑通，但至少一个验证项未完成或结果不可解释 |
| 部分验证 | 只执行了局部命令或检查了关键前置条件，未完整复跑全流程 |
| 静态审查 | 检查了结构、依赖、命令语法、清理顺序和回滚路径，未实跑 |
| 新增未跑 | 本轮新增页面，尚未安排实跑 |

## 汇总

| 状态 | 数量 |
| --- | ---: |
| 实跑通过 | 12 |
| 部分通过 | 1 |
| 部分验证 | 2 |
| 静态审查 | 20 |
| 新增未跑 | 0 |
| **合计** | **35** |

## 基础演练（12）

| 演练 | 环境 | 状态 | 最后核对 | 说明 |
| --- | --- | --- | --- | --- |
| [lab-cpu-100](https://www.dos2unix.cn/tutorial/lab-cpu-100.html) | Linux 或容器 | 静态审查 | 2026-10-25 | — |
| [lab-disk-full](https://www.dos2unix.cn/tutorial/lab-disk-full.html) | Linux root + loop | 静态审查 | 2026-10-25 | — |
| [lab-inode-exhausted](https://www.dos2unix.cn/tutorial/lab-inode-exhausted.html) | Linux root + tmpfs | 静态审查 | 2026-10-25 | — |
| [lab-network-latency](https://www.dos2unix.cn/tutorial/lab-network-latency.html) | Docker + NET_ADMIN | 静态审查 | 2026-10-25 | — |
| [lab-pod-pending](https://www.dos2unix.cn/tutorial/lab-pod-pending.html) | kind | 静态审查 | 2026-10-25 | — |
| [lab-pvc-pending](https://www.dos2unix.cn/tutorial/lab-pvc-pending.html) | kind | 静态审查 | 2026-10-25 | — |
| [lab-crashloopbackoff](https://www.dos2unix.cn/tutorial/lab-crashloopbackoff.html) | kind | 静态审查 | 2026-10-25 | — |
| [lab-dns-failure](https://www.dos2unix.cn/tutorial/lab-dns-failure.html) | kind | 静态审查 | 2026-10-25 | — |
| [lab-mysql-deadlock](https://www.dos2unix.cn/tutorial/lab-mysql-deadlock.html) | Docker | 静态审查 | 2026-10-25 | — |
| [lab-postgres-connection-exhausted](https://www.dos2unix.cn/tutorial/lab-postgres-connection-exhausted.html) | Docker | 静态审查 | 2026-10-25 | — |
| [lab-kafka-consumer-lag](https://www.dos2unix.cn/tutorial/lab-kafka-consumer-lag.html) | Docker | 静态审查 | 2026-10-25 | — |
| [lab-redis-hotkey](https://www.dos2unix.cn/tutorial/lab-redis-hotkey.html) | Docker | 静态审查 | 2026-10-25 | — |

## 进阶演练（10）

| 演练 | 环境 | 状态 | 最后核对 | 说明 |
| --- | --- | --- | --- | --- |
| [lab-oom-killed](https://www.dos2unix.cn/tutorial/lab-oom-killed.html) | Docker / kind | 静态审查 | 2026-10-25 | — |
| [lab-imagepullbackoff](https://www.dos2unix.cn/tutorial/lab-imagepullbackoff.html) | kind | 静态审查 | 2026-10-25 | — |
| [lab-node-notready](https://www.dos2unix.cn/tutorial/lab-node-notready.html) | kind | 静态审查 | 2026-10-25 | — |
| [lab-certificate-expired](https://www.dos2unix.cn/tutorial/lab-certificate-expired.html) | Docker / 本地 TLS | 静态审查 | 2026-10-25 | — |
| [lab-nginx-502](https://www.dos2unix.cn/tutorial/lab-nginx-502.html) | Docker Compose / nginx | 实跑通过 | 2026-10-25 | 坏端口、停进程、日志与修复均实测通过；Docker Desktop 停进程后需重试才见 502 |
| [lab-helm-failed](https://www.dos2unix.cn/tutorial/lab-helm-failed.html) | kind + Helm | 静态审查 | 2026-10-25 | — |
| [lab-kafka-rebalance](https://www.dos2unix.cn/tutorial/lab-kafka-rebalance.html) | Docker Compose / Kafka 3.7.0 | 实跑通过 | 2026-10-25 | 成员退出、会话超时、分区重分配与恢复均实测通过 |
| [lab-es-unassigned](https://www.dos2unix.cn/tutorial/lab-es-unassigned.html) | Docker Compose / Elasticsearch 8.15.3 | 实跑通过 | 2026-10-25 | 单节点 yellow/red、分配 explain 与副本/过滤修复均实测通过 |
| [lab-etcd-quorum](https://www.dos2unix.cn/tutorial/lab-etcd-quorum.html) | 3 节点 kind / etcd | 静态审查 | 2026-10-25 | — |
| [lab-mysql-replication-lag](https://www.dos2unix.cn/tutorial/lab-mysql-replication-lag.html) | Docker Compose / MySQL 8.0.39 | 实跑通过 | 2026-10-25 | 锁等待造成 SQL 线程延迟、KILL 恢复与并行复制均通过；新增初始追平循环未整篇复跑 |

## 变更与恢复演练（13）

| 演练 | 环境 | 状态 | 最后核对 | 说明 |
| --- | --- | --- | --- | --- |
| [lab-k8s-upgrade](https://www.dos2unix.cn/tutorial/lab-k8s-upgrade.html) | kind 多节点 / 一次性测试集群 | 静态审查 | 2026-10-25 | — |
| [lab-cert-rotation](https://www.dos2unix.cn/tutorial/lab-cert-rotation.html) | 本地 TLS 服务 / 测试入口 | 部分验证 | 2026-10-25 | 证书链、生效检查和回滚命令已复核，未完整复跑 |
| [lab-db-failover](https://www.dos2unix.cn/tutorial/lab-db-failover.html) | Docker Compose / 测试数据库 | 实跑通过 | 2026-10-25 | 切换、连接恢复与一致性检查通过 |
| [lab-etcd-restore](https://www.dos2unix.cn/tutorial/lab-etcd-restore.html) | 3 节点 kind / 一次性 etcd | 实跑通过 | 2026-10-25 | 快照恢复与 quorum 重建通过 |
| [lab-regional-failure](https://www.dos2unix.cn/tutorial/lab-regional-failure.html) | Docker Compose + kind | 部分验证 | 2026-10-25 | 就绪等待、清理顺序和 OpenSSL 说明已修订，未完整复跑 |
| [lab-redis-failover](https://www.dos2unix.cn/tutorial/lab-redis-failover.html) | Docker Compose | 实跑通过 | 2026-10-25 | 故障切换、双主隔离与 Sentinel 收敛通过；计划内回切按实际主节点判断 |
| [lab-kafka-broker-replace](https://www.dos2unix.cn/tutorial/lab-kafka-broker-replace.html) | Docker Compose / Kafka 3.7.0 | 部分通过 | 2026-10-25 | 三副本迁移到 broker-4 且 broker-3 退役已验证；停机 ISR、写入拒绝与回滚未验证 |
| [lab-backup-restore-verification](https://www.dos2unix.cn/tutorial/lab-backup-restore-verification.html) | Docker Compose / 本地目录 | 实跑通过 | 2026-10-25 | 备份、隔离恢复、一致性与清理均通过 |
| [lab-velero-restore](https://www.dos2unix.cn/tutorial/lab-velero-restore.html) | kind + MinIO | 静态审查 | 2026-10-25 | — |
| [lab-postgres-pitr](https://www.dos2unix.cn/tutorial/lab-postgres-pitr.html) | Docker Compose | 实跑通过 | 2026-10-25 | 目标时间暂停、提升与约束复验通过 |
| [lab-kafka-restore](https://www.dos2unix.cn/tutorial/lab-kafka-restore.html) | Docker Compose / Kafka 3.7.0 | 实跑通过 | 2026-10-25 | 卷恢复、offset/位点重置与 12 条消息校验均实测通过 |
| [lab-es-restore](https://www.dos2unix.cn/tutorial/lab-es-restore.html) | Docker Compose / Elasticsearch 8.15.3 | 实跑通过 | 2026-10-25 | 快照、删除、恢复、mapping/文档数与别名切换均实测通过 |
| [lab-dns-failover](https://www.dos2unix.cn/tutorial/lab-dns-failover.html) | Docker Compose + CoreDNS | 实跑通过 | 2026-10-25 | TTL 预降、区导入、NS 切换、回滚与探针均通过；宿主 5353 被占用时用 15353 等价验证 |

## 本轮验证限制

- 本机没有 kind，所有依赖 kind 的演练只做了静态审查；不能用 Docker Desktop 的单节点结果替代多节点调度、节点 NotReady 或 etcd quorum 结论。
- macOS 默认没有 GNU `timeout`，实跑时用 Python/perl 包装器替代；页面仍保留 `timeout` 写法，Linux CI 和大多数服务器可直接执行。
- 所有实跑都使用独立 Compose 项目、`/tmp` 目录和本地端口，结束后已清理容器、网络、卷和临时目录；没有连接任何生产环境。
- PITR 的序列值在本轮重复写入后为 38，满足“不小于 7”的验收条件；具体数值取决于测试过程，不应作为固定预期。

## 下一批建议

1. 在临时 kind 集群复跑 `lab-k8s-upgrade`、`lab-velero-restore` 和 `lab-etcd-quorum`，记录节点排空、PDB 和 etcd quorum 的真实输出。
2. 复跑 `lab-cert-rotation` 和 `lab-regional-failure` 的完整流程，把“部分验证”提升为实跑通过。
3. 把每次实跑的镜像 tag、端口、耗时和清理结果补进本页，形成可回归的执行记录。
