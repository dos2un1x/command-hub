kubeone
===

用一份清单管理裸金属与云上Kubernetes集群的生命周期

## 补充说明

**KubeOne** 是 Kubermatic 开源的生产级集群生命周期管理工具。它的定位介于 kubeadm 与 Cluster API 之间:比 kubeadm 多了一层完整的生命周期编排(含节点供应、升级、修复、备份),比 Cluster API 更轻——**不需要一个常驻的管理集群**,只要一份 YAML 和能够 SSH 到的机器。

KubeOne 用自己的方式描述了集群的**期望状态**(哪些机器、什么 Kubernetes 版本、哪个云厂商、补丁怎么打),`kubeone apply` 会先探测机器的**实际状态**,再决定是安装、升级还是修复。这种「探测 → 对账」的模型是它的核心:

```shell
探测结果                        apply 的动作
机器未初始化                   安装集群
Kubernetes 版本与清单不一致     升级集群
节点异常/证书过期              修复
集群完全不可用                 从备份恢复
```

它的目标场景很明确:

- **裸金属与边缘**:没有云厂商 API 可用,机器已经装好系统、能 SSH,需要把它们组成高可用集群。
- **混合云/多基础设施**:同一套工具管理 AWS、Hetzner、OpenStack、vSphere 上的集群,避免被单一供应商绑定。
- **需要 Terraform 但不想被它绑死**:KubeOne 官方提供各云厂商的 Terraform 示例,但 Terraform 只负责「把机器开出来」,集群本身由 KubeOne 管理。

**KubeOne 目前处于活跃维护状态**(由 Kubermatic 持续发布,KubeOne 1.14 已支持 Kubernetes 1.36),并未归档或停更。

### 安装

```shell
# 官方脚本:安装二进制,并解包示例 Terraform 配置、addon 与辅助脚本到当前目录
curl -sfL https://get.kubeone.io | sh

# 手动安装
curl -LO https://github.com/kubermatic/kubeone/releases/latest/download/kubeone_1.14.0_linux_amd64.zip
unzip kubeone_1.14.0_linux_amd64.zip
sudo mv kubeone /usr/local/bin/

# 也可以直接 go install
go install k8c.io/kubeone@latest

kubeone version
```

### 语法

```shell
kubeone [command]
```

```shell
kubeone apply        对账:安装 / 升级 / 修复 / 恢复,最常用的命令
kubeone install      只做安装
kubeone upgrade      只做升级
kubeone status       查看集群与节点状态
kubeone reset        清理节点上的 Kubernetes 组件
kubeone config       生成 / 迁移 / 打印清单配置
kubeone addons       管理 addon
kubeone certificates 证书管理(续期、查看到期时间)
kubeone proxy        通过 SSH 建立隧道访问集群
kubeone version      查看版本
```

### 集群清单

KubeOne 的全部输入是一份 `kubeone.yaml`:

```shell
apiVersion: kubeone.k8c.io/v1beta2
kind: KubeOneCluster
name: my-first-cluster
versions:
  kubernetes: "v1.36.0"
cloudProvider:
  none: {}
controlPlane:
  hosts:
    - publicAddress: "10.0.0.11"
      privateAddress: "10.0.0.11"
      sshUser: "ubuntu"
      sshPrivateKeyFile: "~/.ssh/id_ed25519"
    - publicAddress: "10.0.0.12"
      privateAddress: "10.0.0.12"
      sshUser: "ubuntu"
      sshPrivateKeyFile: "~/.ssh/id_ed25519"
    - publicAddress: "10.0.0.13"
      privateAddress: "10.0.0.13"
      sshUser: "ubuntu"
      sshPrivateKeyFile: "~/.ssh/id_ed25519"
apiEndpoint:
  host: "api.example.com"
  port: 6443
machineController:
  deploy: true
```

关键字段:

```shell
versions.kubernetes    目标 Kubernetes 版本,必须是完整版本号
cloudProvider          云厂商集成,裸金属用 none: {}
controlPlane.hosts     控制平面机器,publicAddress 是 SSH 地址
apiEndpoint            写进 kubeconfig 与 kubelet 的对外 API 地址,高可用必备
staticWorkers          手工纳管的固定工作节点
machineController      是否部署 machine-controller(用于动态扩缩节点)
```

生成一份默认清单作为起点:

```shell
kubeone config print --full > kubeone.yaml
```

### 常用操作

```shell
# 对账(会先探测再询问确认)
kubeone apply -m kubeone.yaml

# 免交互(CI 中使用),并自动备份
kubeone apply -m kubeone.yaml --auto-approve --backup

# 只让机器开出来,不做其他变更
kubeone apply -m kubeone.yaml --no-init

# 强制重装 / 强制升级
kubeone apply -m kubeone.yaml --force-install
kubeone apply -m kubeone.yaml --force-upgrade

# 升级前先看计划
kubeone status -m kubeone.yaml
```

`apply` 的执行流程大致是:SSH 连接各主机 → 检查/安装 containerd → 安装 kubeadm、kubelet、kubectl → 在首节点 `kubeadm init` → 其余控制平面节点加入 → 部署 CNI(Canal,即 Calico + Flannel)→ 部署 machine-controller → 生成 kubeconfig。整个过程通常 3-5 分钟。

```shell
# 拿到 kubeconfig(默认生成在当前目录)
export KUBECONFIG=$(pwd)/my-first-cluster-kubeconfig
kubectl get nodes
kubectl get pods -A
```

### Terraform 集成

KubeOne 官方为各云厂商提供了 Terraform 示例,负责把机器、网络、负载均衡开出来:

```shell
cd ./examples/terraform/aws
terraform init
terraform apply -var-file=terraform.tfvars

# 把 Terraform 的输出喂给 kubeone,避免手工填写 IP
kubeone apply -m kubeone.yaml -t ./output.json
```

支持的平台包括 AWS、Azure、GCP、DigitalOcean、Hetzner、OpenStack、Equinix Metal、Nutanix、VMware Cloud Director、vSphere、KubeVirt 以及纯裸金属。

### 升级与证书

```shell
# 升级 Kubernetes 版本:改清单里的 versions.kubernetes,再 apply
kubeone apply -m kubeone.yaml

# 只升级由 machine-controller 管理的 MachineDeployment
kubeone apply -m kubeone.yaml --upgrade-machine-deployments

# 查看证书到期时间
kubeone certificates list -m kubeone.yaml

# 续期证书(会依次重启控制平面组件)
kubeone certificates renew -m kubeone.yaml

# 轮换加密密钥(etcd 数据加密)
kubeone apply -m kubeone.yaml --rotate-encryption-key
```

从 1.14 起,`kubeone certificates renew` 会检测证书缺失的 SAN 并补齐,不再需要手工重建。

### Addon 框架

```shell
# 查看内置 addon
kubeone addons list -m kubeone.yaml

# 启用 / 禁用
kubeone addons enable <addon-name> -m kubeone.yaml
kubeone addons disable <addon-name> -m kubeone.yaml
```

自定义 addon 放在 `./addons/` 目录下,用 Go template 语法编写,可以引用集群参数。1.14 起支持在清单里用 `customSecrets` 为 addon 注入自定义 Secret。

### 排障与清理

```shell
# 集群状态
kubeone status -m kubeone.yaml

# 通过 SSH 隧道访问 API Server(网络受限时)
kubeone proxy -m kubeone.yaml

# 调试输出
kubeone apply -m kubeone.yaml --verbose --debug

# 清理节点上的 Kubernetes 组件
kubeone reset -m kubeone.yaml
```

### 注意

1. **KubeOne 需要能 SSH 到所有机器**。这是它的前提,也是它与 Cluster API 最大的区别:如果用拉模式,机器在防火墙后面也没关系,但 KubeOne 必须直连。跳板机场景要用 1.14 起支持的独立 SSH 密钥配置(jump/bastion host)。
2. **`apiEndpoint` 必须指向负载均衡器,而不是某一台控制平面节点**。高可用集群里若把 `apiEndpoint.host` 写成单台机器,kubelet 与 kubeconfig 都会绑死在这台上,该机器故障时整个集群失联。裸金属部署前先把 LB(如 HAProxy + keepalived)准备好。
3. **`apply` 是幂等的,但必须先看清楚它打算做什么**。命令会先探测再列出将要执行的动作并要求确认。CI 里用 `--auto-approve` 时要格外小心,它跳过的正是这层保护。
4. **升级会重启控制平面组件,先做备份**。`--backup` 会在升级前对 etcd 做快照,建议始终带上;`--force-upgrade` 只应在确认状态漂移时使用,它会跳过安全检查。
5. **`kubeone reset` 会清掉节点上的 Kubernetes 组件与数据**。执行前确认集群确实要废弃,尤其是共享的存储或外部 etcd。
6. **默认 CNI 是 Canal(Calico + Flannel)**。要换 Cilium 或纯 Calico,需在清单里显式配置并处理卸载旧 CNI 的顺序,直接切换会导致节点网络短暂中断。
7. **`machine-controller` 与 `staticWorkers` 是两套节点来源**。前者通过云厂商 API 动态创建 MachineDeployment,后者是清单里写死的机器。裸金属场景基本只能用 `staticWorkers`(或配合 Kubermatic 的 OSM 做节点供应)。
8. **清单的 `apiVersion` 会演进**。`kubeone.k8c.io/v1beta2` 是文档中的常用版本,代码库中已存在 `v1beta3`。升级 KubeOne 前先 `kubeone config migrate -m kubeone.yaml` 把清单迁移到新版本,否则可能启动失败。
9. **KubeOne 不是「装完就不管」的工具**。它强在生命周期编排,但监控、日志、Ingress、存储、备份策略这些都要自己补;Kubermatic 的商业产品 KKP(Kubermatic Kubernetes Platform)才提供完整栈。
10. **版本支持跟随上游节奏**。KubeOne 每个小版本对应支持若干个 Kubernetes 版本(如 1.14 对应 1.36),不要用旧版 KubeOne 去装新版本 Kubernetes,配置项可能已经对不上。
11. **KubeOne 本身是活跃维护的**(当前 1.14 系列,持续发布补丁),但它的生态位比较窄:既不是最轻的(k3s/k0s),也不是最"云原生"的(CAPI)。选它的理由通常是「需要在裸金属上得到接近托管服务的运维体验」,想清楚这一点再选。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kubeadm` — KubeOne 底层调用的集群引导工具
- `cluster-api` — 另一种集群生命周期管理方案
- `rancher` — 多集群管理平台
- `velero` — 集群备份恢复方案

### 参考链接

- [KubeOne 官方文档](https://docs.kubermatic.com/kubeone/)
- [KubeOne 快速开始](https://www.kubermatic.com/learn/kubeone/installing-kubeone-first-cluster/)
- [KubeOne 支持的平台](https://docs.kubermatic.com/kubeone/main/architecture/requirements/)
- [Meet KubeOne 1.14(支持 Kubernetes 1.36)](https://www.kubermatic.com/blog/meet-kubeone-1-14-supporting-kubernetes-1-36/)
- [KubeOne GitHub 仓库](https://github.com/kubermatic/kubeone)
