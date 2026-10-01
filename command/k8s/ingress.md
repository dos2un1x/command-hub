ingress
===

Kubernetes中提供七层HTTP与HTTPS路由入口的API对象

## 补充说明

**Ingress** 是 Kubernetes 中把集群外部流量按域名和路径转发到集群内 Service 的七层入口规则。它把「路由规则」和「流量实现」拆开:Ingress 资源只是一份声明式的规则表,真正监听端口、解析 Host 头、终结 TLS 的是 **Ingress Controller**(如 ingress-nginx、Traefik、Envoy Gateway)。

Ingress Controller 本身也是集群里的一组 Pod,通常以 Deployment + LoadBalancer/NodePort Service 的方式部署。**不装 Controller,创建再多 Ingress 也不会生效** —— 它们只是躺在 etcd 里,没有任何组件会去读取执行。

与 Service 的分工是:Service 工作在四层(TCP/UDP),只认 IP 和端口;Ingress 工作在七层,认域名、路径、Header。典型做法是最外层用**一个** LoadBalancer Service 把流量引进集群交给 Ingress Controller,内部微服务只暴露 ClusterIP,由 Ingress 按域名分发,公网 IP 与证书因此可以集中管理。

### 安装 Ingress Controller

```shell
# ingress-nginx(最常用)
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.3/deploy/static/provider/cloud/deploy.yaml

# 裸机环境使用 NodePort 版本
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.3/deploy/static/provider/baremetal/deploy.yaml

# 确认 Controller 就绪
kubectl -n ingress-nginx get pods
kubectl -n ingress-nginx get svc ingress-nginx-controller
```

### 语法

```shell
kubectl get ingress [名称] [选项]
kubectl describe ingress [名称]
kubectl create ingress [名称] --rule="host/path=service:port"
kubectl delete ingress [名称]
```

### YAML 清单

按域名转发到不同 Service:

```shell
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web-ingress
  namespace: default
spec:
  ingressClassName: nginx        # 指定由哪个 Controller 接管
  rules:
    - host: www.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: frontend-svc
                port:
                  number: 80
    - host: api.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: backend-svc
                port:
                  number: 8080
```

按路径分流到同一个域名的不同服务:

```shell
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: path-ingress
spec:
  ingressClassName: nginx
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /api
            pathType: Prefix
            backend:
              service:
                name: api-svc
                port:
                  number: 8080
          - path: /static
            pathType: Prefix
            backend:
              service:
                name: static-svc
                port:
                  number: 80
```

配置 TLS,Secret 必须是 `kubernetes.io/tls` 类型:

```shell
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: tls-ingress
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - www.example.com
      secretName: example-tls     # 与 Ingress 必须在同一命名空间
  rules:
    - host: www.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: frontend-svc
                port:
                  number: 80
```

常用 nginx 注解,换 Controller 后这些注解会全部失效:

```shell
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: annotated-ingress
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /$2
    nginx.ingress.kubernetes.io/ssl-redirect: "true"
    nginx.ingress.kubernetes.io/proxy-body-size: "50m"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "600"
spec:
  ingressClassName: nginx
  rules:
    - host: app.example.com
      http:
        paths:
          - path: /old(/|$)(.*)
            pathType: ImplementationSpecific
            backend:
              service:
                name: new-svc
                port:
                  number: 80
```

IngressClass 定义,多 Controller 共存时用它区分:

```shell
apiVersion: networking.k8s.io/v1
kind: IngressClass
metadata:
  name: nginx
  annotations:
    ingressclass.kubernetes.io/is-default-class: "true"
spec:
  controller: k8s.io/ingress-nginx
```

### 创建 TLS Secret

```shell
kubectl create secret tls example-tls --cert=tls.crt --key=tls.key -n default
```

### 常用操作

```shell
# 查看所有 Ingress,关注 ADDRESS 一栏
kubectl get ingress -A
kubectl get ingress -A -o wide

# 命令行快速创建一条规则
kubectl create ingress demo --class=nginx --rule="www.example.com/=frontend-svc:80"

# 查看规则与 Controller 分配到的地址
kubectl describe ingress web-ingress

# 查看 Controller 的访问日志
kubectl -n ingress-nginx logs -l app.kubernetes.io/component=controller --tail=100 -f

# 本地验证路由(绕过 DNS)
curl -H "Host: www.example.com" http://<ingress-ip>/
```

### 排障

```shell
# 1. Ingress 的 ADDRESS 为空 —— Controller 没装或没就绪
kubectl get pods -A | grep -i ingress
kubectl get ingressclass

# 2. 返回 503 —— Service 名或端口写错,或后端 Pod 没有 Ready
kubectl get svc frontend-svc
kubectl get endpoints frontend-svc

# 3. 返回 404 —— Host 或 path 不匹配,看访问日志确认实际请求
kubectl -n ingress-nginx logs <controller-pod> --tail=50 | grep "GET /"

# 4. 证书没生效 —— Secret 类型或命名空间不对
kubectl get secret example-tls -o jsonpath='{.type}'
```

### 注意

1. **必须先部署 Ingress Controller**。Ingress 只是规则声明,没有 Controller 就没人执行,`kubectl get ingress` 会显示 `ADDRESS` 为空但不会报任何错。
2. **`pathType` 在 `networking.k8s.io/v1` 中是必填项**,旧版 `extensions/v1beta1` 可以省略。取值 `Prefix`(按路径段前缀)、`Exact`(完全匹配)、`ImplementationSpecific`(由 Controller 自行解释,带正则的 rewrite 场景用它)。
3. **`Prefix` 的匹配是按路径段而非字符串前缀**。`/api` 能匹配 `/api/v1`,但不会匹配 `/apifoo`,这与 nginx 原生的 `location /api` 行为不同。
4. **TLS Secret 必须与 Ingress 在同一命名空间**,且类型必须是 `kubernetes.io/tls`。用 `kubectl create secret generic` 建出来的 Opaque 类型不会被识别,证书静默失效。
5. **Ingress 不能跨命名空间引用 Service**,backend 只能指向同命名空间的服务;要跨命名空间必须再套一层 ExternalName Service。
6. **不同 Controller 的注解完全不通用**。`nginx.ingress.kubernetes.io/*` 只对 ingress-nginx 有效,换 Traefik 或 APISIX 后这些注解会被静默忽略,重写、超时、上传大小限制统统失效。
7. **注解拼错不会报错,只会被忽略**。`proxy-body-size` 写成 `proxy-bodysize`,Ingress 依然创建成功,但大文件上传照样 413,排查时务必对照官方注解文档核对拼写。
8. **`rewrite-target` 与 `use-regex` 常常要配对使用**,否则正则捕获组不生效,重写结果与预期不符;`/$2` 这类占位符只在 `ImplementationSpecific` 路径下才有意义。
9. **Ingress 只处理 HTTP/HTTPS**。gRPC、MySQL、Redis 等非 HTTP 协议需要靠 Controller 的 TCP/UDP 转发配置,或改用 Gateway API 与 LoadBalancer Service。
10. **多个 Ingress 命中同一 host 与 path 时行为未定义**,不同 Controller 的优先级规则不同,应避免规则重叠。

### 相关命令

- `kubectl` — Kubernetes集群管理工具
- `service` — Ingress的后端,提供四层负载均衡
- `secret` — 存储Ingress所需的TLS证书
- `namespace` — Ingress与后端Service的作用域边界
- `kubeadm` — Kubernetes集群安装与生命周期管理工具

### 参考链接

- [Ingress 官方文档](https://kubernetes.io/docs/concepts/services-networking/ingress/)
- [Ingress Controller](https://kubernetes.io/docs/concepts/services-networking/ingress-controllers/)
- [ingress-nginx 注解文档](https://kubernetes.github.io/ingress-nginx/user-guide/nginx-configuration/annotations/)
