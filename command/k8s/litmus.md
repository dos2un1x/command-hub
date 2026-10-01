litmus
===

LitmusChaos混沌工程框架:基于实验库与工作流的故障演练

## 补充说明

**LitmusChaos** 是一个云原生的混沌工程框架,CNCF 孵化项目。它的核心思路与 Chaos Mesh 不同:**先有实验库,再有实验**。社区把常见故障写成了一个个标准化的 **ChaosExperiment**,使用者只需在 `ChaosEngine` 里引用实验名并填写参数,不必自己描述故障如何注入。

三个关键概念:

```shell
ChaosExperiment   实验的定义(容器镜像 + 参数 + 探针),来自 ChaosHub 或自定义
ChaosEngine       实验的实例化:在哪个应用上、用哪个实验、参数填什么
ChaosResult       实验结果:通过还是失败,以及详细的执行记录
```

Litmus 2.0 之后引入了 **ChaosCenter** 门户,把实验编排、执行记录、混沌枢纽(ChaosHub)集中到 Web 界面,并通过 **Chaos Infrastructure** 的概念把「控制面」与「执行面」分开 —— 门户可以管理多个集群上的混沌执行代理。

3.x 在 2.x 的基础上进一步转向基于 **Argo Workflows** 的工作流编排,`ChaosEngine` 仍然可用,但新建场景更推荐用 `Workflow`。

### 安装

```shell
# 方式一:Helm 一键安装 ChaosCenter
helm repo add litmuschaos https://litmuschaos.github.io/litmus-helm/
helm repo update
kubectl create ns litmus
helm install chaos litmuschaos/litmus --namespace=litmus \
  --set portal.frontend.service.type=NodePort
```

```shell
# 方式二:分步安装(需要自备 MongoDB)
helm repo add bitnami https://charts.bitnami.com/bitnami
helm install my-release bitnami/mongodb --values mongo-values.yml -n <NAMESPACE> --create-namespace
kubectl apply -n <NAMESPACE> -f https://raw.githubusercontent.com/litmuschaos/litmus/master/mkdocs/docs/3.20.0/litmus-getting-started.yaml
```

确认安装:

```shell
kubectl get pods -n litmus
kubectl get svc -n litmus
```

### 访问门户

```shell
# 端口转发
kubectl port-forward svc/chaos-litmus-frontend-service 9091:9091
# 浏览器打开 http://localhost:9091

# NodePort 方式
kubectl get svc -n litmus
# 访问 http://<节点IP>:<NodePort>
```

默认账号是 `admin` / `litmus`,首次登录后会进入一个默认项目。**这套默认凭据必须在上生产前修改或删除**。

### 语法

```shell
kubectl apply -f chaosengine.yaml     创建实验
kubectl get chaosengine -A            查看实验列表
kubectl get chaosresult -A            查看实验结果
kubectl describe chaosengine <name>   查看执行详情
kubectl delete chaosengine <name>     删除实验
```

核心 CRD 与所属 API 组:

```shell
ChaosEngine      litmuschaos.io/v1alpha1   实验实例
ChaosExperiment  litmuschaos.io/v1alpha1   实验定义
ChaosResult      litmuschaos.io/v1alpha1   实验结果
ChaosHub         litmuschaos.io/v1alpha1   混沌枢纽
ChaosSchedule    litmuschaos.io/v1alpha1   定时实验
Workflow         argoproj.io/v1alpha1      3.x 的工作流编排
CronWorkflow     argoproj.io/v1alpha1      定时工作流
```

### ChaosEngine 实验

`ChaosEngine` 是 2.x 时代的经典写法,3.x 仍兼容:

```shell
apiVersion: litmuschaos.io/v1alpha1
kind: ChaosEngine
metadata:
  name: nginx-chaos
  namespace: default
spec:
  appinfo:
    appns: default
    applabel: 'app=nginx'
    appkind: deployment
  chaosServiceAccount: litmus-admin
  experiments:
    - name: pod-delete
      spec:
        components:
          env:
            - name: TOTAL_CHAOS_DURATION
              value: '30'
            - name: CHAOS_INTERVAL
              value: '10'
            - name: FORCE
              value: 'false'
```

关键字段:

```shell
appinfo            目标应用:命名空间、标签、类型
chaosServiceAccount 执行实验用的 ServiceAccount,见下方「注意」
experiments        要运行的实验列表
engineState        active 表示运行,stop 表示停止
```

**实验的定义必须先存在于集群中**。引用一个未安装的实验,`ChaosEngine` 会创建但永远不执行 —— 这正是 ChaosHub 与门户的作用:把实验定义同步进来。

常用的内置实验:

```shell
pod-delete                 删除 Pod
pod-network-latency        注入网络延迟
pod-network-loss           注入丢包
pod-network-corruption     注入报文损坏
pod-cpu-hog                制造 CPU 压力
pod-memory-hog             制造内存压力
pod-io-stress              制造 IO 压力
container-kill             杀掉容器
node-drain                 驱逐节点上的 Pod
node-cpu-hog               节点级 CPU 压力
disk-fill                  填充磁盘
kubelet-service-kill       停掉 kubelet 服务
```

### 工作流编排

3.x 推荐用 Argo 的 `Workflow` 描述实验,由 Litmus 提供的模板步骤串联起来:

```shell
apiVersion: argoproj.io/v1alpha1
kind: Workflow
metadata:
  name: pod-delete-workflow
  namespace: litmus
spec:
  entrypoint: pod-delete
  templates:
    - name: pod-delete
      steps:
        - - name: install-chaos-experiments
            template: install-chaos-experiments
        - - name: pod-delete
            template: pod-delete
```

工作流的优势在于可以把「准备 → 注入 → 验证 → 清理」串成一条流水线,并且在门户里可视化每一步的执行结果。`CronWorkflow` 则用于周期性的常态化演练。

### litmusctl 命令行

门户之外,`litmusctl` 提供了脚本化的接入方式:

```shell
# 安装:下载对应平台的压缩包后解压
tar -zxvf litmusctl-<OS>-<ARCH>-<VERSION>.tar.gz
chmod +x litmusctl
sudo mv litmusctl /usr/local/bin/litmusctl

# 确认可用
litmusctl version

# 通用调用形式
litmusctl <command> <subcommand> [options and parameters]
```

它默认读取 `~/.kube/config`,底层通过 kubectl 把清单应用到集群,因此需要具备目标集群的 kubeconfig。主要用途是把**混沌基础设施(Chaos Infrastructure)的接入流程脚本化**,免去每次都在门户里手工注册;具体的子命令与参数以官方 Litmusctl 参考文档为准。

### 注意

1. **默认账号 `admin` / `litmus` 必须在部署后立即处理**。门户对外可达而凭据未改,等于把整个集群的故障注入能力公开。
2. **服务账号的选择直接决定爆炸半径**。Litmus 通常提供 `litmus` 与 `litmus-admin` 两个 ServiceAccount,后者权限高得多(可操作节点级资源)。**生产环境一律优先使用 `litmus`**,只在确实需要节点级实验时才用 `litmus-admin`,并把它限定在专用命名空间。
3. **实验定义必须先安装**。只创建 `ChaosEngine` 而实验 CR 不存在时不会有任何报错提示,表现为「建了实验但什么都没发生」,排障第一步就是确认对应实验是否已在集群中。
4. **`ChaosEngine` 的 `engineState` 需要显式管理**。运行中的实验不会因为「一次跑完」就消失,想提前结束要把状态置为 `stop` 或删除对象,否则故障可能一直挂着。
5. **生产演练的前提条件必须齐备**:预发环境已验证过同一实验、有明确的观测指标与中止条件、有回滚方案、值班人员在场、避开业务高峰、并且**先从影响面最小的实验开始**(如单个 Pod 的 `pod-delete`),逐步放大。
6. **控制爆炸半径靠三件事**:选择权限最小的 ServiceAccount、把目标限定到具体命名空间与标签、把持续时间(`TOTAL_CHAOS_DURATION`)设得尽可能短。Litmus 不会替你限制影响面。
7. **它不遵守 PodDisruptionBudget**。多数销毁类实验走的是直接删除而非 Eviction API,PDB 拦不住;副本数与反亲和性才是真正的保护。
8. **3.x 与 2.x 的差异很大**。3.x 以 `Workflow` + 门户 + Chaos Infrastructure 为中心,2.x 的 `ChaosEngine` 已不是主推方式;它是否在所有 3.x 版本上完全兼容,官方不同页面的说法并不一致,迁移旧实验前应当先在测试环境实测确认。
9. **门户与执行代理需要双向可达**。ChaosCenter 通过订阅模式向代理下发任务,网络策略阻断了这条链路时,门户上会一直是「代理未连接」。
10. **MongoDB 是门户的必要依赖**。自建安装时漏掉数据库,门户会一直处于待就绪状态;用 Helm 一键安装则由 chart 负责。
11. **实验结果要归档**。`ChaosResult` 记录的是执行当时的状态,长期保留才能看出「韧性是否在变好」,建议把结果导出到外部存储而不是留在集群里。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `chaos-mesh` — 另一套以 CRD 直接描述故障的混沌工程平台
- `kube-monkey` — 轻量的随机删 Pod 工具,适合起步
- `helm` — Kubernetes包管理器
- `argo-workflows` — Litmus 3.x 工作流的编排引擎

### 参考链接

- [LitmusChaos 官方网站](https://litmuschaos.io/)
- [LitmusChaos GitHub 仓库](https://github.com/litmuschaos/litmus)
- [LitmusChaos 官方文档](https://docs.litmuschaos.io/)
- [ChaosCenter 安装说明](https://docs.litmuschaos.io/docs/getting-started/installation)
- [litmusctl 安装说明](https://docs.litmuschaos.io/docs/litmusctl/installation)
- [内置混沌实验库](https://litmuschaos.github.io/litmus/experiments/categories/contents/)
