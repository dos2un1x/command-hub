krew
===

kubectl插件的包管理器

## 补充说明

**krew命令** 是 Kubernetes SIG CLI 维护的 **kubectl 插件管理器**,官方描述是「Krew helps you discover and install `kubectl` plugins on your machine」。

它解决的问题很朴素:kubectl 从 v1.12 起支持插件机制 —— 只要 `PATH` 里有一个叫 `kubectl-foo` 的可执行文件,就能用 `kubectl foo` 调用它。但插件散落在各自的 GitHub 仓库里,安装方式五花八门(下载二进制、解压、改权限、放进 PATH、命名成特定格式)。krew 把这套流程标准化:**一条命令安装、一条命令升级、一条命令卸载**。官方 README 提到,目前索引里有 **200 多个插件**。

它管的是插件本身,和集群没有任何关系:

```shell
krew 装的是你本机 ~/.krew/bin 下的可执行文件
集群里不会多出任何组件,也不会创建任何 CRD
```

在这批工具里的分工:

```shell
krew         安装与管理 kubectl 插件本身 —— 本页
tilt         内循环开发(可用 krew 安装)
telepresence 把本地进程接入远程集群(可用 krew 安装)
kubescape    可用 krew 安装的扫描工具之一
```

当前版本 **v0.5.0(2026-02-26)**。krew 是个小而稳定的工具,发布节奏本来就慢,七个月没有新版本属于正常状态,不代表停止维护。v0.5.0 的更新包括 netrc 认证支持、Go 1.25 升级与 CI 提速。

### 安装

官方**只提供一种安装方式**:下载 release 包再执行自安装。**没有 git clone 安装法** —— git 只是 Windows 下的前置依赖。

macOS / Linux(bash 或 zsh):

```shell
(
  set -x; cd "$(mktemp -d)" &&
  OS="$(uname | tr '[:upper:]' '[:lower:]')" &&
  ARCH="$(uname -m | sed -e 's/x86_64/amd64/' -e 's/\(arm\)\(64\)\?.*/\1\2/' -e 's/aarch64$/arm64/')" &&
  KREW="krew-${OS}_${ARCH}" &&
  curl -fsSLO "https://github.com/kubernetes-sigs/krew/releases/latest/download/${KREW}.tar.gz" &&
  tar zxvf "${KREW}.tar.gz" &&
  ./"${KREW}" install krew
)
```

Windows:确保装了 git,从 Releases 页下载 `krew.exe`,**以管理员身份**打开 `cmd.exe` 后执行 `.\krew install krew` —— 因为 krew 需要创建符号链接。

安装完把 krew 的 bin 目录加进 PATH,**这一步不会自动完成**:

```shell
# bash / zsh
export PATH="${KREW_ROOT:-$HOME/.krew}/bin:$PATH"

# fish
set -gx PATH $PATH $HOME/.krew/bin

# Windows:把 %USERPROFILE%\.krew\bin 加进 PATH
```

```shell
# 重启 shell 后验证
kubectl krew
```

支持的平台以 release 资产为准:`darwin_amd64`、`darwin_arm64`、`linux_amd64`、`linux_arm`、`linux_arm64`、`linux_ppc64le`、`windows_amd64`。**没有 `windows_arm64`,也没有 `linux_s390x`。**

兼容性要求只有一句:**kubectl v1.12 或更高**。krew **没有**发布过受支持的 kubectl 版本对照表,别去找。

包管理器(Homebrew 等)也有 krew,但官方明确说「exist but are not actively supported at this time」。

### 语法

```shell
kubectl krew [command]
```

```shell
kubectl krew install NAME [NAME...]   安装一个或多个插件
kubectl krew list                     列出已安装插件
kubectl krew search [NAME]            搜索可用插件
kubectl krew info NAME                查看插件详情(版本、平台、说明)
kubectl krew update                   更新本地插件索引
kubectl krew upgrade [NAME...]        升级插件(不带参数则升级全部)
kubectl krew uninstall NAME           卸载插件
kubectl krew outdated                 列出有新版本的插件
kubectl krew version                  查看 krew 自身版本
kubectl krew index list               列出已配置的索引
kubectl krew index add NAME URL       添加自定义索引
kubectl krew index remove NAME        移除索引
```

`install` 与 `upgrade` 的常用参数:

```shell
--no-update-index            跳过索引刷新
--enable-netrc               用 netrc 文件做认证(v0.5.0 新增)
--netrc-file                 指定 netrc 路径,默认 ~/.netrc
```

```shell
# 从文件批量安装(每行一个插件名)
kubectl krew install < plugins.txt

# 从自定义索引安装
kubectl krew install myindex/my-plugin

# 从本地或远程 manifest 安装
kubectl krew install --manifest=plugin.yaml
kubectl krew install --manifest-url=https://example.com/plugin.yaml
```

### 插件的命名规则

**插件名叫 `foo`,就用 `kubectl foo` 调用** —— 不带 `krew` 前缀。安装完成后 krew 会提示用法。

机制上,krew 会在 bin 目录里创建一个名为 `kubectl-foo`(Windows 上是 `kubectl-foo.exe`)的符号链接,名字取自 manifest 里的 `metadata.name`。

两个命名相关的坑:

```shell
1. 插件名里的短横线会被自动转成下划线
   插件 view-logs → 链接叫 kubectl-view_logs

2. Windows 上只支持 .exe 入口
   .bat 与 .ps1 都不支持
```

### 安全模型:插件是任意可执行文件

**这是使用 krew 最需要理解的一点。** 官方在安装与升级插件时会打印这样一段提示(原文):

```shell
You installed plugin "<name>" from the krew-index plugin repository.
   These plugins are not audited for security by the Krew maintainers.
   Run them at your own risk.
```

添加自定义索引时的提示(原文):

```shell
You have added a new index from "<url>"
The plugins in this index are not audited for security by the Krew maintainers.
Install them at your own risk.
```

这两段话的含义很直接:

```shell
krew 只做分发,不做审计
插件是在你本机以你的身份运行的普通可执行文件
它能读你的 kubeconfig,能访问你的所有集群,能读写你的文件系统
```

所以「用 krew 装插件」这个动作的安全等级,等同于「从网上下一个二进制直接运行」。krew 官方索引的准入是**逐个案例讨论决定**的,并没有公开的正式准入标准 —— 这本身也是一个治理层面的现实。

### 常用工作流

```shell
# 先刷新索引
kubectl krew update

# 找插件
kubectl krew search
kubectl krew search ctx

# 看清楚再装:确认版本、来源、平台
kubectl krew info ctx

# 安装
kubectl krew install ctx ns

# 使用(直接作为 kubectl 子命令)
kubectl ctx
kubectl ns

# 看哪些插件有新版本
kubectl krew outdated

# 升级全部
kubectl krew upgrade

# 卸载
kubectl krew uninstall ctx
```

### 插件 manifest

想自己开发或用自定义 manifest 安装插件,需要一份 `plugin.yaml`:

```shell
apiVersion: krew.googlecontainertools.github.com/v1alpha2
kind: Plugin
metadata:
  name: foo                  # 必须与文件名一致:foo.yaml
spec:
  version: v1.0.0            # 语义化版本,必须以 v 开头
  shortDescription: 一句话说明
  description: |
    更详细的说明,会显示在 krew info 里。
  homepage: https://example.com/foo
  platforms:
  - selector:
      matchLabels:
        os: linux
        arch: amd64
    uri: https://example.com/foo-linux-amd64.tar.gz
    sha256: <校验和>
    bin: ./foo               # 压缩包内可执行文件的路径
    files:
    - from: ./foo
      to: .
```

必填字段:`apiVersion`、`kind`、`metadata.name`(且必须与 manifest 文件名一致)、`spec.version`(带 `v` 前缀)、`spec.shortDescription`、`spec.description`、`spec.platforms`。平台选择器可用 `matchLabels`(`os` / `arch`)或 `matchExpressions`。

**要进入官方索引,需要向 `kubernetes-sigs/krew-index` 仓库提 PR。** 官方对是否接纳某个插件的说法是「evaluated on a case-by-case basis」,没有公开的量化标准;被拒绝的插件可以走自定义索引分发。

### 注意

1. **插件没有经过安全审计,装了就等于信任作者**。官方提示原文是「These plugins are not audited for security by the Krew maintainers. Run them at your own risk.」插件以你的身份运行,拿到的是你 kubeconfig 的全部权限 —— 包括生产集群的 `cluster-admin`。装之前看一眼仓库的活跃度与作者,别把 krew 当应用商店。
2. **自定义索引风险更高**。官方对自定义索引的措辞同样是「not audited」,而且任何人都能起一个索引。加索引前确认来源可信。
3. **PATH 没配好会一直报警告**。如果 bin 目录不在 `PATH` 里,krew 每次执行都会打印设置提示。安装完记得改 shell 配置文件并重启 shell。
4. **`kubectl krew upgrade` 不带参数会升级所有插件,包括 krew 自己**。krew 本身也是默认索引里的一个插件(名字就叫 `krew`),所以 `kubectl krew upgrade krew` 可以单独升级它。CI 环境里要注意「升级全部」可能带来意料之外的行为变化。
5. **`kubectl krew upgrade` 不支持 `INDEX/PLUGIN` 写法**。安装时可以用 `kubectl krew install myindex/my-plugin`,但升级时只能写插件名。
6. **用 `--manifest` 装的插件不会自动升级**。这类插件被标记为 `detached`,`kubectl krew upgrade` 会打印「Skipping upgrade for ... because it was installed via manifest」并**静默跳过**。想让它们保持最新只能手工重装。
7. **插件名里的短横线会被改写**。插件 `view-logs` 生成的链接是 `kubectl-view_logs` —— 调用时要写 `kubectl view_logs` 而不是 `kubectl view-logs`。这个改写是自动的,写错了会提示找不到命令。
8. **移除自定义索引前要先卸掉来自它的插件**。否则会失败,除非加 `--force`(官方说明「not recommended」)。强行移除后那些插件会变成孤儿。
9. **`install` 与 `upgrade` 会顺带刷新索引**,除非显式加 `--no-update-index`。在离线或受限网络里这一步会卡住或报错,记得加上这个参数。
10. **krew 会定期联网检查自身新版本**。大约 40% 的调用会去查询 GitHub 上的最新 tag 并提示升级,可用环境变量 `KREW_NO_UPGRADE_CHECK` 关掉。开发构建会跳过这个检查。
11. **没有 git clone 安装法,也没有 kubectl 版本对照表**。网上流传的 `git clone ... && make install` 不是官方方式;官方也没有发布过「krew 版本 × kubectl 版本」的兼容矩阵,只保证 kubectl v1.12+。
12. **Windows 需要管理员权限,且只认 `.exe`**。安装时要管理员开 `cmd.exe`(创建符号链接需要);插件入口只支持 `.exe`,`.bat` / `.ps1` 都不行。
13. **平台覆盖不全**。没有 `windows_arm64`,也没有 `linux_s390x`。这些平台上无法用官方方式安装 krew。
14. **入库没有公开的量化标准**。官方对索引准入的表述是逐案评估。自己开发插件时不要预设「满足某几条就能进」,被拒可以走自定义索引。

### 相关命令

- `kubectl` — Kubernetes集群管理工具,插件机制的基础
- `k9s` — 终端 UI,也常通过 krew 分发
- `kubescape` — 可用 krew 安装的安全扫描工具
- `tilt` — 内循环开发工具
- `telepresence` — 把本地进程接入远程集群
- `kube-linter` — 清单 lint 工具

### 参考链接

- [krew 官方文档](https://krew.sigs.k8s.io/)
- [安装 krew](https://krew.sigs.k8s.io/docs/user-guide/setup/install/)
- [插件 manifest 说明](https://krew.sigs.k8s.io/docs/developer-guide/plugin-manifest/)
- [krew GitHub 仓库](https://github.com/kubernetes-sigs/krew)
- [krew-index 插件索引](https://github.com/kubernetes-sigs/krew-index)
- [kubectl 插件机制](https://kubernetes.io/docs/tasks/extend-kubectl/kubectl-plugins/)
