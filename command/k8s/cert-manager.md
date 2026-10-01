cert-manager
===

Kubernetes证书管理控制器,自动完成TLS证书的签发、续期与轮换

## 补充说明

**cert-manager** 是 CNCF 毕业项目,Kubernetes 上事实标准的证书管理控制器。它把「申请证书 → 完成域名验证 → 写入 Secret → 到期续期」这整套流程,变成了声明式资源。

核心概念:

| 资源 | 作用域 | 说明 |
| --- | --- | --- |
| Issuer | 命名空间级 | 定义证书来源(ACME、CA、Vault、自签),只在本命名空间可用 |
| ClusterIssuer | 集群级 | 同上,但能被所有命名空间的 Certificate 引用 |
| Certificate | 命名空间级 | 一张证书的声明:域名、Secret 名、签发者、续期策略 |
| CertificateRequest | 命名空间级 | 一次签发请求,由 Certificate 派生,一般不手工创建 |
| Order / Challenge | 命名空间级 | ACME 流程的中间对象,域名验证的状态在这里 |

签发出来的证书最终写进一个 `kubernetes.io/tls` 类型的标准 Secret,Ingress 或 Gateway 直接引用即可。**这张 Secret 由 cert-manager 完全托管**,手工改动会在下一次 reconcile 时被覆盖。

### 安装

```shell
helm repo add jetstack https://charts.jetstack.io
helm repo update

# 1.15 起用 crds.enabled,旧的 installCRDs 已弃用
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set crds.enabled=true \
  --set crds.keep=true

# 确认
kubectl get pods -n cert-manager
kubectl get crd | grep cert-manager
kubectl api-resources | grep cert-manager.io
```

命令行工具 `cmctl` 在排障时非常有用:

```shell
# macOS
brew install cmctl

# 以 kubectl 插件方式安装时,二进制名为 kubectl-cert_manager
kubectl cert-manager status certificate example-tls -n default

# 独立的 cmctl 用法完全一致
cmctl status certificate example-tls -n default
```

### Issuer 与 ClusterIssuer

命名空间级的 Issuer —— 只能签发本命名空间的 Certificate:

```shell
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: selfsigned
  namespace: default
spec:
  selfSigned: {}
```

集群级的 ClusterIssuer —— 最常用于 Let's Encrypt:

```shell
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ops@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
      - http01:
          ingress:
            ingressClassName: nginx
      - dns01:
          route53:
            region: us-east-1
        selector:
          dnsZones:
            - example.com
```

**联调阶段务必先用 staging 端点**,把它换成:

```shell
https://acme-staging-v02.api.letsencrypt.org/directory
```

正式环境有严格的速率限制(同一组域名每周 50 张),调试时打满配额会被锁一周。

### 方式一:Certificate 资源

最明确、最推荐的方式,续期参数也能自己控制:

```shell
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: example-tls
  namespace: default
spec:
  secretName: example-tls            # 生成的 Secret 名
  duration: 2160h                    # 证书有效期 90 天
  renewBefore: 360h                  # 到期前 15 天开始续期
  privateKey:
    algorithm: ECDSA
    size: 256
  dnsNames:
    - example.com
    - www.example.com
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
```

### 方式二:Ingress 注解

由 **ingress-shim** 自动创建 Certificate:

```shell
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    # 引用命名空间级 Issuer 时改成 cert-manager.io/issuer
spec:
  ingressClassName: nginx
  tls:
    - hosts:
        - example.com
      secretName: example-tls        # 必须显式声明,否则不会签发
  rules:
    - host: example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: web
                port:
                  number: 80
```

### 方式三:Gateway API

```shell
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: web
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  gatewayClassName: envoy
  listeners:
    - name: https
      port: 443
      protocol: HTTPS
      hostname: example.com
      tls:
        mode: Terminate
        certificateRefs:
          - name: example-tls
```

注意 cert-manager 目前**只读取 Gateway 对象上的注解**,不看 HTTPRoute —— 共享 Gateway 的多租户自助签发要等 Gateway API 的 `ListenerSet`(cert-manager 1.20 起提供实验性的 `XListenerSet` 支持,稳定支持规划在 1.21/1.22)。

### ACME challenge 类型

```shell
http01     在 Ingress 或 Gateway 上暴露 /.well-known/acme-challenge/ 路径
dns01      在 DNS 里写一条 TXT 记录
```

选型判断:

```shell
域名能从公网访问 80 端口        → http01 最简单
需要泛域名 *.example.com        → 只能用 dns01(ACME 协议限制)
源站不能对签发方暴露 / 有 WAF   → dns01
```

`dns01` 需要给 cert-manager 配置 DNS 服务商的写权限。优先使用工作负载身份(如 AWS IRSA、GCP Workload Identity),其次才是 API Token;用 Token 时把权限收窄到具体 Zone,并放进 Secret 后用 `apiTokenSecretRef` 引用。

### 查看与排障

```shell
# 资源总览:READY 列必须为 True
kubectl get certificate,issuer,clusterissuer -A
kubectl get certificaterequest,order,challenge -A

# 详细状态与事件
kubectl describe certificate example-tls -n default
cmctl status certificate example-tls -n default

# 手动触发一次续期
cmctl renew example-tls -n default

# 检查签出来的证书内容
kubectl get secret example-tls -n default \
  -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -noout -dates -subject -issuer

# 控制器日志
kubectl logs -n cert-manager -l app.kubernetes.io/component=controller -f

# 查 ACME 卡在哪一步
kubectl describe challenge -A
```

### 关于 ingress-nginx 退役

`ingress-nginx` 已于 2025 年 11 月 11 日宣布退役,2026 年 3 月停止维护,仓库转为只读。需要注意:

```shell
Ingress API 本身没有被移除,现有 Ingress 清单仍然有效
cert-manager 的 ingress-shim 依赖的是 Ingress 资源,不是某个控制器
因此更换 Ingress Controller 后,cert-manager 的注解写法不需要改
```

官方给出的迁移建议是**先迁到仍在维护的 Ingress Controller**(如 Traefik、Kong、HAProxy Ingress,或 F5 的 NGINX Ingress Controller),等到 cert-manager 提供稳定的 `ListenerSet` 支持后,再规划向 Gateway API 迁移。

### 注意

1. **Issuer 是命名空间级的,ClusterIssuer 才是集群级**。`Issuer` 只能签发**同命名空间**的 Certificate,跨命名空间引用会一直卡在 `Ready=False`,报 `Referenced "Issuer" not found`。多命名空间共用请用 `ClusterIssuer`。
2. **Ingress 上的 `secretName` 不能省**。cert-manager 靠 `spec.tls[].secretName` 决定证书写到哪里,只写注解不写 `tls` 段,注解会被**静默忽略** —— 没有报错,也没有证书,只有 `kubectl get certificate -A` 里空空的列表。
3. **ACME 有速率限制,必须先用 staging**。Let's Encrypt 正式环境对同一组域名有每周 50 张的限额,反复调试很容易打满并被锁一周。第一次一定用 staging 端点跑通全流程再切 prod。
4. **http01 要求域名真实可达**。签发时 ACME 服务器要从公网访问 `http://<域名>/.well-known/acme-challenge/<token>`。域名没解析、Ingress 未生效、只开了 443 没开 80、WAF 拦了该路径,都会让 challenge 停在 `pending`。
5. **dns01 的 DNS 写权限要收窄**。给 cert-manager 一个能改账号下**所有**域名的 Token 是典型的过度授权;应限制到具体 Zone,并优先使用工作负载身份而非静态密钥。
6. **泛域名证书只能走 dns01**。`*.example.com` 无法通过 http01 验证,这是 ACME 协议本身的限制,不是配置问题。
7. **续期是自动的,但依赖控制器存活**。`renewBefore` 未设置时,默认在证书剩余有效期 2/3 时续期。控制器长时间不可用,或 Certificate 被误删,续期链条就断了 —— 巡检时重点看 `kubectl get certificate -A` 的 `READY` 与 `RENEWAL TIME` 两列。
8. **Certificate 会覆盖它管理的 Secret**。手工往 `example-tls` 里塞证书不会生效,下一次 reconcile 就被改回去。要纳管已有证书,应让 Certificate 的 `secretName` 指向它,并保证 `duration`、`issuerRef` 与现网证书一致。
9. **`crds.enabled` 已取代 `installCRDs`**。cert-manager 1.15 起 `installCRDs` 弃用,继续使用会打印告警;CRD 由 Helm 管理时,卸载 release 会连带删除 CRD,因此建议同时设置 `crds.keep=true`。
10. **`ClusterIssuer` 引用的凭据 Secret 必须在 cert-manager 所在命名空间**。以 `ClusterIssuer` 引用 `apiTokenSecretRef` 或 `accessKeySecretRef` 时,Secret 要建在 `cert-manager` 命名空间(可用 `--cluster-resource-namespace` 改);建在业务命名空间里会报找不到 Secret。
11. **并发签发同一域名会互相覆盖**。多个 Certificate 声明同一个 `secretName` 或多个 Ingress 使用同一张证书名,会让它们反复改写同一个 Secret,表现为证书「时好时坏」。一个 Secret 只由一个 Certificate 管理。

### 相关命令

- `secret` — 证书最终写入的TLS类型Secret
- `ingress` — 通过注解自动触发签发
- `gateway-api` — 新的入口API与TLS声明方式
- `kubectl` — Kubernetes集群管理工具
- `helm` — 安装cert-manager的主要方式

### 参考链接

- [cert-manager 官方文档](https://cert-manager.io/docs/)
- [Helm 安装](https://cert-manager.io/docs/installation/helm/)
- [ACME 与 Let's Encrypt 配置](https://cert-manager.io/docs/configuration/acme/)
- [Gateway API 支持](https://cert-manager.io/docs/usage/gateway/)
- [Ingress NGINX 退役公告](https://kubernetes.io/blog/2025/11/11/ingress-nginx-retirement/)
