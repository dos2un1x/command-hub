opa
===

通用策略引擎,用Rego声明式语言把策略决策从应用代码中解耦出来

## 补充说明

**OPA**(Open Policy Agent)是 CNCF 毕业的通用策略引擎。它把「策略决策」从业务代码里抽出来,统一成一次查询:输入一段 JSON(谁、对什么、做什么),输出一段 JSON(允许还是拒绝)。策略本身用 **Rego** 这门声明式语言编写。

OPA 只做决策,**不负责执行**。谁来发起查询、拿到决策后怎么处理,由集成方决定 —— API 网关、CI 流水线、SSH 跳板机,或者 Kubernetes 的准入 webhook。

在 Kubernetes 场景下要区分两个层次:

```shell
OPA(本页)     裸引擎,需要自己接 webhook 才能做准入控制
Gatekeeper     OPA 的 K8s 准入实现,官方推荐做法,见 gatekeeper 页
```

裸 OPA 直接做准入,意味着要自己处理 TLS 证书、webhook 注册、对象缓存与策略分发。除非确实需要 OPA 的 bundle 分发、决策日志这类能力,否则 Kubernetes 上不应该绕开 Gatekeeper。

### 安装

```shell
# macOS
brew install opa

# Linux:从 GitHub Releases 下载静态二进制(以 v1.20.2 为例)
curl -LO https://github.com/open-policy-agent/opa/releases/download/v1.20.2/opa_linux_amd64_static
chmod +x opa_linux_amd64_static
sudo install -m 755 opa_linux_amd64_static /usr/local/bin/opa

# Docker
docker run --rm -v "$PWD":/w -w /w openpolicyagent/opa:1.20.2 eval -d policy.rego 'data'

# 确认版本
opa version
```

### 语法

```shell
opa [全局选项] <子命令> [参数]
```

常用子命令:

```shell
opa eval     对策略求值,最常用
opa run      启动 REPL 或 HTTP 服务
opa test     运行策略单元测试
opa fmt      格式化 Rego 代码
opa check    语法与类型检查
opa build    打包成 bundle
opa parse    把 Rego 解析成 AST
opa version  查看版本
```

### Rego v1 策略示例

`package` 声明决定策略的引用路径,**与文件名无关**:

```shell
package authz

import rego.v1

default allow := false

# 单值规则:求值为 true 才代表允许
allow if {
    input.user == "admin"
}

# 多值规则:必须写 contains,集合非空即代表存在拒绝项
deny contains msg if {
    not input.user
    msg := "缺少 user 字段"
}

deny contains msg if {
    input.action == "delete"
    input.user != "admin"
    msg := sprintf("%v 无权执行 delete", [input.user])
}
```

求值:

```shell
# 内联输入
opa eval -d authz.rego 'data.authz.allow'

# 从文件读输入
opa eval -d authz.rego -i input.json 'data.authz'

# 只输出结果值
opa eval -d authz.rego -i input.json --format raw 'data.authz.allow'

# 解释为什么得到这个结果(排障用)
opa eval -d authz.rego -i input.json --explain full 'data.authz.allow'
```

### 单元测试

```shell
package authz_test

import rego.v1
import data.authz

test_admin_allowed if {
    authz.allow with input as {"user": "admin", "action": "read"}
}

test_delete_denied if {
    count(authz.deny) > 0 with input as {"user": "guest", "action": "delete"}
}
```

```shell
# 跑当前目录下所有 *_test.rego
opa test . -v

# 统计覆盖率
opa test . --coverage

# 只跑某个包
opa test authz -v
```

### 作为服务运行

```shell
# 交互式 REPL
opa run

# 启动 HTTP 服务
opa run --server --addr localhost:8181

# 加载策略目录后启动
opa run --server -b ./policies

# 查询
curl -s localhost:8181/v1/data/authz/allow \
  -H 'Content-Type: application/json' \
  -d '{"input": {"user": "admin", "action": "read"}}' | jq
```

OPA 1.0 起服务默认**只监听 `localhost`**,要在容器里被外部访问必须显式写成 `--addr :8181`。

### bundle 打包与分发

```shell
# 打包当前目录
opa build -b . -o bundle.tar.gz

# 查看 bundle 内容
tar -tzf bundle.tar.gz

# 让服务定时拉取远端 bundle
opa run --server \
  --set services.acmecorp.url=https://example.com/bundles \
  --set bundles.acmecorp.resource=bundle.tar.gz

# 校验一个 bundle 是否能正常加载
opa check bundle.tar.gz
```

### 版本迁移

```shell
# 把 v0 语法的策略批量改写成 v1
opa fmt --rego-v1 -w ./policies

# 检查是否还有 v1 不兼容的写法
opa check --rego-v1 ./policies

# 再加严格模式(重复导入、变量遮蔽等)
opa check --rego-v1 --strict ./policies

# 过渡期:整体按 v0 解析
opa eval --v0-compatible -d legacy.rego 'data.legacy.allow'
```

### 注意

1. **Rego v0 与 v1 语法不兼容**。OPA 1.0 起 `if` 与 `contains` 是**强制关键字**,老写法 `p { true }` 会直接报 `rego_parse_error: 'if' keyword is required before rule body`;`violation[{"msg": m}] { ... }` 则报 `` `contains` keyword is required for partial set rules ``。这是从 0.x 升级到 1.x 时最常见的失败原因。
2. **`import rego.v1` 在 1.x 里已是空操作**,但保留它能让同一份策略在 0.5x 与 1.x 上都能解析,升级过渡期建议统一加上。
3. **整体退回 v0 的开关是 `--v0-compatible`**,只能作为临时手段;Go SDK 侧对应 `SetRegoVersion(ast.RegoV0)`,bundle 也可以通过 manifest 声明 `rego_version`。
4. **规则求值为 undefined 时不是 `false`**。没有 `default` 的规则在条件不满足时结果是「未定义」,`data.authz.allow` 查询会返回空结果。在准入、网关这类场景里,「查不到」若被集成方当成「允许」,策略就形同虚设。入口规则一定写 `default allow := false`。
5. **`deny` 是集合,空集合代表通过**。判断是否违规要写 `count(deny) > 0` 或 `deny[_]`;直接写 `if deny` 恒为真(空集合也是真值),会让所有请求都被拒绝。
6. **`input` 与 `data` 是保留字**,1.x 中不能再作为规则名或变量名使用;`with input as {...}` 这种覆盖用法不受影响。
7. **一批内置函数在 1.0 被移除**:`any`、`all`、`re_match`、`net.cidr_overlap`、`set_diff`、`cast_*`,老策略里出现会直接编译失败。`any`/`all` 的替代是 `some` 与 `every`。
8. **OPA 1.0 的服务默认绑定地址改为 `localhost:8181`**,容器化部署时如果沿用旧配置,表现为「容器起来了但调用方连不上」,而且不会有明显报错。
9. **`opa eval` 的 `-d` 可以重复指定**,但多个文件若声明了同一个 `package`,规则会合并 —— 传同一份策略的两个版本会得到难以理解的结果,排查「策略没生效」时先确认加载了哪些文件。
10. **OPA 不含任何执行能力**。部署 OPA 不会自动带来准入控制、不会拦截任何请求;要拦截 Kubernetes 对象必须使用 Gatekeeper,或在自建 webhook 里调用 OPA。
11. **决策日志与状态上报需要单独配置服务**.`decision_logs` 与 `status` 都要求先声明 `services`(含认证凭据),不配置就只有本地日志,合规审计场景下会缺一环。

### 相关命令

- `gatekeeper` — OPA的Kubernetes准入控制器实现
- `kyverno` — Kubernetes原生策略引擎
- `kubectl` — Kubernetes集群管理工具
- `rbac` — Kubernetes基于角色的访问控制
- `kube-apiserver` — 准入 webhook 的调用方

### 参考链接

- [OPA 官方文档](https://www.openpolicyagent.org/docs/)
- [Rego 语言参考](https://www.openpolicyagent.org/docs/policy-language)
- [OPA 1.0 变更与 v0 兼容模式](https://www.openpolicyagent.org/docs/v0-compatibility)
- [在 Kubernetes 中使用 OPA](https://www.openpolicyagent.org/docs/kubernetes)
- [OPA Gatekeeper 官方文档](https://open-policy-agent.github.io/gatekeeper/website/docs/)
