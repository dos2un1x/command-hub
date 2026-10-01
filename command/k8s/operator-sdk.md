operator-sdk
===

Operator Framework的Operator开发、打包与分发工具

## 补充说明

**operator-sdk** 是 CNCF **Operator Framework** 项目的命令行工具,覆盖 Operator 从「生成项目」到「打包成 bundle」「发布到 OperatorHub」的完整链路。它和同属 Operator Framework 的 OLM、OperatorHub、`opm`(operator-registry)一起构成一套分发体系。

**先澄清一个流传很广的说法。** 网上常能看到「operator-sdk 已停止维护、已被 kubebuilder 取代」,这并不准确:

```shell
operator-sdk 上游项目     CNCF Operator Framework 维护,未归档、无退役公告,仍在持续发版
Red Hat OpenShift 内置 CLI 随 OpenShift 4.16 发布弃用公告,4.18 是最后一个内置它的版本
```

Red Hat 的公告中**明确写到上游 CNCF 项目并未日落**,弃用只针对 OpenShift 随发行版分发的那个构建。所以结论是:**在 Kubernetes 上开发 Operator,operator-sdk 依然可用**;但如果你在 OpenShift 4.18 及以上版本工作,内置 CLI 已经不再随集群提供,需要自行安装上游版本。

它与 kubebuilder 的关系也是必须讲清的一点:

```shell
operator-sdk 的 Go 项目  →  直接内嵌 kubebuilder 作为脚手架(默认插件 go.kubebuilder.io/v4)
kubebuilder 项目         →  本身就是一个合法的 operator-sdk 项目,可直接使用其命令
```

也就是说,**两者生成的项目骨架是同一套目录结构**,区别在定位:

| 工具 | 覆盖范围 |
| --- | --- |
| kubebuilder | 生成项目、CRD 与 RBAC 清单、构建与部署(纯脚手架) |
| operator-sdk | 上述全部 + bundle 打包、CSV 生成、OLM 集成、OperatorHub 发布校验 |

因此实际选型的建议是:**只是写代码、用 kustomize/Helm 部署,用 kubebuilder 就够;要把 Operator 发布成可被 OLM 订阅、可进 OperatorHub 的制品,再引入 operator-sdk。**

最后强调一次(详见 `olm` 页):**OLM 与 operator-sdk 都不是运行 Operator 的必要条件**。一个 kubebuilder/operator-sdk 生成的 Operator 本质就是「一组 CRD + 一个 Deployment」,`kubectl apply` 或 Helm 装上去就能跑。

### 安装

```shell
# macOS(Homebrew)
brew install operator-sdk

# 官方脚本:从 GitHub Releases 下载对应平台的二进制
export ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
export OS=$(uname | awk '{print tolower($0)}')
export VER=v1.42.3
export URL=https://github.com/operator-framework/operator-sdk/releases/download/${VER}

curl -LO ${URL}/operator-sdk_${OS}_${ARCH}
chmod +x operator-sdk_${OS}_${ARCH}
sudo mv operator-sdk_${OS}_${ARCH} /usr/local/bin/operator-sdk

# 官方同时提供 .asc 签名文件,可自行校验后再安装
operator-sdk version
```

版本号请以项目发布页为准,不要照抄上面的示例:

```shell
# https://github.com/operator-framework/operator-sdk/releases
operator-sdk version
```

### 语法

```shell
operator-sdk [command]
```

```shell
operator-sdk init            初始化项目
operator-sdk create          创建 API 或 Webhook
operator-sdk edit            修改项目配置
operator-sdk generate        调用生成器(kustomize 清单、bundle)
operator-sdk bundle          校验 bundle 元数据
operator-sdk run             在集群中试运行 bundle(run bundle / run bundle-upgrade)
operator-sdk cleanup         清理 run bundle 装入的内容
operator-sdk olm             管理集群里的 OLM 安装(install / status / uninstall)
operator-sdk scorecard       运行 scorecard 检查
operator-sdk pkgman-to-bundle  把旧的 PackageManifest 迁移为 bundle
operator-sdk alpha           试验性命令(如旧项目版本迁移)
operator-sdk version         查看版本
```

### 初始化与创建

```shell
mkdir memcached-operator && cd memcached-operator

# 与 kubebuilder 的 init 参数一致
operator-sdk init --domain example.com --repo github.com/example/memcached-operator

# 同时生成类型与控制器
operator-sdk create api --group cache --version v1alpha1 --kind Memcached \
  --resource --controller

# 只生成控制器(类型已存在)
operator-sdk create api --group cache --version v1alpha1 --kind Memcached \
  --resource=false --controller=true

# 生成默认值与校验 Webhook
operator-sdk create webhook --group cache --version v1alpha1 --kind Memcached \
  --defaulting --programmatic-validation
```

生成的目录与 kubebuilder 项目基本一致(`cmd/`、`api/`、`internal/controller/`、`config/`、`Makefile`),区别是 operator-sdk 还额外维护 bundle 相关的目录:

```shell
memcached-operator/
├── PROJECT
├── Makefile
├── cmd/main.go
├── api/v1alpha1/memcached_types.go
├── internal/controller/memcached_controller.go
├── config/
│   ├── crd/  rbac/  manager/  samples/  default/
│   └── manifests/           # 生成 CSV 用的 kustomize 骨架
├── bundle/                  # 打包产物(发布用)
│   ├── manifests/
│   │   ├── cache.example.com_memcacheds.yaml
│   │   └── memcached-operator.clusterserviceversion.yaml
│   ├── metadata/annotations.yaml
│   └── tests/scorecard/
└── bundle.Dockerfile        # 构建 bundle 镜像
```

### bundle:打包与发布

**bundle** 是「一个可安装的 Operator 版本」的标准制品,内容是该版本的 CSV 与 CRD 清单,再打成一个容器镜像。工作流如下:

```shell
# 1. 生成 config/manifests 的骨架(只做一次)
operator-sdk generate kustomize manifests

# 2. 由 kustomize 渲染出 CSV,写入 bundle/
kustomize build config/manifests | operator-sdk generate bundle \
  --version 0.0.1 \
  --channels alpha \
  --default-channel alpha

# 3. 校验 bundle 结构与元数据
operator-sdk bundle validate ./bundle

# 4. 构建并推送 bundle 镜像
docker build -f bundle.Dockerfile -t quay.io/example/memcached-operator-bundle:v0.0.1 .
docker push quay.io/example/memcached-operator-bundle:v0.0.1
```

发布到 OperatorHub 还需要**目录(index)镜像**:把所有 bundle 的元数据聚合成一个可查询的镜像,由 `opm`(operator-registry)构建,OLM 通过 `CatalogSource` 指向它。bundle 镜像面向运维人员,index 镜像面向 OLM,两者不要混为一谈。

### 生成 CSV 的关键字段

`bundle/manifests/*.clusterserviceversion.yaml` 是 bundle 的核心,描述这个 Operator 版本的全部元信息:

```shell
apiVersion: operators.coreos.com/v1alpha1
kind: ClusterServiceVersion
metadata:
  name: memcached-operator.v0.0.1     # 必须与 version 对应
spec:
  version: 0.0.1
  replaces: memcached-operator.v0.0.0 # 上一个版本,OLM 靠它串起升级链
  installModes:                       # 支持哪种部署形态
  - type: OwnNamespace
    supported: true
  - type: AllNamespaces
    supported: true
  customresourcedefinitions:
    owned:
    - name: memcacheds.cache.example.com
      version: v1alpha1
      kind: Memcached
    required:
    - name: certificates.cert-manager.io   # 依赖他人提供的 API
      version: v1
      kind: Certificate
  install:
    strategy: deployment               # OLM 据此创建 Deployment 与 RBAC
```

`owned` 用于声明「本 Operator 拥有并管理哪些 API」,**OLM 会据此阻止两个 Operator 争抢同一 API**;`required` 用于声明依赖,OLM 会在目录中寻找能提供该 API 的 Operator 一并安装。

### 与 OLM 配合

```shell
# 在集群里安装 OLM(会创建 olm 与 operators 两个命名空间)
operator-sdk olm install --version <OLM版本>
operator-sdk olm status
operator-sdk olm uninstall

# 直接把 bundle 装进集群试运行(需要集群已装 OLM)
operator-sdk run bundle quay.io/example/memcached-operator-bundle:v0.0.1

# 测试升级路径
operator-sdk run bundle-upgrade quay.io/example/memcached-operator-bundle:v0.0.2

# 清理试运行装入的内容
operator-sdk cleanup memcached-operator
```

使用 `operator-sdk run bundle` 时,**它会在目标命名空间创建 OperatorGroup、CatalogSource 与 Subscription**,再由 OLM 完成实际安装 —— 报错信息往往来自 OLM 而非 operator-sdk 本身,排查时应直接看 CSV 与 Subscription 的状态。

如果只想快速验证 Operator 行为而不引入 OLM,直接用脚手架自带的命令更轻:

```shell
make install
make run ENABLE_WEBHOOKS=false
kubectl apply -k config/samples/
kubectl get memcacheds -w
```

### 非 Go 的 Operator 类型

operator-sdk 通过插件支持用 Ansible 或 Helm 编写 Operator,不写 Go 代码:

```shell
operator-sdk init --plugins=ansible --domain example.com
operator-sdk init --plugins=helm    --domain example.com
```

需要注意这条线正在变化:**Ansible 类型的代码正在被拆分为独立仓库**,并计划最终以 kubebuilder 插件的形式提供;Helm 类型仍保留在 operator-sdk 中。若你打算长期使用非 Go 类型,建议在立项前先确认当前的分发方式。

### 注意

1. **「operator-sdk 已废弃」是误传,但 OpenShift 内置 CLI 确实被弃用了。** 上游项目未归档、仍在发版;被弃用的是随 OpenShift 分发的构建(4.16 公告弃用,4.18 最后内置)。在 OpenShift 4.18 及以上版本上,需要自行安装上游 operator-sdk。
2. **不要把 kubebuilder 与 operator-sdk 的脚手架混用在同一个项目上。** 两者的 `PROJECT` 元数据与插件记录方式不同,虽然默认插件同为 `go.kubebuilder.io/v4`,交替执行生成命令会让后续行为不可预期。
3. **CSV 里的定制内容会被 `generate bundle` 覆盖。** 手工改动 `bundle/manifests/*.clusterserviceversion.yaml` 后再重新生成就会丢失。正确做法是把定制写进 `config/manifests` 的 kustomize 补丁(如描述、图标、示例、安装模式),让生成流程每次都产出正确结果。
4. **bundle 的版本号必须三处一致。** `--version`、CSV 的 `metadata.name`(形如 `<name>.v<version>`)与 `spec.version` 必须互相对应,不匹配时 `bundle validate` 或 OLM 安装阶段会失败。
5. **升级链断了就无法升级。** OLM 不比较版本号大小,而是沿着 CSV 的 `replaces`(必要时配合 `skips`)寻找后继版本。新版本忘记写 `replaces` 时,订阅永远停在旧版本,且不会报错。
6. **`operator-sdk run bundle` 不能在没有 OLM 的集群上使用。** 它会创建 CatalogSource 与 Subscription;集群没装 OLM 时对象会一直无人处理,表现为「命令成功但什么也没发生」。
7. **`operator-sdk olm install` 的 `--version` 有内置默认值,通常已过时。** 不显式指定时可能装上较老的 OLM,遇到已修复的问题;应显式指定当前版本,或按官方安装文档直接用 `kubectl apply` 应用对应版本的 `crds.yaml` 与 `olm.yaml`。
8. **`olm install` 的命名空间是固定的。** 它会创建 `olm`(OLM 组件所在)与 `operators`(默认安装 Operator 的命名空间),该命名空间不可通过参数更改 —— 与集群里已有的 OLM(例如 OpenShift 自带的)冲突时,不要重复安装。
9. **`bundle validate` 默认只做基础校验。** 面向 OperatorHub 的发布要求更严格,需要提升校验等级;具体参数以 `operator-sdk bundle validate --help` 为准,不同版本差异较大。
10. **非 Go 类型的 Operator 调试方式完全不同。** Ansible 类型靠 `watches.yaml` 与运行日志,Helm 类型靠 values 覆盖,都不适用 controller-runtime 那套本地 `make run` 的工作流。
11. **内网环境要处理镜像可达性。** bundle 镜像、index 镜像与 Operator 自身的镜像都要能被集群拉取,必要时先镜像到私有仓库并配置拉取凭据,否则安装会停在 `ImagePullBackOff`。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `olm` — Operator 生命周期管理
- `operator` — Operator 模式与控制器
- `kubebuilder` — Operator 脚手架
- `controller-runtime` — 控制器核心库
- `crd` — 自定义资源定义

### 参考链接

- [Operator SDK 官方文档](https://sdk.operatorframework.io/)
- [operator-sdk 仓库](https://github.com/operator-framework/operator-sdk)
- [operator-sdk CLI 参考](https://sdk.operatorframework.io/docs/cli/operator-sdk/)
- [The future of the Red Hat OpenShift Operator SDK](https://www.redhat.com/en/blog/future-red-hat-openshift-operator-sdk)
- [Operator Framework 官网](https://operatorframework.io/)
