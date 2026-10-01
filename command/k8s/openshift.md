openshift
===

Red Hat企业级Kubernetes平台,安全默认收紧且自带完整工具链

## 补充说明

**OpenShift** 是 Red Hat 的企业级 Kubernetes 平台。它不是一个简单的「Kubernetes 打包版」,而是在上游 Kubernetes 之上做了大量默认值与能力的扩展:更严格的安全模型、内置镜像仓库与构建能力、独立的 Ingress 抽象(Route)、自带的监控与日志栈,以及一整套运维 Operator。

需要先分清两个发行版:

```shell
OCP(OpenShift Container Platform)  Red Hat 商业版,基于 RHEL CoreOS,需订阅,有厂商支持
OKD                                社区版,基于 CentOS Stream CoreOS,免费,无官方支持
```

OKD 是 OCP 的上游,版本号一一对应(如 OKD 4.21 ↔ OCP 4.21),但**"能在 OKD 上跑"不等于"Red Hat 支持"**。生产环境用 OCP,学习和验证可以用 OKD 或 OpenShift Local。

版本节奏:约每 4 个月发布一个小版本,同时至少维持 4 个小版本的支持。**EUS(Extended Update Support)** 版本(如 4.20)额外提供更长的维护周期,生产升级通常按 EUS 到 EUS 规划。

### 与上游 Kubernetes 的主要差异

```shell
安全模型        SCC(Security Context Constraints)默认收紧,替代已废弃的 PSP
Ingress         Route 是原生抽象,Ingress 对象会被自动转换
镜像            ImageStream 提供镜像标签的间接层,配合内置的 Quay 仓库
构建            BuildConfig 支持 S2I(源码到镜像)构建
节点操作系统    RHCOS,由 MachineConfig Operator 声明式管理,不可手工改动
监控日志        内置 Prometheus、Alertmanager、Loki,开箱可用
应用市场        OperatorHub + OLM(Operator Lifecycle Manager)
节点访问        SSH 默认关闭,用 oc debug node/<name> 进入
```

### 安装 oc 客户端

```shell
# 下载客户端(包含 oc 与 kubectl)
export ARCH=$(uname -m)
curl -k https://mirror.openshift.com/pub/openshift-v4/$ARCH/clients/ocp/latest/openshift-client-linux.tar.gz \
  -o oc.tar.gz
tar zxf oc.tar.gz
sudo mv oc kubectl /usr/local/bin/

oc version
oc login https://api.ocp.example.com:6443 -u <user>
```

**oc 的版本不能落后于集群超过一个小版本**,否则会出现难以理解的 API 报错,升级集群后记得同步更新客户端。

### 安装 openshift-install

```shell
# 安装器与 oc 在同一个发行包目录下
curl -k https://mirror.openshift.com/pub/openshift-v4/$ARCH/clients/ocp/latest/openshift-install-linux.tar.gz \
  -o openshift-install-linux.tar.gz
tar zxf openshift-install-linux.tar.gz
sudo mv openshift-install /usr/local/bin/

openshift-install version
```

安装方式有几种,适用场景不同:

```shell
IPI(Installer-Provisioned Infrastructure)  安装器自动创建云资源,最省事
UPI(User-Provisioned Infrastructure)        自己准备机器与负载均衡,最灵活
Agent-based Installer                       离线/裸金属友好,生成 ISO 后引导
SNO(Single Node OpenShift)                  单节点,边缘场景
OpenShift Local(前身 CRC)                  本机虚拟机,开发体验用
```

### 单节点安装(SNO)

`install-config.yaml` 是安装的核心输入:

```shell
apiVersion: v1
baseDomain: example.com
metadata:
  name: sno
compute:
- name: worker
  replicas: 0
controlPlane:
  name: master
  replicas: 1
platform:
  none: {}
networking:
  networkType: OVNKubernetes
bootstrapInPlace:
  installationDisk: /dev/disk/by-id/<disk-id>
pullSecret: '<从 Red Hat 获取的 pull secret>'
sshKey: '<公钥>'
```

要点:`compute.replicas` 为 0 加上 `controlPlane.replicas` 为 1,才构成单节点;**SNO 只支持 OVNKubernetes 网络类型**。

```shell
# 生成安装资产并引导
openshift-install --dir=ocp create single-node-ignition-config
openshift-install --dir=ocp wait-for install-complete

export KUBECONFIG=ocp/auth/kubeconfig
oc get nodes
```

### Agent-based 安装(裸金属/离线)

```shell
# 准备 install-config.yaml 与 agent-config.yaml 后生成引导 ISO
openshift-install --dir=ocp agent create image

# 用 ISO 引导机器后等待安装完成
openshift-install --dir=ocp agent wait-for bootstrap-complete
openshift-install --dir=ocp agent wait-for install-complete
```

`agent-config.yaml` 中需要指定 rendezvous IP 与各主机的网络配置。

### OpenShift Local 快速体验

```shell
# 从 Red Hat 控制台下载 crc 二进制与 pull secret
crc setup
crc start
crc oc-env          # 输出配置 oc 环境变量的命令
eval $(crc oc-env)
oc login -u kubeadmin https://api.crc.testing:6443
crc stop
crc delete
```

### 日常运维

```shell
# 集群版本与升级状态
oc get clusterversion
oc adm upgrade
oc adm upgrade --to=4.21.5

# 集群 Operator 健康(任何 Operator Degraded 都要立刻查)
oc get clusteroperators
oc describe clusteroperator <name>

# 节点与机器
oc get nodes
oc get machines -A
oc get machineconfigpools
oc debug node/<node-name>          # 进入节点,再 chroot /host 拿到宿主 shell
```

### 安全:Security Context Constraints

SCC 是 OpenShift 与上游差异最大、也最容易踩坑的地方。上游 Kubernetes 用 PodSecurityPolicy(已废弃)后改用 Pod Security Admission,而 OpenShift 一直用自己的 SCC。

工作机制:

```shell
1. 准入控制器根据 Pod 的 securityContext 与 ServiceAccount 的权限,
   自动挑选「能满足 Pod 要求、且该 SA 有权使用」的**最严格**的 SCC
2. SCC 通过 RBAC 授权,动词是 use
3. 选中的 SCC 决定:能否以 root 运行、能否用 hostNetwork、允许哪些 Capability、
   SELinux 上下文、可用的 UID 范围等
```

默认自带的 SCC:

```shell
restricted-v2       默认,最严格
nonroot-v2          允许指定非 root UID
hostnetwork-v2      允许 hostNetwork / hostPort
hostaccess          允许 hostNetwork 与 hostPort(旧版)
hostmount-anyuid    允许挂载宿主机目录
node-exporter       为 node-exporter 定制
anyuid              允许以镜像内指定 UID 运行(含 root)
privileged          完全特权,慎用
pipelines-scc       Tekton 流水线使用
```

授权示例:

```shell
# 给某个 ServiceAccount 授权(推荐,粒度最小)
oc adm policy add-scc-to-user nonroot-v2 -z my-sa -n my-namespace

# 给一组用户授权(慎用)
oc adm policy add-scc-to-group anyuid system:serviceaccounts:my-namespace

# 查看当前生效的 SCC
oc get scc
oc describe scc restricted-v2
```

### Route 与 Ingress

```shell
# OpenShift 原生用 Route
oc expose svc/my-service
oc get routes
oc get route my-route -o yaml

# Ingress 也支持,但内部会被转换成 Route
oc get ingress
```

### 注意

1. **`restricted-v2` 会强制使用命名空间分配的随机 UID**,而不是镜像里声明的 UID。这是从上游 Kubernetes 迁过来的应用最容易直接失败的地方:镜像里写死 `USER 101` 的 nginx、`USER 999` 的 redis、PostgreSQL 的 `USER 26` 都会因权限不足启动失败。**正确做法是改用支持任意 UID 的镜像(Red Hat UBI 系列天然支持,GID 0 可写),或退一步绑定 `nonroot-v2`,而不是图省事直接给 `anyuid`** —— 那等于放弃了这一层隔离。
2. **SCC 是通过 RBAC 授权的,不是改改 YAML 就能过**。`securityContext` 里写了 `runAsUser: 65534`,如果该 ServiceAccount 只能使用 `restricted-v2`,Pod 会被直接拒绝。报错信息通常是 `unable to validate against any security context constraint`,看到这句就去查 SCC。
3. **`restricted-v2` 要求显式声明 `runAsNonRoot: true` 与 `seccompProfile`**,并丢弃所有 Capability(只回加 `NET_BIND_SERVICE`)。从上游搬过来的清单默认不带这些字段,需要补齐。
4. **节点操作系统是不可变的 RHCOS**。不能 SSH 进去 `yum install`,所有节点级改动都要通过 MachineConfig Operator 下发,MachineConfig 变更会触发**滚动重启节点**。改一次内核参数可能要等几十分钟,规划时要留出窗口。
5. **SSH 默认关闭**,排障入口是 `oc debug node/<node-name>`,进去后默认落在容器里,需要 `chroot /host` 才拿到宿主机根文件系统。
6. **Route 与 Ingress 的注解互不通用**。上游 nginx-ingress 的注解(`nginx.ingress.kubernetes.io/...`)在 OpenShift 的默认 Ingress Controller(HAProxy)上无效,对应能力要用 `route.openshift.io/...` 的注解或 Route 的字段表达。迁移过来的 Helm chart 常在这里静默失效——不报错,但配置没生效。
7. **`DeploymentConfig` 已废弃**,官方建议改用 `Deployment`。新项目不要再写 `DeploymentConfig`,它缺少 Deployment 的许多特性且不再演进。
8. **ImageStream 改变了镜像拉取语义**。使用 ImageStreamTag 时,`:latest` 会触发一次标签解析,`imagePullPolicy` 的默认行为与直接引用镜像不同,排查「为什么没拉到最新镜像」时先确认这一点。
9. **升级路径受 EUS 限制**。并非任意两个小版本都能直接升级,跨 EUS 版本的升级通常需要先升到中间版本。`oc adm upgrade` 会给出推荐路径,不要用 `--force` 绕过。
10. **OCP 需要订阅**。生产使用 OCP 必须持有 Red Hat 订阅,否则没有安全补丁与支持;OKD 免费但明确「不提供任何保证」。选型时要把订阅成本算进去,这是与 K3s、Talos 这类开源发行版最大的差别。
11. **集群 Operator 是整体健康的晴雨表**。任何 `oc get clusteroperators` 显示 `Degraded=True` 都意味着集群处于非正常状态,升级前必须先修好;`oc adm must-gather` 是收集诊断信息给 Red Hat 支持的标准动作。

### 相关命令

- `kubectl` — Kubernetes集群管理工具(OpenShift 完全兼容)
- `kubeadm` — Kubernetes集群安装工具
- `helm` — 在 OpenShift 上同样可用
- `argocd` — OpenShift 上常用的 GitOps 工具
- `tekton` — OpenShift Pipelines 的上游项目

### 参考链接

- [OpenShift 官方文档](https://docs.redhat.com/en/documentation/openshift_container_platform)
- [单节点 OpenShift 安装](https://docs.redhat.com/en/documentation/openshift_container_platform/4.21/html/installing_on_a_single_node/)
- [SCC 管理与授权](https://docs.redhat.com/en/documentation/openshift_container_platform/4.21/html/authentication_and_authorization/managing-security-context-constraints)
- [OKD 官网](https://okd.io/)
- [OpenShift Local(crc)](https://developers.redhat.com/products/openshift-local/overview)
