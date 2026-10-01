confidential-containers
===

在 Kubernetes 上运行机密容器,用硬件 TEE 保护内存中的敏感数据

## 补充说明

**Confidential Containers(CoCo)** 是 CNCF 的**孵化(Incubating)项目**——由 CNCF 技术监督委员会投票通过,**2026-07-22 正式晋升为孵化项目**(此前自 2021 年起处于 Sandbox)。它解决的是一个普通容器运行时解决不了的问题:

```shell
普通容器   信任节点、信任云厂商、信任运维;root 能读走容器内存里的一切
机密容器   不信任节点与云厂商;内存被 CPU 硬件加密,只有 guest 内部能解密
```

具体做法是:**用 Kata Containers 把 Pod 放进轻量虚拟机**(获得 VM 级隔离),再让这个 VM 跑在硬件 TEE(可信执行环境)里,由 CPU 对内存加密。这样一来,宿主机上的 root、hypervisor、甚至云厂商的运维,都无法读取 Pod 内存中的明文。

它服务于一个明确的合规与信任场景:**跨信任边界的敏感计算**——多方联合分析、把模型或密钥交给不完全信任的算力方、受监管数据出境前的处理。如果数据始终在自有可控的机房与自己的运维手里,CoCo 带来的收益有限,而复杂度与性能开销是实打实的。

### 硬件依赖

CoCo 的"机密"来自硬件,**没有硬件就没有机密性**:

```shell
Intel TDX                     Intel 平台,需要较新的服务器 CPU 与固件支持
AMD SEV-SNP                   AMD 平台,同样需要对应固件与 BIOS 配置
IBM Secure Execution          IBM Z / LinuxONE(s390x)
Intel SGX                     通过 enclave-cc 走进程级 enclave 路线
CoCo without Hardware         无硬件,仅用于测试与开发流程打通,不提供真实保护
```

官方硬件页给出的就是上面这四条主机配置路径(SE、SNP、SGX、TDX),以及一条「无硬件」的开发路径。**ARM CCA 目前没有独立的主机配置文档,不要假设可以直接使用**。

### 架构

```shell
Kata Containers               VM 隔离层,CoCo 的运行时基础(runtime-rs)
guest components              VM 内的组件,负责镜像解密、attestation 代理等
Trustee                       证明与密钥分发组件,含两个核心服务:
                                KBS   Key Broker Service,保管密钥
                                AS    Attestation Service,校验证明
attestation                   用 CPU 签名的度量值证明 VM 里跑的是预期镜像与配置
image-rs / ocicrypt           加密镜像的解密与拉取
```

工作流程大致是:Pod 被调度到机密节点 → 拉起带 TEE 的 VM → guest 侧收集硬件度量并生成证明 → Trustee 校验证明是否匹配参考值 → 通过后释放镜像解密密钥与业务密钥 → 容器启动。

**关键点:镜像必须加密,机密性才成立**。否则节点上的任何人都能直接拉取并解包镜像,VM 内存加密只保护了运行期的一部分。

### 安装

CoCo 的部署方式已经从早期的 Operator 迁移到 **Helm chart**(官方文档在 2026-01 完成了这轮替换),chart 以 OCI 制品发布:

```shell
helm install coco oci://ghcr.io/confidential-containers/charts/confidential-containers \
  --namespace coco-system \
  --create-namespace

# 钉住版本(示例)
helm install coco oci://ghcr.io/confidential-containers/charts/confidential-containers \
  --version 0.18.0 \
  --namespace coco-system --create-namespace

# 等待就绪
kubectl get pods -n coco-system --watch
```

验证与卸载:

```shell
kubectl get runtimeclass

helm uninstall coco --namespace coco-system
kubectl delete namespace coco-system
```

### RuntimeClass

CoCo 复用 Kata 的 RuntimeClass 体系,按硬件与架构区分:

```shell
kata-qemu-coco-dev / kata-qemu-coco-dev-runtime-rs   无 TEE 的开发/测试模式
kata-qemu-snp                                        AMD SEV-SNP
kata-qemu-tdx                                        Intel TDX
kata-qemu-nvidia-gpu-snp / kata-qemu-nvidia-gpu-tdx   GPU + TEE
kata-qemu-se / kata-qemu-se-runtime-rs               IBM Secure Execution(s390x)
kata-remote                                          peer-pods 模式
```

用机密运行时跑一个 Pod:

```shell
apiVersion: v1
kind: Pod
metadata:
  name: coco-demo
spec:
  runtimeClassName: kata-qemu-coco-dev
  containers:
    - name: app
      image: registry.example.com/app:latest
```

先拿 `kata-qemu-coco-dev` 把流程跑通,再切到真实的 TEE 运行时类。

### peer-pods

`kata-remote` 对应 **peer-pods** 模式:把 Pod 的虚拟机放到云厂商提供的沙箱 VM 上运行,集群节点自己不需要虚拟化能力,也不需要装 TEE。它解决的是「托管 Kubernetes 拿不到裸金属与嵌套虚拟化」的问题,代价是网络路径变长、与云厂商能力绑定。

### 与 Kata Containers 的关系

CoCo **构建在 Kata 之上**,而不是另起一套运行时:

```shell
Kata 提供    VM 隔离、独立 guest 内核、OCI/CRI 兼容、RuntimeClass 体系
CoCo 叠加    TEE 内存加密、attestation、加密镜像解密、密钥托管
```

因此 CoCo 的运维约束与 Kata 高度重合:需要虚拟化能力(或 peer-pods)、每个 Pod 一份 guest 内核、启动延迟高于普通容器。**先确认 Kata 能在你的节点上跑起来,再谈 CoCo**。

### 密钥与镜像加密流程

```shell
1) 构建阶段   镜像加密(ocicrypt 等),加密密钥不上传到镜像仓库
2) 分发阶段   加密后的镜像推到任意仓库,仓库管理员也看不到明文
3) 调度阶段   Pod 带 RuntimeClass 落到机密节点,拉起带 TEE 的 VM
4) 证明阶段   guest 收集硬件度量,生成 attestation token 发给 KBS
5) 校验阶段   Trustee 用参考值与证书链校验,确认运行环境与预期一致
6) 释放阶段   校验通过后 KBS 释放镜像解密密钥与业务密钥
7) 运行阶段   guest 内解密镜像并启动容器,密钥不出 TEE
```

**第 5 步的参考值是整套方案的信任锚点**:它由你自己维护,记录「合法运行环境长什么样」。参考值过宽等于没有校验,过窄则每次升级内核或组件都要更新。这部分流程要有明确的变更管理。

### 什么时候值得用

```shell
值得用
  数据或模型的提供方与算力提供方不是同一个信任主体
  合规要求明确写了"云厂商不可见""内存加密""可证明的运行环境"
  多方联合分析,各方都不愿意把明文交给对方

不值得用
  数据始终在自己可控的机房与自己运维的节点上
  只是想要"更强的容器隔离" —— 那应该用 Kata 或 gVisor
  只是想要"镜像保密" —— 那应该用镜像加密 + 私有仓库访问控制
```

### 注意

1. **TEE 是硬件的,买不到就是没有**。Intel TDX 与 AMD SEV-SNP 需要特定代次的服务器 CPU、主板与固件支持,并且**必须在 BIOS/UEFI 里显式开启**。云上要选明确标注为 confidential VM 的机型;通用机型上装完 chart 也只会退化成 `kata-qemu-coco-dev`(无 TEE)。
2. **官方 chart 不配置宿主机内核、固件与系统**。文档写得很清楚:Helm chart 只负责集群侧组件,主机的内核参数、固件配置、TEE 驱动要按各平台的 host setup 文档手工处理。上线前必须先单独验证「这台节点能不能启动机密 VM」。
3. **`kata-qemu-coco-dev` 没有任何机密性**。它是给开发与 CI 用的流程验证模式,内存不加密、attestation 也不校验。**在生产里用它等于自欺欺人**,必须有 CI 检查阻止这种误用。
4. **没有加密镜像,就没有机密性**。镜像必须在构建阶段加密,密钥由 KBS 在 attestation 通过后释放。明文镜像在节点上可被任意读取,VM 内存加密保护不了它。这是 CoCo 落地中最容易被忽略、也最容易让整套方案失效的一环。
5. **attestation 的信任链需要预先准备**。Trustee 需要**参考值**(reference values,即预期镜像与配置的度量值)才能判断证明是否可信,还需要可信的证书链验证 CPU 签名。参考值没配置或过期,表现是「证明通不过、密钥拿不到、容器起不来」,而且错误信息往往只说是 attestation 失败。
6. **请以官方支持的 TEE 清单为准**。硬件页当前列出的是 IBM Secure Execution、AMD SEV-SNP、Intel SGX、Intel TDX;ARM CCA 只在站点的标签体系里出现,没有对应的主机配置文档。跨平台能力差异很大,选型前先确认你的目标平台在支持列表里。
7. **GPU 机密计算是另一个复杂度层级**。NVIDIA 的机密计算需要 H100 及以上的 CC 模式机型,且证明要走独立通道(NRAS 等)。kata-deploy 提供了 `kata-qemu-nvidia-gpu-snp`、`kata-qemu-nvidia-gpu-tdx` 这类运行时类,但 GPU 侧的恢复、度量与验证流程最好按厂商的参考架构来做,而不是自己拼。
8. **性能开销是真实存在的**。VM 隔离 + 内存加密 + 远程 attestation + 镜像解密,启动延迟与运行开销都明显高于普通容器。适合少数高敏感工作负载,不适合全集群铺开。
9. **早期版本用 Operator,新版本用 Helm**。CoCo 曾长期通过 CoCo Operator 部署,官方在 2026-01 把文档全面切换到 Helm chart。**网上大量教程仍在教 Operator 的装法**,那些内容已经过时,照抄会遇到组件不匹配的问题。
10. **版本节奏很快,约每 6 周一个 release**。组件版本之间(Kata、guest components、Trustee、chart)有配套关系,**不要混搭不同 release 的组件**。升级时按官方 release note 的配套矩阵整体升级。
11. **排障比普通容器难得多**。失败可能发生在任意一环:节点没有 TEE、固件没开、参考值不对、镜像没加密、KBS 不可达、网络策略挡住了 attestation 流量。而且**关键日志在 guest 内部**,节点侧看不到。部署前要先把这几层的可观测性建起来,否则出问题只能靠猜。
12. **节点侧的运维能力被有意限制**。CoCo 的威胁模型假定节点管理员不可信,所以设计上就限制了集群管理员影响机密工作负载的能力——这会在排障、监控、调试时带来不便,是有意为之而非 bug。评估时要把这部分运维成本算进去。
13. **起步资源要求不高,但别按最低配规划**。官方给的无硬件基线是至少 8GB 内存、4 核;真实的机密计算节点还需要额外内存用于加密与度量,以及 TEE 自身的内存开销(部分平台会给整块内存加密带来不可忽略的损耗)。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `helm` — Kubernetes包管理器
- `kata-containers` — CoCo 的运行时基础
- `gvisor` — 不依赖虚拟化的另一种强隔离方案
- `securitycontext` — 容器安全字段
- `pod-security-admission` — 特权工作负载的准入控制
- `cosign` — 镜像签名,与加密镜像配合使用
- `trivy` — 镜像漏洞扫描

### 参考链接

- [Confidential Containers 官方文档](https://confidentialcontainers.org/docs/)
- [硬件要求与主机配置](https://confidentialcontainers.org/docs/getting-started/prerequisites/hardware/)
- [Helm 安装](https://confidentialcontainers.org/docs/getting-started/installation/)
- [Trustee(证明与密钥分发)](https://confidentialcontainers.org/docs/attestation/)
- [CoCo Helm Charts 仓库](https://github.com/confidential-containers/charts)
- [CNCF 孵化公告](https://www.cncf.io/blog/?_sft_lf-project=confidential-containers)
