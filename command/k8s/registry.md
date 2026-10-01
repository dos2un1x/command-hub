registry
===

Docker Registry 官方参考实现,自建最简私有镜像仓库的选择

## 补充说明

**registry** 指的是 `distribution/distribution` 项目 —— 也就是当年 `docker push` 背后那个官方 registry 的开源实现。它只做一件事:**按照 Docker Registry HTTP API V2 存取镜像**。

它的能力边界必须一开始就说清楚:

```shell
有   镜像的 pull / push / delete、标签列举、对象存储后端、TLS、基于 htpasswd 的认证
没有 Web 界面、多租户、RBAC、镜像扫描、签名、跨仓库复制、配额
```

定位因此很明确:**单团队、内网、轻量的镜像存放点**。需要界面、权限体系或扫描能力时应改用 `harbor` 这样的上层平台 —— Harbor 内部的 registry 组件其实就是 distribution。

在 Kubernetes 场景里,registry 可以作为集群的私有镜像仓库:节点上的 kubelet 通过 CRI 让 containerd 从这里拉镜像,push 端通常是 CI 或开发者本机。**最需要注意的是:registry 不解决「谁有权限推什么」**,它把鉴权完全交给你在反向代理或 htpasswd 层面处理。

### 版本

```shell
distribution 2.8.x   长期使用的稳定线,镜像标签 registry:2
distribution 3.0.0   2025 年发布的第一个 3.x 正式版,镜像标签 registry:3
```

3.x 的主要变化:

```shell
默认配置路径改为 /etc/distribution/config.yml(2.x 是 /etc/docker/registry/config.yml)
移除 oss 与 swift 存储驱动
签名库由 docker/libtrust 换成 go-jose/go-jose
```

**这是升级时最容易踩的坑**:照搬 2.x 的 `garbage-collect /etc/docker/registry/config.yml` 到 3.x 镜像上,会因为配置路径变了而报找不到文件。

### 安装

最快的启动方式:

```shell
docker run -d -p 5000:5000 --restart=always --name registry \
  -v /mnt/registry:/var/lib/registry \
  registry:3

# 验证
curl -k https://registry.example.com:5000/v2/_catalog
```

在 Kubernetes 上部署则需要持久化存储与配置文件:

```shell
apiVersion: apps/v1
kind: Deployment
metadata:
  name: registry
  namespace: registry
spec:
  replicas: 1
  selector:
    matchLabels:
      app: registry
  template:
    metadata:
      labels:
        app: registry
    spec:
      containers:
        - name: registry
          image: registry:3
          ports:
            - containerPort: 5000
          volumeMounts:
            - name: data
              mountPath: /var/lib/registry
            - name: config
              mountPath: /etc/distribution/config.yml
              subPath: config.yml
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: registry-data
        - name: config
          configMap:
            name: registry-config
```

配置文件通过 ConfigMap 挂到 `/etc/distribution/config.yml`(3.x 的路径,2.x 是 `/etc/docker/registry/config.yml`),并用 `REGISTRY_STORAGE_DELETE_ENABLED=true` 打开删除。**`replicas` 只能为 1**,除非把存储换成 S3 之类的对象存储 —— 本地文件系统后端不支持多副本共享。

### 配置文件

```shell
version: 0.1

storage:
  filesystem:
    rootdirectory: /var/lib/registry
  delete:
    enabled: true
  maintenance:
    readonly:
      enabled: false

http:
  addr: :5000
```

常用配置项:

```shell
storage.filesystem.rootdirectory        镜像数据目录
storage.delete.enabled                  是否允许删除(默认 false,必须显式开启)
storage.maintenance.readonly.enabled    只读模式,GC 期间用
storage.cache.blobdescriptor            缓存后端,可设为 inmemory / redis
http.addr                               监听地址
http.tls.certificate / key              TLS 证书路径
auth.htpasswd.realm / path              基础认证
proxy.remoteurl                         配置后变为拉取代理(pull-through cache)
```

配置项可以用环境变量覆盖,规则是**把配置路径转成大写、用下划线连接**:

```shell
storage.delete.enabled  →  REGISTRY_STORAGE_DELETE_ENABLED=true
http.addr               →  REGISTRY_HTTP_ADDR=:5000
```

### TLS

**docker 与 containerd 默认只走 HTTPS**,所以给 registry 配证书是让它真正可用的前提。不配证书直接 `docker push` 会得到:

```shell
Error response from daemon: Get "https://registry.example.com:5000/v2/":
http: server gave HTTP response to HTTPS client
```

三种处理方式:

```shell
1. 配证书(推荐)
   http:
     tls:
       certificate: /certs/domain.crt
       key: /certs/domain.key

2. docker 侧放行不安全仓库 /etc/docker/daemon.json(仅测试环境)
   { "insecure-registries": ["registry.example.com:5000"] }

3. containerd 侧写成 http(仅测试环境)
   /etc/containerd/certs.d/registry.example.com:5000/hosts.toml
   server = "http://registry.example.com:5000"
```

### 认证

registry 只内置了 htpasswd 一种认证方式,先用 bcrypt 生成密码文件:

```shell
htpasswd -Bbn admin '******' > /auth/htpasswd
```

```shell
auth:
  htpasswd:
    realm: basic-realm
    path: /auth/htpasswd
```

```shell
# 启动时把密码文件挂进去
docker run -d -p 5000:5000 \
  -v /mnt/registry:/var/lib/registry -v /mnt/auth:/auth \
  -e REGISTRY_AUTH=htpasswd \
  -e REGISTRY_AUTH_HTPASSWD_REALM=basic-realm \
  -e REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd \
  registry:3
```

htpasswd 只能区分「能登录」和「不能登录」,**无法做读写分离或按仓库授权**。要让 CI 只能推、节点只能拉,得在 registry 前面放一个反向代理自己做鉴权。

### 删除与垃圾回收

**registry 默认不允许删除任何东西**,`storage.delete.enabled` 必须显式打开;而删除与释放磁盘又是**两个独立的步骤**,只做前一步空间不会变:

```shell
# 第一步:删除 manifest,让它变成「未被引用」
# 必须按 digest 删,不能按 tag 删
curl -u admin:****** -X DELETE \
  -H "Accept: application/vnd.docker.distribution.manifest.v2+json" \
  https://registry.example.com:5000/v2/library/nginx/manifests/sha256:xxxxx

# 或者用 skopeo(它会先解析出 digest 再删)
skopeo delete --creds admin:****** docker://registry.example.com:5000/library/nginx:1.27
```

```shell
# 第二步:垃圾回收,真正释放磁盘
bin/registry garbage-collect [--dry-run] [--delete-untagged] [--quiet] /etc/distribution/config.yml

# 容器里的常见形态:先演练,确认清单无误后正式执行
docker exec registry /bin/registry garbage-collect \
  --dry-run --delete-untagged /etc/distribution/config.yml
docker exec registry /bin/registry garbage-collect \
  --delete-untagged /etc/distribution/config.yml

# 执行完重启一次 registry(原因见下方注意事项)
docker restart registry
```

`--delete-untagged` 决定是否清理「没有标签指向的 manifest」。**不带这个参数时,`docker push` 覆盖过的旧版本会永远留在磁盘上** —— 这是 registry 磁盘只增不减的最主要原因。

### 在 Kubernetes 节点上使用

```shell
# 1. 节点侧信任自签 CA
sudo mkdir -p /etc/containerd/certs.d/registry.example.com:5000
sudo cp ca.crt /etc/containerd/certs.d/registry.example.com:5000/ca.crt

# 2. Pod 里引用凭据,镜像地址要带端口
kubectl create secret docker-registry regcred \
  --docker-server=registry.example.com:5000 \
  --docker-username=admin --docker-password='******'
```

```shell
# /etc/containerd/certs.d/registry.example.com:5000/hosts.toml
server = "https://registry.example.com:5000"

[host."https://registry.example.com:5000"]
  capabilities = ["pull", "resolve"]
  ca = "/etc/containerd/certs.d/registry.example.com:5000/ca.crt"
```

注意 registry 的镜像路径是**两段式**(`<仓库名>/<镜像名>`),没有 Harbor 那样的「项目」层。

### 作为拉取代理

registry 可以配置成上游仓库的缓存,在没有公网出口的集群里很有用:

```shell
proxy:
  remoteurl: https://registry-1.docker.io
  ttl: 168h
```

配置后所有镜像都从同一个地址拉,靠前缀区分上游:`registry.example.com:5000/library/nginx:1.27` 实际来自 Docker Hub 的 `library/nginx`。好处是不必维护镜像同步清单,代价是上游不可达时它会直接失败。

### 注意

1. **默认不允许删除**。`storage.delete.enabled` 不开,任何 DELETE 请求都会被拒绝或静默忽略。这是「删了镜像磁盘却没变」的第一号原因。
2. **删除 manifest 不会释放空间,必须再跑 GC**。删除只是把引用摘掉,blob 仍是垃圾;只有 `garbage-collect` 的清除阶段才真正删文件。**两步缺一不可。**
3. **不带 `--delete-untagged` 的 GC 清不掉多少东西**。被 `docker push` 覆盖过的旧 tag 会留下没有标签引用的 manifest,官方文档明确说明该参数用于「删除当前没有被任何标签引用的 manifest」。不开启时磁盘会持续增长。
4. **GC 期间必须让 registry 只读或停止运行**。官方把 GC 称作「stop-the-world」操作,文档原文是「You should ensure that the registry is in read-only mode or not running at all」。GC 期间有人推镜像,那个镜像的层可能被误判为无引用而删掉,产出一个**推送成功、拉取时才报错的损坏镜像**。只读开关是 `storage.maintenance.readonly.enabled: true`。
5. **GC 之后要重启 registry 进程**。默认 `storage.cache.blobdescriptor: inmemory` 时,GC 删掉了磁盘上的 blob 但内存里的描述符还在;此时重新推送同一个镜像会「看起来成功」(registry 拿缓存里的层直接应答),实际没有写入任何层,之后拉取报 `manifest unknown`。重启进程即可规避。
6. **3.x 的默认配置路径变了**。从 `/etc/docker/registry/config.yml` 改成 `/etc/distribution/config.yml`。照着旧文档在 `registry:3` 镜像里跑 GC 会报找不到文件而不是报参数错误,很容易误判成别的问题。
7. **`storage.cache.blobdescriptor: redis` 与删除一起用时需要留意**。已有安全公告指出,这种组合下删除会清掉共享的 digest 描述符却留下仓库维度的残留记录,后续从其他仓库 Stat 时可能让已删除的 blob 重新变为可读。不需要跨实例共享缓存时,保持 `inmemory` 更简单。
8. **必须开 TLS,否则 docker 客户端根本连不上**。报错文案是 `http: server gave HTTP response to HTTPS client` —— 它说的是「服务器对 HTTPS 请求回了 HTTP」,根因是客户端在说 HTTPS 而服务端只会说 HTTP。`insecure-registries` 只是测试环境的绕行方案。
9. **自签证书要让每个节点都信任**。containerd 读的是 `/etc/containerd/certs.d/<host>/` 下的证书目录,**不是系统信任库**,`update-ca-certificates` 通常不解决问题;而且主机名必须与证书 SAN 完全一致,**用 IP 访问一定会失败**。
10. **htpasswd 无法做细粒度授权**,做不到「这个账号只能推这个仓库」。需要读写分离或按仓库授权时,必须在前面加一层反向代理,或直接换成 Harbor。
11. **本地文件系统后端只能跑单副本**。`replicas` 大于 1 时多个 Pod 各写自己的卷,镜像会时有时无。要多副本必须换对象存储后端。
12. **没有配额、保留策略,也没有 Web 界面**。registry 不会自动清理旧镜像,磁盘最终一定会满;`/v2/_catalog` 默认分页,一次只返回一部分仓库名。请自行写定时任务做「删除旧 tag + GC」,并监控存储使用率。
13. **delete 与 GC 都会影响正在运行的集群**。节点上正在拉取的镜像若被 GC 清掉,kubelet 会进入 `ImagePullBackOff`;清理前请确认没有 Pod 依赖这些 tag。
14. **不要让 registry 长期无鉴权暴露**。它默认既不校验身份也不限制推送,任何能访问该端口的人都能推镜像进来,内网也请至少配上 htpasswd 或反向代理。

### 相关命令

- `harbor` — 在 registry 之上补齐权限、扫描与复制的平台
- `skopeo` — 跨仓库搬运与删除镜像
- `containerd` — 节点侧执行拉取的运行时
- `docker` — 容器管理工具
- `kubelet` — 通过 CRI 触发镜像拉取

### 参考链接

- [Distribution 官方文档](https://distribution.github.io/distribution/)
- [垃圾回收说明](https://distribution.github.io/distribution/about/garbage-collection/)
- [distribution 项目仓库](https://github.com/distribution/distribution)
- [Docker Registry HTTP API V2](https://distribution.github.io/distribution/spec/api/)
