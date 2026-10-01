training-operator
===

Kubeflow的分布式训练作业控制器(TFJob/PyTorchJob等)

## 补充说明

**Training Operator** 是 Kubeflow 里最早的一批组件,它为每种训练框架提供一个 CRD,让「一次分布式训练」变成 Kubernetes 里的一个对象:

```shell
kubeflow.org/v1   PyTorchJob    PyTorch 分布式训练
kubeflow.org/v1   TFJob         TensorFlow 分布式训练
kubeflow.org/v1   XGBoostJob    XGBoost 分布式训练
kubeflow.org/v1   PaddleJob     飞桨分布式训练
kubeflow.org/v1   JAXJob        JAX 分布式训练
```

**状态提醒(重要):这一代产物已经进入维护模式,上游的精力转向了 Kubeflow Trainer v2。**

```shell
2025-07   Kubeflow Trainer v2.0.0 发布,引入统一的 TrainJob  API
2026-08   Training Operator v1 最后一个版本 v1.9.4(2026-08-18)
          源码冻结在 release-1.9 分支
```

`github.com/kubeflow/training-operator` 这个仓库**已经改名为 `kubeflow/trainer`**,访问老地址会跳转过去。V1 的代码继续放在 `release-1.9` 分支上维护,但不再有新功能;Kubernetes 社区(Kueue 项目)在讨论移除 Trainer v1 集成时给出的说法是「Kubeflow Trainer v1 本身已不再维护」。

需要说清楚的是:**它没有归档,也没有任何带日期的官方 EOL 公告**。准确表述是「维护模式 + 被 Trainer v2 取代」,不是「已死」。新项目请直接评估 Trainer v2;存量项目可以继续用,但要接受不再有新特性。

两者是两套并存的 API,不要混着看:

```shell
Training Operator v1        kubeflow.org/v1            每个框架一个 CRD(PyTorchJob 等)
                            manifests/overlays/standalone
                            namespace: kubeflow

Kubeflow Trainer v2         trainer.kubeflow.org/v1alpha1
                            TrainJob + TrainingRuntime + ClusterTrainingRuntime
                            manifests/overlays/manager + runtimes
                            namespace: kubeflow-system
```

### 安装 Training Operator v1

官方只用 kustomize 分发,**没有官方 Helm chart**(仓库里找不到 charts 目录,社区提过的 Helm 化讨论最终也没有落地):

```shell
kubectl apply --server-side -k \
  "github.com/kubeflow/training-operator.git/manifests/overlays/standalone?ref=v1.9.3"

kubectl get pods -n kubeflow
kubectl get crd | grep kubeflow.org
```

`manifests/overlays/standalone` 是 **V1 专用**的 overlay,在 Trainer v2 的仓库里**不存在**这个路径 —— 这是照着老文档安装 V2 时最常撞上的报错。

### PyTorchJob 示例

```shell
apiVersion: kubeflow.org/v1
kind: PyTorchJob
metadata:
  name: pytorch-mnist
  namespace: kubeflow
spec:
  runPolicy:
    cleanPodPolicy: Running
    ttlSecondsAfterFinished: 600
    backoffLimit: 3
  pytorchReplicaSpecs:
    Master:
      replicas: 1
      restartPolicy: OnFailure
      template:
        spec:
          containers:
            - name: pytorch
              image: kubeflow/pytorch-mnist:latest
              command:
                - python
                - /opt/mnist/src/mnist.py
              resources:
                limits:
                  nvidia.com/gpu: 1
    Worker:
      replicas: 2
      restartPolicy: OnFailure
      template:
        spec:
          containers:
            - name: pytorch
              image: kubeflow/pytorch-mnist:latest
              resources:
                limits:
                  nvidia.com/gpu: 1
```

创建与查看:

```shell
kubectl apply -f pytorchjob.yaml

kubectl get pytorchjob -n kubeflow
kubectl get pytorchjob pytorch-mnist -o yaml
kubectl describe pytorchjob pytorch-mnist

kubectl get pods -n kubeflow -l training.kubeflow.org/job-name=pytorch-mnist
kubectl logs -f pytorch-mnist-master-0

kubectl delete pytorchjob pytorch-mnist
```

Pod 的命名规律是 `<job-name>-<role>-<index>`,并且都带 `training.kubeflow.org/job-name` 与 `training.kubeflow.org/job-role` 两个标签,按标签查 Pod 比按名字猜更可靠。

### runPolicy 字段

```shell
cleanPodPolicy           作业结束后清理哪类 Pod(None / Running / All)
ttlSecondsAfterFinished  作业结束后多久删除对象,默认不删
activeDeadlineSeconds    整个作业的超时秒数,超时后标记为 Failed
backoffLimit             失败重试次数
schedulingPolicy         gang scheduling 相关配置
```

`ttlSecondsAfterFinished` 与 `activeDeadlineSeconds` 是训练场景最该配的两个值:前者防止跑完的作业堆积,后者防止卡死的训练永远占着 GPU。

### Gang scheduling

分布式训练要求所有角色同时拿到资源,否则会出现「master 起来了、worker 永远 Pending」。V1 通过 operator 的启动参数指定调度器:

```shell
--gang-scheduler-name=scheduler-plugins
--gang-scheduler-name=volcano
# 留空(默认)= 不启用 gang scheduling
```

装好调度器之后,训练作业通常还需要一个队列声明。例如 Volcano 需要提前建好 `Queue`,作业通过 `schedulingPolicy` 或注解指向它;KAI Scheduler 则由其 podgrouper 自动创建 PodGroup,队列用 `kai.scheduler/queue` 标签指定。

### 安装 Kubeflow Trainer v2

V2 是统一的 API:不再按框架分 CRD,而是「一个 `TrainJob` + 一个运行时模板」。前提是 Kubernetes ≥ 1.31、kubectl ≥ 1.31。

```shell
export VERSION=v2.3.0

kubectl apply --server-side -k \
  "https://github.com/kubeflow/trainer.git/manifests/overlays/manager?ref=${VERSION}"
kubectl apply --server-side -k \
  "https://github.com/kubeflow/trainer.git/manifests/overlays/runtimes?ref=${VERSION}"

kubectl get pods -n kubeflow-system
# jobset-controller-manager + kubeflow-trainer-controller-manager
```

`manager` overlay 会**顺带装上 JobSet**(V2 的底层控制器之一),集群里如果已经有 JobSet,需要把它从 overlay 里注掉,否则会打架。V2 还有官方 Helm chart(这在 Kubeflow 生态里并不常见):

```shell
helm install kubeflow-trainer oci://ghcr.io/kubeflow/charts/kubeflow-trainer \
  --namespace kubeflow-system --create-namespace --version ${VERSION#v} \
  --set runtimes.defaultEnabled=true
```

### TrainJob 示例

```shell
apiVersion: trainer.kubeflow.org/v1alpha1
kind: TrainJob
metadata:
  name: pytorch-distributed
  namespace: default
spec:
  runtimeRef:
    name: torch-distributed
    kind: ClusterTrainingRuntime
  trainer:
    numNodes: 2
    resourcesPerNode:
      requests:
        cpu: "4"
        memory: 8Gi
        nvidia.com/gpu: "1"
```

`TrainJob` **没有 `spec.template`** —— Pod 由运行时模板加 `spec.trainer` 拼出来。内置运行时包括 `torch_distributed`、`deepspeed_distributed`、`jax_distributed`、`mlx_distributed`、`xgboost_distributed` 以及 torchtune 系列;自定义运行时必须带 `trainer.kubeflow.org/framework` 标签,否则 SDK 不认。

```shell
kubectl get clustertrainingruntime
kubectl get trainjob -A
kubectl get trainjob pytorch-distributed -o jsonpath='{.status.conditions}' | jq .
```

### 常用操作

```shell
# 所有框架的作业一次性看全
kubectl get pytorchjob,tfjob,xgboostjob,paddlejob,jaxjob -A
kubectl get trainjob -A

# 某个作业的副本状态
kubectl get pytorchjob pytorch-mnist -o jsonpath='{.status.replicaStatuses}' | jq .

# 控制器日志
kubectl logs -n kubeflow deployment/training-operator --tail=100
kubectl logs -n kubeflow-system deployment/kubeflow-trainer-controller-manager --tail=100

# 指标
kubectl port-forward -n kubeflow deployment/training-operator 8080:8080
curl -s localhost:8080/metrics | grep -E "training_operator_jobs"
```

### 注意

1. **V1 与 V2 是两套 API,不是版本升级关系**。`PyTorchJob` 与 `TrainJob` 可以同时存在于一个集群,但装了两套控制器之后要清楚每个作业归谁管;迁移要用官方迁移文档逐项对照,不能只换 apiVersion。
2. **仓库改名了**。`kubeflow/training-operator` 现在会跳转到 `kubeflow/trainer`,老文档里指向 `training-operator` 的安装路径、issue 链接都可能失效;V1 的代码在 `release-1.9` 分支上。
3. **V1 没有官方 Helm chart**。网上流传的 `kubeflow.github.io/training-operator` 之类 chart 属于第三方配方,不是官方产物,别当成官方文档引用。
4. **`manifests/overlays/standalone` 只属于 V1**。V2 的路径是 `manifests/overlays/manager` 与 `overlays/runtimes`,套用老路径会直接报找不到目录。
5. **V2 仍在 alpha**。官方 README 明说「API 可能变化」,`trainer.kubeflow.org/v1alpha1` 至今仍是 v1alpha1;把它用进生产要接受升级时的破坏性变更。
6. **`MXNetJob` 不要再写**。当前 V1 API 包里已经没有 MXNet 的类型定义,`mxnet-operator` 也早已归档;老教程里的 MXNetJob 清单在新版本上会失败。
7. **MPIJob 已不属于本控制器**。V1 包里虽然残留了 MPIJob 的类型,但实际由独立的 **MPI Operator** 负责(`kubeflow.org/v2beta1`),两者不要混用。
8. **`cleanPodPolicy` 影响排障**。默认在作业结束后保留 Pod 的日志,如果设成 `All` 又忘了抓日志,失败原因会随着 Pod 一起消失;排查期间建议留 `Running` 或 `None`,确认稳定后再收紧。
9. **不配 gang scheduling 就可能死锁**。分布式训练各角色是互相等待的,部分 Pod 拿到资源、部分没拿到时,已启动的进程会一直空转占卡。多机作业务必配调度器,或者至少用 `activeDeadlineSeconds` 兜底。
10. **gang scheduling 下「Pod 中途死亡」仍需人工介入**。官方也提示过:负载高时死掉的 Pod 会让其他作业抢走资源进而死锁;这类场景要靠队列的抢占/回收策略配合,不是控制器自己能解决的。
11. **重启不等于续跑**。`restartPolicy: OnFailure` 只是把失败的 Pod 重新拉起来,**训练进度会丢**。真正的续跑要自己在训练脚本里定期写 checkpoint 到 PVC 或对象存储,并在启动时判断是否有可恢复的检查点;节点故障重建后同理。
12. **GPU 只是普通扩展资源**。每个角色的 `resources.limits` 都要自己写 `nvidia.com/gpu`,控制器不会替你推导;少写一个角色的 GPU 声明,那个角色就会跑在 CPU 上,表现为训练极慢或直接报错。
13. **作业删除要显式做**。除了 `ttlSecondsAfterFinished` 之外,V1 不会自动清理已完成的作业对象,长期运行会积累大量 `Succeeded` 状态的 CR 和它们的 Pod。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `mpi-operator` — 专注MPI作业的独立控制器
- `volcano` — 常用的gang scheduling实现
- `crd` — 各类训练作业都是自定义资源
- `job` — 原生批处理任务,与训练CRD的定位区别
- `poddisruptionbudget` — 训练Pod驱逐时的可用性保护
- `taints-tolerations` — GPU节点通常带污点
- `pvc` — checkpoint与数据集挂载的基础

### 参考链接

- [Kubeflow Trainer 仓库(原 training-operator)](https://github.com/kubeflow/trainer)
- [Training Operator v1 安装文档](https://www.kubeflow.org/docs/components/trainer/legacy-v1/installation/)
- [Training Operator v1 API 参考](https://pkg.go.dev/github.com/kubeflow/training-operator/pkg/apis/kubeflow.org/v1)
- [Kubeflow Trainer v2 安装文档](https://trainer.kubeflow.org/en/latest/operator-guides/installation.html)
- [从 Training Operator v1 迁移到 Trainer v2](https://trainer.kubeflow.org/en/latest/operator-guides/migration.html)
- [v1 作业调度(含 gang scheduling)](https://trainer.kubeflow.org/en/latest/legacy-v1/user-guides/job-scheduling.html)
