ray-operator
===

在Kubernetes上编排Ray集群与Ray应用的Operator(即KubeRay)

## 补充说明

**KubeRay**(项目正式名称,仓库 `ray-project/kuberay`)把 Ray 集群原生化到 Kubernetes:用一个 CRD 描述 head 节点与若干 worker 组,由 Operator 创建 Pod、Service 并负责自动伸缩。最新版本 **v1.7.0(2026-08-20)**,Helm chart 版本 1.7.1,活跃维护。

归属需要说清楚:**KubeRay 目前仍在 `ray-project` 组织下,由 Anyscale 主导**,不是 CNCF 项目。2026-09 有一个把它捐给 CNCF 的议题(`ray-project/ray#65900`),记录了维护者之间的共识并列出 Anyscale、Google、Microsoft、ByteDance、AWS 等共同开发者,但**截至核对时没有可核实的 CNCF 接纳结论**,不要按「CNCF 项目」介绍它。

四个 CRD(API 组 `ray.io`,当前版本 **v1**):

```shell
RayCluster    一个 Ray 集群:1 个 head + N 个 worker 组
RayJob        提交一次作业,自动创建 RayCluster 并在结束后清理
RayService    在线服务:RayCluster + Ray Serve 配置,支持零停机升级
RayCronJob    按 Cron 表达式周期创建 RayJob
```

`ray.io/v1` 从 **v1.0.0** 起成为存储版本;`v1alpha1` 在 v1.7.0 被标记为 **deprecated**(会返回 deprecationWarning),但**仍然可用**,没有在这个版本被移除。

### 安装

```shell
helm repo add kuberay https://ray-project.github.io/kuberay-helm/
helm repo update

kubectl create namespace ray-system
helm install kuberay-operator kuberay/kuberay-operator --version 1.7.0 -n ray-system

kubectl get crd | grep ray.io
```

**命名空间是 `ray-system`**(不是 `kuberay-system`)。仓库里还有 `kuberay-apiserver`(REST API 层,可选)与 `ray-cluster`(示例集群)。kustomize 方式:

```shell
kubectl create -k "github.com/ray-project/kuberay/ray-operator/config/default?ref=v1.7.0" -n ray-system
```

v1.7.0 里 operator chart 有一个破坏性变更:`metrics.serviceMonitor.selector` 改名为 `metrics.serviceMonitor.additionalLabels`,升级时自定义过该值的要同步改。

### RayCluster

```shell
apiVersion: ray.io/v1
kind: RayCluster
metadata:
  name: ray-demo
  namespace: default
spec:
  rayVersion: "2.56.0"
  enableInTreeAutoscaling: true
  headGroupSpec:
    rayStartParams:
      dashboard-host: "0.0.0.0"
    template:
      spec:
        containers:
          - name: ray-head
            image: rayproject/ray:2.56.0
            resources: {limits: {cpu: "4", memory: 16Gi}}
  workerGroupSpecs:
    - groupName: gpu-workers
      replicas: 2
      minReplicas: 0
      maxReplicas: 8
      rayStartParams:
        num-gpus: "2"
      template:
        spec:
          containers:
            - name: ray-worker
              image: rayproject/ray:2.56.0
              resources:
                limits:
                  nvidia.com/gpu: 2
```

```shell
kubectl apply -f raycluster.yaml
kubectl get raycluster
kubectl describe raycluster ray-demo

# worker 组是「裸 Pod」,不是 Deployment
kubectl get pods -l ray.io/cluster=ray-demo
```

命名规律:

```shell
head Pod        <cluster>-head-<5位随机>
worker Pod      <cluster>-<groupName>-worker-<5位随机>
head Service    <cluster>-head-svc(默认 headless,clusterIP: None)
serve Service   <name>-serve-svc
worker          没有 Service。只有 numOfHosts > 1 时才有一个集群级 headless Service
```

集群名长度上限是 **53** 个字符(因为 `-serve-svc` 是最长后缀)。纯 RayCluster 想暴露 Serve 端口需要打注解 `ray.io/enable-serve-service: "true"`,且 head 容器要有名为 `serve` 或 `serve-*` 的端口。

### 自动伸缩:三种机制,别搞混

```shell
1. Ray 自带 autoscaler   enableInTreeAutoscaling: true
                         head Pod 里的 sidecar,按 Ray 的负载语义伸缩 worker 组
                         直接 patch RayCluster 对象,不创建任何 HPA

2. Kubernetes HPA        基于 CPU/内存或自定义指标伸缩
                         对 Ray worker 组不适用,理由见「注意」

3. cluster-autoscaler    节点级伸缩。Ray 的 Pod 调度不上时加节点
                         需要自己配置,官方明说「You must configure the Kubernetes Autoscaler yourself」
```

Ray autoscaler 的工作方式在源码里很清楚:它对 `rayclusters/<name>` 发 JSON Patch,路径是 `/spec/workerGroupSpecs/{i}/replicas`,并用 `/spec/workerGroupSpecs/{i}/scaleStrategy` 的 `workersToDelete` 精确指定要下线哪些 worker。**整个过程不涉及 HPA 对象**,官方表述是「Autoscaler 通过增加 RayCluster CR 的 `replicas` 字段来请求一个额外的 worker Pod」。

```shell
spec.enableInTreeAutoscaling                  打开内置自动伸缩
spec.autoscalerOptions.resources              默认 500m CPU + 512Mi 内存(requests 与 limits)
spec.autoscalerOptions.idleTimeoutSeconds     空闲多久缩容,默认 60
spec.autoscalerOptions.upscalingMode          Default | Aggressive | Conservative
spec.autoscalerOptions.version                v1 | v2;Ray 2.47.0+ 默认 v2
spec.workerGroupSpecs[].idleTimeoutSeconds    针对单个 worker 组覆盖空闲时间
```

`upscalingMode` 三个值首字母大写:`Default` 与 `Aggressive` 目前等价(不限速),`Conservative` 把同时 pending 的 worker 数限制在集群规模以内。sidecar 容器名是 **`autoscaler`**:

```shell
kubectl logs ray-demo-head-xxxxx -c autoscaler --tail=100
```

(示例清单里出现过 `ray-cluster-autoscaler` 这样的资源名,但那不是容器名。)开启自动伸缩时 worker Pod 需要 `restartPolicy: Never`,KubeRay 1.7 会自动设置,而 Ray 2.56.0 起这个限制被放开。head Pod 建议加 `cluster-autoscaler.kubernetes.io/safe-to-evict: "false"`,它是整个集群的单点。

### RayJob

```shell
apiVersion: ray.io/v1
kind: RayJob
metadata:
  name: ray-job-demo
spec:
  entrypoint: python /home/ray/samples/sample_code.py
  submissionMode: K8sJobMode
  shutdownAfterJobFinishes: true
  ttlSecondsAfterFinished: 600
  runtimeEnvYAML: |
    working_dir: "/home/ray/samples"
  rayClusterSpec:
    rayVersion: "2.56.0"
    headGroupSpec:
      template:
        spec:
          containers:
            - name: ray-head
              image: rayproject/ray:2.56.0
```

```shell
submissionMode            K8sJobMode(默认)| HTTPMode | InteractiveMode | SidecarMode
entrypoint                要执行的命令
shutdownAfterJobFinishes   作业结束后是否删除集群
ttlSecondsAfterFinished    结束后多久删对象;仅在 shutdownAfterJobFinishes=true 时生效,默认 0
runtimeEnvYAML             运行时环境,多行 YAML 字符串(注意不是 runtimeEnv)
backoffLimit               失败重试次数,默认 0;每次重试会新建一个 RayCluster
activeDeadlineSeconds      整个作业的超时
managedBy                  ray.io/kuberay-operator 或 kueue.x-k8s.io/multikueue
```

`rayVersion` **不在 RayJob 顶层**,它在 `spec.rayClusterSpec.rayVersion`。

### RayService

```shell
apiVersion: ray.io/v1
kind: RayService
metadata:
  name: ray-serve-demo
spec:
  serveConfigV2: |
    applications:
      - name: my-app
        import_path: my_app:app
        route_prefix: /
  rayClusterConfig:            # 注意字段名,不是 rayClusterSpec
    rayVersion: "2.56.0"
    headGroupSpec: {}
    workerGroupSpecs: []
  upgradeStrategy:
    type: NewClusterWithIncrementalUpgrade
    clusterUpgradeOptions:
      maxSurgePercent: 20
      stepSizePercent: 10
      intervalSeconds: 30
```

```shell
NewCluster                       新建集群,就绪后整体切流,再删旧集群(蓝绿)
NewClusterWithIncrementalUpgrade 渐进式切流,按百分比逐步迁移,资源占用更低
None                             不自动升级
```

渐进式升级依赖 **Gateway API** 做流量切换,由特性门控 `RayServiceIncrementalUpgrade` 控制,v1.7.0 起该门控已是 **beta 且默认开启**。升级期间 status 里会同时出现 `activeServiceStatus` 与 `pendingServiceStatus`(新旧两个集群),还有 `numServeEndpoints`、`trafficRoutedPercent` 等字段;`rayClusterDeletionDelaySeconds` 默认 60 秒,控制旧集群延迟多久删除。

### GCS 容错与 GPU

Ray 的 GCS(Global Control Store)是集群元数据中枢,head 挂掉集群就没了。长期方案是外部 Redis;v1.7.0 新增 **`GCSFaultToleranceEmbeddedStorage`**(alpha,默认关闭):

```shell
spec:
  gcsFaultToleranceOptions:
    backend: rocksdb
    storage:
      size: 1Gi
```

打开后**不再需要外部 Redis**,但要显式开启门控 `--feature-gates=GCSFaultToleranceEmbeddedStorage=true`。

GPU 的写法:

```shell
resources:
  limits:
    nvidia.com/gpu: 2      # 必须写在 limits 里
rayStartParams:
  num-gpus: "2"            # 可选覆盖;rayStartParams 的值必须是字符串
```

Operator 会根据容器的 GPU limits 自动推导 `--num-gpus`。官方还有一个安全提醒:**Pod 资源里没有 `nvidia.com/gpu` 时,`NVIDIA_VISIBLE_DEVICES` 的默认值是 `all`** —— 不需要 GPU 的 Pod 建议显式设成 `void`。

### 常用操作

```shell
kubectl get raycluster,rayjob,rayservice -A
kubectl get raycluster ray-demo -o jsonpath='{.status}' | jq .
kubectl get pods -l ray.io/cluster=ray-demo -o wide

# Dashboard(默认 8265)
kubectl port-forward svc/ray-demo-head-svc 8265:8265

# autoscaler 日志(伸缩不生效时第一个看这个)
kubectl logs ray-demo-head-xxxxx -c autoscaler --tail=200

# 暂停集群(保留对象,删除 Pod):spec.suspend: true
kubectl patch raycluster ray-demo --type merge -p '{"spec":{"suspend":true}}'
```

### 注意

1. **Ray 的 worker 组不是 Deployment**。Operator 直接创建 Pod(它的 RBAC 里**完全没有 `apps` 组的权限**),所以 `kubectl get deploy` 永远看不到 Ray 的 worker,`kubectl rollout restart` 之类操作也无从谈起;要重启就删 Pod 或让 Operator 重建。
2. **Ray 自带 autoscaler 与 Kubernetes HPA 不是一套东西**。Ray autoscaler 直接改 RayCluster CR 的 `replicas` 并按 Ray 的负载语义决策;官方把它与 HPA 做对比时列出三点差异:用应用语义指标而非 CPU/内存、缩容时精确挑选要下线的 Pod(「随机缩容一个 Pod 可能是危险的」)、一个集群一个 autoscaler 而非集中式管理。**官方没有一句「禁止与 HPA 同时使用」** —— 但机制上它们会争抢同一个字段:Ray autoscaler 用 JSON Patch 写 `replicas`,HPA 走 scale 子资源写副本数,**没有任何组件做仲裁**;Ray autoscaler 还会写 `scaleStrategy.workersToDelete`,HPA 无法感知;而 Operator 每次调谐都会把 `replicas` 夹到 `[minReplicas, maxReplicas]` 之间,**HPA 给出的越界值会被静默忽略**。结论:**同一个 RayCluster 上不要叠加 HPA**,要弹性用 `enableInTreeAutoscaling`,要节点级弹性用 cluster-autoscaler。真实存在的类似冲突是 GitOps 侧的(Argo CD/Flux 持续把 `replicas` 拉回清单值,与 autoscaler 来回打架),解法是在 Argo CD 里给 `.spec.workerGroupSpecs[].replicas` 与 `.scaleStrategy` 配 `ignoreDifferences`。
3. **`minReplicas` 与 `maxReplicas` 是硬边界**。Operator 每次调谐都会做夹取,「手动改大 `replicas` 但没改 `maxReplicas`」的结果是改动被悄悄丢弃。
4. **`idleTimeoutSeconds` 有两个层级**,worker 组上的会覆盖 `autoscalerOptions` 的全局默认值(默认 60 秒)。缩容慢或缩不下去时先看这里,而不是怀疑调度器。
5. **`upscalingMode` 是首字母大写的枚举**,写 `conservative` 通不过校验;`Aggressive` 当前与 `Default` 等价,不要期待额外效果。
6. **RayJob 的 `submissionMode` 有四个值**:`K8sJobMode`(默认)、`HTTPMode`、`InteractiveMode`、`SidecarMode`(往 head Pod 里注入一个提交容器)。老文档常只列前三个。
7. **`ttlSecondsAfterFinished` 只在 `shutdownAfterJobFinishes: true` 时生效**。设了前者没设后者是常见配置错误,结果是作业跑完对象与集群都留着。
8. **`backoffLimit` 的每次重试都会新建一个 RayCluster**。重试次数多时集群对象会反复出现消失,而失败原因在已删除的 head 日志里;排障期间建议先设为 0。
9. **`rayVersion` 的位置容易写错**。RayJob 里它在 `spec.rayClusterSpec.rayVersion`,不顶层;运行时环境字段是 `runtimeEnvYAML`(字符串),不是 `runtimeEnv`。
10. **异步升级依赖 Gateway API**。`NewClusterWithIncrementalUpgrade` 需要集群里有 Gateway API 的 CRD 且门控开启(v1.7.0 起默认 beta 开启),否则会失败或退化为整体切换。
11. **head Pod 是单点**。要它不被 cluster-autoscaler 驱逐,记得打 `cluster-autoscaler.kubernetes.io/safe-to-evict: "false"`;GCS 容错在 v1.7.0 之前都要依赖外部 Redis,新版本可用实验性的内嵌存储替代。
12. **客户端应该连 Service 名而不是 Pod IP**。集群重建后 head Pod 名与 IP 都会变,`<cluster>-head-svc` 与 `<cluster>-serve-svc` 的 DNS 名则保持稳定。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `volcano` — 多Pod协同作业的gang scheduling
- `cluster-autoscaler` — 节点级弹性,与Ray autoscaler互补
- `hpa` — 与其叠加会争抢replicas字段
- `crd` — RayCluster/RayJob/RayService都是自定义资源
- `pod` — worker组是裸Pod,不是Deployment
- `nvidia-device-plugin` — GPU可见性的前提
- `keda` — 事件驱动伸缩的另一种思路

### 参考链接

- [KubeRay 仓库](https://github.com/ray-project/kuberay)
- [v1.7.0 Release](https://github.com/ray-project/kuberay/releases/tag/v1.7.0)
- [KubeRay Operator 安装](https://docs.ray.io/en/latest/cluster/kubernetes/getting-started/kuberay-operator-installation.html)
- [自动伸缩配置](https://docs.ray.io/en/latest/cluster/kubernetes/user-guides/configuring-autoscaling.html)
- [与 Kubernetes Autoscaler 的关系](https://docs.ray.io/en/latest/cluster/kubernetes/user-guides/k8s-autoscaler.html)
- [GPU 使用](https://docs.ray.io/en/latest/cluster/kubernetes/user-guides/gpu.html)
