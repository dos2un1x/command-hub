telepresence
===

把本地进程接入远程Kubernetes集群的开发代理工具

## 补充说明

**telepresence命令** 是 CNCF Sandbox 项目(2018-05-15 进入 Sandbox,至今未晋升),采用 **Apache 2.0** 许可,**没有商业版、没有 license key、没有付费分层** —— 项目官方博客的说法是「free of charge — no seats, no paid tier, no feature gates」。这一点值得写在最前面,因为网上大量旧资料描述的「需要 Ambassador Cloud 账号」「Personal Intercept 属于付费档」等等,是 2022 年前后的历史形态,现在已经不适用。

它解决的问题和前面几个开发工具完全不同:

```shell
skaffold / tilt / devspace   把代码送进集群:构建镜像、部署、同步文件
telepresence                 把集群的流量送到你本机:代码根本不用进集群
```

用一句话概括工作方式:**在你本机创建一个虚拟网络接口,把集群流量路由进来;同时把一个「流量代理」注入到集群里的目标 Pod,由它把请求转发给跑在你笔记本上的进程。** 对集群的其他部分来说,服务照常在;对你来说,服务跑在本地,断点、IDE、热重载全都能用。

理解它有四个概念:

```shell
traffic-manager   集群侧组件,`telepresence helm install` 装一次,集群级
traffic-agent     注入到目标工作负载 Pod 里的代理,四种接入模式都由它承载
connect           在本机建立与集群的连接(虚拟网卡 + DNS)
attachment        一次「接入」,有四种模式:replace / intercept / wiretap / ingest
```

在这批工具里的分工:

```shell
skaffold    构建 + 部署流水线
tilt        Tiltfile + UI + Live Update
devspace    devspace.yaml + 双向文件同步
telepresence 把本地进程接入集群,不重建镜像、不部署 —— 本页
```

当前版本 **v2.31.2(2026-08-02)**,维护活跃(2026 年内发布了 2.27 到 2.31 多个版本,其中 2.31 是安全版本)。

### 安装

```shell
# Debian / Ubuntu(会同时安装 root 守护进程的 systemd 服务)
curl -fLO https://github.com/telepresenceio/telepresence/releases/latest/download/telepresence-linux-amd64.deb
sudo apt install ./telepresence-linux-*.deb

# Fedora / RHEL
curl -fLO https://github.com/telepresenceio/telepresence/releases/latest/download/telepresence-linux-amd64.rpm
sudo dnf install ./telepresence-linux-*.rpm

# Linux 手工二进制(不会装系统服务,后续操作会反复要求提权)
sudo curl -fL https://github.com/telepresenceio/telepresence/releases/latest/download/telepresence-linux-amd64 \
  -o /usr/local/bin/telepresence
sudo chmod a+x /usr/local/bin/telepresence
```

```shell
# macOS:官方提供签名并公证过的 .pkg 安装包
#   telepresence-darwin-amd64.pkg / telepresence-darwin-arm64.pkg

# Windows:setup.exe 或 zip;arm64 只有 zip
#   原因是 WinFSP 与 SSHFS-Win 没有 arm64 版本

# 卸载
sudo apt remove telepresence
sudo dnf remove telepresence
```

指定旧版本时,把下载地址里的 `latest/download` 换成 `vX.Y.Z` 即可。

### 语法

```shell
telepresence [command]
```

```shell
telepresence connect / quit     建立 / 断开与本机守护进程的连接
telepresence status             查看连接状态
telepresence list               列出工作负载及其接入状态
telepresence helm install       在集群里安装 traffic-manager
telepresence helm upgrade       升级 traffic-manager
telepresence helm uninstall     卸载 traffic-manager
telepresence intercept          接入:只改流量,远端容器继续运行
telepresence replace            接入:替换容器,接管它的全部流量
telepresence wiretap            接入:复制一份流量给你,不影响原服务
telepresence ingest             接入:只拿环境变量与卷,不碰流量
telepresence detach             解除接入
telepresence uninstall          卸载集群里的 agent
telepresence revoke             按 intercept ID 撤销一次接入
telepresence loglevel           临时调整各组件的日志级别
telepresence gather-logs        收集各处日志供排障
telepresence config             查看/修改客户端配置
telepresence compose            在容器化工作流中操作 compose
telepresence version            查看版本
```

全局参数:

```shell
--config string    客户端配置文件路径
--format string    输出格式:default / json / yaml / json-stream
--progress string  进度输出:auto / tty / plain / json / quiet
--use string       指定要使用的 kubeconfig 上下文
```

**注意:`telepresence leave` 是一个隐藏的、已废弃的命令。** 它是 `detach` 的旧名字,保留只为兼容老脚本,`--help` 里看不到它。当前动词是 **`telepresence detach`**。同样地,**`telepresence list`** 才是列出接入的命令 —— 不存在 `telepresence intercept list`。另外**`telepresence license` 不是子命令**,这个项目不需要 license。

### 安装集群侧组件

```shell
# 基础安装(CLI 内置了版本配套的 chart)
telepresence helm install

# 常用变体
telepresence helm install --values values.yaml
telepresence helm install --set logLevel=debug
telepresence helm install --namespace staging          # 默认命名空间是 ambassador
telepresence helm install --set nodeAgent.enabled=true # 启用特权 node-agent

# 升级 / 卸载
telepresence helm upgrade
telepresence helm uninstall
```

也可以直接用 Helm 装官方 OCI chart:

```shell
helm install --create-namespace --namespace ambassador traffic-manager \
  oci://ghcr.io/telepresenceio/telepresence-oss

helm upgrade --namespace ambassador --reuse-values traffic-manager \
  oci://ghcr.io/telepresenceio/telepresence-oss
```

安装 traffic-manager 需要集群管理员权限,或者在受限环境里走 RBAC-only 安装(`rbac.only=true`、`clientRbac.create=true`、`managerRbac.create=true`)。命名空间级的管理器可以通过 values 文件配置,但**重叠的命名空间集合会被拒绝**。

**默认命名空间是 `ambassador`** —— 这个名字源于项目最初由 Ambassador Labs 创建,现在虽然与该公司无关了,默认值一直没改。看着眼生别以为装错了。

### 四种接入模式

这是 2.30 之后的新模型,理解它比记命令更重要:

```shell
                流量去本机        远端容器       卷访问      多人同时用
replace         该容器全部        被移除         读写        否
intercept       匹配上的请求      继续运行       读写        可以(配合过滤)
wiretap         匹配请求的副本    继续运行       只读        可以
ingest          完全不碰流量      —              只读        可以
```

逐个说:

```shell
intercept   把发往某个服务端口的请求改道到你本机,远端容器继续跑。
            默认「接管该服务端口上的全部流量」—— 这是爆炸半径的来源。
replace     把目标容器从 Pod 里摘掉,它的全部流量都给你;接入结束时容器恢复。
            官方举的典型场景是消息队列消费者 —— 两个活跃消费者会互相抢消息。
wiretap     复制一份流量给你,集群侧完全不受打扰,远端服务照常接收并响应,
            你本机返回的响应会被丢弃。适合观察生产流量。
ingest      纯粹拿容器的环境变量与卷,不涉及任何流量,卷是只读的。
```

```shell
# intercept:默认接管该端口的全部流量
telepresence intercept my-app --port 8080

# 加上 HTTP 过滤,把影响范围收窄到自己
telepresence intercept my-app --port 8080 \
  --http-header 'x-dev=alice' --http-path-prefix '/api'

# 把远端环境变量导出到文件,并挂载远端的卷
telepresence intercept my-app --port 8080 \
  --env-file ~/my-app-intercept.env \
  --mount /tmp/my-app-mounts

# replace / wiretap / ingest
telepresence replace my-app
telepresence wiretap my-app --port 8080
telepresence ingest my-app

# 解除接入
telepresence detach
```

**关于「全局接入」与「个人接入」:** 这是**旧版术语**,当前文档里已经不再定义这两个词。它们要表达的需求 —— 「我只想接自己的请求,别影响同事」—— 现在由 **HTTP 过滤**实现,官方文档的措辞是「header-based personal intercepts (e.g. `x-user=alice`)」。

重要的参数:

```shell
-w, --workload        工作负载名(与资源名不同时使用)
-n, --namespace       命名空间
-p, --port            形如 [<本地端口>:]<标识符>,标识符可以是服务端口名或端口号
--address             监听地址,默认 127.0.0.1
--service --container --metadata key=value
--to-pod <端口>[/UDP] 额外把端口转发给被接入的 Pod
-e, --env-file        把远端环境变量写到文件
-j, --env-json        把远端环境变量写成 JSON
--env-syntax          环境变量格式:docker(默认)/ compose / sh / csh / cmd / json / ps
--mount               挂载,默认 "true";false 关闭,后缀 :ro 表示只读
--mechanism           默认 "tcp",可取值 tcp / http
--plaintext           与处理进程之间不用 TLS
--node-agent          用节点上的 agent 而不是注入 sidecar
```

HTTP 过滤参数:

```shell
--http-header        可重复,多个之间是「与」关系;支持 X-User-ID=dev123 与 curl 风格
--http-path-equal    路径完全匹配
--http-path-prefix   路径前缀匹配
--http-path-regex    路径正则匹配
                     --http-path-* 三者每次接入只能用其中一个
```

**注意:`--mechanism` 的值只有 `tcp` 和 `http`,而且 `http` 是自动设置的** —— 只要你给了任意 `--http-*` 过滤参数,CLI 就会把机制切成 `http`,不需要手写。网上关于「veth 与 tproxy 两种机制」的说法是错的,那不是接入机制;虚拟网卡是 `connect` 在本机建立的东西,和 `--mechanism` 无关。

另外这几个参数**在当前版本里不存在**,看到就别照抄:`--http-match`(已被三个 `--http-path-*` 取代)、`--to-namespace`(改用 `connect --namespace` / `--mapped-namespaces`)、`--env-secret`。

### 常用工作流

```shell
# 1. 连上集群(会创建虚拟网卡与 DNS)
telepresence connect

# 2. 看看有哪些工作负载可以接入
telepresence list

# 3. 接入
telepresence intercept my-app --port 8080 --env-file .env

# 4. 在本机跑起你的服务,它会收到集群流量
go run ./cmd/server

# 5. 收工
telepresence detach
telepresence quit
```

### 注意

1. **intercept 默认接管该服务端口上的全部流量**。官方原话是「takes all traffic on the targeted service port」。如果这个服务还有别的使用方(同事的联调环境、测试环境、甚至线上流量),他们的请求会一起打到你的笔记本上 —— 而你的进程可能正停在断点上。**这是 telepresence 最大的风险点。** 用它之前先确认:这个服务还有谁在用?生产流量会不会经过它?
2. **把影响收窄的正确方式是加 HTTP 过滤**。官方文档给的对照表里,「能否多人同时使用」这一行 replace 是「否」,intercept 是「Yes, with filters」。带上 `--http-header 'x-dev=alice'` 之后,只有携带该请求头的请求会到你这里,其余照常由集群处理。做联调就老老实实带过滤,别裸奔。
3. **接入会修改你的 Pod**。默认模式下 traffic-agent 是**注入到工作负载 Pod 里的 sidecar**,Pod 会被重建。这意味着:同一工作负载的其他使用者连接会断;有状态负载要格外小心。想避免改 Pod 可以走 `--node-agent`,但前提是 traffic-manager 安装时开了 `nodeAgent.enabled=true`。
4. **webhook 的 failurePolicy 决定了故障是「静默」还是「明显」**。默认是 `Ignore` —— 注入 webhook 不可达时,API Server 会放行未修改的 Pod,**接入会静默失效**,你看不出任何报错。改成 `Fail` 能让问题显式暴露,但代价是「webhook 不可达期间,该命名空间里所有工作负载都创建不出来」。这是个需要权衡的取舍,不是越严越好。
5. **EKS + Calico 环境下接入会超时**。控制平面够不到 webhook,sidecar 注入不上,表现为接入一直挂着没有结果。这是官方记录的已知组合问题。
6. **GKE 私有集群也有类似问题**。通常是防火墙挡了 traffic-manager 的 webhook 注入器访问 API Server —— 需要放通 master 节点到 TCP 8443,或者改 `agentInjector.webhook.port`。
7. **DNS 行为与直觉不同,在 macOS 上尤其明显**。Telepresence 连接后会建虚拟网卡并把集群流量路由进去,但 **macOS 上的 `dig` 之类的工具有自己的 DNS 客户端,会绕过系统解析器**,所以 `dig` 可能查不到集群里的名字。可靠的验证方式是 `dscacheutil -q host -a name <名字>`。别用 `dig` 的结果判断「DNS 没生效」。
8. **容器场景下 resolv.conf 不会被改写**。官方说明:在容器里运行时 telepresence 起了 53 端口的 DNS 服务,但**无法更新 bind mount 进去的 resolv.conf**,需要手工写入 `nameserver 127.0.0.1`。
9. **本地集群可能路由成环**。跑在 Docker 容器或虚拟机里的集群「probably has access to the host's network and gets confused when it is mapped」;此外删掉或不存在的 ClusterIP 会导致路由环路,需要靠 route-controller DaemonSet 缓解。
10. **Linux 上的挂载需要额外配置**。要在 `/etc/fuse.conf` 里放开 `user_allow_other`,把用户加入 fuse 组,然后重启。macOS 上建议用 FUSE-T 而不是 macFUSE,并注意**陈旧的 FUSE-T 挂载会让后续挂载全部失败**;报「Operation not permitted」时可能要给终端授予访问网络卷的权限。
11. **连接失败时先看 inotify 上限**。Linux 上如果日志出现「too many files open」,检查 `fs.inotify.max_user_instances` 而不是怀疑权限。
12. **直接调 Helm 时版本不能太旧**。用外部 `helm` 安装时,低于 3.11.3 会遇到「uncomparable type」之类的报错。官方建议 Helm 次版本不要比 CLI 内置的低超过两个。
13. **`-p/--port` 的写法有讲究**。标识符可以是端口名或端口号;配合 `--docker-run` 在非容器化守护进程上,形式会变成 `<本地端口>:<容器端口>[:<标识符>]`。`replace` 模式下 `--port` 默认是 `all`。
14. **接入产生的环境变量文件格式由 `--env-syntax` 决定**。默认是 docker 风格;要 `export` 形式的 shell 变量就选 `sh`。这个文件里含远端容器的环境变量,可能包含密钥,**别提交进版本库**。
15. **VPN 冲突是已知的复杂话题**。官方专门有一页讲 VPN 相关问题,常见表现是路由被判给 VPN 隧道导致集群地址不可达。用企业 VPN 时把这一页读完再动手。
16. **它不是「只读」工具**。`replace` 会摘掉容器,`intercept` 会改流量走向,`helm install` 会往集群装东西。对着生产集群跑之前,先确认自己连的是哪个 context。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `skaffold` — 构建与部署流水线
- `tilt` — 内循环开发工具
- `devspace` — 客户端开发工具,提供文件同步
- `kustomize` — Kubernetes声明式配置定制工具
- `helm` — Kubernetes包管理器

### 参考链接

- [Telepresence 官方文档](https://telepresence.io/docs/)
- [接入方式说明](https://telepresence.io/docs/concepts/attachments)
- [快速上手](https://telepresence.io/docs/quick-start/)
- [命令行参考](https://telepresence.io/docs/reference/cli/telepresence)
- [故障排查](https://telepresence.io/docs/troubleshooting)
- [Telepresence GitHub 仓库](https://github.com/telepresenceio/telepresence)
- [CNCF 项目页](https://www.cncf.io/projects/telepresence/)
