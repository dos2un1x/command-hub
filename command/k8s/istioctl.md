istioctl
===

Istio服务网格的官方命令行工具

## 补充说明

**istioctl** 是 Istio 的官方命令行工具,负责安装、升级、排障与调试整个服务网格。它只能操作 Istio,不管理普通 Kubernetes 资源 —— 那是 `kubectl` 的活。两者通常配合使用:`istioctl` 管 Istio 自身的组件与网格配置,`kubectl` 管业务负载与命名空间。

istioctl 最容易被低估的是**排障能力**。Istio 把配置翻译成 Envoy 的 xDS 逐层下发,中间隔着好几个环节,业务不通时很难从 Kubernetes 那一侧看出问题:Pod 是 Running、Service 有 Endpoints、Ingress 也正常,但请求就是 503。istioctl 提供了从「配置是否被接受」到「Envoy 里实际生效的路由是什么」的完整链条。

三个最常用的排障命令:

- `istioctl analyze` —— 静态检查命名空间里的 Istio 配置有没有问题。
- `istioctl proxy-status` —— 看每个 sidecar 是否成功收到了最新配置。
- `istioctl proxy-config` —— 直接查看某个 sidecar 内部真实生效的监听器、路由、集群与端点。

`istioctl analyze` 报错、`proxy-status` 显示 `STALE`、`proxy-config` 里路由缺失,这三步基本能覆盖绝大多数「配置写了不生效」的问题。

### 安装

```shell
# 官方脚本,会一并下载整个 release 包
curl -L https://istio.io/downloadIstio | sh -
cd istio-1.24.0
export PATH=$PWD/bin:$PATH

# 指定版本下载
curl -L https://istio.io/downloadIstio | ISTIO_VERSION=1.24.0 sh -

# macOS 也可以直接用 Homebrew
brew install istioctl

# 验证
istioctl version
istioctl version --remote      # 同时看控制平面与数据平面的版本
```

### 语法

```shell
istioctl [command] [flags]
```

常用子命令:

```shell
analyze               分析 Istio 配置中的问题
bug-report            收集集群诊断信息并打包
dashboard             打开 Kiali、Grafana、Jaeger 等面板
experimental          实验性命令(别名 x)
install               安装 Istio 控制平面
kube-inject           给 Pod 模板注入 sidecar
manifest              生成或对比安装清单
proxy-config          查看 sidecar 的 Envoy 配置
proxy-status          查看 sidecar 配置同步状态
tag                   管理控制平面的 revision 标签
uninstall             卸载 Istio
upgrade               升级 Istio
validate              校验 Istio 资源清单
verify-install        验证安装结果
version               查看版本
waypoint              ambient 模式的 waypoint 代理管理
ztunnel-config        查看 ambient 模式的 ztunnel 状态
```

### 安装与配置档

```shell
# 列出所有内置配置档
istioctl profile list

# 查看某个配置档的默认值
istioctl profile dump demo > demo.yaml

# 对比两个配置档的差异
istioctl profile diff default demo

# 安装
istioctl install --set profile=demo -y

# 使用自定义配置文件
istioctl install -f my-config.yaml -y
```

`--set` 覆盖的是 IstioOperator 的字段路径,与 Helm 的 `--set` 不是一回事。要沿用旧的 Helm values.yaml,路径需要加 `values.` 前缀:

```shell
istioctl install --set profile=demo \
  --set values.meshConfig.accessLogFile=/dev/stdout -y
```

### 生成清单

不直接安装,先导出 YAML 供审查或走 GitOps 流程:

```shell
istioctl manifest generate > manifest.yaml

# 对比两份清单的差异
istioctl manifest diff a.yaml b.yaml

# 应用生成的清单。注意 istio-system 命名空间需要自己建
kubectl create namespace istio-system
kubectl apply --server-side -f manifest.yaml
```

### 验证安装

```shell
# 检查控制平面组件是否齐全
istioctl verify-install

# 用安装时的同一份配置来验证
istioctl verify-install -f my-config.yaml
istioctl version --remote
```

### 配置分析

`analyze` 是排查「配置写了但不生效」的第一站:

```shell
# 分析整个集群
istioctl analyze -A

# 只分析某个命名空间
istioctl analyze -n default

# 分析本地 YAML 文件,不连集群
istioctl analyze --use-kube=false deployment.yaml

# 屏蔽指定的告警码
istioctl analyze -A --suppress "IST0102=Namespace default"

# 设置退出码阈值,便于接入 CI 流水线
istioctl analyze -A --failure-threshold Warning
```

告警分 Error、Warning、Info 三级,输出里会带 `IST0102` 这类错误码,可直接搜官方文档定位。

### 查看 sidecar 同步状态

```shell
# 别名 istioctl ps
istioctl proxy-status

# 只看某个 Pod,格式为 <pod>.<namespace>
istioctl proxy-status productpage-v1-xxxx.default
```

状态列的含义:`SYNCED` 表示配置已同步;`NOT SENT` 表示当前没有需要下发的配置,不是故障;`STALE` 表示下发失败或没有响应,需要排查 istiod。

### 查看 Envoy 实际配置

```shell
# 先拿到 Pod 名
kubectl get pods -n default

# 监听器:sidecar 在哪些端口上收流量
istioctl proxy-config listener <pod> -n default

# 路由:域名与路径是怎么匹配的
istioctl proxy-config route <pod> -n default

# 集群:上游服务及其负载均衡策略
istioctl proxy-config cluster <pod> -n default

# 端点:集群里实际有哪些可用实例
istioctl proxy-config endpoint <pod> -n default

# 证书
istioctl proxy-config secret <pod> -n default

# 输出 JSON 便于脚本处理
istioctl proxy-config route <pod> -n default -o json

# 临时调整 Envoy 日志级别
istioctl proxy-config log <pod> -n default --level debug
```

### 描述资源

```shell
# 综合描述一个 Pod 的网格状态,含路由、mTLS 与告警
istioctl experimental describe pod <pod> -n default

# 简写
istioctl x describe pod <pod> -n default

```

### 手动注入 sidecar

除了命名空间标签,也可以在提交前手动注入:

```shell
istioctl kube-inject -f deployment.yaml | kubectl apply -f -

# 使用集群里的实际注入配置
istioctl kube-inject --injectConfigFile inject.yaml -f deployment.yaml
```

### revision 与升级

```shell
# 查看已有的 revision 标签
istioctl tag list

# 给新控制平面打标签
istioctl tag set prod --revision 1-24-0 --overwrite

# 安装一个新 revision 的控制平面,与原版本并存
istioctl install --set revision=1-24-0 -y

# 原地升级
istioctl upgrade --dry-run
istioctl upgrade -y

# 卸载指定 revision
istioctl uninstall --revision=1-24-0 -y

# 彻底卸载
istioctl uninstall --purge -y
```

### ambient 模式

```shell
# 为命名空间部署 waypoint 代理
istioctl waypoint apply --enroll-namespace --namespace default

# 查看 waypoint
istioctl waypoint list

# 查看 ztunnel 状态
istioctl ztunnel-config all
```

### 面板与诊断

```shell
# 打开各类面板,会自动做端口转发
istioctl dashboard kiali
istioctl dashboard envoy <pod> -n default

# 收集集群诊断信息,向社区求助时提供
istioctl bug-report

# 校验资源清单文件
istioctl validate -f my-virtualservice.yaml
```

### 注意

1. **istioctl 版本必须与控制平面版本匹配**。用旧版 CLI 操作新版集群会直接报错,升级集群前先同步 CLI。`istioctl version --remote` 能一次看清控制平面与数据平面各自的版本。
2. **`--set` 覆盖的是 IstioOperator 字段,不是 Helm values**。从 Helm 迁移过来时最容易踩的坑就是照抄 `--set meshConfig.xxx`,必须写成 `--set values.meshConfig.xxx`,否则参数被静默忽略。
3. **`proxy-config` 需要 sidecar 已就绪**。对没有注入 sidecar 的 Pod 执行会报找不到容器,先确认 `READY` 是 `2/2`。
4. **`analyze` 只做静态检查,不代表运行时一定正常**。它能发现引用了不存在的 Service、端口写错这类问题,但看不出后端 Pod 是否真的 Ready,后者仍要看 `kubectl get endpoints`。
5. **`analyze` 的告警码可以直接搜官方文档**。`IST0102` 是命名空间未开启注入,`IST0101` 是引用了不存在的资源,按码搜索比读整段输出快得多。
6. **`manifest generate` 的结果不保证与 `install` 完全一致**。官方明确说明这条路径不参与发布测试,还需要自己建命名空间、自己校验、自己清理,生产环境优先用 `istioctl install`。
7. **`istioctl uninstall` 默认不动命名空间**。残留的 `istio-system` 与 CRD 会让重装出现版本冲突,彻底清理要加 `--purge`。
8. **`proxy-status` 里的 `NOT SENT` 不是故障**。它只表示这条 sidecar 当前没有需要下发的配置,只有 `STALE` 才需要排查。
9. **`debug` 级别的 Envoy 日志量极大**。`proxy-config log --level debug` 在高流量 Pod 上可能瞬间打满磁盘,排查完立刻改回 `warning`。
10. **`kube-inject` 只影响提交的那一份清单**。手工注入的 Pod 在 Deployment 更新后会重新变回无 sidecar 状态,长期使用仍应改走命名空间标签。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `istio` — Istio服务网格
- `kiali` — Istio服务网格的可视化控制台
- `helm` — Kubernetes包管理器

### 参考链接

- [istioctl 命令参考](https://istio.io/latest/docs/reference/commands/istioctl/)
- [使用 istioctl 安装](https://istio.io/latest/docs/setup/install/istioctl/)
- [istioctl analyze 配置分析](https://istio.io/latest/docs/ops/diagnostic-tools/istioctl-analyze/)
- [调试 Envoy 与 istio-proxy](https://istio.io/latest/docs/ops/diagnostic-tools/proxy-cmd/)
