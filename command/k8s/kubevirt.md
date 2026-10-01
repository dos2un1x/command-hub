kubevirt
===

在Kubernetes中以Pod形式运行和管理虚拟机的虚拟化扩展

## 补充说明

**KubeVirt** 让 Kubernetes 能调度虚拟机。它把 QEMU/KVM 进程包进一个普通 Pod(`virt-launcher`),再通过 CRD 把「虚拟机」这个概念接进 Kubernetes 的声明式模型 —— 于是虚拟机也能吃上滚动更新、调度约束、网络与存储抽象。

项目自 **2019 年进入 CNCF Sandbox、2022 年 4 月晋升 Incubating**,截至 2026 年仍在 Incubating 阶段并公开推进毕业流程(已完成安全审计)。当前版本线为 `v1.x`,v1.9.0 发布于 2026-07-30,v1.8 发布于 2026-03-25。发布节奏大约每季度一个大版本。

它的典型用途:

```shell
- 把存量 VMware / OpenStack 虚拟机迁到 Kubernetes 上统一管理
- 需要完整内核能力、无法容器化的工作负载(旧系统、特定内核模块)
- 多租户场景下的强隔离(配合 KVM 硬件虚拟化)
- 在同一个平台上同时编排容器与虚拟机,共享网络与存储
```

### 核心对象

API group 为 **`kubevirt.io/v1`**,主要类型:

```shell
VirtualMachine (vm)                      虚拟机的【声明】,类似 Deployment
VirtualMachineInstance (vmi)             一次【运行实例】,类似 Pod
VirtualMachineInstanceReplicaSet         批量管理 VMI
VirtualMachinePool                       池化 / 弹性副本
VirtualMachineInstanceMigration          迁移请求
VirtualMachineExport                     导出磁盘
```

`VirtualMachine` 与 `VirtualMachineInstance` 的关系和 `Deployment` 与 `Pod` 完全对应:VM 是期望状态(关机就是关机),VMI 是实际运行的进程。**关机后 VMI 消失但 VM 还在** —— 这是与 Pod 最大的心智差异。

CDI(Containerized Data Importer)提供磁盘导入能力,API group 是 `cdi.kubevirt.io/v1beta1`:

```shell
DataVolume          对 PVC 的封装,支持从 HTTP/S3/Registry/PVC 导入镜像
DataSource
StorageProfile
```

### 安装

```shell
# 1. 取最新稳定版本号
export RELEASE=$(curl -s https://storage.googleapis.com/kubevirt-prow/release/kubevirt/kubevirt/stable.txt)

# 2. 先装 Operator,再装 CR 触发实际部署
kubectl apply -f https://github.com/kubevirt/kubevirt/releases/download/${RELEASE}/kubevirt-operator.yaml
kubectl apply -f https://github.com/kubevirt/kubevirt/releases/download/${RELEASE}/kubevirt-cr.yaml

# 3. 等待就绪
kubectl -n kubevirt wait kv kubevirt --for condition=Available
```

所有组件部署在 **`kubevirt` 命名空间**。安装前提:

```shell
- kube-apiserver 需要 --allow-privileged=true
- 容器运行时支持 containerd 或 CRI-O
- 节点需要硬件虚拟化(/dev/kvm);没有 KVM 时只能用软件模拟
```

没有 `/dev/kvm` 的环境(如某些嵌套虚拟化场景)可以开启模拟:

```shell
kubectl edit -n kubevirt kubevirt kubevirt
```

```shell
spec:
  configuration:
    developerConfiguration:
      useEmulation: true
```

**模拟模式性能会下降一个数量级,只适合功能验证,不能用于生产。**

### 一个最小虚拟机

```shell
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: testvm
spec:
  runStrategy: Halted
  template:
    metadata:
      labels:
        kubevirt.io/size: small
        kubevirt.io/domain: testvm
    spec:
      domain:
        devices:
          disks:
            - name: containerdisk
              disk:
                bus: virtio
            - name: cloudinitdisk
              disk:
                bus: virtio
          interfaces:
            - name: default
              masquerade: {}
        resources:
          requests:
            memory: 64M
      networks:
        - name: default
          pod: {}
      volumes:
        - name: containerdisk
          containerDisk:
            image: quay.io/kubevirt/cirros-container-disk-demo
        - name: cloudinitdisk
          cloudInitNoCloud:
            userDataBase64: SGkuXG4=
```

几个要点:

```shell
containerDisk   镜像随 Pod 生命周期存在,【不持久化】,VM 重启数据就没了
                 适合一次性测试;生产要用 DataVolume / PVC
masquerade      通过 NAT 让 VM 走 Pod 网络,是最常用的接口类型
                 需要固定 IP / 直通网卡时改用 bridge 或 SR-IOV
```

带持久化磁盘的写法用 `dataVolumeTemplates`:

```shell
apiVersion: kubevirt.io/v1
kind: VirtualMachine
metadata:
  name: myvm
spec:
  runStrategy: Always
  dataVolumeTemplates:
    - metadata:
        name: myvm-root
      spec:
        source:
          http:
            url: "https://download.cirros-cloud.net/0.6.2/cirros-0.6.2-x86_64-disk.img"
        storage:
          resources:
            requests:
              storage: 2Gi
  template:
    spec:
      domain:
        devices:
          disks:
            - name: root
              disk:
                bus: virtio
      volumes:
        - name: root
          dataVolume:
            name: myvm-root
```

### 启动策略

`spec.runStrategy` 决定 VM 的生命周期行为(**与 `spec.running` 互斥,只能用一个**):

```shell
Always           始终保持运行,意外退出后重建
RerunOnFailure   非零退出码时重启;正常关机后保持停止
Once             只运行一次
Halted           不运行(需要时手工 start)
Manual           完全手工控制
```

老版本常用的 `running: true/false` 仍然可用,但语义不如 `runStrategy` 精细,新写的清单建议用后者。

### virtctl 常用子命令

`virtctl` 是 KubeVirt 的配套 CLI:

```shell
virtctl start myvm                         启动 VM
virtctl stop myvm                          关机(优雅)
virtctl stop myvm --force                  强制关机
virtctl restart myvm                       重启
virtctl pause / unpause myvm               暂停 / 恢复
virtctl console myvm                       串口控制台
virtctl vnc myvm                           VNC(需要本地 viewer)
virtctl ssh <user>@myvm                    SSH
virtctl expose vm myvm --name svc --port 22   暴露为 Service
virtctl migrate myvm                       触发实时迁移
virtctl image-upload dv mydv --image-path=./disk.img --size=2Gi
virtctl addvolume / removevolume myvm      热插拔卷
virtctl guestosinfo myvm                   客户机信息
virtctl create vm ...                      用命令行生成 VM 清单
```

### 实时迁移

把运行中的 VM 从一台节点挪到另一台,期间业务不中断:

```shell
virtctl migrate myvm

# 观察迁移状态
kubectl get vmi myvm -o jsonpath='{.status.migrationState}'
kubectl get vmim -n <namespace>
```

前提条件比较硬:

```shell
1. 磁盘必须支持在多个节点同时挂载  → ReadWriteMany(RWX)或支持多挂载的块存储
   仅 RWO 的本地盘 / 普通云盘【无法迁移】
2. VMI 的 LiveMigratable condition 必须为 True
   kubectl get vmi myvm -o jsonpath='{.status.conditions[?(@.type=="LiveMigratable")]}'
3. 目标节点要有足够资源,且调度约束允许
4. 迁移网络带宽要够 —— 迁移靠【内存拷贝】,VM 内存越大越慢
   内存热增长过快时迁移可能一直无法收敛
```

### 排障

```shell
# 总览
kubectl get vm,vmi -A
kubectl get dv,pvc -A          # CDI 数据卷

# VM 起不来的第一步:看 VMI 的事件与条件
kubectl describe vmi myvm
kubectl get vmi myvm -o yaml | grep -A30 "conditions:"

# 真正的 QEMU 进程日志在 virt-launcher Pod 里
kubectl get pods -n <namespace> | grep virt-launcher
kubectl logs -n <namespace> virt-launcher-myvm-xxxxx
kubectl logs -n <namespace> virt-launcher-myvm-xxxxx -c compute

# 直接进容器看 QEMU 进程
kubectl exec -it virt-launcher-myvm-xxxxx -- ps aux | grep qemu

# KubeVirt 组件自身状态
kubectl -n kubevirt get pods
kubectl -n kubevirt logs -l kubevirt.io=virt-controller
```

### 注意

1. **没有 `/dev/kvm` 就只能模拟运行**。这是最常见的「VM 起来了但极慢」的原因。先确认节点真的支持硬件虚拟化:`kubectl exec` 进 Pod 检查 `/dev/kvm` 是否存在,宿主机上 `lsmod | grep kvm` 是否有输出。
2. **`containerDisk` 不持久化**。它把镜像塞在 Pod 里,VM 重启(重建 Pod)后数据全部丢失。除了一次性验证,一律用 `DataVolume` / PVC。
3. **本地盘与 RWO 存储上的 VM 无法实时迁移**。`LiveMigratable=False` 时 `virtctl migrate` 会直接失败。要做迁移能力规划,存储侧必须支持 `ReadWriteMany`,这是采购阶段就要确认的事,事后改很贵。
4. **VM 关机 ≠ 删除**。`virtctl stop` 之后 VMI 消失,`kubectl get pods` 里看不到东西,但 `kubectl get vm` 里 VM 仍然存在,对应的 PVC 也还在。想彻底删除要显式 `kubectl delete vm`,并单独处理 PVC。
5. **`runStrategy` 与 `running` 不能同时设置**。两个字段互斥,同时写会被 API 拒绝。老清单里是 `running: false`,新清单建议统一用 `runStrategy`。
6. **`useEmulation` 是调试开关,不是降级方案**。开启后 CPU 指令要软件翻译,性能下降可达一个数量级,且部分特性(如嵌套虚拟化、特定 CPU 特性)不可用。
7. **迁移依赖足够的内存带宽**。VM 内存写入速率超过迁移速率时,迁移永远追不上,会一直处于 `Migrating` 状态直到超时回滚。生产迁移前应确认网络是万兆以上,并避开内存压力大的时段。
8. **KubeVirt 的虚拟机不是「安全边界更弱的 Pod」**。`virt-launcher` 是特权 Pod,在有 KVM 的前提下隔离性来自硬件虚拟化;但没有 KVM、走纯模拟时,隔离性大幅下降,不要把它当作多租户强隔离方案。
9. **`kubevirt` CR 与 Operator 的版本要匹配**。Operator 与 CR 由两个不同 manifest 提供,升级时两者必须一起更新;只更新其中一个会出现组件版本错配,典型症状是 CR 一直不 `Available`。
10. **virtctl 的版本要与集群侧对齐**。virtctl 是**客户端**工具,它的命令集随版本变化。集群是 v1.9 而本地 virtctl 是 v1.4 时,部分子命令会不存在或行为不一致。用 `virtctl version` 对比。
11. **KubeVirt 尚未 CNCF 毕业**。虽然社区热度高、生产案例多,但截至 2026 年仍是 Incubating 项目。把它作为核心基础设施时,应对「毕业时间不确定」这一点有预期。
12. **别把 KubeVirt 当成「容器跑不起来就用它」的兜底**。它的运维复杂度(存储、网络、迁移、镜像导入)显著高于容器,只有当工作负载**确实需要完整内核或无法容器化**时才是正确的选择。

### 相关命令

- `kubectl` — 管理 KubeVirt 的 CRD 资源
- `crictl` — 排查 virt-launcher 容器
- `csi` — 虚拟机磁盘依赖的存储能力
- `multus` — 虚拟机多网卡与直通网络
- `kube-scheduler` — 决定 virt-launcher Pod 落在哪个节点

### 参考链接

- [KubeVirt 官方网站](https://kubevirt.io/)
- [KubeVirt 用户指南](https://kubevirt.io/user-guide/)
- [KubeVirt API 参考](https://kubevirt.io/api-reference/)
- [安装指南](https://kubevirt.io/user-guide/cluster_admin/installation/)
- [CDI 项目](https://github.com/kubevirt/containerized-data-importer)
