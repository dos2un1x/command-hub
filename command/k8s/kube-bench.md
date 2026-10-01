kube-bench
===

CIS Kubernetes安全基线自动检查工具

## 补充说明

**kube-bench命令** 是 Aqua Security 开源的安全合规检查工具,用于验证 Kubernetes 集群是否按照 **CIS Kubernetes Benchmark**(互联网安全中心发布的 Kubernetes 安全配置基线)完成了加固。

它的工作方式是**读取节点上的实际配置并与基线逐条比对**:

- 读取控制平面组件的**进程命令行参数**(如 `--anonymous-auth`、`--authorization-mode`)
- 检查**配置文件与证书文件的权限**(如 `/etc/kubernetes/manifests`、etcd 数据目录)
- 检查 **kubelet 配置**与容器运行时配置
- 检查 **RBAC 策略**等集群内对象

每条检查有三种结果:

```shell
[PASS]  符合基线要求
[FAIL]  不符合基线要求,存在安全风险
[WARN]  需要人工判断,工具无法自动断言
```

kube-bench **只做检测,不做修复**。输出中的 remediation 只是修复建议的文本,需要运维人员自行评估后执行。

支持的平台基线(用 `--benchmark` 指定):

```shell
cis-1.24 / cis-1.23 / cis-1.20 / ...     原生 Kubernetes 的 CIS 基线
eks-1.2.0 / eks-1.5.0 / eks-1.8.0        Amazon EKS
gke-1.2.0 / gke-1.6.0 / gke-1.8.0        Google GKE
aks-1.0 / aks-1.7 / aks-1.8              Azure AKS
ack-1.0                                  Alibaba Cloud ACK
k3s-cis-1.24 / rke2-cis-1.24 / rke-cis-1.24   轻量发行版
rh-1.0 / rh-1.4                          Red Hat OpenShift
```

### 安装

```shell
# 方式一:下载二进制(GitHub Releases)
curl -L https://github.com/aquasecurity/kube-bench/releases/download/v0.10.0/kube-bench_0.10.0_linux_amd64.tar.gz \
  -o kube-bench.tar.gz
tar -xvf kube-bench.tar.gz
sudo mv kube-bench /usr/local/bin/
kube-bench version

# 方式二:容器运行(无需在宿主机安装)
docker run --rm --pid=host \
  -v /etc:/etc:ro -v /var:/var:ro \
  -t docker.io/aquasec/kube-bench:latest --version 1.31

# 方式三:把二进制与配置安装到宿主机再执行
docker run --rm -v $(pwd):/host docker.io/aquasec/kube-bench:latest install
sudo ./kube-bench

# 方式四:以 Kubernetes Job 运行(结果在 Pod 日志里)
kubectl apply -f https://raw.githubusercontent.com/aquasecurity/kube-bench/main/job.yaml
kubectl logs -f job/kube-bench

# 托管集群专用 Job
kubectl apply -f https://raw.githubusercontent.com/aquasecurity/kube-bench/main/job-eks.yaml
kubectl apply -f https://raw.githubusercontent.com/aquasecurity/kube-bench/main/job-gke.yaml
kubectl apply -f https://raw.githubusercontent.com/aquasecurity/kube-bench/main/job-aks.yaml
```

### 语法

```shell
kube-bench [flags]
kube-bench [command]
```

```shell
kube-bench            直接运行,自动检测 Kubernetes 版本与节点角色
kube-bench run        显式指定要执行的检查目标
kube-bench install    把二进制与配置文件安装到当前目录
kube-bench version    查看版本
kube-bench help       帮助
```

### 常用参数

```shell
--targets / -s        指定检查目标,逗号分隔
--benchmark           手动指定 CIS 基线版本,如 cis-1.24、eks-1.2.0
--version             手动指定 Kubernetes 版本,默认自动检测
--check / -c          只执行指定编号的检查,如 "1.1.1,1.1.2"
--group / -g          执行某个分组下的全部检查,如 "1.1"
--skip                跳过指定编号的检查,逗号分隔
--scored              执行计分项(默认 true)
--unscored            执行非计分项(默认 true)
--json                以 JSON 格式输出
--junit               以 JUnit 格式输出
--outputfile          把 --json / --junit 的结果写入文件
--noremediations      不输出修复建议
--noresults           不输出逐条结果,只看汇总
--nosummary           不输出汇总
--nototals            不输出各类结果的统计总数
--include-test-output 失败时打印实际值
--exit-code           有检查失败时返回的退出码,默认 0
--config              指定 config.yaml 路径
--config-dir / -D     指定配置目录,默认 ./cfg/
--pgsql               结果写入 PostgreSQL
--asff                结果发送到 AWS Security Hub
```

检查目标(`--targets`)的取值与配置目录下的 YAML 文件名对应:

```shell
master          控制平面节点的主检查(API Server 等)
controlplane    控制平面附加检查(CIS 1.5 起有效)
etcd            etcd 相关检查
node            工作节点检查(写 worker 会被自动转换为 node)
policies        Pod 安全策略等集群内对象检查
managedservices 托管服务检查(仅 GKE 等基线)
```

### 常用操作

```shell
# 默认运行:自动检测版本,按节点角色执行对应检查
sudo kube-bench

# 只查控制平面
sudo kube-bench run --targets master,controlplane

# 只查工作节点
sudo kube-bench run --targets node

# 查 etcd
sudo kube-bench run --targets etcd

# 指定基线版本(集群版本较新、自动映射不准时)
sudo kube-bench run --benchmark cis-1.24 --targets master,node

# 只跑单条检查,快速验证某个加固项是否生效
sudo kube-bench run --check 1.1.1
sudo kube-bench run --check "1.1.1,1.1.2,1.2.1"

# 跑某个分组(如 1.1 代表 API Server 组)
sudo kube-bench run --group 1.1

# 跳过已知不影响业务的检查项
sudo kube-bench run --skip "1.3.2,4.2.6"

# 只看失败项(结合 jq)
sudo kube-bench --json | jq '.Controls[] | .tests[] | select(.status=="FAIL") | {test_number, test_desc}'

# 生成 JSON / JUnit 报告供流水线归档
sudo kube-bench --json --outputfile kube-bench.json
sudo kube-bench --junit --outputfile kube-bench.xml

# CI 中使用:有失败即返回非零退出码
sudo kube-bench --exit-code 1 --noremediations > /dev/null

# 只跑计分项(跳过需要人工判断的非计分项)
sudo kube-bench --scored=true --unscored=false

# 只跑非计分项
sudo kube-bench --scored=false --unscored=true
```

### 在集群中以 Job 运行

```shell
# 标准 Job(默认检测工作节点)
kubectl apply -f job.yaml
kubectl get pods -w
kubectl logs job/kube-bench

# 控制平面节点需要 nodeSelector + tolerations 才能调度上去
kubectl apply -f job-master.yaml
kubectl logs job/kube-bench-master

# 保存报告
kubectl logs job/kube-bench > kube-bench-report-$(date +%F).txt

# 用完清理
kubectl delete -f job.yaml
```

OpenShift 需要额外授予特权 SCC:

```shell
oc adm policy add-scc-to-user privileged --serviceaccount default -n kube-bench
```

### 注意

1. **必须以 root 或特权方式运行**。kube-bench 要读取 `/etc/kubernetes`、`/var/lib/kubelet` 以及进程列表,容器方式运行时**必须加 `--pid=host`**,并把 `/etc`、`/var` 以只读方式挂载进去,否则大量检查会因无法读取而误报 FAIL。
2. **托管集群无法检查控制平面**。EKS、GKE、AKS、ACK 的 Master 节点由云厂商托管,既不能调度 Job 也不开放 SSH,只能用 `--benchmark eks-1.2.0` 这类专用基线检查**工作节点**,控制平面部分需向云厂商索取合规报告。
3. **`FAIL` 不等于漏洞**。基线是通用最佳实践,部分检查项与业务架构冲突(如开启审计日志会带来存储与性能成本)。评估时应结合 `WARN` 与业务实际逐条确认。
4. **进程参数类检查在配置文件管理参数时会误报**。当 API Server 参数由 `--config` 指定的配置文件提供时,`ps` 看不到具体参数,kube-bench 可能报 FAIL,需要人工核对 `/etc/kubernetes/manifests/kube-apiserver.yaml`。
5. **kube-bench 只检测不修复**。输出里的 remediation 是文本建议,不会执行任何变更;请勿直接把建议无脑套用到生产集群。
6. **`--version` 与 `--benchmark` 互斥**。同时指定会直接报错,只需给其中一个。
7. **CIS 基线版本与 Kubernetes 版本不是一一对应**。新版本 Kubernetes 可能还没有对应的 CIS 基线,kube-bench 会自动映射到最近的可用基线,并可能在输出中提示版本不匹配。
8. **`--exit-code` 默认是 0**,意味着即使存在 FAIL,命令仍返回成功。放进 CI 流水线时必须显式指定,如 `--exit-code 1`。
9. **升级 Kubernetes 后必须重新跑一遍**。基线中与版本绑定的检查项会变化,旧报告不能代表新集群的安全状态。
10. 建议**固定 kube-bench 版本与基线版本**并在报告中记录,便于跨时间对比;基线配置更新频繁,不同版本的结果不可直接横向比较。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kubeadm` — Kubernetes集群安装工具
- `rbac` — 基于角色的访问控制
- `serviceaccount` — 服务账户与 Pod 身份

### 参考链接

- [kube-bench GitHub 仓库](https://github.com/aquasecurity/kube-bench)
- [kube-bench 运行方式文档](https://github.com/aquasecurity/kube-bench/blob/main/docs/running.md)
- [CIS Kubernetes Benchmark](https://www.cisecurity.org/benchmark/kubernetes/)
- [kube-bench 平台支持列表](https://github.com/aquasecurity/kube-bench/blob/main/docs/platforms.md)
