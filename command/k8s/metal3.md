metal3
===

用Kubernetes原生方式把物理服务器纳管为集群节点的裸金属管理项目

## 补充说明

**Metal3**(读作 metal cubed)把物理服务器变成 Kubernetes 里的一类资源。它的核心主张是:**裸金属的发现、巡检、供电、装机和回收,都应该像管理 Pod 一样,用声明式 API 完成。**

项目于 **2025-08-27 被 CNCF 接纳为 Incubating 项目**(此前长期处于 Sandbox),2026 年社区活跃度明显上升,并公开讨论毕业路线。底层硬件操作全部交给 **OpenStack Ironic** —— Metal3 不重复造轮子,而是把 Ironic 包进 Kubernetes 控制器里。

组件构成:

```shell
baremetal-operator (BMO)          核心控制器,实现 BareMetalHost 的调谐
Ironic + Ironic Python Agent      实际的带外管理、装机、巡检
dnsmasq / DHCP / TFTP             PXE 装机网络(用虚拟介质时可省)
cluster-api-provider-metal3       把 Metal3 接进 Cluster API(CAPM3)
ironic-image                      官方打包好的 Ironic 容器镜像
```

社区把纯 Metal3(不带 Cluster API)称为 **BMO 模式**,配合 Cluster API 使用则是 **CAPM3 模式**。前者适合已有集群、只想纳管几台机器;后者用于从零声明式地拉起整集群。

### BareMetalHost

这是 Metal3 最核心的 CRD,API group 为 **`metal3.io/v1alpha1`**,一台物理机对应一个对象:

```shell
apiVersion: metal3.io/v1alpha1
kind: BareMetalHost
metadata:
  name: node-0
  namespace: metal3
spec:
  # 带外管理地址,协议前缀决定走哪种 BMC 协议
  bmc:
    address: ipmi://192.168.111.1:6230
    credentialsName: node-0-bmc-secret

  # 装机用的 MAC —— 必须是【真实网卡的 MAC】,不是 BMC 的
  bootMACAddress: 00:1b:2c:3d:4e:5f

  # 是否纳管电源状态;false 时 BMO 不碰这台机器
  online: true

  # 要装到机器上的镜像
  image:
    url: http://192.168.111.1/images/rhcos.qcow2
    checksum: http://192.168.111.1/images/rhcos.qcow2.md5sum
    # checksumType: sha256 / sha512（md5 已废弃）

  # 首次启动配置,各自引用一个 Secret
  userData:
    name: node-0-user-data
    namespace: metal3
  networkData:
    name: node-0-network-data
    namespace: metal3

  # 自动化磁盘清理:metadata（默认）/ disabled
  automatedCleaningMode: metadata

  # 指定装到哪块盘
  rootDeviceHints:
    deviceName: /dev/sda
```

`bmc.address` 的协议前缀是判断拓扑的关键:

```shell
ipmi://      传统带外管理,端口一般是 6230
redfish://   Redfish(现代服务器主流),支持虚拟介质
redfish-virtualmedia://   通过 BMC 挂载 ISO 装机,【不需要 PXE 网络】
idrac://     Dell 专用
irmc://      Fujitsu
```

### 状态机

`status.provisioning.state` 是排查问题的第一现场:

```shell
""（空）                  刚创建,尚未确定走向
unmanaged                 未提供 BMC 地址或凭据,无所作为;operationalStatus 为 discovered
externally provisioned    由别的工具装好（spec.externallyProvisioned: true）,只接管电源
registering               正在用 BMC 凭据验证连通性
inspecting                启动 IPA 内存系统巡检硬件,结果写回 status.hardware
preparing                 配置 RAID、BIOS 固件等
available                 就绪可装机（等待 spec.image 被填上）
provisioning              正在写入镜像并做首次启动配置
provisioned               镜像已写好,机器正在运行它
deprovisioning            正在清除原有镜像
powering off before delete 删除前先断电
deleting                  断电完成,记录即将被移除
```

`status.operationalStatus` 则是健康度摘要,取值为 `OK`、`discovered`、`error`、`delayed`、`detached`。

巡检完成后,硬件详情会出现在 `status.hardware` 里:

```shell
kubectl get bmh node-0 -n metal3 -o jsonpath='{.status.hardware}' | python3 -m json.tool

# 包含
cpu.arch / cpu.count
hostname
ramMebibytes
nics[].ip / nics[].name / nics[].mac
storage[].name / storage[].sizeBytes / storage[].type / storage[].serialNumber / storage[].hctl
```

### 常用操作

```shell
# 查看所有裸金属主机与状态
kubectl get bmh -n metal3
kubectl get bmh -A -o wide

# 看单台的详情与事件
kubectl describe bmh node-0 -n metal3

# 只看状态机
kubectl get bmh node-0 -n metal3 -o jsonpath='{.status.provisioning.state}{"\n"}'

# 看巡检出的硬件
kubectl get bmh node-0 -n metal3 -o jsonpath='{.status.hardware}'

# 触发重新巡检
kubectl annotate bmh node-0 -n metal3 \
  inspect.metal3.io=disabled --overwrite
kubectl annotate bmh node-0 -n metal3 inspect.metal3.io-

# 暂时停止调谐（维护机器时用,不会丢状态）
kubectl annotate bmh node-0 -n metal3 \
  baremetalhost.metal3.io/paused="" --overwrite

# 断电 / 上电
kubectl patch bmh node-0 -n metal3 --type=merge -p '{"spec":{"online":false}}'

# 查看控制器日志
kubectl logs -n metal3 -l name=baremetal-operator -f
kubectl logs -n metal3 -l name=ironic -f
```

### 与 Cluster API 的关系(CAPM3)

要在 Cluster API 体系里用裸金属,需要 **cluster-api-provider-metal3**,它提供:

```shell
Metal3Cluster          描述集群与 API Endpoint
Metal3Machine          一台机器的声明,最终会创建对应的 BareMetalHost
Metal3MachineTemplate  MachineDeployment 用的模板
Metal3DataTemplate     网络与元数据的模板
Metal3Data             渲染后的网络数据 / 元数据
```

对应关系是:`Metal3Machine` → `BareMetalHost`。**CAPM3 会把 `Metal3Machine` 上的 `automatedCleaningMode` 同步到 BareMetalHost**,因此改清理策略应优先改 `Metal3MachineTemplate` 而不是逐个改 BMH。

清理模式的同步规则值得记住:

```shell
- Metal3MachineTemplate 上设置了值（metadata / disabled）→ 会同步到所有 Metal3Machine,再同步到 BMH
- 模板上【不设置】该字段 → 同步链断开,可以给单台机器设置不同策略
- BareMetalHost 上的默认值是 metadata
```

### 装机网络:两种模式

```shell
PXE 模式
  需要独立的 provisioning 网络 + DHCP + TFTP
  prebootExecutionEnvironment 由网卡固件发起
  依赖 bootMACAddress 正确,且该网卡能 PXE 启动

虚拟介质（VirtualMedia）模式
  通过 Redfish 等协议把 ISO 挂载为虚拟光驱
  【不需要】provisioning 网络,简化拓扑
  需要 BMC 支持虚拟介质,且 ISO 可被 BMC 访问到
```

选型判断:

```shell
机房网络能划出独立的 provisioning 网段  → PXE 更成熟
服务器都是较新的 Redfish 机型           → 虚拟介质更省事
混合机型                                → 只能逐机型选择,BMH 级别配置
```

### 注意

1. **`bootMACAddress` 必须是真实网卡的 MAC,不能填 BMC 的**。填错的表现是机器在 `provisioning` 状态卡住或反复重启,日志里能看到找不到启动设备。这是最常见的初装错误。
2. **BMC 凭据放在 Secret 里,BMH 只引用名字**。`credentialsName` 指向的 Secret 需要有 `username` 与 `password` 两个键,且必须与 BMH 在同一命名空间。
3. **`online: false` 并不等于「完全放手」**。它只影响电源管理;非 `unmanaged` 状态的机器仍会被控制器调谐。真正要暂停所有操作,应使用 pause 注解。
4. **`automatedCleaningMode` 默认是 `metadata`,会把磁盘清掉**。以为「只是装个机」却发现数据没了,多半是这个默认值导致的。保留数据的场景必须显式设为 `disabled`。
5. **清理失败会让删除流程永久卡住**。BMH 处于 `powering off before delete` 并不断重试时,通常需要先 `automatedCleaningMode: disabled` 再删除。这是硬件不配合时的标准绕行方式。
6. **改 `userData` / `networkData` 不会触发重新装机**。官方文档明确提示:只改这两个字段不会重启 provisioning,需要显式触发重新部署。否则会以为配置生效了,实际机器上还是旧数据。
7. **`md5` 校验和已废弃**。虽然仍可用,但不受 FIPS 140 支持,新配置应使用 `sha256` 或 `sha512`。
8. **`oci://` 镜像会忽略 `checksum` 字段**。使用 OCI 镜像时应按 digest 锁定版本,否则无法保证一致性。
9. **CDI/ISO 的可达性是一个独立的排查维度**。无论 PXE 还是虚拟介质,镜像 URL 必须能被**目标机器或 BMC** 访问到,而不是被你的运维机访问到。防火墙只开了运维网段是典型坑。
10. **Metal3 需要 BMC 网络的完整可达性**。BMO 要能连到每台机器的 BMC(通常 623/443 端口),Ironic 要能连到 provisioning 网段。网络规划错了一步,表现都是 `registering` 卡住。
11. **`status.hardware` 只有巡检后才存在**。刚建的 BMH 查硬件信息为空是正常的,需要等 `inspecting` 走完。巡检依赖 IPA 能正常启动并回调 Ironic。
12. **别把 Metal3 当作「装机脚本的替代品」**。它的价值在声明式与状态收敛,如果只是偶尔装几台机器,用 PXE + Cobbler/Ansible 的成本可能更低。Metal3 的复杂度只有在「机器数量多、生命周期频繁」时才划算。

### 相关命令

- `cluster-api` — CAPM3 的上层框架
- `kubectl` — 管理 BareMetalHost 等 CRD
- `crictl` — 排查 Ironic 容器
- `kured` — 节点重启编排,常与裸金属集群配合
- `kubeadm` — 装机完成后在节点上引导集群

### 参考链接

- [Metal3 官方网站](https://metal3.io/)
- [Metal3 用户手册](https://book.metal3.io/)
- [BareMetalHost 状态机](https://book.metal3.io/bmo/state_machine.html)
- [baremetal-operator 仓库](https://github.com/metal3-io/baremetal-operator)
- [CAPM3 文档](https://book.metal3.io/capm3/metal3machine.html)
- [Metal3 官方博客](https://metal3.io/blog/)
- [CNCF:认识新晋孵化的裸金属项目 Metal3](https://www.cncf.io/blog/2026/03/23/metal3-at-kubecon-cloudnativecon-europe-2026-meet-the-cncfs-freshly-incubated-bare-metal-project/)
