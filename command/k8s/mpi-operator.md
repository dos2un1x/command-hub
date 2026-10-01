mpi-operator
===

Kubernetes上运行MPI分布式训练作业的控制器

## 补充说明

**MPI Operator** 把一次多机多卡的 `mpirun` 拆成两类 Pod:**Launcher**(1 个,执行 `mpirun` 命令)与 **Worker**(N 个,等待被 launcher 拉起)。它维护的 CRD 是 `MPIJob`,当前 API 版本为 **`kubeflow.org/v2beta1`** —— 只有这一个版本被注册,老教程里的 `v1alpha2`、`v1beta1` 已经不存在(v1 在 v0.4.0 就被移除了,官方当时的说明是「要跑 MPIJob v1 请改用 training-operator」)。

项目状态:仍在维护,最新版本 **v0.8.2(2026-07-03)**,仓库未归档。但近期提交以依赖升级为主,属于**低活跃的维护状态**,没有功能演进。要留意两点:

- 它**不在 Kubeflow 默认发行版(`example/kustomization.yaml`)的组件表里**,必须单独安装。
- **Kubeflow Trainer v2 已经覆盖 MPI 场景**(内置 MPI 支持,目前只支持 OpenMPI),迁移文档给出了 `MPIJob` → `TrainJob` 的对应关系。新项目建议先评估 Trainer v2;继续用 MPI Operator 也没有问题,只是要有「上游精力已经转移」的预期。

运行模型:

```shell
Launcher   1 个 Pod,执行 mpirun -np <进程总数> ...
           它同时负责生成 hostfile(通过 discover_hosts.sh)
Worker     N 个 Pod,启动后等待 launcher 通过 SSH 连进来
           每个 worker 的可用进程数由 spec.slotsPerWorker 决定
SSH 密钥   由 operator 为每个作业生成,Secret 名固定为 <mpijob-name>-ssh
```

**进程总数 = `slotsPerWorker` × Worker 副本数**,launcher 自身不占 slot。这个乘号是配置 MPI 作业时最容易算错的地方。

### 安装

官方推荐直接 apply release 的清单(注意路径里有 `v2beta1`,且要带 `--server-side`):

```shell
kubectl apply --server-side -f \
  https://raw.githubusercontent.com/kubeflow/mpi-operator/v0.8.2/deploy/v2beta1/mpi-operator.yaml

# 确认
kubectl get pods -n mpi-operator
kubectl get crd mpijobs.kubeflow.org
```

用 kustomize 安装(README 给出的 overlay 是 `manifests/overlays/kubeflow`,它会把 operator 装进 `kubeflow` 命名空间):

```shell
kubectl apply -k manifests/overlays/kubeflow
# 或
kustomize build manifests/overlays/kubeflow | kubectl apply -f -
```

默认部署把 operator 放在 `mpi-operator` 命名空间(leader election 的锁命名空间默认也是 `mpi-operator`,可用 `--lock-namespace` 改)。

### 一个完整的 MPIJob

```shell
apiVersion: kubeflow.org/v2beta1
kind: MPIJob
metadata:
  name: pi-demo
  namespace: default
spec:
  slotsPerWorker: 2          # 注意:与 mpiReplicaSpecs 同级
  runPolicy:
    cleanPodPolicy: Running  # 作业结束后清掉 Running 的 Pod
  mpiReplicaSpecs:
    Launcher:
      replicas: 1
      template:
        spec:
          containers:
            - name: launcher
              image: mpioperator/mpi-pi:openmpi
              command:
                - mpirun
                - --allow-run-as-root
                - -np
                - "4"                    # = slotsPerWorker(2) × Worker.replicas(2)
                - /home/mpiuser/pi
    Worker:
      replicas: 2
      template:
        spec:
          containers:
            - name: worker
              image: mpioperator/mpi-pi:openmpi
```

创建与查看:

```shell
kubectl apply -f mpijob.yaml

kubectl get mpijob
kubectl get mpijob pi-demo -o yaml
kubectl describe mpijob pi-demo

# 两类 Pod 的命名规律
kubectl get pods -l training.kubeflow.org/job-name=pi-demo
kubectl get pods -l training.kubeflow.org/job-name=pi-demo,training.kubeflow.org/job-role=launcher
```

在线修改 worker 数量是不被支持的,想改规模只能重建 MPIJob。

### 多机多卡训练

GPU 训练常见的写法是每个 worker 占满本机 GPU,launcher 通过 `-np` 指定进程总数:

```shell
spec:
  slotsPerWorker: 8
  mpiReplicaSpecs:
    Launcher:
      replicas: 1
      template:
        spec:
          containers:
            - name: launcher
              image: <训练镜像>
              command:
                - mpirun
                - --allow-run-as-root
                - -np
                - "16"                 # 2 台 × 8 卡
                - -x
                - NCCL_DEBUG=INFO      # 用 -x 把环境变量透传给 worker
                - python
                - train.py
    Worker:
      replicas: 2
      template:
        spec:
          containers:
            - name: worker
              image: <训练镜像>
              resources:
                limits:
                  nvidia.com/gpu: 8
```

`mpirun` 后面用 `-x` 透传环境变量是最省事的做法;官方示例里还常见 `--mca pml ob1 --mca btl ^openib` 这类参数,用于在容器里绕开不可用的 BTL 组件。

### Hostfile 的生成方式

hostfile 由 operator 根据 `--cluster-domain` 启动参数决定地址格式:

```shell
# 未设置 --cluster-domain 时
<pod-name>.<mpi-job-name>.<namespace>.svc

# 设置了 --cluster-domain(例如 cluster.local)时
<pod-name>.<mpi-job-name>.<namespace>.svc.<cluster-domain>
```

也就是说**跨节点通信走的是 Pod DNS 名,不是 hostNetwork**。集群 DNS(通常是 CoreDNS)必须正常解析 `<pod>.<svc>` 这类记录,否则 launcher 生成出来的 hostfile 连不上 worker。

### Gang scheduling

MPI 作业必须整组一起跑,所以通常要配 gang scheduling。MPI Operator 用启动参数开启(注意**不叫** `--gang-scheduler-name`,那是 Training Operator v1 的参数):

```shell
--gang-scheduling=volcano               # 使用 Volcano
--gang-scheduling=scheduler-plugins     # 使用 scheduler-plugins
# 留空(默认)= 关闭 gang scheduling
```

代码里的常量只有 `volcano` 与 `scheduler-plugins` 两个;传别的值会被当成「scheduler-plugins 的调度器名」处理,所以也能写成 `--gang-scheduling=default-scheduler`。

开启后 operator 会为每个 MPIJob **自动创建同名 PodGroup**,并给 Pod 模板打上调度器需要的标记 —— 两者写法不一样,别记混:

```shell
Volcano            注解 scheduling.k8s.io/group-name
scheduler-plugins  标签 scheduling.x-k8s.io/pod-group
```

`spec.runPolicy.schedulingPolicy` 里的字段:

```shell
minAvailable            PodGroup 的 minMember。不写时默认 worker 副本数 + 1(算上 launcher)
queue                   对应 Volcano 的 PodGroup queue;不写则回退到注解
                        scheduling.volcano.sh/queue-name。scheduler-plugins 不使用
priorityClass           对应 Volcano PodGroup 的 priorityClassName。
                        取值优先级:schedulingPolicy > Launcher 模板 > Worker 模板
minResources            PodGroup 的最小资源;不写则由 operator 按副本求和算出
scheduleTimeoutSeconds  仅 scheduler-plugins 使用,Volcano 会忽略
```

示例:

```shell
spec:
  runPolicy:
    schedulingPolicy:
      minAvailable: 3
      queue: research
```

operator 会**覆盖** Pod 模板里的 `spec.schedulerName`(Volcano 场景下改成 `volcano`),如果你自己写了别的调度器名,日志里会有一条 warn。

### 常用操作

```shell
# 查看作业与副本状态
kubectl get mpijob -A
kubectl get mpijob pi-demo -o jsonpath='{.status.replicaStatuses}' | jq .

# launcher 日志(训练的主输出)
kubectl logs -f pi-demo-launcher-xxxxx

# worker 日志
kubectl logs pi-demo-worker-0

# 查看生成的 SSH Secret
kubectl get secret pi-demo-ssh
kubectl get secret pi-demo-ssh -o jsonpath='{.data.ssh-privatekey}' | base64 -d | head

# operator 自身日志
kubectl logs -n mpi-operator deployment/mpi-operator --tail=100

# 指标(默认在 8080 端口)
kubectl port-forward -n mpi-operator deployment/mpi-operator 8080:8080
curl -s localhost:8080/metrics | grep mpi_operator_jobs_
```

### 排障

```shell
# 1. 作业一直 Pending:先看是不是 gang scheduling 卡住了
kubectl describe mpijob pi-demo | tail -30
kubectl get podgroup -n default                   # Volcano
kubectl get podgroup -n default -o yaml | grep -A5 status

# 2. launcher 起来了但 worker 连不上:看 SSH 与 DNS
kubectl logs pi-demo-launcher-xxxxx | head -50
kubectl exec -it pi-demo-launcher-xxxxx -- nslookup pi-demo-worker-0.pi-demo.default.svc

# 3. worker 数量与 mpirun 的 -np 对不上
kubectl get pods -l training.kubeflow.org/job-name=pi-demo
# 核对 slotsPerWorker × Worker.replicas 是否等于 -np

# 4. 只看 GPU 是否真的分配到了
kubectl exec -it pi-demo-worker-0 -- nvidia-smi -L
```

### 注意

1. **`slotsPerWorker` 与 `mpiReplicaSpecs` 同级**,不是写在 Launcher 或 Worker 里面。写错层级时 YAML 不报错但会被忽略,表现为进程数与预期不符。
2. **进程总数 = `slotsPerWorker` × Worker 副本数**,launcher 不占 slot。而 Pod 里的 `resources.limits` 是**按 Pod** 申请的,GPU 数量要和 `slotsPerWorker` 对齐,否则会出现「申请了 8 张卡却只起 4 个进程」或反之。
3. **CRD 只有 `kubeflow.org/v2beta1`**。网上大量示例还写着 `v1alpha2`/`v1beta1`,直接照抄会报 `no matches for kind`。
4. **gang scheduling 的参数名是 `--gang-scheduling`**,取值 `volcano` 或 `scheduler-plugins`;`--gang-scheduler-name` 是 Training Operator v1 的参数,用在 MPI Operator 上不生效。
5. **Volcano 与 scheduler-plugins 的标记写法不同**:前者用**注解** `scheduling.k8s.io/group-name`,后者用**标签** `scheduling.x-k8s.io/pod-group`。operator 会自动加,手工改反而容易破坏。
6. **不配 gang scheduling 时,worker 可能被拆开调度** —— 一半 Pod 起来了、另一半永远 Pending,launcher 一直等不齐人,`mpirun` 卡在初始化阶段。这是多机训练最常见的一种「看起来像卡死」。
7. **worker 中途挂掉不会自动补齐**。MPI 作业是有状态的整体,一个 worker 退出后 launcher 通常直接失败退出,整个作业进入 Failed;要靠上层的重试(如 Argo Workflows 的 retry)或**从 checkpoint 恢复**。训练脚本必须自己定期写 checkpoint 到 PVC 或对象存储,否则重启后只能从头再来。
8. **节点故障 = 作业失败**。MPI Operator 不做弹性伸缩,也不做 worker 重调度;节点宕机后 Pod 会被重建,但新 Pod 的地址变化会让 launcher 侧的 hostfile 失效,实践上等同于重跑作业。
9. **SSH Secret 名字是 `<mpijob-name>-ssh`**(如 `pi-demo-ssh`),前缀不是 `mpi-job-ssh-`。作业被删除时该 Secret 一并清理;手工删掉它会导致后续调度失败。
10. **launcher 退出的那一刻作业就结束了**。worker 是被动等待方,训练逻辑必须放在 launcher 执行的 `mpirun` 命令里;把训练脚本写成 worker 的入口是不会被执行的。
11. **跨节点通信依赖集群 DNS**。hostfile 用的是 `<pod>.<job>.<ns>.svc` 形式的地址,CoreDNS 异常或 NetworkPolicy 拦截会导致 launcher 无法连上 worker,而报错信息往往只是 `Connection refused` 或 `Permission denied`(SSH 层)。
12. **它不在 Kubeflow 默认发行版中**,也不随发行版一起升级。装了 Kubeflow Platform 之后仍然要单独 apply MPI Operator 的清单,版本自行维护。
13. **上游精力已转向 Kubeflow Trainer v2**。Trainer v2 内置 MPI 支持(当前仅 OpenMPI),并通过 `TrainJob` + `ClusterTrainingRuntime` 表达;`MPIJob` 仍可用,但新项目值得先评估迁移路径。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `volcano` — 最常用的gang scheduling实现
- `training-operator` — Kubeflow的训练作业控制器家族
- `crd` — MPIJob本身就是一种自定义资源
- `taints-tolerations` — GPU节点通常带污点,需要显式容忍
- `pod` — 排障的最小单位
- `job` — 单机批处理任务,与MPIJob的定位区别

### 参考链接

- [MPI Operator 仓库](https://github.com/kubeflow/mpi-operator)
- [MPIJob v2beta1 API 参考](https://pkg.go.dev/github.com/kubeflow/mpi-operator/pkg/apis/kubeflow/v2beta1)
- [v2beta1 官方示例](https://github.com/kubeflow/mpi-operator/tree/master/examples/v2beta1)
- [Kubeflow Trainer v2(含 MPI 支持)](https://github.com/kubeflow/trainer)
- [MPIJob 迁移到 TrainJob](https://trainer.kubeflow.org/en/latest/operator-guides/migration.html)
