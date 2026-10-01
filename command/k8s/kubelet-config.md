kubelet-config
===

kubelet 配置文件(KubeletConfiguration)与 kubeadm 的 kubelet-config ConfigMap

## 补充说明

**kubelet-config** 讲的是 kubelet 的两层配置:

1. **配置文件本身** —— `KubeletConfiguration`(`apiVersion: kubelet.config.k8s.io/v1beta1`),由 kubelet 的 `--config` 参数指定;
2. **kubeadm 集群里的分发方式** —— 配置被写进 `kube-system` 命名空间的 `kubelet-config` ConfigMap,再由 `kubeadm init` / `kubeadm join` 下发到每个节点的 `/var/lib/kubelet/config.yaml`。

kubelet 的配置项多且杂,官方推荐的做法是**把参数写进配置文件而不是命令行**:flag 只保留那些"一辈子不会变、或者节点之间不能共享"的东西(如 `--hostname-override`、`--node-ip`、`--config` 本身)。实际上,KubeletConfiguration 对应的大部分命令行 flag 已经被标记为废弃。

### 两个容易混淆的参数

| 参数 | 指向什么 | 内容 |
|---|---|---|
| `--config` | kubelet 的**配置文件** | `KubeletConfiguration`,含 maxPods、evictionHard、cgroupDriver 等 |
| `--kubeconfig` | 访问 apiserver 的**凭据文件** | kubeconfig 格式,含 cluster、user、context |

二者完全不同,却在口语里都叫"kubelet 的配置"。**并不存在 `--kubelet-config-file` 这个参数** —— 指向配置文件的就是 `--config`。

```shell
--config=/var/lib/kubelet/config.yaml        # KubeletConfiguration
--kubeconfig=/etc/kubernetes/kubelet.conf    # 认证凭据
--config-dir=/etc/kubernetes/kubelet.conf.d  # drop-in 目录
--bootstrap-kubeconfig=/etc/kubernetes/bootstrap-kubelet.conf
```

### 配置文件的结构

```shell
apiVersion: kubelet.config.k8s.io/v1beta1
kind: KubeletConfiguration
address: 0.0.0.0
port: 10250
clusterDomain: cluster.local
clusterDNS:
  - 10.96.0.10
maxPods: 110
cgroupDriver: systemd
authentication:
  anonymous:
    enabled: false
  webhook:
    enabled: true
  x509:
    clientCAFile: /etc/kubernetes/pki/ca.crt
authorization:
  mode: Webhook
evictionHard:
  memory.available: "100Mi"
  nodefs.available: "10%"
  nodefs.inodesFree: "5%"
  imagefs.available: "15%"
```

`apiVersion` 与 `kind` 是必填的。相对路径在配置文件里**相对于配置文件所在目录**解析,命令行 flag 里的相对路径则相对 kubelet 的工作目录 —— 同一个相对路径在两处含义不同。

### 配置优先级

官方文档给出的合并顺序(括号里是优先级,越靠后越高):

```shell
1. 命令行上的 feature gates        # 最低
2. kubelet 配置文件(--config)
3. drop-in 配置文件(--config-dir,按文件名排序)
4. 命令行参数(不含 feature gates)  # 最高
```

要点:

- **命令行参数覆盖配置文件** —— 这是为了向后兼容刻意保留的行为;
- **feature gates 是个例外**:命令行上的 `--feature-gates` 优先级**最低**,配置文件里的 `featureGates` 反而会覆盖它;
- drop-in 目录里的文件按**文件名的字典序**处理,后面的覆盖前面的,只加载 `.conf` 后缀的文件(含子目录)。

```shell
# drop-in 示例:99- 前缀保证排在最后、覆盖前面所有文件
/etc/kubernetes/kubelet.conf.d/99-kubelet-address.conf
```

### 查看当前生效的配置

```shell
# 1. configz:节点上实际生效的完整配置(含默认值)
kubectl proxy --port=8001 &
curl -s http://127.0.0.1:8001/api/v1/nodes/<node-name>/proxy/configz | jq .

# 2. 节点上的文件
sudo cat /var/lib/kubelet/config.yaml
sudo cat /var/lib/kubelet/kubeadm-flags.env      # KUBELET_KUBEADM_ARGS="--flag1=value1 ..."
sudo cat /etc/kubernetes/kubelet.conf            # 连接 apiserver 的凭据

# 3. 看 kubelet 启动时实际用了哪些参数
sudo systemctl cat kubelet
sudo journalctl -u kubelet -n 100 | head -40
```

```shell
# 4. 打印 kubeadm 的默认配置(含 KubeletConfiguration 的默认值)
kubeadm config print init-defaults --component-configs KubeletConfiguration
```

### kubeadm 的分发链路

```shell
# init 时:kubeadm 把 KubeletConfiguration 写到 /var/lib/kubelet/config.yaml,
# 并上传到 kube-system 的 kubelet-config ConfigMap
kubectl -n kube-system get cm kubelet-config -o yaml

# 手工重新上传(改过配置之后)
sudo kubeadm init phase upload-config kubelet

# join 时:kubeadm 用 Bootstrap Token 换取凭据,下载 kubelet-config ConfigMap,
# 写到新节点的 /var/lib/kubelet/config.yaml
kubeadm join <endpoint> --token <token> --discovery-token-ca-cert-hash sha256:<hash>

# 升级时:把 ConfigMap 里的配置重新下发到本节点
sudo kubeadm upgrade node phase kubelet-config

# 升级后重启
sudo systemctl daemon-reload && sudo systemctl restart kubelet
```

kubeadm 在节点上维护的几个文件:

| 路径 | 内容 |
|---|---|
| `/var/lib/kubelet/config.yaml` | KubeletConfiguration,来自 kubelet-config ConfigMap |
| `/var/lib/kubelet/kubeadm-flags.env` | `KUBELET_KUBEADM_ARGS`,实例相关的 flag(如 cgroup driver) |
| `/var/lib/kubelet/instance-config.yaml` | kubeadm 探测到的本机信息(如 CRI socket) |
| `/etc/kubernetes/kubelet.conf` | 连接 apiserver 的 kubeconfig |
| `/etc/kubernetes/kubelet.conf.d/` | drop-in 配置目录(可选) |

### 常用默认值

以下取值来自 `kubelet.config.k8s.io/v1beta1` 的默认化逻辑(即**使用 `--config` 时的默认值**):

| 字段 | 默认值 |
|---|---|
| maxPods | 110 |
| cgroupDriver | cgroupfs(kubeadm 会写成 systemd) |
| authentication.anonymous.enabled | false |
| authentication.webhook.enabled | true |
| authorization.mode | Webhook |
| healthzBindAddress / healthzPort | 127.0.0.1:10248 |
| nodeStatusUpdateFrequency | 10s |
| nodeStatusReportFrequency | 5m |
| runtimeRequestTimeout | 2m |
| syncFrequency | 1m |
| imageGCHighThresholdPercent / Low | 85 / 80 |
| imageMinimumGCAge | 2m |
| containerLogMaxSize / MaxFiles | 10Mi / 5 |
| evictionHard | memory.available=100Mi、nodefs.available=10%、nodefs.inodesFree=5%、imagefs.available=15%、imagefs.inodesFree=5% |
| evictionPressureTransitionPeriod | 5m |
| enforceNodeAllocatable | ["pods"] |
| serializeImagePulls | true(设置了 maxParallelImagePulls ≥ 2 时为 false) |
| failSwapOn | true |
| kubeAPIQPS / kubeAPIBurst | 50 / 100 |
| eventRecordQPS / eventBurst | 50 / 100 |
| registryPullQPS / registryBurst | 5 / 10(字段已废弃) |
| containerRuntimeEndpoint | unix:///run/containerd/containerd.sock |
| podLogsDir | /var/log/pods |
| resolvConf | /etc/resolv.conf |

### 注意

1. **没有 `--kubelet-config-file` 这个参数**。网上不少文章这么写,但 kubelet 的 flag 列表里只有 `--config`(指向 KubeletConfiguration)、`--config-dir`(drop-in 目录)和 `--kubeconfig`(apiserver 凭据)。照抄会导致 kubelet 启动失败。
2. **`--config` 与 `--kubeconfig` 是两回事**。前者是 kubelet 自身的行为配置,后者是访问 apiserver 的身份凭据。把 kubeconfig 的内容塞进 `--config`,kubelet 会报解码错误。
3. **改 `kubelet-config` ConfigMap 不会影响已经在运行的节点**。ConfigMap 只在 `kubeadm init`、`kubeadm join`、`kubeadm upgrade node phase kubelet-config` 这几个时机被读取并写入节点磁盘。想让改动生效,必须重新下发并重启 kubelet(或直接改节点上的 `/var/lib/kubelet/config.yaml`)。
4. **kubeadm 会覆盖你对 `/var/lib/kubelet/config.yaml` 的手工修改**。在下一次 `kubeadm upgrade` 时会用 ConfigMap 的内容重新生成该文件。要长期保留的调整,应该改 ConfigMap(或使用 KubeletConfiguration patches),而不是只改节点上的文件。
5. **`evictionHard` 是整体替换,不是逐项合并**。只写一项会让其余阈值归零(等于取消保护)。要么写全五项,要么设置 `mergeDefaultEvictionSettings: true`。
6. **使用 `--config` 与使用纯命令行 flag,默认值并不相同**。为了向后兼容,kubelet 在纯 flag 模式下沿用旧默认(匿名认证开启、授权模式 AlwaysAllow);而用 `--config` 时,未指定的字段取配置文件版默认值(匿名认证关闭、Webhook 鉴权)。kubeadm 生成的 `config.yaml` 会显式写出这两个字段,所以 kubeadm 集群不受影响,但手工搭的节点要留意。
7. **kubelet 的大部分命令行 flag 已被标记废弃**,废弃说明统一是 "This parameter should be set via the config file specified by the Kubelet's --config flag"。唯几个不算废弃的包括 `--v`、`--vmodule`、`--log-flush-frequency`、`--provider-id`、`--fail-cgroupv1`。
8. **drop-in 目录必须显式指定**。kubelet 不会自己去某个默认目录找 drop-in 文件;不写 `--config-dir` 就没有 drop-in 效果。文件名必须 `.conf` 结尾,并按文件名字典序合并。
9. **feature gates 在 kubelet 上的优先级是反的**。命令行 `--feature-gates` 是**最低**优先级,配置文件里的 `featureGates` 会覆盖它 —— 与"命令行覆盖配置文件"的通用规则相反。
10. **`--dynamic-config-dir` 已经不存在**。历史上的动态 kubelet 配置(DynamicKubeletConfig)机制已被移除,现代 kubelet 的 flag 列表里没有它;不要再按老文档配置。改配置的正规做法是改文件 + 重启 kubelet。
11. **`cgroupDriver` 配错会让节点直接不可用**。kubelet 的默认是 `cgroupfs`,而 containerd 等运行时通常使用 `systemd`;两者不一致会导致 Pod 无法启动。kubeadm 生成的配置会把它设成 `systemd`,手工运维时要保证这一项与容器运行时一致。
12. **改完配置要重启 kubelet 并确认节点回到 Ready**。`systemctl daemon-reload && systemctl restart kubelet` 之后,用 `kubectl get nodes -w` 观察;配置写错时 kubelet 会启动失败,节点状态停留在旧值,日志在 `journalctl -u kubelet`。
13. **验证配置是否真的生效,用 configz 而不是看文件**。节点上的文件可能被 drop-in 覆盖、也可能被 `kubeadm-flags.env` 里的 flag 覆盖;`configz` 展示的是 kubelet 进程内**实际生效**的完整配置(含默认值),这才是排障依据。
14. **`staticPodPath` 与 kubeconfig 里的凭据一样是"高价值配置"**。控制面组件以静态 Pod 形式运行,意味着能改 `staticPodPath` 指向目录的人,就能在节点上以 root 身份运行任意容器。这个字段的权限与审计要按最高等级对待。

### 相关命令

- `kubelet` — 节点代理
- `kubeadm` — Kubernetes集群安装工具
- `feature-gates` — 特性门控的启用方式
- `capacity-planning` — kubeReserved / systemReserved 预留配置
- `kubeconfig` — kubeconfig 文件格式
- `crictl` — 容器运行时调试工具

### 参考链接

- [设置 kubelet 的配置参数](https://kubernetes.io/docs/tasks/administer-cluster/kubelet-config-file/)
- [KubeletConfiguration API 参考](https://kubernetes.io/docs/reference/config-api/kubelet-config.v1beta1/)
- [用 kubeadm 配置集群中的每个 kubelet](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/kubelet-integration/)
- [kubelet 命令行参考](https://kubernetes.io/docs/reference/command-line-tools-reference/kubelet/)
- [为系统守护进程预留计算资源](https://kubernetes.io/docs/tasks/administer-cluster/reserve-compute-resources/)
