# Lab 实跑状态（2026-10-25）

本页记录 35 个故障演练的实际执行程度，区分“命令跑通”“只做了静态审查”和“尚未实跑”，避免把文档完整度当成可执行性。环境为 macOS + Docker 29.9.2 + Compose 5.6.1；本机没有 kind，也没有 GNU `timeout`，部分实跑用临时包装脚本替代。

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
| 实跑通过 | 5 |
| 部分通过 | 1 |
| 部分验证 | 2 |
| 静态审查 | 26 |
| 新增未跑 | 1 |
| **合计** | **35** |

## 变更与恢复演练（13）

| 演练 | 环境 | 状态 | 说明 |
| --- | --- | --- | --- |
| [lab-db-failover](https://www.dos2unix.cn/tutorial/lab-db-failover.html) | Docker Compose | 实跑通过 | 主从切换、就绪等待、连接恢复与一致性检查跑通；文档已修正清理顺序 |
| [lab-etcd-restore](https://www.dos2unix.cn/tutorial/lab-etcd-restore.html) | kind / 一次性 etcd | 实跑通过 | 快照恢复、quorum 重建与 API Server 验证跑通；键数量校验已改为 `grep -c .` |
| [lab-redis-failover](https://www.dos2unix.cn/tutorial/lab-redis-failover.html) | Docker Compose | 实跑通过 | 故障切换、双主隔离、Sentinel 收敛与客户端重发现跑通；本轮修正计划内回切判据、diskless 偏移差值和 `READONLY` 退出码说明，并把清理移到验证之后 |
| [lab-kafka-broker-replace](https://www.dos2unix.cn/tutorial/lab-kafka-broker-replace.html) | Docker Compose | 部分通过 | broker-4 监听器冲突和 `grep -E` 转义已修正，broker 替换与副本迁移主路径可跑；完整迁移验收未复跑 |
| [lab-backup-restore-verification](https://www.dos2unix.cn/tutorial/lab-backup-restore-verification.html) | Docker Compose | 实跑通过 | 独立网络与卷、custom 备份、截断副本报错、隔离恢复、行数/聚合/序列/约束和清理均验证通过 |
| [lab-postgres-pitr](https://www.dos2unix.cn/tutorial/lab-postgres-pitr.html) | Docker Compose | 实跑通过 | 目标时间暂停、7 行/2800、事故后数据 0、`pg_promote()` 和 CHECK 拒绝均复验；本轮修正 `pg_basebackup -U lab`、manifest 嵌套路径、`docker version` 模板和约束测试语句 |
| [lab-cert-rotation](https://www.dos2unix.cn/tutorial/lab-cert-rotation.html) | 本地 TLS 服务 | 部分验证 | 证书链、生效检查和回滚命令已核对，清理顺序已修订；未完整复跑 |
| [lab-regional-failure](https://www.dos2unix.cn/tutorial/lab-regional-failure.html) | Docker Compose + kind | 部分验证 | 就绪等待、清理顺序和 OpenSSL 说明已修订；跨系统全流程未复跑 |
| [lab-k8s-upgrade](https://www.dos2unix.cn/tutorial/lab-k8s-upgrade.html) | kind 多节点 | 静态审查 | 依赖 kind，本机未安装；控制面/节点升级命令和回滚边界已人工核对 |
| [lab-velero-restore](https://www.dos2unix.cn/tutorial/lab-velero-restore.html) | kind + MinIO | 静态审查 | 依赖 kind 与对象存储，未实跑 |
| [lab-kafka-restore](https://www.dos2unix.cn/tutorial/lab-kafka-restore.html) | Docker Compose | 静态审查 | topic、元数据和消费位点恢复步骤已审查，未实跑 |
| [lab-es-restore](https://www.dos2unix.cn/tutorial/lab-es-restore.html) | Docker Compose | 静态审查 | 快照恢复与 mapping/文档数校验已审查，未实跑 |
| [lab-dns-failover](https://www.dos2unix.cn/tutorial/lab-dns-failover.html) | Docker Compose + CoreDNS | 新增未跑 | 本轮新增，覆盖 TTL 预降、区文件导入、NS 委派和回滚；尚未实跑 |

## 基础与进阶演练（22）

以下页面本轮只做静态审查：结构、前置条件、命令参数、清理范围和回滚路径。它们不涉及本轮改动，未重新实跑。

| 演练 | 环境 | 状态 |
| --- | --- | --- |
| [lab-cpu-100](https://www.dos2unix.cn/tutorial/lab-cpu-100.html) | Linux 或容器 | 静态审查 |
| [lab-disk-full](https://www.dos2unix.cn/tutorial/lab-disk-full.html) | Linux root + loop | 静态审查 |
| [lab-inode-exhausted](https://www.dos2unix.cn/tutorial/lab-inode-exhausted.html) | Linux root + tmpfs | 静态审查 |
| [lab-network-latency](https://www.dos2unix.cn/tutorial/lab-network-latency.html) | Docker + NET_ADMIN | 静态审查 |
| [lab-pod-pending](https://www.dos2unix.cn/tutorial/lab-pod-pending.html) | kind | 静态审查 |
| [lab-pvc-pending](https://www.dos2unix.cn/tutorial/lab-pvc-pending.html) | kind | 静态审查 |
| [lab-crashloopbackoff](https://www.dos2unix.cn/tutorial/lab-crashloopbackoff.html) | kind | 静态审查 |
| [lab-dns-failure](https://www.dos2unix.cn/tutorial/lab-dns-failure.html) | kind | 静态审查 |
| [lab-mysql-deadlock](https://www.dos2unix.cn/tutorial/lab-mysql-deadlock.html) | Docker | 静态审查 |
| [lab-postgres-connection-exhausted](https://www.dos2unix.cn/tutorial/lab-postgres-connection-exhausted.html) | Docker | 静态审查 |
| [lab-kafka-consumer-lag](https://www.dos2unix.cn/tutorial/lab-kafka-consumer-lag.html) | Docker | 静态审查 |
| [lab-redis-hotkey](https://www.dos2unix.cn/tutorial/lab-redis-hotkey.html) | Docker | 静态审查 |
| [lab-oom-killed](https://www.dos2unix.cn/tutorial/lab-oom-killed.html) | Docker / kind | 静态审查 |
| [lab-imagepullbackoff](https://www.dos2unix.cn/tutorial/lab-imagepullbackoff.html) | kind | 静态审查 |
| [lab-node-notready](https://www.dos2unix.cn/tutorial/lab-node-notready.html) | kind | 静态审查 |
| [lab-certificate-expired](https://www.dos2unix.cn/tutorial/lab-certificate-expired.html) | Docker / 本地 TLS | 静态审查 |
| [lab-nginx-502](https://www.dos2unix.cn/tutorial/lab-nginx-502.html) | Docker Compose | 静态审查 |
| [lab-helm-failed](https://www.dos2unix.cn/tutorial/lab-helm-failed.html) | kind + Helm | 静态审查 |
| [lab-kafka-rebalance](https://www.dos2unix.cn/tutorial/lab-kafka-rebalance.html) | Docker Compose | 静态审查 |
| [lab-es-unassigned](https://www.dos2unix.cn/tutorial/lab-es-unassigned.html) | Docker Compose | 静态审查 |
| [lab-etcd-quorum](https://www.dos2unix.cn/tutorial/lab-etcd-quorum.html) | 3 节点 kind / etcd | 静态审查 |
| [lab-mysql-replication-lag](https://www.dos2unix.cn/tutorial/lab-mysql-replication-lag.html) | Docker Compose | 静态审查 |

## 本轮验证限制

- 本机没有 kind，所有依赖 kind 的演练只做了静态审查；不能用 Docker Desktop 的单节点结果替代多节点调度、节点 NotReady 或 etcd quorum 结论。
- macOS 默认没有 GNU `timeout`，实跑时用 Python 包装器替代；页面仍保留 `timeout` 写法，Linux CI 和大多数服务器可直接执行。
- 所有实跑都使用独立 Compose 项目、`/tmp` 目录和本地端口，结束后已清理容器、网络、卷和临时目录；没有连接任何生产环境。
- PITR 的序列值在本轮重复写入后为 38，满足“不小于 7”的验收条件；具体数值取决于测试过程，不应作为固定预期。

## 下一批建议

1. 实跑 `lab-dns-failover`，重点验证 TTL 预降是否真的生效、旧权威是否仍被缓存，以及回滚时 NS 委派顺序。
2. 实跑 `lab-kafka-restore` 和 `lab-es-restore`，补齐恢复类演练的消费位点、mapping 和文档数验收。
3. 在临时 kind 集群复跑 `lab-k8s-upgrade`、`lab-velero-restore` 和 `lab-etcd-quorum`，记录节点排空、PDB 和 etcd quorum 的真实输出。
4. 为每篇 Lab 增加“预计耗时 / 最低资源 / 可跳过步骤”元数据，减少读者在中途因资源不足放弃。
