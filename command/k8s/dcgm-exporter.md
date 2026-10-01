dcgm-exporter
===

把NVIDIA GPU的利用率、显存、温度等指标导出给Prometheus的采集器

## 补充说明

**DCGM-Exporter** 基于 **DCGM(Data Center GPU Manager)** 采集 GPU 遥测数据,并以 Prometheus 格式暴露在 `:9400/metrics`,是 Kubernetes 上 GPU 监控的事实标准。

状态:**活跃维护,没有任何弃用或 EOL 公告**。仓库最后一次推送在 2026-09,最新版本 **4.6.0-4.8.3(2026-07-15)**。官方文档的原话是「To gather GPU telemetry in Kubernetes, its recommended to use DCGM Exporter」。仓库 README 里有一句「Consider using the NVIDIA GPU Operator rather than DCGM-Exporter directly」,那是在推荐**部署方式**(让 Operator 替你把 exporter 装上),**不是**在说 exporter 被取代 —— 这两件事经常被混为一谈。

tag 的命名顺序容易记反:**DCGM 版本在前,exporter 版本在后**:

```shell
4.6.0-4.8.3-distroless     DCGM 4.6.0 + dcgm-exporter 4.8.3,distroless 变体
4.6.0-4.8.3-ubuntu22.04    Ubuntu 变体
4.6.0-4.8.3-ubi9           UBI 变体
```

镜像地址 `nvcr.io/nvidia/k8s/dcgm-exporter`,当前清单里用的是 `4.6.0-4.8.3-distroless`。**exporter 与 DCGM 必须配套使用**:官方明确说不匹配的组合「可能能跑,但未经测试也不受支持」。

### 安装

```shell
helm repo add gpu-helm-charts https://nvidia.github.io/dcgm-exporter/helm-charts
helm repo update

helm install --generate-name gpu-helm-charts/dcgm-exporter \
  --namespace monitoring --create-namespace

kubectl -n monitoring get pods,svc | grep dcgm
```

装完会有一个名为 `dcgm-exporter` 的 Service,端口名 `metrics`,端口 **9400**,类型 ClusterIP。用 GPU Operator 时它会作为受管组件自动部署,**不要重复安装**。

验证:

```shell
kubectl -n monitoring port-forward svc/dcgm-exporter 9400:9400
curl -s localhost:9400/health
curl -s localhost:9400/metrics | grep DCGM_FI_DEV_GPU_UTIL
```

`/health` 返回 `OK`,并带 `X-Registry-Available` 与 `X-Reload-In-Progress` 两个头;`/metrics` 的 content-type 是标准的 `text/plain; version=0.0.4`。

### 指标名

**指标名是大写的** —— 是 `DCGM_FI_DEV_GPU_UTIL`,不是 `dcgm_fi_dev_gpu_util`。小写的 `dcgm_*` 只存在于一个可选的兼容性 CSV(`etc/1.x-compatibility-metrics.csv`)里,默认不启用。

默认采集集(`etc/default-counters.csv`)里最常用的几个:

```shell
DCGM_FI_DEV_GPU_UTIL            GPU 利用率(gauge)
DCGM_FI_DEV_FB_USED             已用显存,单位 MiB(gauge)
DCGM_FI_DEV_FB_FREE             空闲显存,单位 MiB(gauge)
DCGM_FI_DEV_GPU_TEMP            GPU 温度(gauge)
DCGM_FI_DEV_MEMORY_TEMP         显存温度(gauge)
DCGM_FI_DEV_POWER_USAGE         功耗(gauge)
DCGM_FI_DEV_SM_CLOCK            SM 时钟(gauge)
DCGM_FI_DEV_MEM_CLOCK           显存时钟(gauge)
DCGM_FI_DEV_MEM_COPY_UTIL       显存带宽利用率(gauge)
DCGM_FI_DEV_XID_ERRORS          最近一次 XID 错误的值(gauge,不是计数器)
DCGM_FI_DEV_PCIE_REPLAY_COUNTER PCIe 重放计数
DCGM_FI_DEV_TOTAL_ENERGY_CONSUMPTION   累计能耗
DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL     NVLink 带宽总量
DCGM_FI_DRIVER_VERSION          驱动版本(类型是 label,作为标签注入其他指标)
```

注意 **`DCGM_FI_DEV_XID_ERRORS` 是 gauge**,它表示「最后遇到的 XID 错误编号」,不是错误计数。想看错误累计次数要用 exporter 自己的 `DCGM_EXP_XID_ERRORS_COUNT` / `DCGM_EXP_XID_ERRORS_TOTAL`(默认 CSV 里被注释掉了,需要自己打开)。

**Profiling 指标(`DCGM_FI_PROF_*`)** 是另一类东西,需要 GPU 支持 Datacenter Profiling(Volta 及更新的数据中心卡)并且容器有 `SYS_ADMIN`:

```shell
默认开启   DCGM_FI_PROF_GR_ENGINE_ACTIVE
           DCGM_FI_PROF_PIPE_TENSOR_ACTIVE
           DCGM_FI_PROF_DRAM_ACTIVE
           DCGM_FI_PROF_PCIE_TX_BYTES
           DCGM_FI_PROF_PCIE_RX_BYTES

需自行添加 DCGM_FI_PROF_SM_ACTIVE、DCGM_FI_PROF_SM_OCCUPANCY
           DCGM_FI_PROF_PIPE_FP64_ACTIVE / FP32 / FP16
           以及所有 *_TOTAL 计数器
```

`DCGM_FI_PROF_NVLINK_TX_BYTES` / `_RX_BYTES` 是真实存在的 DCGM 字段,但**不在任何随附的 CSV 里**,必须自己加。

### 自定义采集指标

两条路径,都能用:

**CSV(传统方式)**,参数 `--collectors`,短参数是 **`-f`**,环境变量 `DCGM_EXPORTER_COLLECTORS`,默认路径 `/etc/dcgm-exporter/default-counters.csv`。格式固定三列:

```shell
DCGM FIELD, Prometheus metric type, help message
DCGM_FI_DEV_GPU_UTIL, gauge, GPU utilization (in %).
DCGM_FI_DEV_FB_USED, gauge, Used FrameBuffer memory.
```

类型可以是 `counter`、`gauge`、`untyped`、`label`。`#` 开头是注释。

**YAML(4.6.0-4.8.3 新增)**,参数 `--config-file`,环境变量 `DCGM_EXPORTER_CONFIG_FILE`,chart 会把它挂到 `/etc/dcgm-exporter/config.yaml`:

```shell
version: 1
metrics:
  file: /etc/dcgm-exporter/default-counters.csv    # 与 fields 二选一,不能同时写
  # fields:
  #   - name: DCGM_FI_DEV_GPU_TEMP
  #     prometheusType: gauge
  #     help: GPU temperature (in C).
collection:
  interval: 30s
  watchGroups:
    - name: fast-thermals
      interval: 5s
      fields: [DCGM_FI_DEV_GPU_TEMP, DCGM_FI_DEV_POWER_USAGE]
```

YAML 校验很严格:未知字段、重复键、多个 YAML 文档、`file` 与 `fields` 同时出现、非正的毫秒间隔都会被拒绝。**YAML 只在启动时读取一次**,且显式给出的 flag/环境变量优先级高于 YAML。

**无论哪种方式,自定义的指标文件都是对默认列表的「完整替换」而不是追加** —— 只写三个字段,其余默认指标就全部消失了。

### Pod 归属与标签

加 `--kubernetes`(`-k`)会让指标带上 `pod`、`namespace`、`container` 标签,依赖宿主机上的 kubelet pod-resources 目录:

```shell
# chart 默认挂载(只读)
/var/lib/kubelet/pod-resources:/var/lib/kubelet/pod-resources:ro

# kubelet socket 路径可改
--pod-resources-kubelet-socket=/var/lib/kubelet/pod-resources/kubelet.sock
```

两点说明:老命名(用 `--use-old-namespace` / `-o` 切回)是 `pod_name`、`pod_namespace`、`container_name`;只有分配了 `nvidia.com/gpu` 或 `nvidia.com/mig-*` 的 Pod 才会被打标。Pod 自身的标签会以 `pod_label_<净化后的键>` 形式带出来,数量大时用 `--kubernetes-pod-label-allowlist-regex` 白名单收敛。

### MIG

**MIG 不需要任何开关,也没有 `--mig` 或 `--mig-format` 这类参数**。设备选择器 `--devices`(短参数 `-d`)默认值是 `f`,含义是「MIG 关闭时监控所有 GPU,MIG 开启时监控所有 GPU 实例」;需要精挑时语法是 `f | g[:id1[,-id2]] | i[:id1[,-id2]]`(如 `g:0-3+i:0-1`),但**只有在 MIG 模式开启时才能用 `i` 指定实例**。

MIG 实例的标识以标签形式附加(都是**大写**):

```shell
GPU_I_ID         实例 ID,如 "13"
GPU_I_PROFILE    实例 profile,如 "1g.5gb"
```

MIG 是可按实例归属指标的;而 **time-slicing 场景下 exporter 无法把指标映射到容器**(官方 issue 记录在案),这是两种共享方式在可观测性上的关键差别。

### Prometheus 采集

chart 默认开启 ServiceMonitor(`serviceMonitor.enabled: true`,间隔 30s,超时 25s,apiVersion `monitoring.coreos.com/v1`)。集群里没有 Prometheus Operator 的 CRD 时必须关掉,否则安装会失败:

```shell
helm install --generate-name gpu-helm-charts/dcgm-exporter \
  --set serviceMonitor.enabled=false
```

超时值有个约束:**`scrapeTimeout` 要小于 exporter 的 `--web-write-timeout`(默认 30s),且不大于采集间隔**,否则会持续出现超时。

### 版本里需要注意的破坏性变更

```shell
4.5.1-4.8.0   Helm chart 默认镜像改为 distroless 变体(没有 shell,exec 进去排障会失败)
4.5.1-4.8.0   NVLink 带宽指标由 counter 改为 gauge(Prometheus 类型变了)
4.6.0-4.8.3   标签 Hostname 改名为 hostname —— 引用旧名字的看板与告警会失效
              (可用 --no-hostname 关掉该标签)
4.6.0-4.8.3   新增 YAML 配置方式;新增 MIG 设备上的 Pod 标签采集
```

### 常用命令

```shell
# 指标清单与端点
curl -s localhost:9400/metrics | grep -c "^DCGM_"
curl -s localhost:9400/metrics | grep DCGM_FI_DEV_FB_USED
curl -s localhost:9400/health

# 排障:exporter 自己的日志
kubectl -n monitoring logs ds/dcgm-exporter --tail=200
kubectl -n monitoring logs -l app.kubernetes.io/name=dcgm-exporter --tail=100

# 确认容器里有采集 GPU 所需的能力
kubectl -n monitoring get ds dcgm-exporter -o jsonpath='{.spec.template.spec.containers[0].securityContext}' | jq .

# 改了指标配置后
kubectl -n monitoring rollout restart ds/dcgm-exporter
```

### 注意

1. **容器不是 `privileged`,而是要 `SYS_ADMIN`**。chart 的 securityContext 是 `runAsUser: 0` + `capabilities.add: ["SYS_ADMIN"]` + `drop: ["ALL"]` + `allowPrivilegeEscalation: false`。Profiling 指标(`DCGM_FI_PROF_*`)依赖这个能力;不需要 profiling 时可以改成非 root(`runAsNonRoot: true`、`runAsUser: 1000`)并去掉 `SYS_ADMIN`。
2. **自定义指标文件是「替换」不是「追加」**。只写自己关心的几个字段会把默认的一整套指标全丢掉,看板会大面积空白。稳妥做法是从默认 CSV 复制一份再改。
3. **指标名是大写的**。写 `dcgm_fi_dev_gpu_util` 的查询一定查不到数据,小写命名只在可选的兼容 CSV 里存在。
4. **`DCGM_FI_DEV_XID_ERRORS` 是 gauge 不是 counter**。它表示最近一次 XID 错误的编号,拿它做 `rate()` 或 `increase()` 是没有意义的;要计数请用 exporter 自身的 `DCGM_EXP_XID_ERRORS_COUNT`。
5. **`DCGM_FI_PROF_NVLINK_TX_BYTES` / `_RX_BYTES` 默认没有**。需要自己加进 CSV,并且确认 GPU 支持 Datacenter Profiling。
6. **exporter 与 DCGM 版本必须配套**。混搭不同的 DCGM 与 exporter 版本属于官方「不受支持」的组合,典型表现是某些字段直接为空。
7. **`--enable-pprof` 单独使用会被拒绝**,必须同时提供 web 配置文件;这是有意的安全约束。
8. **distroless 镜像没有 shell**。`kubectl exec` 进去想 `curl localhost:9400` 会失败,排障要么用带 shell 的 `-ubuntu22.04` 变体,要么在 Pod 外面转发端口。
9. **`Hostname` 标签改名会影响看板**。4.6.0-4.8.3 起是 `hostname`(小写),引用 `Hostname` 的 Grafana 面板与告警规则需要同步修改。
10. **time-slicing 下无法按容器归属指标**。多个 Pod 共用一张卡时,指标只能到卡这一级;要按租户/容器做计量,必须改用 MIG。
11. **ServiceMonitor 在缺少 Prometheus Operator CRD 的集群里会导致安装失败**,记得 `--set serviceMonitor.enabled=false`。
12. **exporter 自身的累计计数器会在重启或热加载后归零**。`DCGM_EXP_*_TOTAL` 这类指标在 collector 重建、进程重启、热加载时都会重置,不要把它当作长期累计值。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `gpu-operator` — 会自动部署本组件,勿重复安装
- `nvidia-device-plugin` — GPU可用性的前提
- `gpu-mig` — MIG实例可按实例采集,有独立UUID
- `gpu-time-slicing` — 共享场景下无法按容器归属指标
- `prometheus` — 采集与告警的接收端
- `grafana` — NVIDIA 提供官方 GPU 看板
- `node-exporter` — 节点级指标,与GPU指标互补
- `daemonset` — exporter以DaemonSet形式运行

### 参考链接

- [DCGM-Exporter 仓库](https://github.com/NVIDIA/dcgm-exporter)
- [4.6.0-4.8.3 Release](https://github.com/NVIDIA/dcgm-exporter/releases/tag/4.6.0-4.8.3)
- [DCGM 官方文档](https://docs.nvidia.com/datacenter/dcgm/latest/index.html)
- [DCGM 字段 ID 参考](https://docs.nvidia.com/datacenter/dcgm/latest/dcgm-api/dcgm-api-field-ids.html)
- [GPU Telemetry 文档](https://docs.nvidia.com/datacenter/cloud-native/gpu-telemetry/latest/index.html)
- [time-slicing 下的归属限制](https://github.com/NVIDIA/dcgm-exporter/issues/307)
