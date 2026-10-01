node-problem-detector
===

Kubernetes节点问题检测器:把内核与运行时故障暴露为Node Condition

## 补充说明

**node-problem-detector(NPD)** 以 DaemonSet 形式运行在每个节点上,持续读取**内核日志、系统日志与运行时日志**,从中识别出硬件故障、内核死锁、文件系统只读、容器运行时频繁重启等问题,并把结果写回 Node 对象,变成标准的 **Node Condition** 与 **Event**。

它填补的是 kubelet 覆盖不到的那一层:磁盘坏了、内核报 Oops、文件系统被重挂成只读 —— 这些故障不会让 kubelet 退出,节点在控制平面眼里依然是 `Ready`,业务却已经在悄悄劣化。NPD 让这类问题变得可观测。

```shell
# NPD 检测到的 Condition 直接挂在 Node 上,和 Ready、DiskPressure 并列
kubectl describe node <node-name> | grep -A20 Conditions
```

需要特别记住的是:**NPD 只做「检测 + 上报」,不做任何「处置」**。它不会驱逐 Pod、不会给节点打污点、也不会重启服务。原因见下方「注意」一节。

### 安装

```shell
# 方式一:kustomize(官方清单,包含 RBAC、ConfigMap 与 DaemonSet)
git clone https://github.com/kubernetes/node-problem-detector.git
kubectl apply -k node-problem-detector/deployment

# 手动分步安装
curl -O https://raw.githubusercontent.com/kubernetes/node-problem-detector/master/deployment/rbac.yaml
curl -O https://raw.githubusercontent.com/kubernetes/node-problem-detector/master/deployment/node-problem-detector-config.yaml
curl -O https://raw.githubusercontent.com/kubernetes/node-problem-detector/master/deployment/node-problem-detector.yaml
kubectl create -f rbac.yaml
kubectl create -f node-problem-detector-config.yaml
kubectl create -f node-problem-detector.yaml

# 方式二:Helm(第三方 chart)
helm install npd oci://ghcr.io/deliveryhero/helm-charts/node-problem-detector
```

安装后会创建:

```shell
DaemonSet/node-problem-detector              kube-system
ConfigMap/node-problem-detector-config       检测规则,挂载到容器的 /config
ServiceAccount/node-problem-detector
ClusterRoleBinding/npd-binding               绑定到内置 ClusterRole system:node-problem-detector
```

NPD 以 `privileged: true` 运行,并挂载宿主机的 `/var/log`(只读)与 `/dev/kmsg`(只读)—— 读内核环形缓冲区需要访问 `/dev/kmsg`,这是它必须提权的原因。

### 常用参数

```shell
--config.system-log-monitor=...      系统日志监控的配置文件,逗号分隔
--config.system-stats-monitor=...    系统状态监控的配置文件
--config.custom-plugin-monitor=...   自定义插件监控的配置文件
--address=127.0.0.1                  HTTP 服务监听地址
--port=20256                         HTTP 服务端口(提供 /conditions 等)
--prometheus-address=127.0.0.1       Prometheus 端点监听地址
--prometheus-port=20257              Prometheus 端点端口,默认开启
--enable-k8s-exporter=true           是否把结果写回 apiserver
--k8s-exporter-write-events=true     是否写入 Event
--k8s-exporter-update-node-conditions=true  是否更新 Node Condition
--k8s-exporter-heartbeat-period=5m   心跳周期
--apiserver-wait-timeout=5m          等待 apiserver 可用的超时
--kube-api-qps=500 --kube-api-burst=500  访问 apiserver 的限流参数
```

`--config.*` 系列**没有默认值**,默认的配置文件来自容器镜像的 ENTRYPOINT:

```shell
# 镜像内置的默认启动参数
--config.system-log-monitor=/config/kernel-monitor.json,/config/readonly-monitor.json

# 官方清单在此基础上多挂了一个 docker-monitor.json
--config.system-log-monitor=/config/kernel-monitor.json,/config/readonly-monitor.json,/config/docker-monitor.json
```

若所有 `--config.*` 都是空,NPD 会直接 panic 退出;若同时设置了已被废弃的 `--system-log-monitors` 与新的 `--config.system-log-monitor`,同样会 panic。

### 内置的四类检测器

| 检测器类型 | 配置参数 | 能产生的 Condition |
| --- | --- | --- |
| `SystemLogMonitor` | `--config.system-log-monitor` | `KernelDeadlock`、`ReadonlyFilesystem`、`FrequentKubeletRestart` 等 |
| `SystemStatsMonitor` | `--config.system-stats-monitor` | 目前不产生 Condition,只输出系统指标 |
| `CustomPluginMonitor` | `--config.custom-plugin-monitor` | 由用户配置决定,官方示例为 `NTPProblem` |
| `HealthChecker` | 由上述配置引用 | `KubeletUnhealthy`、`ContainerRuntimeUnhealthy` |

SystemLogMonitor 支持多种「插件」来读取日志源:

```shell
kmsg       读取 /dev/kmsg,内核环形缓冲区
filelog    读取普通文件,如 /var/log/syslog
journald   读取 systemd journal
systemd    通过 systemd 接口读取
abrt       读取 ABRT 崩溃报告
```

### 默认检测的 Condition

官方清单默认只启用 `kernel-monitor.json` 与 `readonly-monitor.json`,开箱即可产出两个 Condition:

```shell
KernelDeadlock         内核死锁,例如任务阻塞超过 120 秒
ReadonlyFilesystem     文件系统被重挂载为只读,通常意味着磁盘故障
```

其余 Condition 需要额外挂载对应的配置文件才会生效,它们是**可选插件配置**而非默认行为:

```shell
CorruptDockerOverlay2          docker 的 overlay2 存储损坏
FrequentKubeletRestart         kubelet 重启过于频繁
FrequentDockerRestart          docker 重启过于频繁
FrequentContainerdRestart      containerd 重启过于频繁
FrequentUnregisterNetDevice    网卡设备频繁注销
KubeletUnhealthy               kubelet 健康检查失败
ContainerRuntimeUnhealthy      容器运行时健康检查失败
NTPProblem                    时间同步异常(自定义插件示例)
```

注意这些 Condition 名称**不带任何前缀**,直接就是 `KernelDeadlock` 这样的字符串,与 `Ready`、`DiskPressure` 同级。

### 配置文件的写法

系统日志监控的配置是一个 JSON,核心结构如下:

```shell
{
  "plugin": "kmsg",
  "logPath": "/dev/kmsg",
  "lookback": "5m",
  "bufferSize": 10,
  "source": "kernel-monitor",
  "metricsReporting": true,
  "conditions": [
    {
      "type": "KernelDeadlock",
      "reason": "KernelHasNoDeadlock",
      "message": "kernel has no deadlock"
    }
  ],
  "rules": [
    {
      "type": "temporary",
      "reason": "KernelOops",
      "pattern": "BUG: unable to handle kernel NULL pointer dereference at .*"
    },
    {
      "type": "permanent",
      "condition": "KernelDeadlock",
      "reason": "DockerHung",
      "pattern": "task docker:\\w+ blocked for more than \\w+ seconds\\."
    }
  ]
}
```

关键点在于 `rules[].type`:

```shell
temporary    命中时只产生一条 Event,不改变 Condition
permanent    命中时把 condition 字段指定的 Condition 置为 True,产生 Event
```

`conditions` 数组里声明的是「健康的默认值」,NPD 启动时会先把它们播报为 False,这样节点上始终能看到这些 Condition,而不是等出事之后才突然冒出来。

把配置放进 ConfigMap 后滚动重启即可生效:

```shell
kubectl create configmap node-problem-detector-config -n kube-system \
  --from-file=kernel-monitor.json --dry-run=client -o yaml | kubectl apply -f -
kubectl rollout restart ds/node-problem-detector -n kube-system
```

### 验证与测试

往内核日志里注入一条能被规则匹配的消息,是验证链路是否打通的官方做法:

```shell
# 注入一条内核 Oops —— 应产生 KernelOops 事件
sudo sh -c "echo 'kernel: BUG: unable to handle kernel NULL pointer dereference at TESTING' >> /dev/kmsg"

# 注入一条 Docker 阻塞消息 —— 应同时产生事件与 KernelDeadlock Condition
sudo sh -c "echo 'kernel: INFO: task docker:20744 blocked for more than 120 seconds.' >> /dev/kmsg"

# 观察事件
kubectl get events -w --field-selector reason=KernelOops

# 观察 Condition 与 NPD 自身状态
kubectl describe node <node-name> | grep -A5 KernelDeadlock
kubectl -n kube-system port-forward ds/node-problem-detector 20256:20256
curl -s localhost:20256/conditions
```

注意注入的消息必须以 `kernel: ` 开头(冒号后**有一个空格**),否则 filelog/kmsg 插件不会按预期解析。

自定义插件检测器的规则不用 `pattern`,而是用 `path` 指定脚本并靠返回码判断:

```shell
{
  "plugin": "custom",
  "pluginConfig": {
    "invoke_interval": "30s",
    "timeout": "5s",
    "max_output_length": 80,
    "concurrency": 3
  },
  "rules": [
    {
      "type": "permanent",
      "condition": "NTPProblem",
      "reason": "NTPIsNotRunning",
      "path": "/config/check_ntp.sh"
    }
  ]
}
```

### 指标

```shell
# NPD 自身的 Prometheus 端点在 20257
kubectl -n kube-system port-forward ds/node-problem-detector 20257:20257
curl -s localhost:20257/metrics

# 核心是这两个指标
# problem_counter   某类问题发生的次数,按 reason 分组
# problem_gauge     某类问题当前是否正在影响该节点,按 type、reason 分组

# 系统状态监控还会输出 cpu/load_1m、disk/io_time 等,经 Prometheus 转义后使用
```

### 注意

1. **NPD 不会驱逐 Pod,也不会给节点打污点**。它只修改 Node Condition 与写入 Event,而这些 Condition **不会触发任何调度或驱逐行为**。Kubernetes 的调度器只看污点不看 Condition,而内置污点列表里并没有 `KernelDeadlock`、`ReadonlyFilesystem` 这类自定义 Condition。
2. **想让检测结果产生实际处置,必须再引入一个补救系统**。官方推荐的路径是 Descheduler(驱逐违反污点的 Pod)、medik8s 的 Node Health Check Operator,或 Cluster API 的 MachineHealthCheck。只装 NPD 而不装补救系统,等于只多了几个看得见的告警字段。
3. **`FrequentKubeletRestart` 等 Condition 不在默认配置里**。默认只启用内核与只读文件系统两个监控,需要额外挂载 `systemd-monitor-counter.json` 之类的配置文件才会出现,不要以为装上就有。
4. **`NetworkUnavailable` 不是 NPD 维护的**。它由 CNI 网络插件写入,把 NPD 当作来源排查网络问题会找错方向。
5. **NPD 必须以特权容器运行并挂载 `/dev/kmsg`**。这是读取内核环形缓冲区的硬性要求,也因此需要评估它在多租户集群中的安全边界。
6. **`--config.*` 与旧的 `--system-log-monitors` 不能同时设置**,否则 NPD 直接 panic 退出;旧参数已被废弃,新部署一律用 `--config.system-log-monitor`。
7. **所有 `--config.*` 都为空同样会 panic**。自定义镜像或手写清单时很容易漏掉,表现为 DaemonSet 的 Pod 反复重启,日志里只有一行 `No configuration option for any problem daemon is specified`。
8. **官方清单的 ConfigMap 与仓库 `config/` 目录并不完全一致**。清单里的 `kernel-monitor.json` 是一个较旧的副本(缺少 `XfsShutdown`、`CperHardwareErrorFatal` 等规则),想用上游最新规则时应从仓库 `config/` 目录取文件再自行放入 ConfigMap。
9. **规则里的正则越宽,误报越多**。`permanent` 规则一旦命中就会把 Condition 置为 True,而 Condition 只能靠后续规则再置回 False;宽泛的正则会让节点长期停留在「有问题」的状态。
10. **注入测试消息会污染真实的内核日志**。`/dev/kmsg` 的写入会进入内核环形缓冲区并被其他日志采集器读到,生产环境上做验证要谨慎,测试完也应确认 Condition 已经恢复。
11. **NPD 的 Condition 名称没有命名空间前缀**,与 Kubernetes 内置 Condition 处在同一个命名空间里,自定义时不要取 `Ready`、`DiskPressure` 这类官方已经在用的名字,否则会相互覆盖。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `node` — kubectl 视角的节点状态与 Condition 查看
- `kubelet` — 节点代理,自身健康状态也被 NPD 的 HealthChecker 监控
- `kured` — 节点重启编排,与 NPD 组合实现「检测 + 处置」
- `event` — 查看 NPD 写入的 KernelOops 等事件

### 参考链接

- [node-problem-detector GitHub 仓库](https://github.com/kubernetes/node-problem-detector)
- [NPD 部署清单](https://github.com/kubernetes/node-problem-detector/tree/master/deployment)
- [自定义插件监控说明](https://github.com/kubernetes/node-problem-detector/blob/master/docs/custom_plugin_monitor.md)
- [节点状态与 Condition 官方文档](https://kubernetes.io/docs/reference/node/node-status/)
- [污点与容忍(为什么 Condition 不触发驱逐)](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/)
