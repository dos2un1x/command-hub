cronjob
===

Kubernetes定时任务调度控制器

## 补充说明

**CronJob** 按照 cron 表达式周期性地创建 Job,每个周期产生一个 Job 对象,再由 Job 创建 Pod 执行任务。它是「定时任务」在 Kubernetes 中的实现,适合备份、报表生成、缓存清理、证书续期、定期同步等场景。

CronJob 本身不执行任务,它只负责**在正确的时间点创建一个 Job**。因此排查 CronJob 问题时,顺序永远是:`CronJob 状态 → Job 状态 → Pod 状态 → 容器日志`。

### 语法

```shell
kubectl [command] cronjob [flags]
```

CronJob 的常用简写为 `cj`:

```shell
kubectl get cj
kubectl describe cj backup
```

### cron 表达式

CronJob 使用标准 cron 格式,共 5 个字段,以空格分隔:

```shell
# ┌───────────── 分钟 (0 - 59)
# │ ┌───────────── 小时 (0 - 23)
# │ │ ┌───────────── 日 (1 - 31)
# │ │ │ ┌───────────── 月 (1 - 12)
# │ │ │ │ ┌───────────── 星期 (0 - 6,SUN=0,也可用 SUN、MON 等)
# │ │ │ │ │
# * * * * *
```

常用写法:

```shell
0 * * * *        每小时整点执行
*/5 * * * *      每 5 分钟执行
0 2 * * *        每天 2:00 执行
0 3 * * 0        每周日 3:00 执行
0 0 1 * *        每月 1 日 0:00 执行
30 1 * * 1-5     工作日 1:30 执行
```

### 完整的 CronJob 清单

```shell
apiVersion: batch/v1
kind: CronJob
metadata:
  name: backup
  namespace: default
spec:
  schedule: "0 2 * * *"
  timeZone: "Asia/Shanghai"          # v1.27 起 GA,不设置则为 kube-controller-manager 的时区(通常为 UTC)
  concurrencyPolicy: Forbid          # Allow / Forbid / Replace
  suspend: false
  startingDeadlineSeconds: 200
  successfulJobsHistoryLimit: 3
  failedJobsHistoryLimit: 1
  jobTemplate:
    spec:
      backoffLimit: 2
      activeDeadlineSeconds: 1800
      ttlSecondsAfterFinished: 86400
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: backup
              image: bitnami/kubectl:1.31
              command:
                - /bin/sh
                - -c
                - 'kubectl get pods -A > /backup/pods-$(date +%F).txt'
              resources:
                requests:
                  cpu: 100m
                  memory: 128Mi
                limits:
                  cpu: 500m
                  memory: 256Mi
              volumeMounts:
                - name: backup
                  mountPath: /backup
          volumes:
            - name: backup
              persistentVolumeClaim:
                claimName: backup-pvc
```

创建与查看:

```shell
kubectl apply -f cronjob.yaml

# 也可以用命令直接创建(注意 --schedule 是必填项)
kubectl create cronjob hello --image=busybox:1.36 \
  --schedule="*/1 * * * *" -- date

kubectl get cronjob
kubectl get cj backup -o yaml
kubectl describe cronjob backup
```

### 查看执行历史

CronJob 的状态里只保留最近一次调度时间,真正的历史在 Job 列表中:

```shell
# 查看由 CronJob 产生的所有 Job
kubectl get jobs --selector=job-name
kubectl get jobs -o wide

# 查看某个 Job 的 Pod 与日志
kubectl get pods --selector=job-name=backup-28934560
kubectl logs job/backup-28934560

# 查看 CronJob 上次调度时间与上次成功时间
kubectl get cj backup -o jsonpath='{.status.lastScheduleTime}{"\n"}{.status.lastSuccessfulTime}{"\n"}'
```

Job 名称由 CronJob 名加上调度时间生成,格式为 `<cronjob-name>-<unix 分钟时间戳>`,例如 `backup-28934560`。

### 手动触发一次

```shell
# 立即创建一个 Job,不影响原有调度计划
kubectl create job --from=cronjob/backup backup-manual

# 查看结果
kubectl get jobs
kubectl logs job/backup-manual
```

### 暂停与恢复

```shell
# 暂停调度(已创建的 Job 不受影响)
kubectl patch cronjob backup -p '{"spec":{"suspend":true}}'

# 恢复调度
kubectl patch cronjob backup -p '{"spec":{"suspend":false}}'

# 也可以直接编辑
kubectl edit cronjob backup
```

### 并发策略

`concurrencyPolicy` 决定上一次任务还没结束时,新一次调度该怎么办:

```shell
Allow     默认值,允许并发运行,可能同时存在多个 Job
Forbid    跳过本次调度,直到上一个 Job 结束
Replace   取消当前正在运行的 Job,用新的 Job 替代
```

`Forbid` 是最常用的选择 —— 例如备份任务不能并行执行,否则会互相覆盖文件。

### 注意

1. **CronJob 名不能超过 52 个字符**。Job 名字会在 CronJob 名后追加 11 个字符(时间戳),超出长度限制会导致调度失败。
2. **默认使用 UTC 时区**。`schedule: "0 2 * * *"` 在未设置 `timeZone` 时表示 UTC 2:00,国内用户会看到任务在早上 10 点执行,务必显式设置 `timeZone: "Asia/Shanghai"`。
3. 最小调度间隔是 **1 分钟**,cron 表达式无法表达秒级调度。需要秒级精度只能改用其他方案(如 Deployment 内自建定时器)。
4. 控制器每 10 秒检查一次是否有错过的调度;如果错过的调度超过 **100 次**,CronJob 会**停止创建新的 Job** 并在控制器日志中报出 `Cannot determine if job needs to be started. Too many missed start time (> 100)`,需要调整 `startingDeadlineSeconds` 或检查节点时钟漂移。
5. `startingDeadlineSeconds` 若设置得过小,在控制器短暂不可用时会直接跳过任务;不设置则没有截止时间限制。
6. `restartPolicy` 在 `jobTemplate` 中同样只能是 `Never` 或 `OnFailure`。
7. `successfulJobsHistoryLimit` 与 `failedJobsHistoryLimit` 默认分别为 3 和 1,设置为 0 会导致历史记录被立即清理,排查问题时无从下手。
8. `suspend: true` 只阻止**新的调度**,已经在运行的 Job 会继续执行完毕。
9. CronJob 不保证「恰好执行一次」。控制器重启、时钟漂移都可能造成重复调度,任务本身应当设计为幂等的。
10. 修改 `schedule` 后不会影响已经创建的 Job,只影响后续调度。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `job` — 一次性任务控制器
- `pod` — 最小调度单元
- `deployment` — 无状态工作负载控制器

### 参考链接

- [CronJob 官方文档](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)
- [CronJob 自动清理已完成的 Job](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/#job-history-limits)
- [使用 CronJob 运行自动化任务](https://kubernetes.io/docs/tasks/job/automated-tasks-with-cron-jobs/)
- [kubectl create cronjob 命令参考](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_create/kubectl_create_cronjob/)
