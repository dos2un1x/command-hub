kata-containers
===

基于轻量虚拟机的容器运行时,每个 Pod 一个独立 guest 内核

## 补充说明

**Kata Containers** 是 OpenInfra Foundation 旗下的容器运行时,思路是**给每个 Pod(或每个容器)起一台轻量虚拟机**,容器进程跑在 VM 里的 guest 内核上。对外它和普通容器没有区别——镜像格式、OCI 运行时接口、CRI 接口都兼容;对内它把「容器逃逸」的后果从「拿到宿主机内核」降级成「打穿一台一次性 VM」。

它和 runc 的区别可以用一句话概括:**runc 共享宿主机的内核,Kata 不共享**。因此 Kata 的隔离强度接近虚拟机,而启动速度与资源开销介于容器与虚拟机之间。

项目本身活跃:**v4.2.0 发布于 2026-09-15**,主线已迁移到 Rust 实现的 `runtime-rs`。

### 组件

```shell
runtime-rs           Rust 写的运行时(当前主线)
kata-runtime         早期 Go 实现的运行时,官方已标注 deprecated
kata-agent           VM 内的 agent,负责在 guest 里执行容器的 OCI 生命周期操作
containerd-shim-kata-v2  shim-v2,连接 containerd 与 VM
VMM                  虚拟机监视器,可选 QEMU / Cloud Hypervisor / Firecracker /
                     Dragonball(runtime-rs 专用)/ Stratovirt
kata-monitor         节点上的监控组件,暴露 VM 级指标
```

### 安装(kata-deploy)

官方推荐用 kata-deploy 的 Helm chart(以 OCI 制品发布,版本号跟随 Kata 发行版):

```shell
export VERSION=$(curl -sSL https://api.github.com/repos/kata-containers/kata-containers/releases/latest | jq -r .tag_name)
export CHART="oci://ghcr.io/kata-containers/kata-deploy-charts/kata-deploy"

helm install kata-deploy "${CHART}" --version "${VERSION}"

# 查看可配置项(每个 shim 的开关与 RuntimeClass 配置都在这里)
helm show values "${CHART}" --version "${VERSION}"
```

前置要求:Kubernetes ≥ v1.22、containerd(推荐 2.1.x 及以上)、Kata ≥ 3.12。

### RuntimeClass

kata-deploy 会**为每个启用的 shim 创建一个 RuntimeClass**。名字由 VMM 与变体决定:

```shell
kata-qemu                  QEMU + 已废弃的 Go runtime
kata-qemu-runtime-rs       QEMU + runtime-rs(当前推荐)
kata-clh                   Cloud Hypervisor
kata-clh-runtime-rs        Cloud Hypervisor + runtime-rs
kata-fc                    Firecracker
kata-dragonball            Dragonball(runtime-rs 专用)
kata-stratovirt            Stratovirt
kata-qemu-snp              AMD SEV-SNP(机密计算)
kata-qemu-tdx              Intel TDX(机密计算)
kata-qemu-se               IBM Secure Execution(s390x)
kata-qemu-coco-dev         无 TEE 的 CoCo 开发模式
kata-qemu-nvidia-gpu       GPU 直通
kata-qemu-nvidia-gpu-snp / -tdx   GPU + TEE
```

```shell
# 看当前集群实际有哪些
kubectl get runtimeclasses

# 用某一个跑一个测试 Pod
kubectl run kata-test --image=busybox \
  --overrides='{"spec":{"runtimeClassName":"kata-qemu-runtime-rs"}}' \
  -- sleep 3600

# 验证:guest 内核版本与宿主机不同,即证明跑在 VM 里
kubectl exec kata-test -- uname -r
uname -r
```

选择 shim 用 values:

```shell
shims:
  disableAll: true
  qemu:
    enabled: true
  qemu-nvidia-gpu:
    enabled: true
```

### 硬件要求

这是 Kata 与其它运行时最大的差别——**它需要虚拟化能力**:

```shell
# 1) 确认是裸金属还是虚拟机;输出 none 表示裸金属
systemd-detect-virt

# 2) 确认 CPU 有虚拟化扩展(有输出即可;空表示不可用)
grep -E -o '(vmx|svm)' /proc/cpuinfo | sort -u

# 3) KVM 设备必须存在,且 shim 的运行用户(root 或 kvm 组)可访问
ls -l /dev/kvm
sudo modprobe kvm_intel    # Intel
sudo modprobe kvm_amd      # AMD

# 4) 常用内核模块
sudo modprobe vhost_vsock
sudo modprobe vhost_net
# 持久化:/etc/modules-load.d/kata-containers.conf
```

如果节点本身就是虚拟机,必须在**宿主机侧**开启嵌套虚拟化(nested virtualization)。微软 Hypervisor 系(Azure、Windows 上的嵌套 Linux 虚拟机)没有 `/dev/kvm`,对应设备是 `/dev/mshv`,需要 mshv 兼容的 VMM。

### 观测与排障

```shell
# 1) 节点上看到的是 VMM 进程,不是应用进程
ps aux | grep -E 'qemu|cloud-hypervisor|firecracker|kata-runtime'

# 2) kata-deploy 自身的状态(job 模式下失败原因写在节点注解里)
kubectl -n kube-system get pods | grep kata-deploy
kubectl get nodes -l kata-deploy-job-dispatcher/result=failed
kubectl get node <node> -o jsonpath='{.metadata.annotations}' | tr ',' '\n' | grep kata-deploy

# 3) kata-monitor 暴露的 VM 级指标
kubectl -n kube-system get pods -l name=kata-monitor -o wide

# 4) 容器起不来时,先确认 RuntimeClass 名与实际启用的 shim 是否对得上
kubectl get runtimeclass
kubectl describe pod kata-test | tail -20
```

### 升级与卸载

```shell
# 升级:chart 版本跟随 Kata 发行版,两者要一起升
export VERSION=$(curl -sSL https://api.github.com/repos/kata-containers/kata-containers/releases/latest | jq -r .tag_name)
helm upgrade kata-deploy "${CHART}" --version "${VERSION}"

# 升级是节点级的滚动替换,期间不要同时部署新的 Kata 工作负载

# 卸载
helm uninstall kata-deploy -n kube-system
```

### 与 CRI 实现的配置关系

kata-deploy 会在节点上写入 containerd 的配置片段(把 kata 的 runtime handler 注册进去),所以**它需要能改动节点的容器运行时配置**。这带来两个实际约束:

```shell
1) 节点上必须已经装了兼容版本(推荐 containerd 2.1.x 以上)的 CRI 实现
2) kata-deploy 的 Pod 需要能写到宿主机的 containerd 配置目录,
   因此以特权方式运行,并且需要挂载宿主机的根文件系统
```

如果集群用 CRI-O,Kata 同样支持,但配置路径与 containerd 不同;chart 会按节点上检测到的运行时分别处理。**托管 Kubernetes 上通常拿不到这个权限**,这也是 Kata 主要在自建集群落地的原因之一。

### 注意

1. **嵌套虚拟化是最大的落地障碍,而且很多云机型不支持**。Kata 要么跑在裸金属上,要么跑在**已开启嵌套虚拟化**的虚拟机上。大量云厂商的通用机型不开放嵌套虚拟化,表现为 `/dev/kvm` 不存在或 `modprobe kvm_intel` 报错。**选型第一件事是确认目标机型是否支持**,而不是先搭环境。
2. **集群升级 k8s 版本不等于能升级 Kata**。chart 要求 Kubernetes ≥ v1.22,并推荐 containerd 2.1.x 及以上;containerd 1.7 及更早的版本虽然还能跑,但缺少新 shim 需要的特性。节点上的 CRI 实现版本会被 kata-deploy 检查。
3. **每个 Pod 一份 guest 内核,内存开销是刚性的**。Kata 的内存占用不只看应用本身,还要算上 guest 内核、kata-agent、virtiofsd 等常驻部分。高密度部署时可用的 Pod 密度会明显低于 runc,容量规划要按 VM 而不是按容器估算。
4. **启动延迟明显高于 runc**。冷启动要拉起 VM、引导 guest 内核、启动 agent。对秒级弹性伸缩敏感的负载(如突发流量的 Serverless)不适合默认走 Kata,除非用上快照恢复等加速手段。
5. **`kata-qemu` 对应的是已废弃的 Go runtime**。新部署应使用带 `-runtime-rs` 后缀的 RuntimeClass。旧文档里的 `kata-qemu` 例子照抄会用到 deprecated 实现。
6. **`deploymentMode` 的默认值正在变化**。chart 支持 `daemonset`(常驻 DaemonSet)与 `job`(按节点分发一次性 Job)两种模式,官方在 4.2.0 里把切换默认值的计划推迟到了 4.3.0。**部署前用 `helm show values` 确认当前版本的默认值**,不要想当然,两种模式下排障方式完全不同(Job 模式下失败原因写在节点的注解 `kata-deploy-job-dispatcher/error` 里)。
7. **早期的 `io.katacontainers.io/kata-runtime` 注解方式已过时**。RuntimeClass 是当前唯一受支持的声明方式。老 YAML 里的注解不要再沿用。
8. **Host 侧看到的是一堆 QEMU/CLH 进程**。在节点上 `ps` 看不到应用的真实进程树,依赖节点侧进程信息的安全 agent、监控 agent 会失效或误报。要观察 VM 内部需要进 guest(runtime-rs 支持 `kubectl exec` 进容器,但如果 agent 没起来就进不去)。
9. **Firecracker 的取舍很明确**:启动快、内存开销小,但设备模型极简——没有 PCI、不支持 GPU/热插拔等一堆能力。需要 GPU、需要复杂块设备拓扑的场景只能用 QEMU 或 Cloud Hypervisor。
10. **`shims.<name>.dropIn` 是给 shim 打补丁的正规途径**。kata-deploy 会把它写成该 shim 的 `config.d/50-user-overrides.toml`。直接改节点上的配置文件会在下次部署时被覆盖。
11. **kata-monitor 与指标**。VM 级指标由 kata-monitor 提供,默认不一定被 Prometheus 采集到;要在 GC/性能排障里有数据,需要显式配置抓取。
12. **机密计算相关 RuntimeClass 需要额外硬件与固件**。`kata-qemu-snp`、`kata-qemu-tdx` 等不是「打开开关就能用」——需要对应 CPU、BIOS/UEFI 里开启、以及宿主机的 attestation 组件。没有硬件时用 `kata-qemu-coco-dev` 做流程验证,但它不提供真正的内存加密。
13. **卸载后残留的 RBAC 资源是预期行为**。`helm uninstall kata-deploy` 后集群级的 RBAC 资源会被保留(跨命名空间复用),官方用一个 post-delete 的 Job 来清理。看到残留不要手工乱删,先确认是不是这个机制。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `helm` — Kubernetes包管理器
- `gvisor` — 不需要虚拟化的另一种强隔离运行时
- `confidential-containers` — 在 Kata 之上实现机密计算
- `containerd` — 注册 kata runtime handler 的 CRI 实现
- `crictl` — 直接调试 CRI 层面的容器
- `pod-security-admission` — 特权工作负载的准入控制
- `node` — 检查节点的虚拟化能力

### 参考链接

- [Kata Containers 官方文档](https://kata-containers.github.io/kata-containers/)
- [安装指南](https://kata-containers.github.io/kata-containers/installation/)
- [Helm 配置参数](https://github.com/kata-containers/kata-containers/blob/main/docs/helm-configuration.md)
- [Kata Containers GitHub 仓库](https://github.com/kata-containers/kata-containers)
- [发布说明(版本与硬件要求)](https://github.com/kata-containers/kata-containers/tree/main/docs/releases)
