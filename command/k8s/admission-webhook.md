admission-webhook
===

动态准入控制,Mutating与Validating Webhook

## 补充说明

**Admission Webhook** 是 Kubernetes 的**动态准入控制**机制:API Server 在处理请求的过程中,把请求内容(AdmissionReview)通过 HTTPS POST 发给你自己的服务,由该服务决定「放行、拒绝、还是改写」。它把策略从 apiserver 里搬了出来,让镜像白名单、标签规范、资源配额、注入 sidecar 这类自定义规则可以独立部署和升级。

两类 Webhook,调用时机不同:

| 类型 | 配置对象 | 能力 |
| --- | --- | --- |
| Mutating | `MutatingWebhookConfiguration` | **先**调用,可以改写对象(返回 JSON Patch) |
| Validating | `ValidatingWebhookConfiguration` | **后**调用,只能放行或拒绝 |

调用链是:`认证 → 授权 → Mutating 准入 → 对象 Schema 校验 → Validating 准入 → 写入 etcd`。因此需要在**对象最终定型后**做判断的策略(比如「所有标签必须符合规范」),必须用 Validating Webhook —— Mutating 阶段之后对象还可能被其他 Webhook 改掉。

除了 Webhook,Kubernetes 还有两条替代路线:编写代码量小得多的 **CEL 声明式策略 `ValidatingAdmissionPolicy`**(v1.30 起 GA,直接在 apiserver 内执行,无网络调用),以及历史遗留的**编译进 apiserver 的准入插件**。

### 语法

```shell
kubectl get mutatingwebhookconfigurations
kubectl get validatingwebhookconfigurations
kubectl describe validatingwebhookconfiguration <名称>
kubectl delete validatingwebhookconfiguration <名称>
```

API 版本固定为 `admissionregistration.k8s.io/v1`(更早的 `v1beta1` 自 Kubernetes 1.22 起已移除)。

### ValidatingWebhookConfiguration 清单示例

```shell
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingWebhookConfiguration
metadata:
  name: pod-policy.example.com
webhooks:
- name: pod-policy.example.com          # 必须为全限定域名,且全局唯一
  rules:
  - apiGroups:   [""]
    apiVersions: ["v1"]
    operations:  ["CREATE", "UPDATE"]
    resources:   ["pods"]
    scope:       "Namespaced"           # Cluster / Namespaced / *
  clientConfig:
    service:
      namespace: "example-namespace"
      name: "example-service"
      path: "/validate"                 # 默认 /
      port: 443                         # 默认 443
    caBundle: <BASE64编码的PEM CA证书>   # 用于校验 webhook 服务端证书
  admissionReviewVersions: ["v1"]
  sideEffects: None                     # v1 中必填,且只能是 None / NoneOnDryRun
  failurePolicy: Fail                   # Ignore / Fail,默认 Fail
  matchPolicy: Equivalent               # Equivalent / Exact,默认 Equivalent
  timeoutSeconds: 5                     # 默认 10,取值 1-30
```

### MutatingWebhookConfiguration 清单示例

```shell
apiVersion: admissionregistration.k8s.io/v1
kind: MutatingWebhookConfiguration
metadata:
  name: sidecar-injector.example.com
  annotations:
    cert-manager.io/inject-ca-from: example-namespace/example-cert   # 由 CA 注入器维护 caBundle
webhooks:
- name: sidecar-injector.example.com
  rules:
  - apiGroups:   [""]
    apiVersions: ["v1"]
    operations:  ["CREATE"]
    resources:   ["pods"]
  clientConfig:
    service:
      namespace: "example-namespace"
      name: "sidecar-injector"
      path: "/mutate"
  admissionReviewVersions: ["v1"]
  sideEffects: None
  failurePolicy: Fail
  reinvocationPolicy: Never             # Never 默认 / IfNeeded
  namespaceSelector:                    # 只对带此标签的命名空间生效
    matchLabels:
      sidecar-injection: enabled
```

### 关键字段

```shell
failurePolicy      Fail   webhook 调用失败(超时、5xx、TLS 错误)时**拒绝**请求(默认)
                   Ignore webhook 调用失败时**放行**请求
matchPolicy        Equivalent  规则命中某版本时,同资源的其他版本也一并命中(默认)
                   Exact       仅精确匹配 apiVersions 列出的版本
sideEffects        None          调用无副作用,可参与 dry-run(默认要求项)
                   NoneOnDryRun  仅在非 dry-run 时有副作用
timeoutSeconds     1-30,默认 10;超时按 failurePolicy 处理
reinvocationPolicy Never(默认)/ IfNeeded,后者在后继 Mutating Webhook 改写对象后重跑
namespaceSelector  命名空间标签选择器;对**集群级资源不生效**
objectSelector     对象标签选择器;对 DELETE 操作不生效
matchConditions    CEL 表达式,进一步收窄触发条件
```

### 服务端实现要点

Webhook 服务收到的是一份 `AdmissionReview`(JSON),必须原样回传同一个 `uid`,并用**收到的同一个版本**回复:

```shell
# 请求关键字段
request.uid          本次请求的唯一标识,响应必须原样回带
request.operation    CREATE / UPDATE / DELETE / CONNECT
request.object       新对象(原始 JSON)
request.oldObject    旧对象,仅 UPDATE / DELETE 有
request.dryRun       是否为 dry-run 请求
request.userInfo     发起者身份
request.namespace    命名空间(集群级资源为空)

# 响应关键字段
response.uid         必须与请求一致
response.allowed     true 放行 / false 拒绝
response.status      拒绝时的说明信息
response.patch       Mutating 专用的 JSON Patch(Base64)
response.patchType   固定为 "JSONPatch"
response.warnings    返回给用户端的警告文本
```

Mutating Webhook 若返回 patch,内容形如:

```shell
[
  { "op": "add", "path": "/metadata/labels/injected", "value": "true" }
]
```

### 常用排查

```shell
# 集群里注册了哪些 Webhook(按注册顺序观察)
kubectl get mutatingwebhookconfigurations,validatingwebhookconfigurations
kubectl get validatingwebhookconfigurations -o custom-columns=\
NAME:.metadata.name,FAIL:.webhooks[*].failurePolicy,RULES:.webhooks[*].rules[*].resources

# 单条 Webhook 的详细配置(失败策略、超时、CA、选择器)
kubectl describe validatingwebhookconfiguration pod-policy.example.com

# 定位「谁在拒绝我」:对比临时把 failurePolicy 改成 Ignore 前后的行为
kubectl get validatingwebhookconfiguration pod-policy.example.com -o yaml > wh.yaml
# 编辑 wh.yaml 中对应 webhook 的 failurePolicy,然后
kubectl apply -f wh.yaml

# apiserver 侧日志(webhook 调用失败会记在这里)
kubectl logs -n kube-system -l component=kube-apiserver --tail=200 | grep -i webhook

# 从 apiserver 所在节点直接验证连通性与证书
kubectl run tmp --rm -it --image=curlimages/curl --restart=Never -- \
  curl -kv https://example-service.example-namespace.svc/validate

# 查是否有准入相关事件
kubectl get events -A --sort-by=.lastTimestamp | grep -i -E 'admission|webhook'
```

### 临时关闭一个失控的 Webhook

Webhook 配错导致连 Pod 都建不出来时,`kubectl delete` 是最快的恢复手段:

```shell
kubectl delete validatingwebhookconfiguration pod-policy.example.com
kubectl delete mutatingwebhookconfiguration sidecar-injector.example.com

# 命名空间被删不掉时,先看是不是有 Webhook 在拦 namespace 的 DELETE
kubectl get validatingwebhookconfigurations \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.webhooks[*].rules[*].resources}{"\n"}{end}'
```

### 注意

1. **`failurePolicy` 默认是 `Fail`,配错会锁死整个集群**。规则里写了 `resources: ["*"]`、`operations: ["*"]` 又没有 `namespaceSelector` 限制时,只要 webhook 服务不可用,集群里**任何**写操作都会失败 —— 包括创建 Webhook 自己的 Pod。这是最典型的事故场景。
2. **`failurePolicy: Ignore` 不是更安全的默认值**。它的代价是策略**静默失效**:webhook 挂了照样放行,你以为在拦截,实际什么也没拦。安全策略应当用 `Fail`,但必须把范围收窄。
3. **`namespaceSelector` 对集群级资源完全不生效**。Node、PersistentVolume、ClusterRole 这类对象没有命名空间,选择器无从匹配,一旦把 `namespaceSelector` 当成「只保护我的命名空间」的手段,集群级资源的写操作仍会全量命中规则。
4. **选择器写 `{}` 与不写选择器含义不同**。不写表示「全部匹配」;写 `namespaceSelector: {}` 同样匹配所有命名空间 —— 想排除 `kube-system` 必须用 `matchExpressions` 显式排除,而不是留空。
5. **Webhook 服务自己也要能被创建出来**。这构成自举死锁:Webhook 容器所在的 Deployment 需要建 Pod,而建 Pod 又要先通过 Webhook。解法是给它的命名空间打上豁免标签,并在 `namespaceSelector` 中排除。
6. **`timeoutSeconds` 默认 10 秒,最大 30 秒**。超时会按 `failurePolicy` 处理,且 apiserver 会一直占用连接。生产 Webhook 应给出远小于默认值的超时(如 2-3 秒),防止一次网络抖动放大成全集群变慢。
7. **`caBundle` 是 Base64 编码的 PEM,且不轮换就会过期**。证书过期后 apiserver 侧报 `x509: certificate signed by unknown authority`,所有命中规则的操作立刻失败。应交给 cert-manager 的 CA 注入器(`cert-manager.io/inject-ca-from` 注解)自动维护,或把轮换做成可重复的运维流程。
8. **服务端证书的 SAN 必须包含 `<service>.<namespace>.svc`**。用 `clientConfig.service` 时 apiserver 只认这个名称,证书里写 Pod IP 或别的域名都会验证失败。
9. **多个 Mutating Webhook 的执行顺序不确定**。apiserver 可能并行调用,同一字段被两个 Webhook 改写时结果不可预期;需要「看到最终对象」的策略必须用 Validating Webhook 实现。
10. **`reinvocationPolicy: IfNeeded` 可能引发重复注入**。它会在对象被后续 Webhook 改写后重跑本 Webhook,sidecar 注入类逻辑若不做幂等判断,会出现注入两份容器的情况。
11. **`sideEffects` 在 v1 中是必填字段**,且只接受 `None` 与 `NoneOnDryRun`。声明 `NoneOnDryRun` 的 Webhook 在 `--dry-run` 请求中会被跳过,这是让 dry-run 保持无副作用的标准做法。
12. **Webhook 无法返回 `uid` 或返回了别的版本,请求会被判为失败**。`admissionReviewVersions` 里必须包含 `v1`,响应也要按收到的版本回写;老代码里回 `v1beta1` 的写法在新版本上会直接报错。
13. **规则里写 `resources: ["pods/status"]` 这类子资源必须显式列出**,`pods` 不会自动匹配其子资源,这与 RBAC 的行为一致。
14. **删除 Webhook 配置后有几秒生效延迟**。新建配置同理,`kubectl create` 后立刻发请求可能还没被拦住,验证时留出缓冲。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kube-apiserver` — 准入控制链与 apiserver 参数
- `pod-security-admission` — 内置的 Pod 安全准入控制
- `securitycontext` — 被准入策略最常检查的字段
- `keda` — 自带准入 Webhook 的组件实例

### 参考链接

- [动态准入控制官方文档](https://kubernetes.io/docs/reference/access-authn-authz/extensible-admission-controllers/)
- [准入控制器参考](https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/)
- [ValidatingAdmissionPolicy(CEL 声明式策略)](https://kubernetes.io/docs/reference/access-authn-authz/validating-admission-policy/)
- [admissionregistration.k8s.io/v1 API 参考](https://kubernetes.io/docs/reference/generated/kubernetes-api/v1.37/#validatingwebhookconfiguration-v1-admissionregistration-k8s-io)
- [编写 Webhook 服务端的最佳实践](https://kubernetes.io/docs/concepts/cluster-administration/admission-webhooks-good-practices/)
