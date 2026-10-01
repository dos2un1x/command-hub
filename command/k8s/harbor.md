harbor
===

开源容器镜像仓库,提供镜像签名、扫描与多租户复制能力

## 补充说明

**Harbor** 是 CNCF 毕业项目,在开源的 registry 之上补齐了企业真正需要的那一层:多租户项目、基于 RBAC 的权限、机器人账号、镜像漏洞扫描、镜像签名与跨实例复制。单纯的 `registry` 只有「存取」,而 Harbor 是「可运营的镜像平台」。

Harbor 与 Kubernetes 的关系可以概括成两句话:**集群里的所有镜像几乎都从它拉取;它自身的所有组件又都跑在 Kubernetes 上**。

```shell
kubelet    按 Pod 里的 image 字段向 Harbor 发起拉取,凭据来自 imagePullSecrets
Harbor     校验凭据后返回镜像 manifest 与各层 blob
containerd / CRI-O  接收并落盘,交给 kubelet 启动容器
```

Harbor 的核心组件:

```shell
harbor-core         API 服务,权限、项目、Webhook 都在这
harbor-portal       Web 界面
harbor-registry     真正的镜像存储,内部就是 distribution
harbor-jobservice   异步任务:复制、扫描、GC
harbor-db           PostgreSQL,存元数据
harbor-redis        缓存与任务队列
trivy               漏洞扫描器(2.x 默认内置)
```

本页聚焦 Harbor 本体的安装与运维。底层 registry 的原理与手工搭建请看 `registry` 页。

### 安装

生产环境一律用 Helm 安装:

```shell
helm repo add harbor https://helm.goharbor.io
helm repo update

helm install harbor harbor/harbor \
  --namespace harbor --create-namespace \
  --set externalURL=https://harbor.example.com \
  --set expose.type=ingress \
  --set expose.ingress.hosts.core=harbor.example.com \
  --set expose.tls.enabled=true \
  --set expose.tls.certSource=secret \
  --set expose.tls.secret.secretName=harbor-tls
```

先落一份 values 文件再安装,后续升级会轻松很多:

```shell
helm show values harbor/harbor > harbor-values.yaml
```

```shell
# harbor-values.yaml(节选)
expose:
  type: ingress
  tls:
    enabled: true
    certSource: secret
    secret:
      secretName: harbor-tls
  ingress:
    className: nginx
    hosts:
      core: harbor.example.com

externalURL: https://harbor.example.com

persistence:
  persistentVolumeClaim:
    registry:
      storageClass: ceph-rbd
      size: 200Gi
```

```shell
helm install harbor harbor/harbor -n harbor --create-namespace -f harbor-values.yaml
```

### 必须配对的两个参数

`externalURL` 与 `expose.tls` 是 Harbor 安装里最容易出事、也最不能省的两项。

```shell
externalURL      格式必须是 protocol://domain[:port],不能带路径
                 Harbor 用它生成界面上展示的 docker push 命令
                 更重要的是,它是返回给 docker 客户端的 token 服务地址
```

如果 `externalURL` 写错(最常见的错误是写成了 Service 名 `harbor-core.harbor.svc.cluster.local`),你在集群外执行 `docker push` 时就会看到类似这样的报错:

```shell
Error response from daemon: Get "http://harbor-core.harbor.svc.cluster.local/v2/":
dial tcp: lookup harbor-core.harbor.svc.cluster.local: no such host
```

TLS 则是另一种经典故障。**docker / containerd 默认只走 HTTPS**,如果 Harbor 实际以 HTTP 暴露,你会得到:

```shell
Error response from daemon: Get "https://harbor.example.com/v2/":
http: server gave HTTP response to HTTPS client
```

这句话的字面意思是「服务器对 HTTPS 请求返回了 HTTP 响应」,根因是**客户端在说 HTTPS,而服务端只会说 HTTP**。正确的做法是给 Harbor 配上证书(`expose.tls.enabled=true`),而不是去改客户端的 insecure 配置。只有内网测试环境才考虑放行不安全仓库。

### 让节点信任自签证书

用自签证书时,集群的每个节点都必须信任 Harbor 的 CA,否则 kubelet 拉镜像会报 `x509: certificate signed by unknown authority`。

```shell
# containerd:集群节点走的是这条
sudo mkdir -p /etc/containerd/certs.d/harbor.example.com
sudo cp ca.crt /etc/containerd/certs.d/harbor.example.com/ca.crt

# docker 客户端(节点上跑 docker 时)
sudo mkdir -p /etc/docker/certs.d/harbor.example.com
sudo cp ca.crt /etc/docker/certs.d/harbor.example.com/ca.crt
```

```shell
# /etc/containerd/certs.d/harbor.example.com/hosts.toml
server = "https://harbor.example.com"

[host."https://harbor.example.com"]
  capabilities = ["pull", "resolve"]
  ca = "/etc/containerd/certs.d/harbor.example.com/ca.crt"
```

并确认 containerd 的 `config_path` 指向了这个目录:

```shell
[plugins.'io.containerd.cri.v1.images'.registry]
  config_path = "/etc/containerd/certs.d"
```

### 在 Pod 中使用

```shell
# 方式一:创建 imagePullSecret 并在 Pod 中引用
kubectl create secret docker-registry harbor-cred \
  --docker-server=harbor.example.com \
  --docker-username='robot$ci+puller' \
  --docker-password='******' \
  -n default
```

```shell
# 方式二:挂到 ServiceAccount 上,该命名空间的 Pod 自动生效
kubectl patch serviceaccount default \
  -p '{"imagePullSecrets":[{"name":"harbor-cred"}]}'
```

Pod 里的镜像地址要写**完整路径**,包含项目名:

```shell
image: harbor.example.com/library/nginx:1.27
```

仓库主机名必须与证书 CN/SAN 完全一致,而且**不能用 IP 代替域名**,否则证书校验一定失败。

### 机器人账号

CI 流水线不要用个人账号,用项目级的机器人账号:

```shell
名称形式   robot$<项目名>+<机器人名>(系统级机器人为 robot$<机器人名>)
权限       只勾 pull 或 push,不勾 delete
有效期     设置到期时间,配合轮换
```

```shell
docker login harbor.example.com -u 'robot$ci+builder' -p '******'
docker push harbor.example.com/library/app:v1
```

### 漏洞扫描

Harbor 2.x 内置 Trivy,默认在推送时自动扫描:

```shell
# 手工触发某个镜像的扫描
curl -u admin:****** -X POST \
  "https://harbor.example.com/api/v2.0/projects/library/repositories/nginx/artifacts/1.27/scan"

# 查看扫描结果概览
curl -u admin:****** \
  "https://harbor.example.com/api/v2.0/projects/library/repositories/nginx/artifacts/1.27"
```

配合项目的「部署安全策略」,可以做到**存在高危漏洞的镜像直接拒绝拉取**,这对集群是一道很实在的防线 —— 拒绝发生在 kubelet 拉取阶段,Pod 会停在 `ImagePullBackOff`。

### 垃圾回收

删除镜像标签**不会释放磁盘**,必须跑 GC:

```shell
# 界面上:系统管理 → 垃圾清理 → 立即清理
# 或走 API 触发一次 GC
curl -u admin:****** -X POST \
  -H "Content-Type: application/json" \
  "https://harbor.example.com/api/v2.0/system/gc/schedule" \
  -d '{"schedule":{"type":"Manual"},"parameters":{"delete_untagged":true,"dry_run":false}}'
```

GC 的本质是标记-清除:`delete_untagged` 决定是否连同「没有标签指向的 manifest」一起清理,开启它才能真正清掉那些被 `docker push` 覆盖后遗留的旧版本。

### 复制与高可用

多集群、多机房场景下用 Harbor 的复制功能做镜像分发:

```shell
方向       推模式(本端推送到远端)/ 拉模式(从远端拉取)
触发       手动 / 定时 / 推送到本端时自动触发
过滤       按项目、按标签正则、按资源类型
```

异地多活时通常是「主 Harbor 推模式分发到各机房 Harbor」,这样每个机房的 kubelet 只拉本地仓库,避免跨专线拉大镜像。

单实例 Harbor 的数据库与 Redis 都在集群内,挂掉就整体不可用,生产环境建议改成外部依赖:

```shell
database.type=external                   使用外部 PostgreSQL(主从)
redis.type=external                      使用外部 Redis(哨兵或集群)
persistence.imageChartStorage.type=s3    镜像存储改用对象存储
core.replicas=2 / jobservice.replicas=2
```

镜像存储改成 S3 类对象存储后,registry 组件变成无状态,扩容与容灾都简单得多。

### 升级

```shell
helm repo update
helm upgrade harbor harbor/harbor -n harbor -f harbor-values.yaml

# 确认 Pod 全部就绪,并观察数据库迁移 Job 的日志
kubectl -n harbor get pods -w
kubectl -n harbor logs job/harbor-db-migrate
```

**Harbor 只支持从最近的两个小版本升级**。也就是说想从 2.12 升到 2.15,必须依次经过 2.13、2.14,不能跳级。

### 注意

1. **`externalURL` 必须配成集群外可解析的地址**。它是返回给 docker 客户端的 token 服务地址,写成集群内部 Service 名会导致「在集群内能拉、在集群外 `docker push` 报 DNS 解析失败」。格式必须是 `protocol://domain[:port]`,**不支持带路径**。
2. **TLS 不是可选项**。docker 与 containerd 默认只走 HTTPS,以 HTTP 暴露 Harbor 会得到 `http: server gave HTTP response to HTTPS client`。正确解法是配证书,而不是在客户端放行不安全仓库。
3. **每个节点都要信任 Harbor 的 CA**。只在一台机器上 `docker login` 成功不代表 kubelet 能拉 —— containerd 走的是 `/etc/containerd/certs.d/` 下的证书目录,**不是**系统信任库。只执行 `update-ca-certificates` 通常不够。
4. **Helm 安装时 `expose.type=ingress` 需要集群里已有 Ingress Controller**。没装 controller 时,Ingress 资源会创建成功但永远不会被处理,Harbor 表现为「装好了却访问不了」。
5. **`expose.tls.certSource` 有三个取值,选错会静默出问题**。`auto` 由 chart 自动签发一张自签证书(浏览器一定报不信任);`secret` 引用你自己的证书(生产用这个);`none` 表示不配证书、由 Ingress Controller 提供默认证书。用 `auto` 后又忘了把 CA 分发到节点,就是 `x509` 报错的最常见来源。
6. **删除镜像不会释放磁盘**。必须在 Harbor 里跑 GC,且要开启 `delete_untagged`,否则被覆盖的旧 tag 指向的 manifest 会一直占着空间。Harbor 2.x 的 GC 已是非阻塞实现,不再强制把仓库切成只读(1.11 之前才会),但它仍是重 IO 操作,请安排在低峰期,并确保存储后端的快照、复制任务不与它重叠。
8. **Harbor 不支持跳版本升级**。只能从最近的两个小版本升上来,跨多了必须先逐级升。升级前务必备份 PostgreSQL 与镜像存储,数据库迁移失败很难回滚。
9. **`harborAdminPassword` 只在首次安装时生效**。`helm upgrade` 时再改这个值不会修改已存在的管理员密码,得走界面或 API 改。
10. **项目必须显式设为公开,否则拉取需要凭据**。默认创建的项目是私有的,忘建 `imagePullSecret` 时 Pod 会一直 `ImagePullBackOff`,而事件里往往只写 `unauthorized`,信息量很少。
11. **机器人账号名里的 `$` 在 shell 里要转义**。`docker login -u robot$ci+builder` 会被 shell 当成变量展开,必须写成单引号 `'robot$ci+builder'`。
12. **`persistence` 相关的 storageClass 必须真实存在**。用 `helm install` 时写了一个不存在的 StorageClass,PVC 会一直 Pending,而后端组件因为等不到卷会 CrashLoop,Harbor 表现为「装了一半」。
13. **`trivy` 的漏洞库要能定期更新**。离线环境里 Trivy 拉不到漏洞库时扫描会静默失败,界面上的「未发现漏洞」并不等于真的安全。
14. Harbor 的镜像地址**必须带项目名**(`harbor.example.com/library/nginx`),与 Docker Hub 的两段式写法不同。少写一段会在推送时报 `denied: requested access to the resource is denied`。

### 相关命令

- `registry` — Harbor 底层的镜像存储实现
- `skopeo` — 跨仓库搬运镜像,常用于配合 Harbor 做离线同步
- `containerd` — 节点侧真正执行拉取的运行时
- `kubelet` — 通过 CRI 触发镜像拉取
- `secret` — 存放 imagePullSecret

### 参考链接

- [Harbor 官方文档](https://goharbor.io/docs/)
- [Harbor Helm Chart 安装文档](https://goharbor.io/docs/latest/install-config/harbor-ha-helm/)
- [Harbor 项目仓库](https://github.com/goharbor/harbor)
- [Harbor Helm Chart 仓库](https://github.com/goharbor/harbor-helm)
