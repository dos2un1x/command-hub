kyverno
===

Kubernetes原生策略引擎,以资源形式校验、变更与生成集群对象

## 补充说明

**Kyverno** 是 CNCF 毕业项目(2026 年 3 月毕业),一个 Kubernetes 原生的策略引擎。与 Gatekeeper 最大的区别在于:**策略本身就是 Kubernetes 资源,用 YAML 而不是 Rego 编写**。不需要再学一门语言,策略也能被 `kubectl get`、被 GitOps 管理、被 RBAC 约束。

Kyverno 以准入 webhook 加后台控制器的方式工作,能力分四类:

```shell
validate        校验对象是否符合规则,不符合则拒绝或告警
mutate          在对象落库前修改它,如自动补标签、注入 sidecar
generate        依据一个对象生成或同步其他对象,如新命名空间自动建 NetworkPolicy
verifyImages    校验镜像签名与证明(cosign / Notary)
```

策略有两种作用域:

```shell
ClusterPolicy     集群级,可作用于任意命名空间
Policy            命名空间级,只在本命名空间生效
```

**必须了解的重大变更**:Kyverno 1.19(2026 年 8 月)已正式弃用 `ClusterPolicy`、`Policy`、`CleanupPolicy` 等 `kyverno.io` 旧策略类型,并计划在 **1.20(预计 2026 年 11 月)彻底移除**。替代方案是 `policies.kyverno.io` API 组下的 CEL 策略:`ValidatingPolicy`、`MutatingPolicy`、`GeneratingPolicy`、`ImageValidatingPolicy`、`DeletingPolicy`。1.19 是最后一个完整支持旧类型的版本,新部署应当直接写 CEL 策略。

### 安装

```shell
helm repo add kyverno https://kyverno.github.io/kyverno/
helm repo update

# 基础安装
helm install kyverno kyverno/kyverno -n kyverno --create-namespace

# 同时装上 Pod Security Standards 策略集
helm install kyverno-policies kyverno/kyverno-policies -n kyverno

# 高可用:各控制器多副本
helm install kyverno kyverno/kyverno -n kyverno --create-namespace \
  --set admissionController.replicas=3 \
  --set backgroundController.replicas=2 \
  --set cleanupController.replicas=2 \
  --set reportsController.replicas=2
```

安装后确认:

```shell
kubectl get pods -n kyverno
kubectl get validatingwebhookconfiguration,mutatingwebhookconfiguration | grep kyverno
kubectl api-resources | grep kyverno
```

离线校验用的 CLI:

```shell
# 从 GitHub Releases 下载(以 v1.19.1 为例)
curl -LO https://github.com/kyverno/kyverno/releases/download/v1.19.1/kyverno-cli_v1.19.1_linux_x86_64.tar.gz
tar -xzf kyverno-cli_v1.19.1_linux_x86_64.tar.gz
sudo install -m 755 kyverno /usr/local/bin/kyverno
kyverno version
```

### Validate 策略

```shell
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: require-labels
spec:
  validationFailureAction: Audit    # Audit 只记录,Enforce 直接拒绝
  background: true
  rules:
    - name: check-team-label
      match:
        any:
          - resources:
              kinds:
                - Pod
      exclude:
        any:
          - resources:
              namespaces:
                - kube-system
      validate:
        message: "所有 Pod 必须带 team 标签"
        pattern:
          metadata:
            labels:
              team: "?*"            # ?* 表示必须存在且非空
```

`pattern` 的通配符语义:

```shell
*       匹配任意值,包括该字段不存在
?*      要求字段必须存在,且值非空
X       用 (key) 引用同级其他字段的值,要求二者相等
```

### Mutate 策略

```shell
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: add-default-labels
spec:
  rules:
    - name: add-labels
      match:
        any:
          - resources:
              kinds:
                - Pod
      mutate:
        patchStrategicMerge:
          metadata:
            labels:
              managed-by: kyverno
```

`mutate` 还支持 `patchesJson6902`(精确的 JSON Patch)与 `mutateExisting`(修改已存在的对象,通常与 `generate` 配合)。

### Generate 策略

```shell
apiVersion: kyverno.io/v1
kind: ClusterPolicy
metadata:
  name: add-networkpolicy
spec:
  rules:
    - name: default-deny
      match:
        any:
          - resources:
              kinds:
                - Namespace
      generate:
        synchronize: true              # 源对象变化时同步更新生成物
        apiVersion: networking.k8s.io/v1
        kind: NetworkPolicy
        name: default-deny
        namespace: "{{request.object.metadata.name}}"
        data:
          spec:
            podSelector: {}
            policyTypes:
              - Ingress
```

### CEL 策略(1.19 之后的方向)

`policies.kyverno.io` 组下的新策略类型用 CEL 表达式代替 `pattern`,与 Kubernetes 原生的 ValidatingAdmissionPolicy 保持同一套语言:

```shell
apiVersion: policies.kyverno.io/v1beta1     # 1.20 起为 v1
kind: ValidatingPolicy
metadata:
  name: require-team-label
spec:
  validationActions: [Audit]                # Deny / Warn / Audit
  matchConstraints:
    resourceRules:
      - apiGroups: [""]
        apiVersions: ["v1"]
        operations: ["CREATE", "UPDATE"]
        resources: ["pods"]
  validations:
    - expression: "has(object.metadata.labels) && 'team' in object.metadata.labels"
      message: "所有 Pod 必须带 team 标签"
```

旧字段到新字段的对应关系:

```shell
spec.rules.match                 → spec.matchConstraints / spec.matchConditions
spec.rules.preconditions         → spec.matchConditions
spec.rules.context               → spec.variables
validationFailureAction: Enforce → validationActions: [Deny]
validate.pattern / validate.deny → validations[].expression(deny 语义要取反)
spec.background                  → spec.evaluation.background.enabled
```

### 查看与排障

```shell
# 策略与命中情况
kubectl get clusterpolicy
kubectl get validatingpolicy
kubectl get policyreport -A
kubectl get clusterpolicyreport

# 策略详情(含 Ready 状态与逐条规则)
kubectl describe clusterpolicy require-labels

# 控制器日志
kubectl logs -n kyverno -l app.kubernetes.io/component=admission-controller -f
kubectl logs -n kyverno -l app.kubernetes.io/component=background-controller -f
```

### Kyverno CLI

```shell
# 本地套用策略:不连集群,直接把策略作用到资源清单上
kyverno apply ./policies/ --resource ./deployments/

# 运行策略单元测试
kyverno test ./tests/

# 把存量对象重写为当前存储版本(升级后执行)
kyverno migrate storage

# 把弃用告警当成错误,适合放进 CI 卡住不合规的策略
kyverno apply ./policies/ --resource ./deployments/ --warnings-as-errors
```

### 注意

1. **`validationFailureAction` 与 `failurePolicy` 是两件事**。前者决定「策略判定不通过时怎么办」(`Audit` 只记录、`Enforce` 拒绝);后者在 `spec.webhookConfiguration.failurePolicy` 上,决定「Kyverno 自己没响应时 apiserver 怎么办」(`Ignore` 放行、`Fail` 拒绝)。把 `failurePolicy` 设成 `Fail` 而 Kyverno 又不健康,**整个集群的写入都会被拒绝**,这是最严重的一类配置事故。
2. **默认是 `Audit`,策略上线不会立刻拦截任何东西**。正确流程是:先 `Audit` 观察 `PolicyReport` → 确认没有误报 → 再切 `Enforce`。直接上 `Enforce` 等于拿生产做实验。
3. **`ClusterPolicy` 已在 1.19 弃用,1.20 计划移除**。1.19 起 admission webhook 与 CLI 都会对旧类型打印弃用告警,`kyverno_deprecated_api_requests_total` 指标可以统计还有多少在用;新策略请直接写 CEL 类型。
4. **迁移不是改几个字段那么简单**。旧的一条 `ClusterPolicy` 可以同时包含 validate 与 mutate 规则,新模型按类型**拆成多个对象**;`validate.deny` 的逻辑要取反(CEL 表达式返回 `true` 表示通过);`mutate.patchStrategicMerge` 要改成 `ApplyConfiguration` 或 `JSONPatch`;`validationFailureActionOverrides` 与 `allowExistingViolations` 不支持,只能用策略例外替代。
5. **`background: true` 才能审计存量资源**。设为 `false` 时策略只在准入时生效,`PolicyReport` 里永远不会出现历史违规,很容易被误读成「集群很干净」。
6. **`generate` 默认不覆盖已存在的目标对象**,`synchronize: true` 才会在源对象变化时同步 —— 但这也意味着 Kyverno 会**把手工改过的生成物改回去**,两类行为要在上线前想清楚。
7. **`pattern` 的通配符写错会让策略形同虚设**。校验「标签必须存在」时写成 `*` 而不是 `?*`,则缺少该标签的对象同样通过 —— 不报错,也不拦截。
8. **策略作用范围过宽会拦住系统组件**。对 `kube-system` 做 mutate 或 enforce,可能导致 CoreDNS、CNI 等组件无法正常更新。所有集群级策略都应当显式 `exclude` 掉 `kube-system` 与 `kyverno` 命名空间。
9. **策略例外(PolicyException)本身是一条权限边界**。能创建例外的人可以绕过任意策略,必须用 RBAC 严格限制;旧类型的例外在 `kyverno.io` 组,新模型在 `policies.kyverno.io` 组,迁移时不要漏掉。
10. **`kyverno apply` 的本地结果与集群内不完全一致**。CLI 缺少准入上下文(如 `request.userInfo`、集群中已存在的对象),涉及用户身份、`generate`、`verifyImages` 的策略只能到集群里验证。
11. **多副本部署是可用性前提**。Kyverno 的 webhook 一旦全部不可用,`failurePolicy: Fail` 的策略会阻断写入;`failurePolicy: Ignore` 则会让策略静默失效。无论哪种,`admissionController.replicas` 都应当大于 1 并配置反亲和。

### 相关命令

- `gatekeeper` — 基于OPA的准入控制器,用Rego写策略
- `opa` — 策略引擎的通用底座
- `kubectl` — Kubernetes集群管理工具
- `rbac` — 限制谁能创建策略与例外
- `networkpolicy` — generate 规则的典型生成目标
- `pod` — 最常见的策略作用对象

### 参考链接

- [Kyverno 官方文档](https://kyverno.io/docs/)
- [安装方法(Helm / 清单)](https://kyverno.io/docs/installation/methods/)
- [策略类型总览](https://kyverno.io/docs/policy-types/overview/)
- [迁移到 CEL 策略](https://kyverno.io/docs/guides/migration-to-cel/)
- [升级 Kyverno](https://kyverno.io/docs/installation/upgrading/)
