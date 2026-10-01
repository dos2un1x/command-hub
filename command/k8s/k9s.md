k9s
===

终端下的Kubernetes集群交互式管理工具

## 补充说明

**k9s命令** 是一个基于终端的 Kubernetes 集群管理 UI。它把 `kubectl get`、`describe`、`logs`、`exec` 等高频操作变成了可键盘驱动的实时视图,资源变化会自动刷新,不必反复敲命令。

k9s 本身不做任何集群操作之外的事情 —— 它读取 kubeconfig、调用 Kubernetes API,权限完全由当前上下文和 RBAC 决定。因此它既是日常运维的效率工具,也是排查问题时的「资源浏览器」。

主要能力:

- 实时浏览所有内置资源与 CRD,支持全命名空间聚合视图
- 一键 describe / 编辑 / 查看日志 / 进入容器 / 删除
- 内置日志跟随、多容器切换、全屏查看
- 支持插件(plugins.yaml)把自定义命令挂到快捷键上
- 支持换肤(skins)、别名(aliases)、自定义快捷键(hotkeys)

### 安装

```shell
# macOS / Linux (Homebrew)
brew install derailed/k9s/k9s

# 官方脚本
curl -sS https://webinstall.dev/k9s | bash

# 通过 Krew 安装(kubectl 插件管理器)
kubectl krew install k9s

# Go 安装
go install github.com/derailed/k9s@latest

# 下载预编译二进制(GitHub Releases)
curl -LO https://github.com/derailed/k9s/releases/latest/download/k9s_Linux_amd64.tar.gz
tar -zxvf k9s_Linux_amd64.tar.gz
sudo mv k9s /usr/local/bin/
k9s version

# Windows
scoop install k9s
choco install k9s
```

### 语法

```shell
k9s [flags]
k9s [command]
```

```shell
k9s info           显示配置文件路径、日志目录等环境信息
k9s version        查看版本
k9s help           帮助
k9s completion     生成 shell 自动补全脚本
```

常用启动参数:

```shell
k9s                                     # 使用默认上下文
k9s -n kube-system                      # 指定命名空间
k9s -A                                  # 直接进入全命名空间视图
k9s --context=prod-cluster              # 指定 kubeconfig 上下文
k9s --kubeconfig=/path/to/config        # 指定 kubeconfig 文件
k9s --readonly                          # 只读模式,禁止一切写操作
k9s --headless                          # 无头部信息栏
k9s --logoless                          # 启动时不显示 logo
k9s --splashless                        # 跳过启动动画
k9s --crumbsless                        # 隐藏左上角面包屑
k9s --command pod                       # 启动后直接进入某个资源视图
k9s --request-timeout=30s               # API 请求超时
```

### 交互操作

进入 k9s 后所有操作都通过单键完成:

```shell
:            进入命令模式,输入资源名切换视图,如 :pod / :svc / :deploy
?            显示当前视图的可用快捷键
/            按关键字过滤当前列表(支持正则)
Esc          清除过滤
0            切换「全部命名空间」与「当前命名空间」
j / k        上下移动(方向键同样可用)
Enter        进入下一层,如从 Deployment 进入其 Pod
d            查看 describe 详情
y            查看资源 YAML
e            编辑资源(调用 $K9S_EDITOR)
l            查看日志(支持滚动跟随)
s            进入容器 Shell
a            附加(attach)到容器
x            解码 Secret 内容
Ctrl-D       删除资源(需确认)
Ctrl-K       Kill 资源
Space        标记多个资源后批量操作
q            返回上一层 / 退出
```

命令模式下的资源别名(部分):

```shell
:po / :pod        Pod
:svc              Service
:deploy           Deployment
:sts              StatefulSet
:ds               DaemonSet
:cj / :job        CronJob / Job
:ns               Namespace
:no               Node
:cm / :sec        ConfigMap / Secret
:pv / :pvc        PersistentVolume / PersistentVolumeClaim
:ing / :ep        Ingress / Endpoints
:sa / :rb / :crb  ServiceAccount / RoleBinding / ClusterRoleBinding
:ev               Event
:ctx              kubeconfig 上下文切换
:xray deploy      查看 Deployment 的资源依赖关系树
:pulse            集群总体健康状态
```

### 配置文件

配置目录默认为 `~/.config/k9s/`,可用 `K9S_CONFIG_DIR` 覆盖:

```shell
~/.config/k9s/config.yaml     主配置(刷新间隔、日志行数、默认视图等)
~/.config/k9s/aliases.yaml    自定义资源别名
~/.config/k9s/hotkeys.yaml    自定义快捷键
~/.config/k9s/plugins.yaml    插件定义
~/.config/k9s/views.yaml      各视图的默认排序与列
~/.config/k9s/skins/          皮肤文件
```

```shell
# config.yaml 常用片段
k9s:
  liveViewAutoRefresh: true
  refreshRate: 2
  ui:
    skin: dracula
    enableMouse: false
    headless: false
  logger:
    tail: 200
    buffer: 500
  thresholds:
    cpu:
      critical: 90
      warn: 70
    memory:
      critical: 90
      warn: 70
```

```shell
# plugins.yaml:把自定义命令挂到快捷键上
plugins:
  debug-pod:
    shortCut: Ctrl-L
    description: 用临时容器调试
    scopes:
    - pods
    command: kubectl
    args:
    - debug
    - -it
    - $NAME
    - -n
    - $NAMESPACE
    - --image=busybox
    - --target=$NAME
```

### 常用环境变量

```shell
KUBECONFIG=/path/to/config     指定 kubeconfig
K9S_CONFIG_DIR=~/.k9s          自定义配置目录
K9S_EDITOR=vim                 指定按 e 时调用的编辑器
K9S_LOGS_DIR=~/.k9s/logs       k9s 自身日志目录
K9S_SKIN=dracula               指定皮肤
```

### 注意

1. **k9s 是真实可写的**。按 `e` 编辑、`Ctrl-D` 删除都会直接作用于集群,误操作代价很高。生产环境建议用 `k9s --readonly` 启动。
2. `Ctrl-D` 删除资源默认会弹出确认框,但删除 Namespace、PVC 等会级联清理数据,确认前务必看清对象。
3. k9s 的权限就是当前 kubeconfig 的权限,`--readonly` 只禁止 UI 侧操作,**不会**降低 API 层的权限。
4. 编辑资源调用 `K9S_EDITOR`(默认 `vim`),保存后立即 apply。若 YAML 不合法,k9s 会报错但集群状态保持不变。
5. 配置目录在不同版本间是**向下兼容但不向上兼容**的,升级 k9s 后若启动异常,可先删除 `~/.config/k9s/config.yaml` 让其重新生成。
6. 资源视图的刷新频率由 `refreshRate`(秒)控制,集群规模很大时调得过小会显著增加 API Server 压力。
7. `:xray`、`:popeye` 等高级视图需要额外安装对应工具(popeye)或依赖较新的 k9s 版本。
8. Windows 下需要终端支持 ANSI 色彩,建议使用 Windows Terminal,旧版 cmd 会出现乱码。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `kubeadm` — Kubernetes集群安装工具
- `minikube` — 本地Kubernetes开发环境
- `kind` — 用 Docker 运行本地集群

### 参考链接

- [k9s 官方文档](https://k9scli.io/)
- [k9s GitHub 仓库](https://github.com/derailed/k9s)
- [k9s 快捷键说明](https://k9scli.io/topics/commands/)
- [k9s 插件与配置](https://k9scli.io/topics/plugins/)
