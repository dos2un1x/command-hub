registry-mirror
===

配置containerd与CRI-O的镜像加速与私有仓库,通过mirror规避registry限流

## 补充说明

**镜像加速(registry mirror)** 解决的是两个具体问题:一是从 Docker Hub 拉镜像被限流或极慢,二是所有节点都跨公网回源造成出口带宽浪费。做法是让容器运行时先访问一个离得近的 mirror,拿不到再回源上游。

**关键认知:配置写在容器运行时侧,不在 Kubernetes 侧。** 没有 `ImageMirror` 这类 Kubernetes 对象 —— 改的是每个节点上的 containerd 或 CRI-O 配置。这意味着它不属于集群清单,不受 GitOps 管,升级节点时容易被覆盖,排查时也常被忘记。

两种运行时的配置方式完全不同,互不相通:

```shell
containerd   目录式,每个 registry 一个目录 + 一份 hosts.toml
             路径由 registry.config_path 指定,推荐 /etc/containerd/certs.d

CRI-O        单文件 TOML,/etc/containers/registries.conf
             (rootless 时是 $HOME/.config/containers/registries.conf)
```

### containerd:目录结构

```shell
/etc/containerd/certs.d/
├── docker.io/
│   └── hosts.toml
├── registry.example.com_5000_/     # 带端口的主机名,冒号在目录名里要写成下划线
│   └── hosts.toml
└── _default/                       # 兜底,匹配所有 registry
    └── hosts.toml
```

在 `config.toml` 里指向这个目录 —— **1.x 与 2.x 的插件 ID 不同**:

```shell
# containerd 2.x
version = 3

[plugins."io.containerd.cri.v1.images".registry]
  config_path = "/etc/containerd/certs.d"
```

```shell
# containerd 1.x
version = 2

[plugins."io.containerd.grpc.v1.cri".registry]
  config_path = "/etc/containerd/certs.d"
```

带端口时,containerd 按以下顺序查找目录(Unix):

```shell
myregistry.io_5000_        # 首选,冒号换成下划线
myregistry.io:5000
_default
```

### hosts.toml 字段

```shell
server = "https://registry-1.docker.io"    # 默认上游,不写则用镜像名里的 registry 主机

[host."https://mirror.example.com"]        # mirror,可以写多个
  capabilities = ["pull", "resolve"]       # 允许的能力
  ca = "mirror.crt"                        # CA,相对路径基于本 hosts.toml 所在目录
  client = [["client.cert", "client.key"]] # 客户端证书
  skip_verify = true                       # 跳过 TLS 校验,仅限测试
  override_path = true                     # 上游 API 根路径不在 URL 规范位置时用
  dial_timeout = "1s"                      # 连接超时,给短一点让回退更快
  [host."https://mirror.example.com".header]
    x-custom = "value"
```

### fallback 顺序(最容易搞反的地方)

官方规范原文是:**当配置了 `host` 时,host 会按列出的顺序先被尝试;全部失败之后,才回退到 `server`。**

```shell
host."https://mirror-a"    # 第 1 个尝试
host."https://mirror-b"    # 第 2 个尝试
server                     # 最后兜底
```

所以最常见的加速写法是:把上游写在 `server`,`mirror` 写成 `host`。这样 mirror 挂了会自动回上游,不会导致拉不动镜像。

反过来,若要**强制只走 mirror、禁止回源**,把 mirror 直接写成 `server`,并且不写任何 `host`:

```shell
# /etc/containerd/certs.d/_default/hosts.toml
server = "https://registry.example.com"
```

### capabilities 的三个值

```shell
pull      可以拉取内容
resolve   可以信任地把 tag 解析成 digest
push      可以向其推送内容

公开 mirror 只应给 ["pull"] —— 它没有资格决定某个 tag 对应哪个 digest
私有 mirror 可以给 ["pull", "resolve"]
```

### CRI-O / Podman:registries.conf

```shell
unqualified-search-registries = ["docker.io"]

[[registry]]
prefix = "docker.io"
location = "docker.io"
insecure = false
blocked = false

[[registry.mirror]]
location = "mirror.example.com"
insecure = false
```

查找规则:**按 `prefix` 最长匹配**选中唯一一个 `[[registry]]` 表(支持 `*.example.com` 形式的通配子域,且通配只能出现在最前面)。

```shell
# 拉取时的尝试顺序:mirror 按序尝试,全部失败才用 location
prefix 匹配 → registry.mirror[0] → registry.mirror[1] → registry.location
```

与 containerd 不同的几个字段:

```shell
mirror-by-digest-only: true     # mirror 只用于 digest 拉取,不用于 tag 拉取
pull-from-mirror: "all"         # all / digest-only / tag-only,按单个 mirror 设置
blocked: true                   # 禁止拉取匹配该 prefix 的镜像
short-name-mode: "permissive"   # enforcing / permissive / disabled,默认 permissive
```

`mirror-by-digest-only` 的意义:tag 是可变引用,不同 registry 可能返回不同内容;用 digest 拉取才能保证一致。要求严格一致性的环境应该启用它。

### 常用配方

给 docker.io 配加速(containerd):

```shell
# /etc/containerd/certs.d/docker.io/hosts.toml
server = "https://registry-1.docker.io"

[host."https://mirror.example.com"]
  capabilities = ["pull", "resolve"]
```

给所有 registry 配同一个兜底 mirror:

```shell
# /etc/containerd/certs.d/_default/hosts.toml
[host."https://mirror.example.com"]
  capabilities = ["pull", "resolve"]
```

私有仓库 + 自签证书:

```shell
# /etc/containerd/certs.d/harbor.internal:5000/hosts.toml
server = "https://harbor.internal:5000"

[host."https://harbor.internal:5000"]
  capabilities = ["pull", "resolve", "push"]
  ca = "/etc/containerd/certs.d/harbor.internal:5000/ca.crt"
```

### 生效与验证

```shell
# hosts.toml 的改动是热加载的,不需要重启 containerd
# 但 config_path 本身的改动需要重启
systemctl restart containerd

# 确认 containerd 读到的 registry 配置
crictl info | grep -A10 registry

# 直接测试 mirror 是否可用
curl -sv https://mirror.example.com/v2/
curl -sv https://mirror.example.com/v2/library/nginx/manifests/1.27

# 拉一个镜像看走没走 mirror
crictl pull nginx:1.27
journalctl -u containerd -f | grep -i mirror

# CRI-O
crio status config | grep -A20 registries
```

### 注意

1. **containerd 的 `registry.mirrors` / `registry.configs` 与 `registry.config_path` 同时配置会直接启动失败**,而不是以某一个为准。这两套写法是「旧」与「新」的关系,官方已把前者标记为 DEPRECATED,只有**不配置 `config_path` 时**旧写法才生效。迁移时务必二选一,否则 containerd 起不来,节点直接 NotReady。
2. **不要漏掉 `config_path` 这一半**。`config_path` 与旧写法是「全有或全无」的关系:只写 `config_path` 而目录不存在、或只写旧写法,都不报错但也不生效,表现为「配了加速但一点没快」。改完记得 `systemctl restart containerd`。
3. **`hosts.toml` 里 host 在前、server 在后**。规范原文是 host 全部试完才回退 server。想「优先 mirror、失败回源」就把上游放 `server`;想「只走 mirror」就只写 `server` 且不写 host。搞反会得到完全相反的行为。
4. **`capabilities` 决定信任边界,不是可选项**。公开 mirror 若被授予 `resolve`,它就能决定某个 tag 解析成哪个 digest —— 等于把供应链交给了它。公开 mirror 一律只给 `["pull"]`。
5. **自签证书的 CA 必须放进 `certs.d` 目录并用 `ca` 引用**。只把 CA 装进系统信任库(`update-ca-certificates`)**不一定管用**,containerd 走的是自己那套证书目录逻辑。另外注意 `ca`/`client` 的相对路径是相对于 `hosts.toml` 所在目录,不是相对于当前工作目录。
6. **`_default` 会影响集群里所有 registry**,包括公司内部仓库、临时测试用的仓库。排查「某个私有仓库突然拉不动了」时,先看有没有 `_default/hosts.toml`。另外 `_default` 的名字是字面量,写成 `default` 不生效。
7. **CRI-O 的 `prefix` 匹配 docker.io 时必须带 `/library`**。`docker.io` 的引用会被内部规范化:`docker.io/alpine` 实际是 `docker.io/library/alpine`。因此只写 `prefix = "docker.io/alpine"` 匹配不到它,要写 `prefix = "docker.io/library/alpine"` 或干脆用 `prefix = "docker.io"`。
8. **CRI-O 的 mirror 只属于它所在的那个 `[[registry]]` 表**。`example.com/foo` 下的 mirror 不会作用于 `registry.com`。写多个 registry 时要逐个配 mirror。
9. **CRI-O 仍支持已废弃的 VERSION 1 格式,但它不支持 mirror、最长前缀匹配与 location 重写**。老集群里如果看到 `[registries.search]` 这种写法,那是 v1,配 mirror 是不生效的,必须升级成 `[[registry]]` 格式。
10. **CRI-O 的短名搜索有安全风险**。`unqualified-search-registries` 里越靠前的 registry 越优先,攻击者可以抢注同名镜像。官方建议只用完全可信的 registry,或配置 `[aliases]` 与 `short-name-mode: enforcing`。
11. **kubelet 的镜像缓存会掩盖配置变更**。镜像已经在节点上了,改配置后不会重新拉取,自然看不到效果。验证时要换一个没拉过的 tag,或先 `crictl rmi` 删掉。
12. **改节点配置文件的方式决定了它会不会丢**。手工改 `/etc/containerd/config.toml` 在节点升级、节点池替换、Talos/Bottlerocket 这类不可变系统上会被覆盖。生产环境建议用机器镜像、cloud-init 或配置管理工具下发。
13. **mirror 拿不到时是静默回退,不是报错**。所以「配置写错了」和「配置没生效」表现一模一样 —— 都是「能拉,但没加速」。验证必须看 containerd 日志或直接 curl mirror 的 `/v2/` 端点。
14. **`dial_timeout` 默认 30s**。mirror 不可达又不设小超时,每次拉取都要先等 30 秒;加速配置反而变成了拖慢。建议设成 1s 甚至几百毫秒。

### 相关命令

- `containerd` — 需要配置registry.mirror的容器运行时
- `crictl` — 验证镜像拉取是否走mirror
- `ctr` — containerd自带CLI,可用--hosts-dir测试hosts.toml
- `cni` — 与镜像分发无关,但同属节点级配置
- `harbor` — 最常用的私有registry与mirror上游
- `spegel` — 基于P2P的集群内镜像缓存,另一种加速思路
- `dragonfly` — 带中心调度的P2P镜像分发系统

### 参考链接

- [containerd registry 配置(hosts.toml)](https://github.com/containerd/containerd/blob/main/docs/hosts.md)
- [containerd CRI 插件配置](https://github.com/containerd/containerd/blob/main/docs/cri/config.md)
- [containers-registries.conf 手册](https://github.com/containers/image/blob/main/docs/containers-registries.conf.5.md)
- [CRI-O 配置说明](https://github.com/cri-o/cri-o/blob/main/docs/crio.conf.5.md)
- [Kubernetes 镜像拉取](https://kubernetes.io/docs/concepts/containers/images/)
