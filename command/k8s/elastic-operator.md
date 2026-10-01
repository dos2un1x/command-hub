elastic-operator
===

在Kubernetes上以Operator方式运行管理Elasticsearch集群

## 补充说明

**Elastic Cloud on Kubernetes(ECK)** 是 Elastic 官方的 Kubernetes Operator,二进制与 Helm Chart 的名字都是 `eck-operator`。它用一个 `Elasticsearch` CR 描述集群,把节点按 **nodeSet** 分组,再用 `Kibana`、`ApmServer`、`Beats`、`Logstash`、`Agent` 等 CR 管理周边组件。

nodeSet 是理解 ECK 的关键:每个 nodeSet 有独立的 `count`、`config`(含 `node.roles`)、`resources` 与 `volumeClaimTemplates`,对应一个 StatefulSet。生产中几乎都是按角色拆:

```shell
master   count: 3   node.roles: ["master"]                              专用主节点
hot      count: 3   node.roles: ["data_hot","data_content","ingest"]    热数据 + 写入
warm     count: 2   node.roles: ["data_warm"]                           温数据
ml       count: 1   node.roles: ["ml"]                                  机器学习
```

启动顺序与仲裁配置由 Operator 接管,**`discovery.seed_hosts`、`cluster.initial_master_nodes`、`_cluster/voting_config_exclusions` 都不该手工设置**,ECK 会按 Elasticsearch 官方最佳实践替你维护。

许可证分 **Basic(免费)与 Enterprise(付费)** 两档,基础功能 Basic 即可用,部分能力(如某些多命名空间特性)需要 Enterprise 订阅。

### 安装

```shell
# 官方 YAML:先 CRD,再 Operator
kubectl create -f https://download.elastic.co/downloads/eck/3.5.0/crds.yaml
kubectl apply -f https://download.elastic.co/downloads/eck/3.5.0/operator.yaml

# Helm
helm repo add elastic https://helm.elastic.co
helm repo update
helm install elastic-operator elastic/eck-operator \
  --namespace elastic-system --create-namespace

kubectl get crd | grep elastic
```

### CRD 家族

```shell
elasticsearch.k8s.elastic.co/v1     Elasticsearch(同时提供 v1beta1)
kibana.k8s.elastic.co/v1            Kibana
apmserver.k8s.elastic.co/v1         APM Server
enterprisesearch.k8s.elastic.co/v1  Enterprise Search
beat.k8s.elastic.co/v1beta1         Beats
agent.k8s.elastic.co/v1alpha1       Elastic Agent
logstash.k8s.elastic.co/v1alpha1    Logstash
stackconfigpolicy.k8s.elastic.co/v1alpha1   跨集群配置策略
```

### 集群清单

```shell
apiVersion: elasticsearch.k8s.elastic.co/v1
kind: Elasticsearch
metadata:
  name: quickstart
spec:
  version: 9.5.4
  volumeClaimDeletePolicy: DeleteOnScaledownOnly    # 缩容删 PVC,删集群时保留
  nodeSets:
    - name: master
      count: 3
      config:
        node.roles: ["master"]
        node.store.allow_mmap: false
      resources:
        requests:
          cpu: 500m
          memory: 2Gi
        limits:
          memory: 2Gi
      volumeClaimTemplates:
        - metadata:
            name: elasticsearch-data          # 这个名字必须固定,不能改
          spec:
            storageClassName: fast
            accessModes: ["ReadWriteOnce"]
            resources:
              requests:
                storage: 100Gi
    - name: data
      count: 3
      config:
        node.roles: ["data_hot", "data_content", "ingest"]
      volumeClaimTemplates:
        - metadata:
            name: elasticsearch-data
          spec:
            storageClassName: fast
            accessModes: ["ReadWriteOnce"]
            resources:
              requests:
                storage: 500Gi
```

```shell
kubectl apply -f elasticsearch.yaml -n elastic

kubectl get elasticsearch -n elastic
kubectl get elasticsearch quickstart -n elastic -o jsonpath='{.status.health}'
kubectl get pods -n elastic -l elasticsearch.k8s.elastic.co/cluster-name=quickstart

# 取内置用户密码
kubectl get secret quickstart-es-elastic-user -n elastic -o jsonpath='{.data.elastic}' | base64 -d
```

### 角色分离与脑裂

Elasticsearch 的投票决策需要**超过半数**的投票节点响应,这就是 master 必须按 3、5 这样的奇数部署的原因:

```shell
3 或 4 个 master-eligible 节点 → 只能容忍 1 个不可用
2 个及以下                     → 必须全部存活
任何时候都不能同时停掉半数及以上的投票节点
```

因此:

- **专用 master 节点**最稳妥,不要让 master 同时承担 data 角色 —— 数据节点上的大查询会把 master 拖垮,进而影响整个集群;
- **不要同时重启多个 master**,靠 `PodDisruptionBudget`(ECK 按 nodeSet 自动创建)与滚动升级,一次只动一个;
- 非 master 节点若磁盘上残留索引元数据,启动时会被拒绝,需要清空数据目录再加入。

### 扩缩容与 PVC

```shell
# 用 JSON patch 改 count;strategic merge 会整段替换 nodeSets 数组,容易误删其它 nodeSet
kubectl patch elasticsearch quickstart -n elastic --type json \
  -p '[{"op":"replace","path":"/spec/nodeSets/1/count","value":5}]'
```

扩缩容时 ECK 会先做数据迁移再调整 StatefulSet,被移除节点的 **PVC 会按策略删除**:

```shell
DeleteOnScaledownOnly                  缩容时删 PVC,删除整个集群时保留
DeleteOnScaledownAndClusterDeletion    缩容与删除集群时都删(默认)
```

**没有 `OnDelete` 这个取值**。默认行为意味着:**直接 `kubectl delete elasticsearch` 会把数据盘一起删掉**。想让数据留下来做恢复或迁移,必须显式改成 `DeleteOnScaledownOnly`,并确认 PV 的回收策略是 `Retain`。

```shell
# 扩容存储:只能调大,不能调小,也不能改 storageClassName
kubectl patch elasticsearch quickstart -n elastic --type json \
  -p '[{"op":"replace","path":"/spec/nodeSets/1/volumeClaimTemplates/0/spec/resources/requests/storage","value":"1Ti"}]'
```

要「换存储类」只有一条路:新建一个 nodeSet 指向新 StorageClass,等数据迁移完成后再删掉旧 nodeSet。

### 升级

```shell
# 1. Operator:CRD 要用 replace(create 会因已存在而失败)
kubectl replace -f https://download.elastic.co/downloads/eck/3.5.0/crds.yaml
kubectl apply -f https://download.elastic.co/downloads/eck/3.5.0/operator.yaml
# Helm 安装的用:helm upgrade elastic-operator elastic/eck-operator -n elastic-system

# 2. Elasticsearch:改 spec.version
kubectl patch elasticsearch quickstart -n elastic --type merge -p '{"spec":{"version":"9.5.4"}}'
kubectl get pods -n elastic -w
```

滚动节奏由 `updateStrategy` 控制:

```shell
spec:
  updateStrategy:
    changeBudget:
      maxSurge: -1            # 默认 -1 = 不做限制
      maxUnavailable: 1       # 默认 1
```

**Elasticsearch 不支持降级**,版本升上去只能从快照恢复。若升级被内部检查挡住(例如某分片状态异常),可以临时禁用:

```shell
kubectl annotate elasticsearch quickstart -n elastic \
  eck.k8s.elastic.co/disable-upgrade-predicates="true" --overwrite
```

官方对此的措辞是 **extremely risky**,只应作为排障手段,恢复后立刻移除。

### 备份与快照

**ECK 没有备份 CRD**。快照要靠 Elasticsearch 自己的快照仓库 + SLM 策略,分三步:

```shell
# 1. 把对象存储凭据放进 ES keystore(以 GCS 为例)
spec:
  secureSettings:
    - secretName: gcs-credentials

# 2. 用 ES API 注册快照仓库
kubectl exec -n elastic quickstart-es-default-0 -- curl -s -X PUT \
  -u elastic:$PASSWORD "localhost:9200/_snapshot/my-repo" \
  -H 'Content-Type: application/json' \
  -d '{"type":"gcs","settings":{"bucket":"my-es-snapshots","client":"default"}}'

# 3. 定时策略交给 SLM
curl -s -X PUT -u elastic:$PASSWORD "localhost:9200/_slm/policy/nightly" \
  -H 'Content-Type: application/json' -d '{
    "schedule": "0 30 1 * * ?",
    "name": "<nightly-{now/d}>",
    "repository": "my-repo",
    "config": {"indices": ["*"], "include_global_state": true},
    "retention": {"expire_after": "30d", "min_count": 5, "max_count": 50}
  }'
```

云上可以免密钥:AWS IRSA、GKE Workload Identity、Azure Workload Identity 直接给 Pod 绑定身份,连 `secureSettings` 都省掉。恢复时先建好空集群,再调用 `_snapshot/<repo>/<snapshot>/_restore`。

### 监控

两层监控,别混淆:

```shell
# 1) Elasticsearch 自身指标:走 Stack Monitoring(Metricbeat sidecar 推到监控集群)
spec:
  monitoring:
    metrics:
      elasticsearchRefs:
        - name: monitoring-cluster

# 2) Operator 自身指标:默认关闭,需在 ConfigMap 里打开并加 containerPort
kubectl edit configmap elastic-operator -n elastic-system
#   metrics-port: "8080"
#   metrics-host: "0.0.0.0"
```

自 3.0.0 起 Operator 的指标端点**默认带 TLS 与 RBAC 保护**,Prometheus Operator 环境写 PodMonitor:

```shell
apiVersion: monitoring.coreos.com/v1
kind: PodMonitor
metadata:
  name: elastic-operator
spec:
  selector:
    matchLabels:
      control-plane: elastic-operator
  podMetricsEndpoints:
    - port: metrics
      path: /metrics
```

### 注意

1. **`volumeClaimDeletePolicy` 没有 `OnDelete`**。合法值只有 `DeleteOnScaledownOnly` 与 `DeleteOnScaledownAndClusterDeletion`(默认),写错会被 API Server 拒绝。
2. **默认删集群会连数据一起删**。默认策略下 `kubectl delete elasticsearch` 会连带 PVC 一起清理;生产建议显式设为 `DeleteOnScaledownOnly`,并确认 PV 回收策略为 `Retain`。
3. **`volumeClaimTemplates` 的 `metadata.name` 必须是 `elasticsearch-data`**。改成别的名字会直接挂载失败,这是硬性约定。
4. **`vm.max_map_count` 要按版本设**。Elasticsearch **8.16 及以后是 1048576**,8.15 及以前是 262144。生产应把内核参数设对,而不是长期靠 `node.store.allow_mmap: false` —— 官方明确提示它有性能代价,只适合测试。
5. **不要手工设置 `discovery.seed_hosts` 等编排参数**。ECK 负责维护 `discovery.seed_hosts`、`cluster.initial_master_nodes`、`voting_config_exclusions`,自己再设一遍会与 Operator 打架,引发脑裂或集群起不来。
6. **master 必须奇数并保持专用**。投票需要过半节点响应,3 或 4 个 master 都只能容忍 1 个故障;任何时候都不能同时停掉半数及以上的 master,升级要一个一个来。
7. **单节点集群不要配 dedicated master**。只有一个节点时它同时是 master 与 data,配 `count: 1` 的 master nodeSet 没有意义,滚动升级期间也没有可用性保证。
8. **Elasticsearch 不能降级**。版本只能往上走,出问题只能从快照恢复,升级前务必确认快照可用。
9. **没有备份 CRD,官方也不推荐 Velero 这类方案**。官方路径就是快照仓库 + SLM,别把「ECK 会自动帮我备份」当默认前提。
10. **改 `secureSettings` 默认触发滚动重启**。凭据轮换会导致节点重启,提前确认影响范围与维护窗口。
11. **存储不能缩容,也不能换 StorageClass**。「换盘」只能新建 nodeSet 迁数据再删旧 nodeSet,过程会真实搬运数据,要预留时间并盯住磁盘水位。
12. **用 strategic merge 打 nodeSets 会整段替换数组**。Kubernetes 对 CRD 数组默认按整体替换处理,`--type merge` 只写一个 nodeSet 会把其它 nodeSet 一起抹掉,请改用 `--type json` 指定下标。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `statefulset` — Elasticsearch 节点的实际载体
- `pvc` — 持久卷声明,数据盘
- `storageclass` — 存储类,决定检索性能
- `poddisruptionbudget` — 保障滚动升级与节点维护时的高可用
- `helm` — Kubernetes包管理器
- `prometheus` — 抓取 Operator 与业务指标

### 参考链接

- [ECK 官方文档](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s)
- [YAML 清单安装](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/install-using-yaml-manifest-quickstart)
- [CRD / API 参考](https://www.elastic.co/docs/reference/cloud-on-k8s/api-reference)
- [卷与 PVC 删除策略](https://www.elastic.co/docs/deploy-manage/deploy/cloud-on-k8s/volume-claim-templates)
- [快照与恢复](https://www.elastic.co/docs/deploy-manage/tools/snapshot-and-restore/cloud-on-k8s)
- [升级 ECK 与集群](https://www.elastic.co/docs/deploy-manage/upgrade/orchestrator/upgrade-cloud-on-k8s)
