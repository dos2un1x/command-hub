nginx-ingress
===

Nginx系Ingress Controller的安装与运维,含社区版与NGINX官方版两个项目

## 补充说明

**Nginx 系 Ingress Controller** 是 Kubernetes 里使用最广的入口实现。但这个名字底下其实是**两个完全不同的项目**,这是本页首先要讲清楚的事:

```shell
ingress-nginx              kubernetes 社区维护,仓库是 kubernetes/ingress-nginx
NGINX Ingress Controller   F5 / NGINX 官方维护,文档在 docs.nginx.com
```

两者的区别:

```shell
维护方     kubernetes 社区(已宣布退役)  vs  F5 / NGINX 官方(持续维护)
仓库       kubernetes/ingress-nginx      vs  nginx/kubernetes-ingress
镜像       registry.k8s.io/ingress-nginx/controller  vs  nginx/nginx-ingress
注解前缀   nginx.ingress.kubernetes.io/  vs  nginx.org/
配置方式   ConfigMap                     vs  ConfigMap + VirtualServer 等 CRD
商业版     无                            vs  NGINX Plus 版本
```

**即使不看注解,两者的默认 IngressClass 名都是 `nginx`**。也就是说,同一个集群里先后装上这两个控制器,它们会争抢同一批 Ingress 资源,行为完全不可预测。这是最容易踩、也最难排查的坑。

关于 `ingress-nginx` 的退役时间线,必须了解清楚:

```shell
2025-11-11   Kubernetes SIG Network 与安全响应委员会正式宣布退役
2026-03 之前  维持尽力而为(best-effort)的维护
2026-03 之后  不再发布任何版本、不再修 bug、不再修补安全漏洞
```

集群里已经在跑的 `ingress-nginx` **不会停止工作**,Helm chart 与镜像也仍然可以下载,但**之后发现的安全漏洞不会再有补丁**。官方的迁移建议是转向 **Gateway API**,如果必须继续用 Ingress,则应更换为其他仍在维护的 Ingress Controller(例如 NGINX 官方版)。

本页只讲 controller 自身的安装与运维。Ingress 资源本身的写法、`pathType` 的语义、TLS Secret 的要求请看 `ingress` 页。

### 安装 ingress-nginx(社区版)

```shell
# 云环境,自动创建 LoadBalancer Service
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.3/deploy/static/provider/cloud/deploy.yaml

# 裸机环境,使用 NodePort
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.3/deploy/static/provider/baremetal/deploy.yaml

# Helm 方式(推荐,便于后续调整参数)
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update
helm install ingress-nginx ingress-nginx/ingress-nginx \
  --namespace ingress-nginx --create-namespace
```

验证:

```shell
kubectl -n ingress-nginx get pods
kubectl -n ingress-nginx get svc ingress-nginx-controller
kubectl get ingressclass
```

### 安装 NGINX Ingress Controller(官方版)

官方 chart 发布在 OCI 仓库,没有传统的 `helm repo add`:

```shell
helm install my-release oci://ghcr.io/nginx/charts/nginx-ingress --version 2.7.3 \
  --namespace nginx-ingress --create-namespace
```

从源码 chart 安装:

```shell
helm pull oci://ghcr.io/nginx/charts/nginx-ingress --untar --version 2.7.3
cd nginx-ingress
helm install my-release .
```

不需要自定义资源时,可以跳过 CRD 安装:

```shell
helm install my-release oci://ghcr.io/nginx/charts/nginx-ingress --version 2.7.3 \
  --skip-crds \
  --set controller.enableCustomResources=false \
  --set controller.appprotect.enable=false \
  --set controller.appprotectdos.enable=false
```

验证:

```shell
kubectl get pods -n nginx-ingress
kubectl get ingressclasses
```

### 获取入口地址

```shell
kubectl -n ingress-nginx get svc ingress-nginx-controller -o wide

# 拿 LoadBalancer IP
kubectl -n ingress-nginx get svc ingress-nginx-controller \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}'

# 本机验证,绕过 DNS
curl -H "Host: app.example.com" http://<ingress-ip>/
```

裸机环境用 NodePort 时:

```shell
kubectl -n ingress-nginx get svc ingress-nginx-controller \
  -o jsonpath='{.spec.ports[0].nodePort}'
```

### ConfigMap 配置

`ingress-nginx` 的全局配置放在 `ingress-nginx-controller` 这个 ConfigMap 里:

```shell
kubectl -n ingress-nginx edit configmap ingress-nginx-controller
```

常用配置项:

```shell
proxy-body-size: "50m"               请求体最大体积,默认只有 1m
proxy-read-timeout: "600"            读超时,长连接场景必调
proxy-send-timeout: "600"            写超时
proxy-connect-timeout: "10"          连接后端超时
use-forwarded-headers: "true"        信任上游负载均衡传来的 X-Forwarded-*
enable-real-ip: "true"               从 X-Forwarded-For 取真实客户端 IP
compute-full-forwarded-for: "true"   X-Forwarded-For 追加而不是覆盖
ssl-protocols: "TLSv1.2 TLSv1.3"     允许的 TLS 版本
log-format-upstream: '...'           访问日志格式,可加 trace id
allow-snippet-annotations: "true"    打开 snippet 类注解(有安全风险)
```

用 Helm 安装时,等价写法是把这些放进 values:

```shell
controller:
  config:
    proxy-body-size: "50m"
    proxy-read-timeout: "600"
    use-forwarded-headers: "true"
  replicaCount: 2
  service:
    externalTrafficPolicy: Local
```

改完 ConfigMap 后,控制器会在几秒内重新生成 nginx.conf 并**热重载**(不是重启进程),连接不会中断:

```shell
kubectl -n ingress-nginx logs deploy/ingress-nginx-controller --tail=20 | grep -i reload
```

### 扩缩容与高可用

```shell
# 扩容到多副本
kubectl -n ingress-nginx scale deploy/ingress-nginx-controller --replicas=3

# Helm 方式
helm upgrade ingress-nginx ingress-nginx/ingress-nginx \
  -n ingress-nginx --set controller.replicaCount=3
```

保留客户端真实 IP 需要把 Service 的 `externalTrafficPolicy` 设为 `Local`,代价是流量只发给本节点上的 Pod:

```shell
kubectl -n ingress-nginx patch svc ingress-nginx-controller \
  -p '{"spec":{"externalTrafficPolicy":"Local"}}'
```

配合节点反亲和,让副本尽量分散到不同节点:

```shell
controller:
  replicaCount: 3
  affinity:
    podAntiAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
        - weight: 100
          podAffinityTerm:
            topologyKey: kubernetes.io/hostname
            labelSelector:
              matchLabels:
                app.kubernetes.io/name: ingress-nginx
```

### 运维与排障

```shell
# 控制器日志,排障第一站
kubectl -n ingress-nginx logs -l app.kubernetes.io/component=controller --tail=100 -f

# 只看错误
kubectl -n ingress-nginx logs deploy/ingress-nginx-controller --tail=200 | grep -i error

# 查看生成的 nginx.conf
kubectl -n ingress-nginx exec deploy/ingress-nginx-controller -- cat /etc/nginx/nginx.conf

# 检查配置语法
kubectl -n ingress-nginx exec deploy/ingress-nginx-controller -- nginx -t

# 指标与健康检查端口是 10254
kubectl -n ingress-nginx port-forward deploy/ingress-nginx-controller 10254:10254
curl -s localhost:10254/metrics | head

# 查看所有 Ingress 及其分配到的地址
kubectl get ingress -A
```

### 多控制器共存

集群里必须有多个 Ingress Controller 时,要给每个控制器设置不同的 `controller-class` 与 `election-id`:

```shell
controller:
  ingressClassResource:
    name: nginx-internal
    controllerValue: "k8s.io/ingress-nginx-internal"
  electionID: ingress-controller-leader-internal
  ingressClass: nginx-internal
```

对应的 Ingress 必须显式写 `ingressClassName: nginx-internal`。

### 迁移到 Gateway API

`ingress-nginx` 退役后官方推荐的方向是 Gateway API:

```shell
# 1. 安装 Gateway API 的 CRD
kubectl apply --server-side -f \
  https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.6.1/standard-install.yaml

# 2. 部署一个实现了 Gateway API 的控制器,例如 Envoy Gateway
helm install eg oci://docker.io/envoyproxy/gateway-helm \
  --version v1.9.1 -n envoy-gateway-system --create-namespace

# 3. 用官方工具把现有 Ingress 转成 Gateway API 资源
ingress2gateway print --input-file ingress.yaml > gateway.yaml
```

转换工具只处理标准字段,**各家控制器的私有注解不会被翻译**,`nginx.ingress.kubernetes.io/*` 这类注解需要人工逐条找对应字段。

### 注意

1. **`ingress-nginx` 与 `NGINX Ingress Controller` 是两个项目,极易混淆**。前者是 kubernetes 社区项目,注解前缀 `nginx.ingress.kubernetes.io/`;后者是 F5/NGINX 官方项目,注解前缀 `nginx.org/`。搜到一篇教程时先确认它讲的是哪一个,否则所有命令、镜像地址、注解都会对不上。
2. **两个项目的默认 IngressClass 都叫 `nginx`**。同时安装会造成 Ingress 资源被随机争抢,现象是「同一条规则一会儿正常一会儿 404」。多控制器共存时必须给每个控制器显式设置不同的 `ingressClassResource.name` 与 `electionID`,并在 Ingress 里写清 `ingressClassName`。
3. **`ingress-nginx` 已经退役**。2025 年 11 月宣布,2026 年 3 月之后不再有版本发布、bug 修复与安全补丁。已有部署不会被破坏、镜像与 chart 也仍然可下载,但继续使用意味着之后的安全漏洞只能自己扛。新项目应直接选 Gateway API 或其他仍在维护的控制器。
4. **`allow-snippet-annotations` 在新版本中默认关闭**。`configuration-snippet`、`server-snippet`、`auth-snippet` 这几类注解从 v1.9 起不再生效,除非在 ConfigMap 里显式打开。这是为了修复一个可提权的漏洞,打开之前必须清楚风险 —— 这些注解允许注入任意 Nginx 配置。
5. **`proxy-body-size` 默认只有 1m**。上传稍大的文件就会返回 413,而日志里不会给出「配置太小」这样直白的提示。文件上传类业务必须提前在 ConfigMap 里调大,或者用单条 Ingress 的注解覆盖。
6. **正则路径必须配合 `use-regex` 注解**。`pathType: ImplementationSpecific` 加上正则语法不会自动生效,还需要 `nginx.ingress.kubernetes.io/use-regex: "true"`,并且正则路由的优先级规则与普通前缀路由不同,容易产生意料之外的匹配顺序。
7. **默认没有匹配任何规则时返回 404**,而不是 502。看日志时先区分这两种情况:404 说明请求根本没匹配上路由,502/503 才是后端的问题。
8. **客户端真实 IP 需要一整套配置才能拿到**。链路上有云负载均衡时,要同时设置 `use-forwarded-headers: "true"`、`compute-full-forwarded-for: "true"`,并把 Service 的 `externalTrafficPolicy` 设为 `Local`。少任何一项,业务代码里看到的都是节点或负载均衡的 IP。
9. **未配置证书的域名会返回一个自签的假证书**。浏览器会报证书错误。需要给集群设置默认证书时要显式传 `--default-ssl-certificate=<namespace>/<secret-name>`,Secret 必须是 `kubernetes.io/tls` 类型。
10. **ConfigMap 的改动不是立即生效**。控制器监听到变更后需要几秒钟重新生成配置并 reload,排障时如果刚改完就测试,可能拿到的是旧配置。确认方式是在日志里看到 reload 记录,或进容器 `nginx -t` 检查当前文件。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `ingress` — Ingress对象本身的用法
- `service` — Controller对外暴露流量的载体
- `secret` — 存放TLS证书
- `gateway-api` — ingress-nginx退役后的迁移方向
- `traefik` — 另一款主流Ingress Controller

### 参考链接

- [ingress-nginx 官方文档](https://kubernetes.github.io/ingress-nginx/)
- [Ingress NGINX 退役公告](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/)
- [NGINX Ingress Controller 官方文档](https://docs.nginx.com/nginx-ingress-controller/)
- [NGINX Ingress Controller Helm 安装](https://docs.nginx.com/nginx-ingress-controller/install/helm/open-source/)
