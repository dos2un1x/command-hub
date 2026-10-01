job
===

Kubernetes一次性批处理任务控制器

## 补充说明

**Job** 用于运行一次性的批处理任务,它会创建一个或多个 Pod,并持续重试直到指定数量的 Pod **成功结束**(退出码为 0)。这与 Deployment 有本质区别:Deployment 关心的是「始终有 N 个 Pod 在运行」,Job 关心的是「任务被成功完成过 N 次」。

Job 适合数据处理、批量导入导出、数据库迁移、离线计算、压测等场景。任务可以只跑一次,也可以按固定次数并发跑多次;需要按时间周期重复执行时,应当使用 CronJob(它本身也是在调度 Job)。

Job 的 Pod 与普通 Pod 的关键差异在于 `restartPolicy` 只能是 `Never` 或 `OnFailure`:

- `Never`:容器失败后整个 Pod 变为 `Failed`,由 Job 控制器**新建**一个 Pod 重试。
- `OnFailure`:容器失败后在**同一个 Pod 内**重启容器,不会新建 Pod。

### 语法

```shell
kubectl [command] job [flags]
```

### 最简单的 Job

```shell
apiVersion: batch/v1
kind: Job
metadata:
  name: pi
spec:
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: pi
          image: perl:5.34
          command: ["perl", "-Mbignum=bpi", "-wle", "print bpi(2000)"]
```

创建与查看:

```shell
kubectl apply -f job.yaml

# 也可以用命令直接创建
kubectl create job pi --image=perl:5.34 -- perl -Mbignum=bpi -wle 'print bpi(2000)'

# 从 CronJob 手动生成一个 Job
kubectl create job --from=cronjob/backup backup-manual

kubectl get job
kubectl get pods --selector=job-name=pi
kubectl describe job pi

# 查看任务输出
kubectl logs job/pi
kubectl logs -f job/pi
```

### 完成次数与并行度

`completions` 与 `parallelism` 是最容易混淆的一对参数:

```shell
apiVersion: batch/v1
kind: Job
metadata:
  name: batch-process
spec:
  completions: 10        # 总共需要成功完成 10 次
  parallelism: 3         # 同时最多运行 3 个 Pod
  backoffLimit: 6        # 失败重试的总次数上限(不是并发数)
  template:
    spec:
      restartPolicy: OnFailure
      containers:
        - name: worker
          image: busybox:1.36
          command: ["sh", "-c", "echo processing && sleep 5"]
```

- `completions` 不设置时默认为 1(`parallelism` 可大于 1,但只要有一个成功,Job 即完成)。
- `parallelism` 不设置时默认为 1,即串行执行。
- 两者都不设置就是「跑一次,成功即结束」。

### 带索引的并行任务

`completionMode: Indexed` 会让每个 Pod 拿到一个从 0 开始的编号,通过 `JOB_COMPLETION_INDEX` 环境变量或 `job-index` 注解读取,适合按分片处理数据:

```shell
apiVersion: batch/v1
kind: Job
metadata:
  name: indexed-job
spec:
  completions: 5
  parallelism: 2
  completionMode: Indexed
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: worker
          image: busybox:1.36
          command:
            - sh
            - -c
            - 'echo "shard ${JOB_COMPLETION_INDEX}"; sleep 2'
```

### 超时与自动清理

```shell
apiVersion: batch/v1
kind: Job
metadata:
  name: short-lived
spec:
  backoffLimit: 4
  activeDeadlineSeconds: 600        # 整个 Job 最长运行 600 秒,超时后标记 Failed
  ttlSecondsAfterFinished: 3600     # 完成 1 小时后自动删除 Job 及其 Pod
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: task
          image: busybox:1.36
          command: ["sh", "-c", "echo done"]
```

`ttlSecondsAfterFinished` 需要集群开启 `TTLAfterFinished` 特性(1.23 起默认启用),否则 Job 会一直保留。

### 失败处理策略

`podFailurePolicy` 可以区分「可重试的失败」与「应当立即判定失败的失败」,常用于避免因为一个不可恢复的错误白白重试到 `backoffLimit`:

```shell
spec:
  backoffLimit: 10
  podFailurePolicy:
    rules:
      - action: FailJob                  # 遇到退出码 42 立即判定 Job 失败
        onExitCodes:
          containerName: worker
          operator: In
          values: [42]
      - action: Ignore                   # 退出码 137 不计入 backoffLimit
        onExitCodes:
          containerName: worker
          operator: In
          values: [137]
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: worker
          image: busybox:1.36
          command: ["sh", "-c", "exit 0"]
```

### 常用操作

```shell
# 列出所有 Job 及其完成情况
kubectl get jobs -A
kubectl get jobs -o custom-columns=\
NAME:.metadata.name,COMPLETIONS:.status.succeeded,ACTIVE:.status.active,FAILED:.status.failed

# 等待 Job 完成
kubectl wait --for=condition=complete job/pi --timeout=300s

# 查看某个 Pod 属于哪个 Job
kubectl get pod pi-abcde -o jsonpath='{.metadata.ownerReferences[0].name}'

# 查看失败原因
kubectl describe pod pi-abcde

# 删除 Job(默认级联删除其 Pod)
kubectl delete job pi

# 只删 Job 保留 Pod 以便排查
kubectl delete job pi --cascade=orphan

# 清空全部已完成的 Job
kubectl delete jobs --field-selector status.successful=1
```

### 注意

1. **`backoffLimit` 与 `completions` 完全不是一回事**。`completions` 是「需要成功多少次」,`backoffLimit` 是「允许失败重试多少次」,默认值都是 1 与 6,写错会导致任务提前判定失败或无限重试。
2. 两个参数都不填时,Job 默认 `completions: 1`、`parallelism: 1`、`backoffLimit: 6`;而 `backoffLimit` **不包含首次尝试**,即最多会创建 7 个 Pod。
3. `restartPolicy` 是**必填**的,且只能是 `Never` 或 `OnFailure`。填 `Always` 会被 API Server 直接拒绝。
4. Job 的 `spec.template` 几乎全部**不可变**,创建后无法修改镜像或命令;需要变更只能删除重建。`parallelism`、`activeDeadlineSeconds`、`backoffLimit` 等少数字段可以原地更新。
5. 使用 `Never` 时失败的 Pod 会残留在集群中(方便看日志),数量多时会占满 `kubectl get pods` 输出;配合 `ttlSecondsAfterFinished` 或 `--field-selector status.phase!=Succeeded` 过滤。
6. 重试是**指数退避**的:间隔从 10 秒开始翻倍,最长 6 分钟,因此一个持续失败的任务看起来「卡住了」其实是在等待下一次重试。
7. `activeDeadlineSeconds` 超时后 Job 会被标记为 `Failed` 并终止所有 Pod,这个判定**不受 `backoffLimit` 影响**。
8. Job 控制器通过 `batch.kubernetes.io/controller-uid` 标签认领 Pod,手动修改或删除这个标签会导致 Pod 被抛弃并不断重建。
9. 不用 `completionMode: Indexed` 时,并行 Pod 之间无法直接知道彼此编号,需要靠外部队列或分片机制协调。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `cronjob` — 定时任务控制器
- `pod` — 最小调度单元
- `deployment` — 无状态工作负载控制器

### 参考链接

- [Job 官方文档](https://kubernetes.io/docs/concepts/workloads/controllers/job/)
- [Job 的并行执行](https://kubernetes.io/docs/concepts/workloads/controllers/job/#parallel-jobs)
- [处理 Pod 与容器的失败](https://kubernetes.io/docs/tasks/job/pod-failure-policy/)
- [使用工作队列进行粗粒度并行处理](https://kubernetes.io/docs/tasks/job/coarse-parallel-processing-work-queue/)
