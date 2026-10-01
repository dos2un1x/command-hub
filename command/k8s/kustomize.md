kustomize
===

Kubernetes无模板化的声明式配置定制工具

## 补充说明

**kustomize命令** 是 Kubernetes 原生的配置定制工具,通过覆盖(overlay)的方式在**不修改原始 YAML** 的前提下,为不同环境生成定制后的资源清单。

与 Helm 的区别很关键:

- Helm 是**模板 + 值**的渲染方式,Chart 里到处是 `{{ }}`,渲染结果依赖 values 的完整程度。
- kustomize 是**基准 + 补丁**的合并方式,原始 YAML 本身就是合法可用的清单,`kubectl apply -f` 直接可用,不需要模板语法。

kustomize 自 1.14 起内置于 kubectl,可以直接用 `kubectl apply -k` 而无需额外安装独立二进制。

### 安装

```shell
# kubectl 内置(推荐,无需额外安装)
kubectl version --client       # 输出中的 Kustomize Version 即内置版本
kubectl kustomize --help

# macOS / Linux (Homebrew)
brew install kustomize

# 官方脚本
curl -s "https://raw.githubusercontent.com/kubernetes-sigs/kustomize/master/hack/install_kustomize.sh" | bash
sudo mv kustomize /usr/local/bin/

# Go 安装
go install sigs.k8s.io/kustomize/kustomize/v5@latest

# 通过 Krew 安装
kubectl krew install kustomize
```

### 语法

```shell
kustomize build <目录> [选项]
kustomize create [选项]
kustomize edit <子命令>
```

```shell
kustomize build .                       # 渲染当前目录
kustomize build overlays/prod           # 渲染指定 overlay
kustomize build overlays/prod -o out.yaml

kustomize create --autodetect           # 扫描目录下的 YAML 生成 kustomization.yaml
kustomize create --resources=deploy.yaml,svc.yaml

kustomize edit add resource deploy.yaml
kustomize edit add patch --path patch.yaml --group apps --version v1 --kind Deployment --name my-app
kustomize edit set image nginx=nginx:1.27
kustomize edit set namespace prod
kustomize edit set nameprefix prod-
kustomize edit set replicas my-app=3
kustomize edit add configmap app-config --from-file=app.properties
kustomize edit add label env:prod
kustomize edit fix                     # 把旧版字段自动升级为 v5 字段名
```

### 目录结构

典型的多环境布局:

```shell
myapp/
├── base/
│   ├── kustomization.yaml
│   ├── deployment.yaml
│   └── service.yaml
└── overlays/
    ├── dev/
    │   ├── kustomization.yaml
    │   └── replicas-patch.yaml
    └── prod/
        ├── kustomization.yaml
        ├── replicas-patch.yaml
        └── resources-patch.yaml
```

### base/kustomization.yaml

```shell
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- deployment.yaml
- service.yaml
```

### overlays/prod/kustomization.yaml

```shell
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
# 引用 base(相对路径),v5 中 bases 字段已废弃
resources:
- ../../base

# 命名空间与名称前后缀会同步更新所有引用处
namespace: prod
namePrefix: prod-
nameSuffix: -v2

# 统一追加标签与注解
labels:
- pairs:
    env: prod
    team: platform
  includeSelectors: true      # 同时写入 selector,注意会导致 Deployment 滚动重建
commonAnnotations:
  owner: ops@example.com

# 替换镜像地址(按 name 匹配,不写 newTag 则保留原 tag)
images:
- name: nginx
  newName: registry.example.com/nginx
  newTag: "1.27"

# 副本数覆盖
replicas:
- name: my-app
  count: 5
```

### patches:补丁的两种写法

**v5 推荐的统一写法**是 `patches`,它同时支持 strategic merge 与 JSON patch:

```shell
patches:
# 1. 外部文件 + target 选择器(strategic merge patch)
- path: replicas-patch.yaml
  target:
    kind: Deployment
    name: my-app

# 2. 内联 JSON patch(6902)
- patch: |-
    - op: replace
      path: /spec/template/spec/containers/0/resources/limits/cpu
      value: "2"
  target:
    kind: Deployment
    name: my-app

# 3. 内联 strategic merge patch
- patch: |-
    apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: my-app
    spec:
      template:
        spec:
          containers:
          - name: app
            env:
            - name: LOG_LEVEL
              value: warn
```

`replicas-patch.yaml`(strategic merge,按 name 字段合并,列表元素按 name 对齐):

```shell
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  replicas: 5
  template:
    spec:
      containers:
      - name: app
        resources:
          requests:
            cpu: 500m
            memory: 512Mi
```

**v4 及以前的写法**(v5 仍能识别但已标记废弃):

```shell
patchesStrategicMerge:
- replicas-patch.yaml

patchesJson6902:
- target:
    group: apps
    version: v1
    kind: Deployment
    name: my-app
  path: patch.json
```

### 生成器

configMapGenerator 会自动计算内容哈希并追加到名称上,内容一变名称就变,从而触发 Deployment 滚动更新:

```shell
configMapGenerator:
- name: app-config
  literals:
  - LOG_LEVEL=info
  files:
  - app.properties
  envs:
  - app.env

secretGenerator:
- name: app-secret
  literals:
  - password=s3cr3t
  envs:
  - secret.env

# 关闭哈希后缀(不推荐,会失去自动滚动更新能力)
generatorOptions:
  disableNameSuffixHash: true
  labels:
    generated-by: kustomize
```

### components:可选的横切能力

`components` 与 overlay 类似,但**不是**完整配置,而是一组可插拔的补丁片段,适合注入 sidecar、开关监控等:

```shell
# overlays/prod/kustomization.yaml
components:
- ../../components/logging

# components/logging/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1alpha1
kind: Component
patches:
- path: sidecar.yaml
```

### 与 kubectl 配合

```shell
# 渲染预览(不提交到集群)
kubectl kustomize overlays/prod
kubectl kustomize overlays/prod > rendered.yaml

# 直接应用
kubectl apply -k overlays/prod
kubectl delete -k overlays/prod

# 查看将要发生的变更
kubectl diff -k overlays/prod

# 服务端 dry-run 校验
kubectl apply -k overlays/prod --dry-run=server
```

### 注意

1. **`patchesStrategicMerge` 与 `patches` 的区别**:前者是 v3/v4 的旧字段,只能接受文件路径,且同一文件无法指定 target;`patches` 是 v5 的统一入口,既能引用文件也支持内联字符串,并能用 `target` 精确选择对象。新项目一律用 `patches`,老项目可用 `kustomize edit fix` 自动迁移。
2. **strategic merge 与 JSON patch(6902)的语义完全不同**。strategic merge 按 `name` 对齐列表元素、按字段合并,适合改容器配置;JSON patch 按数组下标与路径操作,适合精确替换。**用错会导致整个列表被覆盖而不是合并**。
3. **kubectl 内置的 kustomize 版本通常落后于独立二进制**,且**不支持 `--enable-helm`**(Helm Chart 膨胀功能)。需要渲染 Helm Chart 时必须安装独立 kustomize。
4. **`labels` 加 `includeSelectors: true` 会改动 Deployment 的 selector,而 selector 不可变**,直接 apply 会报 `field is immutable`,必须先删除再重建工作负载。
5. **`configMapGenerator` 生成的名称带哈希后缀**,因此 Deployment 里**不能**硬编码 `configMapRef.name`,必须写原始名称,由 kustomize 负责替换引用。若引用名写了带哈希的全名,渲染后会找不到对象。
6. **`resources` 与 `bases` 不能同时出现**。v5 中 `bases` 已废弃,混用会直接报错。
7. 目录下必须有 `kustomization.yaml`,否则 `kubectl apply -k` 报 `unable to find one of 'kustomization.yaml' ...`。
8. 默认 `--load-restrictor LoadRestrictionsRootOnly` **禁止引用上级目录之外的文件**,把 base 放在仓库外会被拒绝。确实需要时用 `--load-restrictor LoadRestrictionsNone`(会削弱可移植性)。
9. `secretGenerator` 生成的 Secret 内容以明文写在 kustomization.yaml 或 env 文件里,**会进入 Git 历史**,生产环境应改用 Sealed Secrets、External Secrets 等方案。
10. `namespace: prod` 只会给资源加上 namespace 元数据,**不会**自动创建 Namespace 对象,需要单独维护或用 `resources` 引入。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `helm` — Kubernetes包管理器
- `kubeadm` — Kubernetes集群安装工具
- `velero` — 集群备份与恢复

### 参考链接

- [kustomize 官方文档](https://kubectl.docs.kubernetes.io/references/kustomize/)
- [kustomize GitHub 仓库](https://github.com/kubernetes-sigs/kustomize)
- [声明式管理应用配置](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/kustomization/)
- [kustomize API 字段参考](https://kubectl.docs.kubernetes.io/references/kustomize/kustomization/)
