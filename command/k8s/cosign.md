cosign
===

Sigstore容器镜像签名与验签工具

## 补充说明

**cosign** 是 **Sigstore** 项目的命令行工具,用于给容器镜像和其他 OCI 制品做**数字签名与验签**,解决的是供应链问题:「你拉下来的这个镜像,真的是那个团队构建并批准的版本吗?」

它有三个关键设计:

```shell
签名存放在镜像仓库里    签名作为独立的 OCI 制品推到同一个 registry,不需要额外的签名服务器
支持 keyless(无密钥)   不需要自己生成和保管私钥,用 OIDC 身份换取短时证书
提供透明日志            签名行为被记录进 Rekor,可公开审计,事后无法抵赖
```

**keyless 是默认模式**,也是 cosign 与「自己管一堆 GPG 私钥」最大的区别。它的流程是:

```shell
1. cosign 生成一对临时密钥,只在内存中存活
2. 拿 OIDC 身份(如 GitHub Actions 的 token)向 Fulcio 申请证书
3. Fulcio 签发一张约 10 分钟有效期的证书,把公钥绑定到该身份
4. 用临时私钥签名,私钥随即丢弃
5. 签名与证书一起写入镜像仓库,Rekor 记录一条可验证的存在性证明
```

验签时看的是「签名发生的那一刻,证书是否有效、身份是谁」,而不是「证书现在是否还在有效期内」——所以十年后依然能验证今天的签名。

两种签名方式对比:

| 方式 | 私钥 | 需要联网 | 适用场景 |
| --- | --- | --- | --- |
| keyless | 临时生成,用完即弃 | 需要(Fulcio + Rekor) | CI 流水线,推荐 |
| 密钥对 | 自己生成并保管 | 不需要 | 气隙环境、必须离线签名的场景 |

### 安装

```shell
# macOS / Linuxbrew
brew install cosign

# 用 Go 安装
go install github.com/sigstore/cosign/v3/cmd/cosign@latest

# 从 GitHub Releases 下载二进制
curl -LO https://github.com/sigstore/cosign/releases/latest/download/cosign-linux-amd64
sudo install -m 755 cosign-linux-amd64 /usr/local/bin/cosign

# 容器方式
docker run --rm gcr.io/projectsigstore/cosign:latest version

# 验证
cosign version

# 私有仓库需要先登录
cosign login registry.example.com -u <用户名> -p <密码>
```

### 语法

```shell
cosign <子命令> [flags] <镜像或文件>
```

```shell
cosign generate-key-pair      生成密钥对
cosign sign                   给镜像签名
cosign verify                 验证镜像签名
cosign sign-blob              给普通文件签名
cosign verify-blob            验证普通文件签名
cosign attest                 附加并签名一条证明(attestation)
cosign verify-attestation     验证证明
cosign attach sbom            附加 SBOM(不签名)
cosign download               下载签名或证明
cosign tree                   查看镜像上挂载了哪些签名与证明
cosign clean                  清理镜像上的签名制品
cosign initialize             拉取最新的 TUF 根,用于离线校验
cosign version                查看版本
```

### 密钥对方式

```shell
# 1. 生成密钥对:私钥 cosign.key(加密,0600)、公钥 cosign.pub
cosign generate-key-pair

# 非交互式生成(CI 中避免卡在密码提示)
COSIGN_PASSWORD=<强口令> cosign generate-key-pair

# 生成后立刻把公钥分发出去,私钥务必放进密钥管理服务
cat cosign.pub

# 2. 按 digest 签名(不要用可变的 tag)
cosign sign --key cosign.key registry.example.com/app@sha256:xxxx

# 3. 验签
cosign verify --key cosign.pub registry.example.com/app@sha256:xxxx

# 4. 查看镜像上挂载的签名与证明
cosign tree registry.example.com/app@sha256:xxxx

# 5. 清理签名
cosign clean registry.example.com/app@sha256:xxxx
```

使用 KMS 托管私钥,避免私钥落盘:

```shell
cosign generate-key-pair --kms awskms:///arn:aws:kms:cn-north-1:123456789012:key/xxxx
cosign sign --key awskms:///arn:aws:kms:cn-north-1:123456789012:key/xxxx <镜像>
```

### keyless 签名

```shell
# 签名:自动走 OIDC 流程,浏览器弹出登录(GitHub / Google / 微软等)
cosign sign registry.example.com/app@sha256:xxxx

# 在 CI 中跳过交互确认
cosign sign --yes registry.example.com/app@sha256:xxxx
```

验签时**必须**给出身份与签发者,二者缺一会直接被拒绝:

```shell
cosign verify \
  --certificate-identity-regexp '^https://github.com/myorg/myrepo/.+$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  registry.example.com/app@sha256:xxxx
```

```shell
# 精确匹配某个工作流身份
cosign verify \
  --certificate-identity 'https://github.com/myorg/myrepo/.github/workflows/release.yml@refs/heads/main' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  registry.example.com/app@sha256:xxxx

# 签发者用正则匹配(如同时接受多个 OIDC 提供方)
cosign verify \
  --certificate-identity-regexp '^https://gitlab.com/mygroup/' \
  --certificate-oidc-issuer-regexp '^https://gitlab.com$' \
  registry.example.com/app@sha256:xxxx
```

验签成功会输出每条签名的证书身份、签发者与时间戳,并以 `0` 退出;失败返回非零,可直接用作准入卡点。

### 文件签名

```shell
# 生成签名并打包成 bundle(bundle 内含签名、证书与透明日志证明)
cosign sign-blob artifact.tar.gz --bundle artifact.sigstore.json

# 验签:有 bundle 即可离线完成
cosign verify-blob artifact.tar.gz \
  --bundle artifact.sigstore.json \
  --certificate-identity-regexp '^https://github.com/myorg/myrepo/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

# 用密钥对签名
COSIGN_PASSWORD=<口令> cosign sign-blob --key cosign.key \
  --bundle artifact.sigstore.json artifact.tar.gz

cosign verify-blob --key cosign.pub --bundle artifact.sigstore.json artifact.tar.gz
```

### 证明(attestation)与 SBOM

attestation 用 in-toto 格式记录「这个镜像**是怎么构建出来的**」,而不只是「它是谁签的」:

```shell
# 附加 CycloneDX 格式的 SBOM
trivy image --format cyclonedx --output sbom.cdx.json registry.example.com/app:v1
cosign attest --predicate sbom.cdx.json --type cyclonedx \
  registry.example.com/app@sha256:xxxx

# 附加 SLSA 构建证明
cosign attest --predicate provenance.json --type slsaprovenance \
  registry.example.com/app@sha256:xxxx

# 验证证明
cosign verify-attestation --type cyclonedx \
  --certificate-identity-regexp '^https://github.com/myorg/myrepo/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  registry.example.com/app@sha256:xxxx

# 只附加 SBOM 而不签名
cosign attach sbom --sbom sbom.cdx.json registry.example.com/app@sha256:xxxx
```

### 在 GitHub Actions 中签名

```shell
# 工作流必须声明 id-token: write,否则拿不到 OIDC token
# permissions:
#   id-token: write
#   contents: read
#
# steps:
#   - uses: sigstore/cosign-installer@v3
#   - run: cosign sign --yes registry.example.com/app@${{ steps.build.outputs.digest }}
```

cosign v3 起 GitHub 不再自动注入 ID token,工作流需要显式导出:

```shell
export SIGSTORE_ID_TOKEN=$(curl -sS -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=sigstore" | jq -r .value)
cosign sign --yes registry.example.com/app@sha256:xxxx
```

### 与 Kubernetes 结合

在准入门上强制「只有验签通过的镜像才能部署」,有两种主流做法:

```shell
# 方式一:sigstore policy-controller(官方,本身就是一个准入 Webhook)
# 安装后创建 ClusterImagePolicy,声明允许的身份与签发者,
# 不符合的 Pod 会被 admission webhook 拒绝

# 方式二:Kyverno 的 verifyImages 规则
kubectl get clusterpolicies
kubectl describe clusterpolicy verify-image-signatures
```

Kubernetes 官方文档中「Verify Signed Kubernetes Artifacts」一节给出了用 cosign 校验控制平面镜像的完整示例:

```shell
cosign verify registry.k8s.io/kube-apiserver-amd64:v1.37.0 \
  --certificate-identity krel-trust@k8s-releng-prod.iam.gserviceaccount.com \
  --certificate-oidc-issuer https://accounts.google.com | jq .
```

### 注意

1. **永远按 digest 签名,不要按 tag**。tag 是可变的,今天签的 `app:v1` 明天可能指向完全不同的镜像,而签名依然「有效」。正确做法是构建后取 digest,`cosign sign <repo>@sha256:...`。
2. **keyless 验签不写 `--certificate-identity` 和 `--certificate-oidc-issuer` 会失败**。自 cosign 2.0 起这两个条件是强制的 —— 这不是麻烦,而是防止「只要有 Sigstore 签名就放行」这种形同虚设的校验。必须指定到具体的仓库/工作流身份。
3. **keyless 依赖 Fulcio 与 Rekor 两个公共服务**。签名时必须能访问 `fulcio.sigstore.dev` 与 `rekor.sigstore.dev`;气隙环境只能改用密钥对方式,或自建 Fulcio/Rekor 实例。
4. **临时证书只有约 10 分钟有效期,验签不看「证书现在是否过期」**。验的是签名时刻的证书链与 Rekor 中的时间戳证明,所以签名不会随时间失效;但这也意味着**签名时刻**必须落在证书有效期内,Rekor 记录是这一点的唯一凭证。
5. **私有仓库需要先 `cosign login`**。签名是往 registry 推一个额外的 OCI 制品,凭据不足时签名失败,报错常表现为 `unauthorized`,容易误判成签名逻辑问题。
6. **签名制品会占用仓库空间与配额**。每次签名都会在仓库里留下以 `sha256-<digest>.sig` 命名的制品,签名与 attestation 累积起来可能触发仓库的存储或对象数限制,`cosign clean` 可以清理。
7. **删除签名不等于撤销**。Rekor 中的记录是公开且不可删除的,已经泄露的私钥所签出的内容永远可以被验证为「曾用该身份签过」。私钥泄露必须走吊销与轮换流程,而不是删签名制品。
8. **`COSIGN_PASSWORD` 为空等于私钥不加密**。`COSIGN_PASSWORD="" cosign generate-key-pair` 生成的 `cosign.key` 是明文的,仅可用于本地测试;生产环境应使用强口令或 KMS。
9. **cosign v3 的 bundle 与旧参数不兼容**。`--output-signature`、`--signature` 在 v3 中已废弃并计划移除,统一改用 `--bundle`;v3 生成的 protobuf bundle 内嵌 Fulcio 证书,验证逻辑与 v2 不同。新旧版本混用时要在工具链里锁定版本,不要指望双向完全兼容。
10. **v3 还废弃了 `cosign triangulate`、`cosign copy`、`--offline` 等命令与参数**。脚本里若用到这些,需要提前迁移;因为 bundle 已自包含验证材料,离线验证不再需要单独的 `--offline`。
11. **GitHub Actions 的 OIDC 有个常见坑**。忘记 `permissions: id-token: write`,或 v3 下没有显式导出 `SIGSTORE_ID_TOKEN`,keyless 签名会报 `getting signer: getting key from Fulcio: getting ID token: ...` 一类的错误,而报错信息往往指向浏览器登录,极具误导性。
12. **`cosign verify` 成功只说明「签名有效」,不说明「镜像安全」**。签名保证来源与完整性,不保证镜像里没有漏洞 —— 漏洞扫描是 `trivy` 的职责,两者必须一起用。
13. **签名前镜像必须已经推到仓库**。cosign 是往 registry 追加制品,不能给一个只存在于本地 docker daemon 的镜像签名。
14. **准入校验失败会阻塞整个部署**。把 cosign 验签接进 admission webhook 后,验签服务不可用或 Rekor 不可达都可能让 Pod 建不出来,务必参照 `admission-webhook` 页面配置好 `failurePolicy`、超时与豁免范围。

### 相关命令

- `trivy` — 扫描镜像漏洞与配置,与签名共同构成供应链防线
- `admission-webhook` — 在准入阶段强制验签的落地机制
- `kubectl` — Kubernetes集群管理工具
- `kube-bench` — CIS 基线检查
- `helm` — 部署时常用的制品来源之一,supply chain 同样需要覆盖

### 参考链接

- [Sigstore 官方文档](https://docs.sigstore.dev/)
- [cosign 命令参考](https://docs.sigstore.dev/cosign/signing/overview/)
- [cosign GitHub 仓库](https://github.com/sigstore/cosign)
- [Sigstore 签名规范与 bundle 格式](https://docs.sigstore.dev/about/bundle/)
- [验证已签名的 Kubernetes 制品](https://kubernetes.io/docs/tasks/administer-cluster/verify-signed-artifacts/)
- [sigstore policy-controller](https://docs.sigstore.dev/policy-controller/overview/)
