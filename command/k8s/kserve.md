kserve
===

Kubernetes上的模型推理平台,提供InferenceService等CRD与多框架运行时

## 补充说明

**KServe** 是 Kubernetes 上的模型推理层:用一个 `InferenceService` 声明「模型在哪、用什么运行时、要几个副本」,它负责把底层的 Deployment/Service/路由/自动伸缩全部配好。它支持 Serverless(可缩容到零)与常驻部署两种模式,内置了一批开箱即用的推理运行时。

项目沿革(引用时容易搞错):

```shell
2022-02   捐给 LF AI & Data 基金会
2022-09   由 KFServing 更名为独立的 KServe
2025-09   迁入 CNCF,成为 incubating 项目(2025-11-11 对外公布)
```

也就是说 **KServe 已经不是 Kubeflow 的子项目**,它现在是 CNCF incubating 项目;早年的文档把它写作「Kubeflow 组件」是过时信息。当前版本 **v0.20.0(2026-08-06)**。

### 两种部署模式

这是选型与排障最先要搞清楚的一件事。

```shell
Knative(Serverless)   依赖 Knative Serving + 网络层(Istio 或 Kourier)
                      支持缩容到零、按请求伸缩、Revision 级别的流量切分
                      默认安装就是这个模式

Standard(常驻)        直接用 Kubernetes Deployment,不依赖 Knative/Istio
                      更轻量,HTTP 请求不支持缩容到零(Knative 侧的能力)
                      可以用 KEDA 按自定义指标做伸缩
```

**注意命名上的坑**:这两个模式在代码里经历过改名,老名字仍然能解析但已标注废弃:

```shell
LegacyServerless    "Serverless"      已废弃 → 用 Knative
Knative             "Knative"         当前写法
LegacyRawDeployment "RawDeployment"   已废弃 → 用 Standard
Standard            "Standard"        当前写法
```

也就是说**「RawDeployment」这个到处可见的名字现在是废弃别名**,新配置应该写 `Standard`;写 `RawDeployment` 仍会被归一化成 `Standard`(安装参数也一样,官方安装页只出现 `Knative` 与 `Standard` 两个值)。

切换方式有两处:

```shell
# 单个 InferenceService(注解)
metadata:
  annotations:
    serving.kserve.io/deploymentMode: Standard

# 集群默认值(ConfigMap,键名是 deploy,不是 deploymentMode)
kubectl patch configmap/inferenceservice-config -n kserve --type=strategic \
  -p '{"data": {"deploy": "{\"defaultDeploymentMode\": \"Standard\"}"}}'
```

```shell
ConfigMap 名    inferenceservice-config,命名空间 kserve
data 键         deploy
值是 JSON 字符串 {"defaultDeploymentMode": "Serverless"|"Knative"|"Standard"}
```

**默认安装是 Knative(Serverless)模式**,不是 Standard —— ConfigMap 里写着 `"defaultDeploymentMode": "Serverless"`,chart 的默认值也是 `kserve.controller.deploymentMode=Knative`。代码里的 `DefaultDeployment = Standard` 只在配置键为空时才起作用,别被它误导。

v0.20.0 起,**金丝雀发布在 Standard 模式下也能用了**(`spec.canary`,零重启提升、删掉条目即可回滚);此前金丝雀只在 Knative 模式下可用,官方文档里「Standard 不支持 canary」的说法已经过时。

### 安装

**KServe 没有传统的 Helm 仓库**,chart 以 OCI 制品发布在 ghcr.io:

```shell
helm install kserve-crd oci://ghcr.io/kserve/charts/kserve-crd \
  --version v0.20.0 --namespace kserve --create-namespace

helm install kserve-resources oci://ghcr.io/kserve/charts/kserve-resources \
  --version v0.20.0 --namespace kserve \
  --set kserve.controller.deploymentMode=Knative --wait
```

chart 清单(都带 `-minimal` 变体):

```shell
kserve-crd | kserve-crd-minimal
kserve-llmisvc-crd | kserve-llmisvc-crd-minimal
kserve-localmodel-crd | kserve-localmodel-crd-minimal
kserve-resources
kserve-llmisvc-resources
kserve-localmodel-resources
kserve-runtime-configs
```

用 kustomize 的话:

```shell
kubectl apply -k config/overlays/standalone/kserve
kubectl apply -k config/runtimes
```

验证:

```shell
kubectl get crd | grep serving.kserve.io
```

### CRD

```shell
InferenceService(简写 isvc)   serving.kserve.io/v1beta1     命名空间级
ServingRuntime                  serving.kserve.io/v1alpha1    命名空间级
ClusterServingRuntime           serving.kserve.io/v1alpha1    集群级
InferenceGraph                  serving.kserve.io/v1alpha1    命名空间级
TrainedModel                    serving.kserve.io/v1alpha1    命名空间级
LLMInferenceService(简写 llmisvc) serving.kserve.io/v1alpha1 / v1alpha2
LLMInferenceServiceConfig       serving.kserve.io/v1alpha1 / v1alpha2
```

### 一个 InferenceService

```shell
apiVersion: serving.kserve.io/v1beta1
kind: InferenceService
metadata:
  name: sklearn-iris
  namespace: default
spec:
  predictor:
    minReplicas: 1
    model:
      modelFormat:
        name: sklearn
      storageUri: s3://models/iris/model.joblib
      resources:
        requests:
          cpu: "1"
          memory: 2Gi
        limits:
          nvidia.com/gpu: 1        # GPU 推理时加上
```

三个可选组件:

```shell
predictor     必填。真正跑模型的部分
transformer   可选。预处理/后处理,与 predictor 在同一个 Pod 里(以 sidecar 形式注入)
explainer     可选。解释性接口,走 /v1/models/<name>:explain
```

查看:

```shell
kubectl get isvc -A
kubectl describe isvc sklearn-iris
kubectl get isvc sklearn-iris -o jsonpath='{.status.url}'
kubectl get isvc sklearn-iris -o jsonpath='{.status.address.url}'
```

### 内置运行时

`config/runtimes` 目录下共 **16 个运行时清单,默认安装 15 个**:

```shell
kserve-sklearnserver          kserve-xgbserver           kserve-lgbserver
kserve-pmmlserver             kserve-mlserver            kserve-paddleserver
kserve-tensorflow-serving     kserve-torchserve          kserve-tritonserver
kserve-huggingfaceserver      kserve-huggingfaceserver-multinode
kserve-autogluonserver        kserve-predictiveserver
kserve-vllmserver             kserve-llm-sglang
(kserve-openvino              目录里有,但不在 kustomization 里,默认不安装)
```

官网的运行时列表页只列了 9 个,已经落后于仓库 —— 以 `config/runtimes` 为准。

```shell
kubectl get clusterservingruntime
kubectl get clusterservingruntime kserve-tritonserver -o yaml
```

### Python SDK 与推理协议

```shell
pip install kserve

# 主要导出
Model / BaseKServeModel / ModelServer / PredictorConfig
KServeClient / InferenceRESTClient / InferenceGRPCClient
InferRequest / InferInput / InferResponse / InferOutput
```

自定义服务端用 `ModelServer`:实现一个继承 `BaseKServeModel` 的类,用 `register_model` 注册,再 `start(models)` 启动(底层是 FastAPI)。

两个协议版本的路由(注意 V1 的动词是**贴在模型名后面的**,不是独立路由):

```shell
V1
  GET  /v1/models
  GET  /v1/models/{model_name}
  POST /v1/models/{model_name}:predict
  POST /v1/models/{model_name}:explain

V2
  GET  /v2/health/live | /v2/health/ready
  GET  /v2/models | /v2/models/{model_name}
  GET  /v2/models/{model_name}/versions/{model_version}
  POST /v2/models/{model_name}/infer
  POST /v2/models/{model_name}/versions/{model_version}/infer
  POST /v2/repository/models/{model_name}/load | /unload
```

V1 的请求体是 `{"instances": [...]}`,响应是 `{"predictions": [...]}`;V2 用 `/infer` 取代 `:predict`。**V1 没有被废弃**,只是 V2 目前不支持 explain 接口。

### 状态与排障

`InferenceService` 自己的 condition 类型是这些:

```shell
PredictorReady / TransformerReady / ExplainerReady
PredictorRouteReady / TransformerRouteReady / ExplainerRoutesReady
PredictorConfigurationReady / TransformerConfigurationReady / ExplainerConfigurationReady
IngressReady
RoutesReady、LatestDeploymentReady     仅 Knative 模式
CanaryPredictorReady、Ready、Stopped
```

**`RevisionMissing` 与 `IngressNotConfigured` 不是 KServe 的 condition 类型**,它们是 Knative 侧的原因(reason)被透传到状态里:

```shell
IngressNotConfigured   Istio Ingress Gateway 探针失败
                       kubectl logs -l app=networking-istio -n knative-serving
                       返回 403 通常是 Istio RBAC 拦掉了探针

RevisionMissing        Pod 没就绪,三种典型原因
                       1. storage-initializer 初始化容器失败(模型拉不下来)
                          kubectl logs <pod> -c storage-initializer
                       2. ExitCode137 = 被 OOM Kill,提高内存 limit
                       3. CrashLoopBackOff,看 kserve-container 的日志
```

请求路径(Knative 模式)是:Istio Gateway → KServe VirtualService → Knative Istio VirtualService → Kubernetes Service → **8012 端口的 queue-proxy** → 模型容器。定义了 transformer 时,按 verb 决定路由到哪一侧。

### 注意

1. **ModelMesh 已经不再开发,不要再照着老教程装它**。官方没有发过正式的弃用公告,但 2025-02-16 合并的 PR(`kserve/kserve#4243`)写得很直接:「ModelMesh is no longer actively developed. So, we are decoupling ModelMesh from KServe.」——它已从 Helm chart 中移除,KServe 代码里也没有 ModelMesh 控制器了。相关的五个仓库(`modelmesh`、`modelmesh-serving`、`modelmesh-runtime-adapter` 等)全部处于归档状态(modelmesh-serving 的归档时间是 2026-04-14)。**但它没有直接替代品**:高密度多模型托管目前没有官方方案,单模型场景用 `ServingRuntime` + `supportedModelFormats` 即可。
2. **官方文档自身仍然过时**。README 里还写着「可以可选安装 ModelMesh」,运行时页只列 9 个运行时,CNCF 的接纳公告还把 ModelMesh 列在技术组件里 —— 这些都要以仓库源码为准。
3. **`RawDeployment` 是废弃别名**。它仍能被解析(会被归一化成 `Standard`),但新配置、新脚本统一写 `Standard`;安装参数同理。
4. **默认模式是 Knative,不是 Standard**。想用常驻部署必须在安装时或集群级 ConfigMap 里显式切换,否则会连带装上 Knative 与 Istio,资源开销与排障复杂度都会上一个台阶。
5. **ConfigMap 的键名是 `deploy`**,值是内含 `defaultDeploymentMode` 的 JSON 字符串。网上常见的 `{"data":{"deploymentMode": ...}}` 写法是错的,改了不会生效。
6. **Standard 模式不支持「HTTP 请求缩容到零」**。它换来的是不依赖 Knative/Istio 与更简单的调试路径;需要缩容到零就只能用 Knative 模式。自定义指标伸缩在 Standard 下要自己装 KEDA。
7. **`autoscaling.knative.dev/min-scale` 是 Knative 侧的注解**,写在组件的 template 上;设为 ≥1 就不会缩容到零。KServe 自己的等价字段是组件级的 `minReplicas`/`maxReplicas`,两者作用层次不同,排障时别混淆。
8. **transformer 与 predictor 在同一个 Pod 里**,是注入的 sidecar,不是独立的 Deployment。所以「transformer 的资源限制」需要单独在组件里声明,而它的失败会直接让整个 Pod 不健康。
9. **模型拉取失败是 `RevisionMissing` 的常见原因**。看 `storage-initializer` 这个 init 容器的日志;它失败一段时间后 Pod 会被缩掉,所以要及时看,不然连现场都没有了。
10. **`LLMInferenceService` 是新的 LLM 部署路径,但仍是 alpha**。它基于 vLLM 模板,通过路由侧的 Endpoint Picker(EPP)做推理网关调度,支持 prefill/decode 分离、LoRA、KV cache 卸载、用 LeaderWorkerSet 做多机部署。API 版本号仍是 `v1alpha*`,生产使用要评估变更风险。
11. **外部访问在 Knative 模式下需要真实域名、DNS 与证书**。网关与 VirtualService 的链路决定了必须有可解析的域名才能从集群外访问;测试阶段用 `kubectl port-forward` 到网关更省事。
12. **金丝雀发布的能力随模式与版本变化**。v0.20.0 起 Standard 模式也支持 `spec.canary`(且金丝雀目前只在 Standard 模式下被校验器接受),而老文档说的是「只有 Serverless 支持金丝雀」——升级前先按目标版本核对。
13. **`InferenceService` 的 `status.url` 与 `status.address.url` 用途不同**,前者是对外地址(可能带域名),后者是集群内地址;自动化脚本抓错字段会在集群外访问失败。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `knative` — Serverless模式的依赖
- `istio` — 常与Knative一起提供入口
- `hpa` — Standard模式下的副本伸缩
- `keda` — Standard模式按自定义指标伸缩
- `gateway-api` — 新版流量切换与网关能力的基础
- `crd` — InferenceService等对象的定义
- `nvidia-device-plugin` — GPU推理的前提
- `dcgm-exporter` — 推理GPU的监控

### 参考链接

- [KServe 仓库](https://github.com/kserve/kserve)
- [v0.20.0 Release](https://github.com/kserve/kserve/releases/tag/v0.20.0)
- [KServe 成为 CNCF incubating 项目](https://www.cncf.io/blog/2025/11/11/kserve-becomes-a-cncf-incubating-project/)
- [安装文档](https://kserve.github.io/website/docs/install/kserve-install)
- [部署模式说明](https://kserve.github.io/website/docs/admin-guide/kubernetes-deployment)
- [调试指南](https://kserve.github.io/website/docs/developer-guide/debugging)
- [数据平面与推理协议](https://kserve.github.io/website/docs/concepts/architecture/data-plane)
- [移除 ModelMesh 的 PR](https://github.com/kserve/kserve/pull/4243)
