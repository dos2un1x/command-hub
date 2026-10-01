gatekeeper
===

基于OPA的Kubernetes准入控制器,用ConstraintTemplate与Constraint两层CRD落地策略

## 补充说明

**Gatekeeper** 是 OPA 官方的 Kubernetes 准入控制器实现,隶属于 CNCF 毕业项目 OPA。它把 Rego 策略接进 Kubernetes 的准入链路,帮你处理了自建 webhook 最麻烦的几件事:证书轮换、webhook 注册、集群对象缓存,以及对存量资源的定期审计。

它由三个组件构成:

```shell
gatekeeper-controller-manager   准入 webhook,拦截请求并给出决策
gatekeeper-audit                定期全量扫描已有资源,把违规写回 status
ConstraintTemplate / Constraint 两层 CRD,分别承载策略的定义与实例
```

**两层模型**是这个项目最容易混淆的地方,必须先理清:

| 资源 | 作用 | 类比 |
| --- | --- | --- |
| ConstraintTemplate | 定义 Rego 逻辑与参数 schema,本身不拦截任何对象 | 类 |
| Constraint | 引用模板、填入参数并声明 match,这才是生效的规则 | 实例 |

模板里写「怎么判断」,Constraint 里写「对谁生效、参数是什么」。**只建模板不建 Constraint,集群里不会有任何拦截行为**,而且不会有任何报错。

### 安装

```shell
# Helm 方式
helm repo add gatekeeper https://open-policy-agent.github.io/gatekeeper/charts
helm repo update
helm install gatekeeper/gatekeeper --name-template=gatekeeper \
  --namespace gatekeeper-system --create-namespace

# 清单方式(URL 里的版本号即 Release tag)
kubectl apply -f https://raw.githubusercontent.com/open-policy-agent/gatekeeper/v3.23.1/deploy/gatekeeper.yaml

# 卸载:CRD 不会随 Helm release 一起删除
helm delete gatekeeper --namespace gatekeeper-system
kubectl delete crd -l gatekeeper.sh/system=yes
```

安装后可以确认 webhook 是否就位:

```shell
kubectl get pods -n gatekeeper-system
kubectl get validatingwebhookconfiguration | grep gatekeeper
kubectl get crd | grep -E 'gatekeeper.sh|constraints.gatekeeper'
```

### ConstraintTemplate 示例

```shell
apiVersion: templates.gatekeeper.sh/v1
kind: ConstraintTemplate
metadata:
  name: k8srequiredlabels
spec:
  crd:
    spec:
      names:
        kind: K8sRequiredLabels
      validation:
        openAPIV3Schema:
          type: object
          properties:
            labels:
              type: array
              items:
                type: string
  targets:
    - target: admission.k8s.gatekeeper.sh
      rego: |
        package k8srequiredlabels

        violation[{"msg": msg, "details": {"missing_labels": missing}}] {
          provided := {label | input.review.object.metadata.labels[label]}
          required := {label | label := input.parameters.labels[_]}
          missing := required - provided
          count(missing) > 0
          msg := sprintf("缺少必需标签: %v", [missing])
        }
```

几个关键点:

```shell
spec.crd.spec.names.kind   决定生成的 Constraint 的 kind,必须首字母大写
spec.targets[].rego        策略主体,violation 是约定好的规则名
input.review.object        被拦截的对象
input.parameters           Constraint 里填的参数
```

模板创建后,Gatekeeper 会自动为它生成一个对应的 CRD。

### Rego v1 写法(3.19 起支持)

Gatekeeper 默认只允许 Rego v0 语法,v1 需要按新的 `code` 结构显式开启:

```shell
  targets:
    - target: admission.k8s.gatekeeper.sh
      code:
        - engine: Rego
          source:
            version: "v1"
            rego: |
              package k8srequiredlabels

              violation contains {"msg": msg, "details": {"missing_labels": missing}} if {
                provided := {label | input.review.object.metadata.labels[label]}
                required := {label | label := input.parameters.labels[_]}
                missing := required - provided
                count(missing) > 0
                msg := sprintf("缺少必需标签: %v", [missing])
              }
```

用这种方式开启 v1 后,**不需要**再写 `import rego.v1`。

### Constraint 示例

```shell
apiVersion: constraints.gatekeeper.sh/v1beta1
kind: K8sRequiredLabels
metadata:
  name: ns-must-have-team
spec:
  enforcementAction: dryrun          # deny / warn / dryrun
  match:
    kinds:
      - apiGroups: [""]
        kinds: ["Namespace"]
    excludedNamespaces: ["kube-system", "gatekeeper-system"]
  parameters:
    labels: ["team"]
```

`enforcementAction` 有三档:

```shell
deny     直接拒绝请求
warn     放行,但在 kubectl 输出里附带 warning
dryrun   放行且不提示,只把违规记进 status(默认值)
```

### 常用操作

```shell
# 查看模板与约束
kubectl get constrainttemplates
kubectl get constraints                       # 所有约束的聚合视图
kubectl get k8srequiredlabels                 # 按生成的 kind 查看
kubectl describe k8srequiredlabels ns-must-have-team

# 查看审计出的违规
kubectl get k8srequiredlabels ns-must-have-team -o jsonpath='{.status.violations}' | jq
kubectl get constraints -o json | \
  jq '.items[] | {name: .metadata.name, violations: (.status.violations | length)}'

# 用服务端 dry-run 试一条资源(会走 webhook)
kubectl apply -f test-namespace.yaml --dry-run=server

# 控制器与审计器日志
kubectl logs -n gatekeeper-system -l control-plane=controller-manager -f
kubectl logs -n gatekeeper-system -l control-plane=audit-controller
```

### 把集群对象同步给策略(Config)

约束若要引用**已存在的其他对象**(例如「同一命名空间内的 Ingress 主机名不能与 Service 冲突」),必须先把这些资源同步进 OPA 的 `data.inventory`:

```shell
apiVersion: config.gatekeeper.sh/v1alpha1
kind: Config
metadata:
  name: config
  namespace: gatekeeper-system
spec:
  sync:
    syncOnly:
      - group: ""
        version: "v1"
        kind: "Namespace"
      - group: "networking.k8s.io"
        version: "v1"
        kind: "Ingress"
```

同步进来的对象按 `data.inventory.namespace["<命名空间>"]["<group>/<version>"]["<Kind>"]["<名称>"]` 引用,集群级资源则在 `data.inventory.cluster` 下。需要让某些命名空间完全不受管辖时,在 Config 的 `spec.match` 里配置 `excludedNamespaces`,或给 webhook 加 `namespaceSelector`。

### gator 测试工具

```shell
# 安装(需要 Go 环境,也可从 GitHub Releases 直接下载二进制)
go install github.com/open-policy-agent/gatekeeper/v3/cmd/gator@latest

# 用测试套件验证策略,不需要集群
gator verify ./policy-suite/

# 查看所有子命令
gator --help
```

测试套件用 `suite.yaml` 描述:每个 case 给一个 `object` 和一组 `assertions`(期望有/无 violations),`gator verify` 会实际执行模板里的 Rego 并比对结果。这是策略上线前唯一能离线验证的手段。

### 注意

1. **ConstraintTemplate 与 Constraint 是两层,缺一不可**。模板只是「类的定义」,不写 Constraint 不会拦截任何对象;而 Constraint 的 `kind` 必须是模板 `spec.crd.spec.names.kind` 里声明的名字(首字母大写),**不是模板自身的名字** —— 写错会直接报 no matches for kind。
2. **Rego v1 默认不开启**。只有 Gatekeeper 3.19 及以上才支持,且必须走 `targets[].code[].source.version: "v1"` 这个结构;在旧版模板的 `rego:` 字段里直接写 `if`/`contains`,会得到 `rego_parse_error`,或 `missing required rules: [violation]`。
3. **`spec.targets[].rego` 的优先级高于 `code`**。两个字段同时存在时,旧字段会把新字段覆盖掉,于是精心配置的 v1 结构静默失效。同一个模板里只用一种写法。
4. **`violation` 是固定规则名**,模板必须产出 `violation` 集合(没有违规时集合为空即可)。改名成 `deny` 之类会让模板不可用,报 `missing required rules`。
5. **策略里引用集群现有对象前必须先在 Config 里同步**。没有配置 `syncOnly` 时 `data.inventory` 是空的,依赖它的规则会「永远通过」—— 这是最难发现的一类失效。
6. **`enforcementAction` 默认是 `dryrun`**。改完 Constraint 发现没拦住请求,先检查这个字段;`dryrun` 与 `warn` 都不会阻止请求,只能靠 `status.violations` 观察效果。
7. **`deny` 会直接阻断集群运维操作**。涉及 Namespace、`kube-system`、`gatekeeper-system` 的约束务必先用 `dryrun` 跑一轮完整审计,确认违规列表符合预期后再切 `deny`;否则可能出现「策略上线后无法创建任何命名空间」的窘境。
8. **Gatekeeper 不可用会波及整个集群的写操作**。webhook 的 `failurePolicy` 默认是 `Ignore`(放行),但显式改成 `Fail` 之后,Gatekeeper 挂掉或模板渲染超时都会导致大面积请求被拒。生产环境要给 `gatekeeper-system` 配足副本与资源,并监控 webhook 延迟。
9. **`match.kinds` 里写错 apiGroups 不会报错,只会匹配不到任何对象**。core 组要写 `apiGroups: [""]`,Deployment 要写 `["apps"]`,Ingress 要写 `["networking.k8s.io"]`。约束看起来「生效了」但从不触发时,先核对这里。
10. **卸载要清干净 CRD**。Helm 不会删除 CRD,残留的 CRD 与 webhook 配置会让重装时出现 `already exists` 或 webhook 指向空的 Service。卸载后执行 `kubectl delete crd -l gatekeeper.sh/system=yes`。
11. **不要同时上两套准入策略引擎**。Gatekeeper 与 Kyverno 可以共存,但一旦出现「这个对象为什么被拒绝」,同时排查两套策略的 Rego 与 YAML 成本极高。一个集群建议只保留一套。

### 相关命令

- `opa` — 通用策略引擎,ConstraintTemplate 的语言基础
- `kyverno` — 另一款主流策略引擎,用 YAML 而非 Rego
- `kubectl` — Kubernetes集群管理工具
- `rbac` — Kubernetes基于角色的访问控制
- `kube-apiserver` — 准入 webhook 的调用方

### 参考链接

- [Gatekeeper 官方文档](https://open-policy-agent.github.io/gatekeeper/website/docs/)
- [安装 Gatekeeper](https://open-policy-agent.github.io/gatekeeper/website/docs/install/)
- [ConstraintTemplate 参考](https://open-policy-agent.github.io/gatekeeper/website/docs/constrainttemplates/)
- [gator 测试工具](https://open-policy-agent.github.io/gatekeeper/website/docs/gator/)
- [排除命名空间](https://open-policy-agent.github.io/gatekeeper/website/docs/exempt-namespaces/)
