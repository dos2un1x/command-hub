kube-hunter
===

Kubernetes集群安全弱点自查工具(已停止开发)

## 补充说明

> **项目状态:已停止开发,不建议在新项目中继续使用。** kube-hunter 的仓库 README 明确写着「kube-hunter is not under active development anymore」,官方给出的替代方案是 **Trivy** 的 Kubernetes 配置扫描与 KBOM 漏洞扫描。最后一个小版本 **0.6.8 发布于 2022 年 5 月**,仓库自 2024 年 3 月起没有实质更新,其内置的漏洞知识库也不会再跟进新的 Kubernetes 版本。若目标是持续性的安全检查,请直接使用 `trivy`;本文保留 kube-hunter 的用法,主要供已在使用旧流水线的团队查阅,以及理解「从攻击者视角看集群暴露面」这一思路。

**kube-hunter** 是 Aqua Security 开源的集群安全弱点扫描器,用于**在自己的集群上**做一次「如果我是攻击者,我能看到什么、能走到哪一步」的自查。它与 kube-bench 互补:kube-bench 逐条比对 CIS 基线文本,kube-hunter 则从网络与服务出发,主动发现暴露的端口、匿名可访问的接口和过宽的权限。

它的核心价值在**视角**:以 Pod 内身份、以节点身份、或以一个只能访问网络的匿名身份去探测,把「配置弱点」还原成「实际可达的攻击路径」。

三种扫描位置:

```shell
远程扫描(remote)   从集群外扫描 API Server、kubelet、etcd 等暴露端口
节点扫描(node)     在节点上执行,扫描本机网络接口与本地服务
Pod 内扫描(pod)    在集群内以普通 Pod 身份运行,看到的是「攻陷一个容器后能到达的范围」
```

结果按四类组织:

```shell
Vulnerabilities   可被直接利用的漏洞,需要优先处置
Weaknesses        配置弱点,单独看不致命,组合起来可能构成攻击链
Services          探测到的开放服务与端口,用于理解暴露面
Nodes             发现的主机及其角色
```

### 安装

```shell
# 方式一:pip 安装(需要 Python 3.x)
pip install kube-hunter
kube-hunter --help

# 隔离环境安装(推荐,避免污染系统 Python)
pipx install kube-hunter

# 方式二:容器运行(自带全部依赖)
docker run -it --rm --network host aquasec/kube-hunter
docker run --rm aquasec/kube-hunter --cidr 192.168.0.0/24

# 方式三:源码运行
git clone https://github.com/aquasecurity/kube-hunter.git
cd kube-hunter
pip install -r requirements.txt
./kube-hunter.py --help
```

### 语法

```shell
kube-hunter [options]
```

不接任何参数时会进入交互式菜单,让你选择扫描方式;脚本化使用时请显式给出目标参数。

### 常用参数

```shell
--remote <host>      扫描指定的远程主机(IP 或域名),默认端口 443/6443 等
--cidr <网段>        扫描整个网段,如 192.168.0.0/24
--interface          扫描本机所有网卡所在的网段
--pod                以 Pod 内身份扫描,自动发现集群节点(权限受限的视角)
--active             启用主动模式:尝试利用发现的漏洞以获得更深的信息
--quick              把网段扫描限制在 /24,用于云上按 Pod 出网场景
--list               列出全部可执行的检查项(配合 --active 可看主动检查项)
--mapping            只输出节点与服务的网络拓扑图
--log <级别>         日志级别:DEBUG / INFO(默认)/ WARNING
--report <格式>      结果格式
--dispatch <方式>    结果投递方式:stdout(默认)/ http
```

HTTP 投递通过环境变量配置:

```shell
KUBEHUNTER_HTTP_DISPATCH_URL=https://collector.example.com/ingest
KUBEHUNTER_HTTP_DISPATCH_METHOD=POST
```

### 被动模式与主动模式

```shell
# 被动(默认):只做探测与只读查询,不会改变集群任何状态
kube-hunter --remote 10.0.0.10
kube-hunter --cidr 10.0.0.0/24
kube-hunter --pod

# 主动:发现弱点后会尝试利用,可能创建/修改集群内对象
kube-hunter --active --remote 10.0.0.10
```

官方对主动模式的描述是「can potentially do state-changing operations on the cluster」。**主动模式只能在你自己拥有、且允许被破坏的测试集群上使用**,绝不要对着生产集群或任何不属于你的集群运行。

### 常用操作

```shell
# 从外部看 API Server 暴露了什么(最常用的第一次扫描)
kube-hunter --remote api.example.com

# 扫描整个内网网段,找出所有暴露的 6443 / 10250 / 2379
kube-hunter --cidr 10.0.0.0/24 --log WARNING

# 只看网络拓扑,先摸清有多少节点、开了哪些端口
kube-hunter --cidr 10.0.0.0/24 --mapping

# 在集群内以普通 Pod 身份自查:攻陷一个容器后能走多远
kube-hunter --pod

# 列出全部检查项,配合自建的加固清单做核对
kube-hunter --list

# 在测试集群上做主动验证(高风险,仅限自有测试环境)
kube-hunter --active --cidr 10.0.0.0/24

# 把结果投递到集中采集端
KUBEHUNTER_HTTP_DISPATCH_URL=https://collector.example.com/ingest \
  kube-hunter --cidr 10.0.0.0/24 --dispatch http
```

### 在集群内以 Job 运行

这是最贴近真实攻击者视角的方式:以一个使用默认 ServiceAccount 的普通 Pod 运行,看它能发现什么。

```shell
# 应用官方 Job 清单
kubectl apply -f https://raw.githubusercontent.com/aquasecurity/kube-hunter/main/job.yaml

# 或者克隆仓库后使用本地清单
git clone https://github.com/aquasecurity/kube-hunter.git
cd kube-hunter
kubectl create -f ./job.yaml

# 查看结果(结果写在容器标准输出)
kubectl describe job kube-hunter
kubectl get pods -l job-name=kube-hunter
kubectl logs <pod-name>

# 清理
kubectl delete -f ./job.yaml
```

Job 默认不带 `--active`。`--pod` 模式下 kube-hunter 会使用挂载进容器的 ServiceAccount Token 做 API 调用 —— 这也正是它的意义所在:如果这个默认身份的权限过大,扫描结果会直接暴露出来。建议把它部署在**独立的命名空间**里,不要用 `default`,更不要给它挂 `cluster-admin`。

### 结果解读与修复

把扫描输出当作待办清单,常见条目与对应的修复方向:

```shell
Kubelet 匿名认证开启(10250 未鉴权)
  → 在 kubelet 配置中设置 authentication.anonymous.enabled: false
  → 同时把 authorization.mode 设为 Webhook

Kubelet 只读端口 10255 暴露
  → 该端口已在新版本移除;老集群应在启动参数中显式关闭 read-only port

API Server 允许匿名请求
  → 移除 --anonymous-auth=true,或在 --anonymous-auth=false 下重启 apiserver

Dashboard / 其他控制台未鉴权可访问
  → 不对外暴露,或接入统一身份认证并收紧 RBAC

暴露等权限过宽(默认可写、能建 Pod、能读 Secret)
  → 用 kubectl auth can-i --list --as=system:serviceaccount:<ns>:<sa> 核对实际权限
  → 按最小权限重建 Role/ClusterRole,参照 rbac 页面的做法

etcd 2379 对外可达
  → etcd 只监听内网/本地,启用客户端证书认证

容器可以挂载宿主机目录 / 以特权运行
  → 施加 Pod Security Admission 的 baseline 或 restricted 级别
```

修复完**必须重跑一遍验证**,而不是改完即认为闭环。

### 卸载清理

```shell
pip uninstall kube-hunter
pipx uninstall kube-hunter

# 清掉集群内留下的 Job 与 Pod
kubectl delete job kube-hunter -n <命名空间>
```

### 注意

1. **只能扫自己的集群**。这一点在官方 README 中有明确告诫。对不属于你的集群做端口扫描与漏洞探测,在多数司法辖区属于未授权访问,可能承担法律责任。本文所有用法都限定在自有集群的安全自查场景。
2. **项目已停止开发**。最后一个小版本是 2022 年 5 月的 0.6.8,知识库不会跟进新的 Kubernetes 版本;用它扫出来的「未发现问题」不能作为安全结论。新项目请使用 Trivy。
3. **`--active` 会改变集群状态**。它会尝试利用已发现的弱点(例如匿名创建 Pod)来深入探测,可能留下残留对象甚至造成服务中断。生产集群**永远不要**开主动模式;确需验证时,请在可随时销毁的测试集群里进行。
4. **被动模式的「未发现漏洞」不等于安全**。被动扫描只覆盖网络可达性与只读接口,无法发现 RBAC 设计缺陷、镜像漏洞、供应链问题。
5. **扫描结果里 `Vulnerabilities` 与 `Weaknesses` 要区别对待**。前者是可直接利用的路径,应作为阻断项立即处理;后者多为配置项,需要结合业务判断。把两者混作一堆会淹没真正紧急的条目。
6. **`--cidr` 网段扫描会产生大量流量**,可能触发云厂商的告警或网络 ACL 限流。生产网段上执行前应先与网络团队确认窗口,优先用 `--quick` 限制在 /24。
7. **`--remote` 的默认端口有限**,自建的非标准端口(如把 apiserver 映射到 8443)可能扫不到,需要结合 `--mapping` 与手工确认。
8. **容器镜像内的工具版本是固定的**。`aquasec/kube-hunter` 镜像长期未更新,其中的知识库停留在 2022 年,新版本 Kubernetes 的默认配置可能已与它的判断标准不符,容易产生误报或漏报。
9. **不要在 CI 中把它当作门禁**。它是探测工具,没有稳定的退出码语义和结构化输出契约,不适合做流水线卡点;kube-bench 的 `--exit-code` 与 Trivy 的 `--exit-code` 才是为此设计的。
10. **扫描动作本身会被审计**。如果集群已开启审计日志,Pod 内扫描会产生大量 `create`、`list` 请求并可能触发安全告警,提前告知值班同学可以避免误判为入侵。
11. **它不替代 kube-bench**。两者视角不同:kube-bench 对照 CIS 基线做配置合规检查,kube-hunter 从可达性出发找暴露面,自查时应两者都跑并交叉比对。

### 相关命令

- `kube-bench` — CIS 安全基线检查(活跃维护,推荐)
- `trivy` — 官方推荐的替代工具,覆盖配置与 KBOM 漏洞扫描
- `kubectl` — Kubernetes集群管理工具
- `rbac` — 核对扫描发现的过宽权限
- `pod-security-admission` — 收敛容器特权,减少可达的攻击面

### 参考链接

- [kube-hunter GitHub 仓库](https://github.com/aquasecurity/kube-hunter)
- [kube-hunter 使用文档](https://aquasecurity.github.io/kube-hunter/)
- [kube-hunter 漏洞知识库索引](https://aquasecurity.github.io/kube-hunter/kbindex.html)
- [Trivy Kubernetes 扫描(官方推荐的替代方案)](https://trivy.dev/latest/docs/target/kubernetes/)
- [kube-hunter 的 PyPI 发布页](https://pypi.org/project/kube-hunter/)
