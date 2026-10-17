# 命令速查站(多分支)

Linux / Kubernetes 命令速查站。支持多分支切换,新增分支不需要改代码。

## 快速开始

```bash
npm install
npm run build      # 构建到 build/
```

本地预览:

```bash
npx serve build     # 或 python3 -m http.server -d build 8000
```

## 目录结构

```
command/<分支>/<slug>.md   内容源(Markdown)
branches.json              分支注册表
legacy-slugs.json          老 URL 集合(构建时生成 nginx 301 规则)
template/                  EJS 模板
template/snake.ejs         贪吃蛇小游戏页(非命令页)
template/tetris.ejs        俄罗斯方块小游戏页(非命令页)
assets/                    CSS / JS / 图片源
assets/js/snake-core.js    贪吃蛇纯逻辑(可单测)
assets/js/tetris-core.js   俄罗斯方块纯逻辑(可单测)
test/                      单测(node --test)
scripts/                   构建与校验脚本
build/                     构建产物(gitignore)
deploy/nginx/              老 URL 301 配置(gitignore,由 npm run build 生成)
public/  public.zip        发布暂存与打包产物(gitignore,由 npm run package 生成)
```

## 贪吃蛇小游戏

首页页脚有一个「🎮 贪吃蛇」入口,页面在 `/snake.html`。与俄罗斯方块同为站内的非命令页:
不套顶栏与搜索框,由 `template/snake.ejs` + `assets/js/snake-core.js`(纯逻辑)+
`assets/js/snake.js`(渲染/输入)组成,随 `npm run build` 一起产出。

按键:方向键控制,回车确认(开始 / 继续 / 再来一局),空格返回上一级
(未开始与结束界面直接回首页,游戏中则暂停)。触屏设备会显示四个方向按钮。

## 俄罗斯方块小游戏

首页页脚另一个入口「🧱 俄罗斯方块」,页面在 `/tetris.html`。与贪吃蛇同构:
`template/tetris.ejs` + `assets/js/tetris-core.js`(纯逻辑)+ `assets/js/tetris.js`(渲染/输入)。

按键:`←→` 移动(按住连发)、`↑`/`X` 顺时针、`Z` 逆时针、按住 `↓` 软降、`回车` 硬降、
`C` 暂存、`空格` 暂停或返回(与贪吃蛇一致)。触屏底部五个按钮,`▼` 轻点软降一格、
长按 0.25 秒硬降。

规则:7-bag 随机、SRS 踢墙、500ms 锁定延迟、幽灵落点、下一块预览、暂存(每块限一次)、
消行闪烁;单/双/三/四行计 100/300/500/800 分 × 等级,每 10 行升级。

> 两个游戏页都是 ES module,必须经 HTTP 打开 —— 直接双击 `build/*.html`(file://)不会运行。
> 本地预览用 `npx serve build` 或 `python3 -m http.server -d build 8000`。

`npm test` 跑两个游戏的核心逻辑单测(需要 Node ≥ 18)。

## 新增一个命令页

在对应分支目录下新建 `command/<分支>/<slug>.md`,格式:

```markdown
<slug>
===

一行中文描述

## 补充说明

**<slug>命令** 是……

### 语法

```shell
命令示例
```

### 注意

1. ……

### 相关命令

- `其他命令` — 说明

### 参考链接

- [标题](https://example.com)
```

**两条硬性规则:**

1. **第一行必须与文件名(去掉 `.md`)完全一致。** 产物文件名取标题,而链接取文件名 —— 二者不一致必然 404。构建会拦截并报错。
2. **文件名必须是 ASCII slug**(`pod`、`kube-proxy`),不能有空格或中文。中文只能出现在描述与正文里。

描述取自 `===` 之后、第一个 `##` 之前的内容,进搜索索引。

## 新增一个分支

1. 建目录 `command/<分支id>/`,放入 `.md`
2. 在 `branches.json` 的 `branches` 数组里加一条:

```json
{
  "id": "docker",
  "name": "Docker",
  "desc": "容器运行时与镜像管理",
  "searchPlaceholder": "搜索 Docker 命令",
  "default": false
}
```

3. `npm run build`

分支标签自动出现在首页与所有内页顶栏,搜索索引、总览页分组、计数全部自动更新。**无需改动任何代码。**

`id` 必须与目录名一致。`"default": true` 只能有一个。

### 老 URL 301(`legacy-slugs.json`)

曾经发布过的 `/c/<slug>.html` 老 URL 固化在这个文件里。构建时按 slug 查当前页面,
生成 `deploy/nginx/legacy-redirects.conf`,每条形如:

```nginx
location = /c/ls.html { return 301 https://www.dos2unix.cn/linux/ls.html; }
```

**不再生成 HTML 跳转 stub。** 这是关于历史的事实,与页面现在归属哪个分支无关 ——
把页面迁到别的分支后,老 URL 依然有效,不需要改这里。若存在找不到目标页的 slug,
构建会直接失败,避免出现指向 404 的 301。

`aliases` 用于同一页面曾以多个名字发布的特殊情况(如 `pullgcc` 与 `gcc`)。

同名跨分支时(如 `pv`、`service` 在两个分支都有),老 URL 指向**默认分支**的那个;其余情况按 slug 直接匹配。构建日志会打印实际解析结果。

**部署(可选)**:有 nginx 配置权限时,把 `deploy/nginx/legacy-redirects.conf`
上传到服务器(例如 `/etc/nginx/snippets/dos2unix-legacy.conf`),在站点
`server {}` 内加一行:

```nginx
include /etc/nginx/snippets/dos2unix-legacy.conf;
```

然后 `nginx -t && nginx -s reload`。**先上 nginx 配置,再发布不含 `/c/` 的新产物**,
避免旧 URL 出现 404 窗口。

没有 nginx 配置权限时可以忽略该文件:旧 `/c/<slug>.html` 会返回 404。
基于当前索引状态(百度只收录了 2 个首页,Bing/Google 没有 `/c/` 结果),
这个损失可以接受;如果以后发现某个旧 URL 有外链,再用托管平台的重定向功能处理。

## 校验与发布

```bash
npm run validate       # 命名与结构校验
npm run check-links    # 产物内链完整性(零 404)
npm run verify         # build + validate + check-links
npm run package        # verify + 暂存 public/ + 打包 public.zip(可直接上传)
```

`npm run package` 产出的 `public.zip` 与 `build/` 逐字节一致 —— 打包用系统
`zip` 并排除 `__MACOSX`/`.DS_Store`(Linux/Windows 解包不会多出一堆 `._*`),
完成后还会自检条目数与解压体积。`public/` 与 `public.zip` 均为本地暂存产物,
每次发布重新生成。

> 保真度校验(`fidelity.mjs`)已在迁移完成后退役:它的比对基线是旧站产物 `public/c/*.html`,
> 该目录已于 2026-10-01 随新站上线清理。历史实现见 commit `96d0bfa`。

## SEO 产物

构建会自动产出:

- `robots.txt`:允许抓取,并指向 `https://www.dos2unix.cn/sitemap.xml`
- `sitemap.xml`:首页、分支页、`hot.html`、分类页与全部命令页(约 888 条)
- 每页独立的 `<title>` / `meta description` / `canonical` / Open Graph
- `404.html`:托管平台若默认读取根目录 404 页面,可直接生效(不需要 nginx)
- `deploy/nginx/legacy-redirects.conf`:老 `/c/<slug>.html` → 新地址的 301 规则(有 nginx 权限时使用)

标题与描述在 `scripts/build.mjs` 的页面渲染段集中生成,不再使用模板拼接。
`list.html`、`snake.html`、`tetris.html`、`404.html` 均为 `noindex,follow`。

## Kubernetes 二级分类

`command/k8s/categories.json` 定义 K8s 分支的二级分类:

- `categories`: 分类 id、名称、顺序、短描述 `desc`、长描述 `longDesc`
- `assignments`: 每个页面 slug → 分类 id

构建时会校验:

- 每个 `command/k8s/*.md` 必须出现在 `assignments` 里
- `assignments` 里的 slug 必须有对应页面
- 每个分类至少有 1 个页面

分类页自动生成到 `/k8s/category/<id>/`,并加入 `sitemap.xml`(priority 0.7)。
`npm run category-map` 会重新生成 `docs/seo/k8s-category-map.md` 供人工审阅。

新增 K8s 页面时,先在 `categories.json` 的 `assignments` 里归类,否则构建失败。

## 百度主动推送

```bash
npm run build              # 先生成 sitemap.xml
npm run baidu:push         # 默认推送 www 域名,最多 100 条新增/变更
npm run baidu:push -- --limit=50
npm run baidu:push -- --all
npm run baidu:push -- --site=dos2unix.cn   # 推送裸域版本
npm run baidu:push -- --dry-run
```

Token 读取顺序:`--token=` > `BAIDU_TOKEN` 环境变量 > `.baidu-token` 文件(gitignore)。
已推送状态记录在 `deploy/baidu-pushed.json`,只有内容变化才会再次推送。
**先部署新版本,再执行推送**——否则百度抓到的是旧页面。

## 架构说明

`js/dt.js` 里的每条记录形如:

```js
{"n":"helm","p":"/linux/helm","d":"Kubernetes包管理器","b":"linux"}
```

`p` 是**完整路径**(含分支),因此链接拼接是 `${站点根}${p}.html`。这也是构建脚本能直接从 `p` 反推源文件路径(`command/linux/helm.md`)的原因。

完整设计文档见 `docs/superpowers/specs/2026-09-18-branch-architecture-design.md`。

## 内容覆盖

| 分支 | 页面 | 说明 |
|---|---|---|
| Linux | 618 | 上游 jaywcjlove/linux-command 的命令集 |
| Kubernetes | 254 | 集群与节点、工作负载、网络、存储、安全、可观测性、CI/CD、服务网格、Operator、发行版等 |

Kubernetes 分支按方向划分:

```
集群与节点   kubeadm kubelet kube-proxy kube-apiserver etcd crictl ctr kubeconfig node ...
调度与资源   kube-scheduler affinity taints-tolerations priority-class poddisruptionbudget
             topology-spread resource-quota limitrange qos descheduler cluster-autoscaler vpa
工作负载     pod deployment statefulset daemonset job cronjob replicaset hpa
网络         service ingress networkpolicy coredns cni calico cilium flannel metallb multus ...
配置与存储   configmap secret pvc pv storageclass namespace csi longhorn rook ceph ...
安全         rbac serviceaccount pod-security-admission securitycontext admission-webhook
             opa gatekeeper kyverno falco trivy cosign sealed-secrets cert-manager vault ...
可观测性     prometheus alertmanager grafana loki fluent-bit jaeger opentelemetry thanos ...
CI/CD        argocd flux jenkins tekton argo-workflows argo-rollouts keda knative ...
服务网格     istio linkerd envoy kiali gateway-api contour traefik apisix kong nginx-ingress ...
Operator     crd operator kubebuilder operator-sdk olm controller-runtime aggregated-apiserver
发行版       k3s k0s talos microk8s k3d minikube kind kubeone rancher karmada kubevela openshift
中间件       postgres-operator mysql-operator redis-operator strimzi elastic-operator ...
运维工具     k9s kustomize velero metrics-server kube-bench kube-state-metrics chaos-mesh ...
```

其中 **`ecosystem-status`** 是一页专门的生态状态汇总:已退役/已归档的项目(含时间点与替代方案)、发生重大变更的项目(如 kube-proxy 的 IPVS 模式废弃、containerd 2.x 配置格式变更)、以及已从 CNCF 毕业的项目。写内容时如引用第三方工具,建议先对照该页确认其是否仍在维护。

> 各页面的 `### 注意` 小节记录的是**经核实的真实坑点**与常见误传的纠正,而非泛泛的最佳实践。

## 内容来源与许可

`command/linux/` 下的全部页面,以及 `command/k8s/` 中的 `kubectl`、`helm`、`docker` 三页,取自 [jaywcjlove/linux-command](https://github.com/jaywcjlove/linux-command)(MIT),是其 `command/*.md` 的内容,合计 621 页。本仓库在此之上加入了分支架构,以及 Kubernetes 分支其余的 251 页内容。

上游的版权声明与许可正文已完整复刻在 [LICENSE](LICENSE) 中 —— 该文件同时给出本站自有部分的许可,并逐条写明各自覆盖哪些路径。**分发本仓库或其内容时,不得移除 LICENSE。**

其中 `gcc.md` 修正了一处上游缺陷:原标题误写为 `pullgcc`,导致产物名为 `pullgcc.html` 而链接指向 `gcc.html`,产生 404。现标题与文件名统一为 `gcc`。

`kubectl`、`helm`、`docker` 三个页面已从 linux 迁至 k8s 分支(它们同属两边,放在 k8s 更符合浏览直觉)。迁移不影响老 URL —— `/c/kubectl.html` 仍会跳转到新位置。
