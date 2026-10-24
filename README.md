# 命令速查站(多分支)

Linux / Windows / macOS / Kubernetes / DevOps / 排障 / 指南 / 中间件 / 教程 / AI 与 MLOps 多分支速查站。支持多分支切换,新增分支不需要改代码。

## 快速开始

需要 Node.js 22 及以上版本。

```bash
npm install
npm run build      # 构建到 build/
```

本地预览:

```bash
npx serve build     # 或 python3 -m http.server -d build 8000
```

### 内容源是私有子模块

`command/` 是私有仓库 `dos2un1x/command` 的 git submodule。公开 clone 只包含站点代码；没有该仓库读取权限时，`npm run build` / `npm run verify` 会提示初始化子模块并停止。

有权限的人首次拉取后执行:

```bash
git submodule update --init --recursive
```

也可以直接 `git clone --recurse-submodules git@github.com:dos2un1x/command-hub.git`。

内容变更在 `command/` 子模块内提交并推送，然后在 `command-hub` 提交更新后的子模块指针:

```bash
git -C command add .
git -C command commit -m "content: ..."
git -C command push

git add command
git commit -m "chore(content): 更新 command 子模块"
```

GitHub Actions 用只读 Deploy Key 拉取该子模块；没有权限的公开贡献者可以运行 `npm test`，但不能完整构建。站点发布后的 HTML/搜索索引仍然是公开的，私有化保护的是 Markdown 源与提交历史。

## 目录结构

```
command/<分支>/<slug>.md   内容源(Markdown,私有子模块)
branches.json              分支注册表
template/                  EJS 模板
template/snake.ejs         贪吃蛇小游戏页(非命令页)
template/tetris.ejs        俄罗斯方块小游戏页(非命令页)
template/review.ejs        每日复习页
template/diagnose.ejs      故障诊断向导页
assets/                    CSS / JS / 数据源
assets/data/diagnose.json  诊断向导决策树数据
assets/js/snake-core.js    贪吃蛇纯逻辑(可单测)
assets/js/tetris-core.js   俄罗斯方块纯逻辑(可单测)
test/                      单测(node --test)
scripts/                   构建与校验脚本(scripts/lib/ 为公共解析与 SEO 逻辑)
build/                     构建产物(gitignore)
deploy/                    本地部署状态与日志(gitignore)
public/  public.zip        发布暂存与打包产物(gitignore,由 npm run package 生成)
```

## 首页

`template/index.ejs` 渲染十分支入口,采用蓝紫渐变、圆角卡片与胶囊式分支标签,让首页到内页的过渡保持连续。页面包含品牌文字标识、分支切换、全局搜索、条目/分支/分类统计、按目的进入的“我想…”(查命令 / 学一个领域 / 排故障 / 上线服务 / 跟着向导查)五张场景卡与“每日复习”“故障诊断向导”入口、十个分支索引卡(名称、描述、分类与条目数)、跨分支高频入口,以及首屏可见的“小彩蛋”游戏入口。样式集中在 `assets/css/index.css` 的首页段落;分支卡片与计数由构建参数 `branchCards` 注入,各分支页顶部的学习路径入口由 `branches.json` 的 `learningPath` 字段注入。

首页不按单一命令站组织,而是把 Linux、Windows、macOS、Kubernetes、DevOps、排障、指南、中间件、教程、AI 与 MLOps 作为十个并列入口;页脚保留“全部条目”“故障诊断向导”“每日复习”、收藏提示、备案号与署名。

## 学习层

站点在“查”之外提供一条“学”的路径,相关页面集中在指南分支的“学习路径”类目:

- `/guide/learning-paths.html`:总入口,列出 12 条领域路径、12 个心智模型和 22 个故障演练,并给出六周推进建议。
- 学习路径:每个领域 4 个阶段,每阶段含阅读顺序(通常 7–13 个真实站内链接)、动手任务和过关标准,如 `linux-learning-path`、`k8s-learning-path`;另有可观测性、数据库、网络三条跨域路径。
- 心智模型:每个领域一页,只讲 5–7 个核心概念和它们的关系,如 `linux-mental-model`、`observability-mental-model`。
- 故障演练:教程分支 `lab` 类目的 22 页(12 个基础 + 10 个进阶),在 kind、Docker Compose 或临时目录里注入故障,按“观察 → 判断 → 修复 → 复盘”练习,不碰生产;`lab-learning-path` 给出四周基础计划和进阶插入方式。
- 故障复盘:排障分支的 15 篇匿名化合成案例(如 `incident-dns-ndots`、`incident-etcd-quorum`),按“现象 → 时间线 → 影响面 → 误导线索 → 根因 → 修复 → 预防”展开,用于练习从错误线索中收敛。
- 恢复 Runbook:指南分支的 `runbook-etcd-restore`、`runbook-velero-restore`、`runbook-postgres-pitr`、`runbook-kafka-restore`、`runbook-es-restore`、`runbook-k8s-upgrade`、`runbook-cert-rotation`、`runbook-db-failover`,按“前置检查 → 恢复步骤 → 验证 → 失败回滚”组织;新增页面均从事故响应手册、排障学习路径和灾难恢复页手工入链。
- 平台生命周期:`platform-lifecycle-matrix` 汇总操作系统、Kubernetes 与 DevOps 工具的支持窗口和升级节点;`version-eol-matrix` 继续维护 K8s/AI/中间件的版本与 EOL。
- 公开事故复盘:指南分支收录 AWS S3 2017、GitLab 2017、GitHub 2018、Cloudflare 2019/2020、CircleCI 2023、Slack 2021、Datadog 2023、Roblox 2021、Facebook 2021、Google Cloud 2019、AWS Kinesis 2020 共 12 篇摘要与检查清单,事实以原始报告为准。
- 精确错误页:排障分支覆盖 `x509`、`connection reset`、`context deadline exceeded`、`i/o timeout`、`TLS handshake timeout` 等精确报错;Windows/macOS 排障单独成类。
- 读完自测:全部 2,011 个页面在页尾有 3 道自测题,答案折叠;`/review.html` 从全站 6,033 道题中抽题,支持按分支筛选、只练错题、连续答对两次移出随机池、每日一题和掌握进度。
- 版本与生命周期:指南分支的 `version-eol-matrix` 集中记录 Kubernetes、AI 推理与中间件的当前版本、EOL/归档状态和迁移建议;`npm run freshness` 负责检查这些页面的最后核对日期。
- `/diagnose.html`:6 棵可点击的故障决策树,覆盖 502/504、Pod Pending/CrashLoop、磁盘满/inode、DNS/网络、CPU/负载和数据库连接/慢查询;每步给出引导问题、验证命令和对应条目。

## 详情页阅读体验

- 长页目录:正文达到 8,000 字时,在标题与简介之后自动插入本页目录,锚点直接跳到对应章节;短页不显示,避免噪声。
- 相关命令:自动推荐按“同分类同前缀 → 同分类 → 同前缀 → 字母序邻居”排序,以卡片形式展示命令名、所属分支与一句话说明,比纯字母邻居更贴近当前主题。
- 面包屑、上一条/下一条与手工维护的 `## 相关命令` 区块保持原样;页面已有手工相关命令时不再叠加自动推荐。版本敏感页显示“版本信息最后核对”日期。
- 分类页会显示“先读这三篇”,由 `assets/data/category-featured.json` 配置;构建期校验 slug 必须属于该分类,写错直接失败。
- 搜索支持别名(如 `k8s` → kubectl、`ripgrep` → rg、`fdfind` → fd),配置在 `assets/data/search-aliases.json`。
- 命令页底部有“遇到问题?”入口,按 `assets/data/troubleshoot-links.json` 链到对应排障页;顶部按分支显示“系统学习”入口。

新增工具或概念页时,建议在页尾补 `## 读完自测`;学习路径、心智模型和故障演练的写法见 CONTRIBUTING。所有内容页的站内链接统一用相对路径(`../k8s/pod.html`),因此 `public/` 可以在站点根、子路径或本地 `file://` 下直接预览。

## Windows、macOS、Vim 与快捷键

- **Windows 分支**:CMD 文件/系统/网络命令、21 个 PowerShell 核心 cmdlet、WSL 与 `wslconfig`,以及 Windows Server/AD 的 `dcdiag`、`repadmin`、`dsquery`、`diskpart`、`wbadmin` 等。系统操作、注册表、防火墙、计划任务、更新、磁盘、恢复、远程桌面和用户账户放在指南分支的「Windows 与 PowerShell」分类。
- **macOS 分支**:BSD 文件命令、`launchctl`/`pmset`/`softwareupdate`/`tmutil`/`csrutil` 等系统命令、网络工具、Xcode 命令行工具与 Homebrew、`diskutil`/`hdiutil` 磁盘维护;指南分支提供 macOS 学习路径、心智模型与 Linux↔macOS 对照。
- **Vim 系列**:`vim-basics`、`vim-advanced`、`vim-config-plugins`、`vim-vs-neovim`,并扩写了 `vim-cheatsheet` 与 `linux/vi`。
- **快捷键**:Windows、macOS、Linux 桌面、终端、浏览器、VS Code、Office 七页,统一按场景表格组织,标注平台差异与容易误按的组合。

所有新页都补了 3 道「读完自测」,并自动进入 `/review.html` 题库。

## 贪吃蛇小游戏

首页首屏“小彩蛋”行有一个「🎮 贪吃蛇」入口,页面在 `/snake.html`。与俄罗斯方块同为站内的非命令页:
不套顶栏与搜索框,由 `template/snake.ejs` + `assets/js/snake-core.js`(纯逻辑)+
`assets/js/snake.js`(渲染/输入)组成,随 `npm run build` 一起产出。

按键:方向键控制,回车确认(开始 / 继续 / 再来一局),空格返回上一级
(未开始与结束界面直接回首页,游戏中则暂停)。触屏设备会显示四个方向按钮。

## 俄罗斯方块小游戏

首页首屏“小彩蛋”行另一个入口「🧱 俄罗斯方块」,页面在 `/tetris.html`。与贪吃蛇同构:
`template/tetris.ejs` + `assets/js/tetris-core.js`(纯逻辑)+ `assets/js/tetris.js`(渲染/输入)。

按键:`←→` 移动(按住连发)、`↑`/`X` 顺时针、`Z` 逆时针、按住 `↓` 软降、`回车` 硬降、
`C` 暂存、`空格` 暂停或返回(与贪吃蛇一致)。触屏底部五个按钮,`▼` 轻点软降一格、
长按 0.25 秒硬降。

规则:7-bag 随机、SRS 踢墙、500ms 锁定延迟、幽灵落点、下一块预览、暂存(每块限一次)、
消行闪烁;单/双/三/四行计 100/300/500/800 分 × 等级,每 10 行升级。

> 两个游戏页都是 ES module,必须经 HTTP 打开 —— 直接双击 `build/*.html`(file://)不会运行。
> 本地预览用 `npx serve build` 或 `python3 -m http.server -d build 8000`。

`npm test` 跑游戏核心逻辑与构建辅助函数的单测(需要 Node ≥ 22)。

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

页面有两种写法,按分支沿用现有风格:

- **Linux(紧凑速查)**:描述之后写 `## 补充说明`,示例用 `### 常用示例`,坑点用 `## 易错点与排错`。存量页多在 20–120 行(中位约 56 行),不强制完整四段式。
- **Kubernetes(完整条目)**:180–280 行(中位约 244 行),包含 `## 补充说明`、`### 语法`、`### 注意`、`### 相关命令`、`### 参考链接`。

**两条硬性规则(两种写法都适用):**

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

`id` 必须与目录名一致。`"default": true` 只能有一个。可选字段:`seo.label` / `seo.intro`(分支页标题与介绍,`{n}` 会替换为条目数)、`content: true`(按内容页生成标题,不套用“命令详解”)、`unit`(页脚量词)、`learningPath`(分支页的学习路径入口)。首页热门命令在 `site.hotCommands` 中维护。

## 校验与发布

```bash
npm run validate       # 命名与结构校验
npm run check-links    # 产物内链完整性(零 404)
npm run freshness      # 版本敏感页的最后核对日期与过期检查
npm run quiz-audit     # 自测题质量(答案过短、缺少原因的是非题)
npm run verify         # validate + build + check-links
npm run package        # verify + 暂存 public/ + 打包 public.zip(可直接上传)
```

`npm run package` 产出的 `public.zip` 与 `build/` 逐字节一致 —— 打包用系统
`zip` 并排除 `__MACOSX`/`.DS_Store`(Linux/Windows 解包不会多出一堆 `._*`),
完成后还会自检条目数与解压体积。`public/` 与 `public.zip` 均为本地暂存产物,
每次发布重新生成。

`npm run freshness` 默认扫描 AI、Kubernetes、中间件三个分支中包含较多版本号/日期/
EOL 断言的页面,对照 `assets/data/content-freshness.json` 里的最后核对日期,列出
未登记与超过 180 天的页面;`--all` 扫描全部分支,`--strict` 在有未登记/过期页面时
返回非零退出码。完成一次审计后,把对应页面路径与日期写进登记表即可。

## SEO 产物

构建会自动产出:

- `robots.txt`:允许抓取,并指向 `https://www.dos2unix.cn/sitemap.xml`
- `sitemap.xml`:首页、分支页、`hot.html`、`diagnose.html`、分类页与全部命令页(2000 条)
- 每页独立的 `<title>` / `meta description` / `canonical` / Open Graph
- `404.html`:托管平台若默认读取根目录 404 页面,可直接生效(不需要 nginx)

标题与描述的文本处理在 `scripts/lib/seo.mjs`,页面级参数在 `scripts/build.mjs` 的渲染段集中生成,不再使用模板拼接。
`list.html`、`snake.html`、`tetris.html`、`404.html` 均为 `noindex,follow`。

当前构建规模:2,120 个 HTML、2,011 个内容页、sitemap 2,115 条、站内链接 72,392 条(校验零 404)。

## 二级分类(Linux / Windows / macOS / Kubernetes / DevOps / 排障 / 指南 / 中间件 / 教程 / AI 与 MLOps)

`command/<branch>/categories.json` 定义分支的二级分类:

- `categories`: 分类 id、名称、顺序、短描述 `desc`、长描述 `longDesc`
- `assignments`: 每个页面 slug → 分类 id

当前有十份:

- `command/linux/categories.json`:16 个分类、862 条
- `command/windows/categories.json`:6 个分类、89 条
- `command/macos/categories.json`:5 个分类、58 条
- `command/k8s/categories.json`:12 个分类、274 条
- `command/devops/categories.json`:10 个分类、97 条
- `command/troubleshoot/categories.json`:8 个分类、134 条
- `command/guide/categories.json`:8 个分类、155 条
- `command/middleware/categories.json`:11 个分类、71 条
- `command/tutorial/categories.json`:3 个分类、77 条
- `command/ai/categories.json`:7 个分类、84 条

构建时会校验:

- 每个 `command/<branch>/*.md` 必须出现在 `assignments` 里
- `assignments` 里的 slug 必须有对应页面
- 每个分类至少有 1 个页面

分类页自动生成到 `/<branch>/category/<id>/`,并加入 `sitemap.xml`(priority 0.7)。

新增页面时,先在对应 `categories.json` 的 `assignments` 里归类,否则构建失败。

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

## 内容覆盖

| 分支 | 页面 | 说明 |
|---|---|---|
| Linux | 862 | 基础命令集 + 现代 CLI/诊断/开发/网络/备份/密钥/数据/系统工具,数据库客户端与语言运行时,Git 进阶与数据库服务端运维,存储/网络/终端效率/主机安全,LUKS/DRBD/GlusterFS 与 Doris/StarRocks/Druid/Pinot,OpenSCAP/SSSD/PAM/Firejail/TargetCLI/NBD/BIRD/StrongSwan 与 ripgrep/btop,以及 bcc-tools/火焰图/namespace/cgroup v2/page cache/IO 调度/网络栈/内存回收/eBPF 探针/sysdig 等性能与 eBPF 工具 |
| Windows | 89 | CMD 文件/系统/网络命令、21 个 PowerShell 核心 cmdlet、WSL 与 wslconfig、Windows Server/AD 的 dcdiag/repadmin/dsquery/diskpart/wbadmin 等诊断与运维命令 |
| macOS | 58 | BSD 文件命令、launchctl/pmset/softwareupdate/tmutil/csrutil 等系统命令、ifconfig/tcpdump/dscacheutil 等网络工具、Xcode 命令行工具与 Homebrew、diskutil/hdiutil 磁盘维护 |
| DevOps | 97 | GitHub Actions、GitLab CI、Jenkins、Buildkite、发布自动化、云 CLI、Terraform/OpenTofu/Pulumi/Ansible、Helmfile/cdk8s、ORAS/SLSA/in-toto、tfsec/KICS/TFLint/Terrascan、Atlantis/Infracost/Backstage,以及 SLO/错误预算、事故指挥/复盘、容量预测、FinOps、IDP、策略即代码、混沌工程、渐进式发布、多集群、DR 演练、on-call/runbook/toil 等 SRE 与平台工程实践 |
| 排障 | 170 | 按报错/现象组织:系统、磁盘、网络、权限证书、JVM/Go/Node、etcd/APIServer/CNI/CSI、Nginx、MySQL/PostgreSQL、Redis/Kafka/RabbitMQ、K8s 控制面与中间件连接问题,以及 Python/Ruby/PHP 运行时、MongoDB/ClickHouse/Pulsar、IPv6/gRPC/WebSocket/DNS ndots/TCP 状态等运行时与数据排障 |
| 指南 | 181 | 工具对比、速查表、路线图/检查清单、学习路径与心智模型、Windows 系统操作、PowerShell 概念、Vim 系列、快捷键与跨平台对照,以及恢复 Runbook、公开事故复盘和平台生命周期矩阵;包含 12 条领域路径、12 个心智模型和 22 个故障演练,覆盖选型、上线检查、性能排查、可观测性、容器安全、CI/CD 成熟度、SRE 值班、迁移、成本、事故响应、AI 基础设施、RAG 与 GPU 集群 |
| 中间件 | 71 | Elasticsearch/OpenSearch/Logstash/Kibana/Filebeat/Vector、Kafka/ZooKeeper/Schema Registry/ksqlDB/RabbitMQ、Nginx/HAProxy/Keepalived/Keycloak、Nexus/JFrog、PostgreSQL/PgBouncer/ProxySQL/MySQL Router,以及 MQTT、Nacos/Apollo、Temporal/Airflow、Qdrant/Milvus、Valkey/KeyDB,以及 RocketMQ/Dubbo/ShardingSphere/Seata/Canal/Arthas 等 Java 生态中间件 |
| 教程 | 77 | 迁移与升级(MySQL→PostgreSQL、Elasticsearch→OpenSearch、Prometheus→VictoriaMetrics、VM/Compose→Kubernetes 等)、搭建实战(Argo Workflows、Tekton、Flux、Gatekeeper、Falco、OpenBao、Temporal、Airflow、ClickHouse、StarRocks、MinIO、Ceph 等),以及 22 个本地故障演练(磁盘满/inode/CPU/网络/K8s/MySQL/PostgreSQL/Kafka/Redis/OOM/镜像/证书/Helm/etcd 等) |
| AI 与 MLOps | 132 | GPU 监控与容器运行时、CUDA/NCCL、Ollama/vLLM/SGLang/TGI/TensorRT-LLM 推理、torchrun/DeepSpeed/Ray/Megatron 训练、PEFT/TRL/Axolotl/Unsloth 微调、LangChain/LlamaIndex/RAGFlow/Dify 应用、MLflow/DVC/W&B/Langfuse 实验与可观测性,以及 Ragas/DeepEval/Guardrails/Llama Guard/promptfoo/Inspect AI/garak/LangSmith 评估与红队、LangGraph/CrewAI/AutoGen/MCP/DSPy/Pydantic AI/smolagents/OpenAI Agents SDK/A2A Agent、GraphRAG/reranker/Milvus 运维、推理调优/量化/投机解码、Weaviate/Chroma 运维、Triton/Ray Serve/Slurm/模型注册 |

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
现代平台     crossplane karpenter tetragon kubewarden kueue yunikorn
             envoy-gateway kgateway clusternet juicefs piraeus
             external-secrets sops kube-burner kwok kube-ovn
调试与成本   kubectx kubectl-tree kubectl-cost rbac-police
```

DevOps 分支按方向划分:

```
持续集成与交付   github-actions gitlab-ci jenkins gitlab-runner act drone buildkite-agent
                 buildkite circleci concourse dagger woodpecker gitea-actions tkn backstage
发布自动化       semantic-release release-please goreleaser renovate dependabot
代码质量         pre-commit lefthook commitlint ansible-lint molecule
云厂商 CLI       aws gcloud gsutil bq az aliyun doctl hcloud openstack oci
基础设施即代码   terraform opentofu terragrunt pulumi ansible-playbook ansible-vault
                 ansible-galaxy packer vagrant nomad helmfile cdk8s atlantis infracost tflint
容器与镜像       docker-compose docker-buildx buildctl crane regctl dive oras
安全与供应链     grype syft hadolint gitleaks semgrep tfsec kics terrascan
                 slsa-verifier in-toto
可观测性         promtool amtool logcli otel-cli
消息系统         kafka-topics nats pulsar
```

排障分支按故障域划分:

```
系统与进程       oom-killed too-many-open-files cpu-100 load-average-high
                 zombie-process process-stuck memory-leak boot-failure
                 jvm-gc-overhead metaspace-oom thread-deadlock goroutine-leak
                 node-heap-oom event-loop-blocked hung-task time-drift
磁盘与文件系统   no-space-left inode-exhausted read-only-filesystem disk-io-high
                 fsck-failed mount-failed disk-readonly
网络与 DNS       connection-refused connection-timeout dns-resolution-failed port-in-use
                 502-bad-gateway 504-gateway-timeout tls-handshake-failed packet-loss
                 mtu-blackhole nat-port-exhausted
权限与证书       permission-denied sudo-failed selinux-denied certificate-expired
                 certificate-untrusted ssh-permission-denied
Kubernetes       crashloopbackoff imagepullbackoff pod-pending pod-evicted probe-failed
                 node-notready k8s-dns-failed k8s-pvc-pending etcd-slow apiserver-429
                 kubelet-not-ready cni-plugin-failed csi-mount-failed terminating-stuck
服务与中间件     redis-connection-failed mysql-connection-failed postgres-connection-failed
                 kafka-consumer-lag postgres-lock-wait postgres-connection-exhausted
                 redis-hotkey elasticsearch-yellow rabbitmq-queue-backlog
```

指南分支分四类(共 41 个工具对比 + 42 个速查表 + 15 个路线图/检查清单 + 22 个学习路径与心智模型):

```
工具对比   iptables-vs-nftables curl-vs-wget docker-vs-podman helm-vs-kustomize
           systemd-vs-sysvinit cgroup-v1-vs-v2 nginx-vs-caddy haproxy-vs-nginx
           ext4-vs-xfs btrfs-vs-zfs psql-vs-mysql kafka-vs-pulsar nats-vs-kafka
           argocd-vs-flux ansible-vs-terraform prometheus-vs-victoriametrics
           kafka-vs-rabbitmq redis-vs-memcached mysql-vs-mariadb envoy-vs-nginx
           traefik-vs-nginx terraform-vs-cloudformation ollama-vs-vllm
           vllm-vs-sglang qdrant-vs-milvus emqx-vs-mosquitto temporal-vs-airflow
           valkey-vs-redis crossplane-vs-terraform karpenter-vs-cluster-autoscaler
           envoy-gateway-vs-nginx-ingress pgvector-vs-qdrant
速查表     linux-permission-cheatsheet k8s-troubleshooting-cheatsheet
           git-cheatsheet network-troubleshooting-cheatsheet bash-cheatsheet
           kubectl-cheatsheet docker-cheatsheet terraform-cheatsheet
           ansible-cheatsheet ssh-cheatsheet tcpdump-cheatsheet
           systemd-cheatsheet vim-cheatsheet tmux-cheatsheet
           awk-cheatsheet sed-cheatsheet find-cheatsheet grep-cheatsheet
           jq-cheatsheet yq-cheatsheet openssl-cheatsheet curl-cheatsheet
           promql-cheatsheet logql-cheatsheet nginx-cheatsheet redis-cheatsheet
           mysql-cheatsheet postgres-cheatsheet kafka-cheatsheet
           helm-cheatsheet kustomize-cheatsheet dockerfile-cheatsheet
           argocd-cheatsheet gpu-cheatsheet kubectl-jsonpath-cheatsheet
           linux-signal-cheatsheet http-status-cheatsheet dns-cheatsheet
           tls-cheatsheet k8s-rbac-cheatsheet cron-cheatsheet regex-cheatsheet
路线图     k8s-production-checklist linux-performance-triage observability-roadmap
           database-selection-roadmap container-security-checklist
           cicd-maturity-roadmap sre-oncall-checklist
           migration-readiness-checklist cost-optimization-checklist
           incident-response-playbook ai-infra-roadmap rag-production-checklist
           gpu-cluster-checklist platform-engineering-roadmap k8s-upgrade-checklist
学习路径   linux-learning-path devops-learning-path troubleshoot-learning-path
           middleware-learning-path ai-learning-path security-learning-path
           k8s-learning-path observability-learning-path database-learning-path
           network-learning-path lab-learning-path learning-paths
心智模型   linux-mental-model k8s-mental-model devops-mental-model
           troubleshoot-mental-model middleware-mental-model ai-mental-model
           security-mental-model observability-mental-model
           database-mental-model network-mental-model
```

中间件分支按服务划分:

```
日志与搜索     elasticsearch opensearch logstash kibana filebeat vector
消息与协调     kafka kafka-broker zookeeper schema-registry ksql rabbitmq
               kafka-connect mirrormaker debezium redpanda
网关与接入     nginx haproxy keepalived keycloak oauth2-proxy
               varnish openresty
物联网消息     emqx mosquitto vernemq nanomq
配置中心       nacos apollo
工作流与调度   temporal airflow prefect dagster
制品与仓库     nexus jfrog
数据与连接池   postgresql pgbouncer proxysql mysql-router
高可用与备份   patroni orchestrator redis-cluster mongodb-replica-set mysql-shell
               elasticsearch-cluster clickhouse-keeper tempo opensearch-dashboards
               pgbackrest wal-g percona-xtrabackup
缓存与云托管   memcached mongodb-atlas valkey keydb dragonfly garnet
向量检索       qdrant milvus weaviate chroma pgvector
全文搜索       meilisearch typesense solr
Java 生态      rocketmq dubbo shardingsphere seata canal arthas
```

教程分支分三类:

```
迁移与升级   migrate-docker-to-containerd migrate-iptables-to-nftables
             migrate-cgroup-v1-to-v2 migrate-mysql57-to-mysql8
             migrate-postgresql-major-version migrate-nginx-to-caddy
             migrate-helm-to-kustomize migrate-jenkins-to-github-actions
             migrate-elk-to-loki migrate-redis-to-valkey
             migrate-ingress-nginx-to-gateway-api migrate-mysql-to-postgresql
             migrate-elasticsearch-to-opensearch migrate-prometheus-to-victoriametrics
             migrate-nginx-ingress-to-traefik migrate-jenkins-to-gitlab-ci
             migrate-helm-to-argo-cd migrate-vm-to-kubernetes
             migrate-docker-compose-to-k8s
搭建与实战   build-k8s-cluster build-kafka-cluster build-postgresql-ha
             build-redis-cluster build-observability-stack build-cicd-pipeline
             build-argocd-gitops build-istio-mesh build-velero-backup
             build-vault build-keycloak-sso build-harbor build-prometheus-ha
             build-loki-ha build-cert-manager build-external-dns
             build-sealed-secrets build-argo-rollouts build-kyverno-policies
             build-cilium-network build-postgresql-pitr build-mysql-ha
             build-mongodb-replica-set build-kafka-connect build-argo-workflows
             build-tekton build-flux build-gatekeeper build-falco build-openbao
             build-temporal build-airflow build-clickhouse build-starrocks
             build-minio build-ceph
故障演练     lab-disk-full lab-inode-exhausted lab-cpu-100 lab-network-latency
             lab-pod-pending lab-crashloopbackoff lab-dns-failure lab-pvc-pending
             lab-mysql-deadlock lab-postgres-connection-exhausted
             lab-kafka-consumer-lag lab-redis-hotkey lab-oom-killed
             lab-imagepullbackoff lab-node-notready lab-certificate-expired
             lab-nginx-502 lab-helm-failed lab-kafka-rebalance
             lab-es-unassigned lab-etcd-quorum lab-mysql-replication-lag
```

AI 与 MLOps 分支按方向划分:

```
GPU 与加速   nvidia-smi nvitop nvtop cuda nccl dcgm-exporter
             nvidia-container-toolkit hami gpu-burn bitsandbytes flash-attn transformers
             slurm
推理与服务   ollama vllm sglang llama-server triton huggingface-cli
             tgi lmdeploy xinference openllm tensorrt-llm gpustack
             triton-inference-server ray-serve bentoml
推理优化     vllm-tuning quantization speculative-decoding
训练与编排   torchrun deepspeed accelerate ray kubeflow llama-factory
             peft trl axolotl unsloth megatron-lm optuna
RAG 与应用   langchain llamaindex ragflow dify fastgpt docling
RAG 运维     weaviate-ops chroma-ops milvus-ops graphrag reranker
评估与安全   ragas deepeval guardrails-ai llama-guard promptfoo
             inspect-ai garak langsmith
Agent 与编排 langgraph crewai autogen mcp dspy pydantic-ai
             smolagents openai-agents-sdk a2a
实验与数据   mlflow dvc wandb tensorboard label-studio lm-eval
             langfuse phoenix evidently clearml comet neptune model-registry
```

其中 **`ecosystem-status`** 是一页专门的生态状态汇总:已退役/已归档的项目(含时间点与替代方案)、发生重大变更的项目(如 kube-proxy 的 IPVS 模式废弃、containerd 2.x 配置格式变更)、以及已从 CNCF 毕业的项目。写内容时如引用第三方工具,建议先对照该页确认其是否仍在维护。

2026-10 做过一次版本巡检,更新了 15 个高频页的版本号、安装清单和废弃声明(Kubernetes 1.37、Helm 3.22/4.3、Argo CD 3.5、KEDA 2.21、Karpenter 1.15、etcd 3.7、Kafka 4.x KRaft、RabbitMQ 4.x quorum 队列等),并在 `ecosystem-status` 增加了带日期的版本矩阵。版本会继续变化,升级前以官方 release notes 为准。

> 各页面的 `### 注意` 小节记录的是**经核实的真实坑点**与常见误传的纠正,而非泛泛的最佳实践。

## 内容与许可

本站内容（除另有标注外）采用 [LICENSE](LICENSE) 的 MIT 许可，Copyright © 2026 dos2un1x。

全站 2011 页，按 10 个分支、91 个分类组织：

- Linux：862 页
- Windows：89 页
- macOS：58 页
- Kubernetes：274 页
- DevOps：97 页
- 排障：170 页
- 指南：181 页
- 中间件：71 页
- 教程：77 页
- AI 与 MLOps：132 页

引用第三方工具或文档时，页面内保留官方来源链接；正文、示例取舍与排错说明由本站组织。分发或复用内容时请保留 LICENSE。

## 联系与支持

扫码添加微信、加入交流群，或赞赏支持。

需要 `command` 私有子模块权限以完整构建？请扫码添加作者微信或加入交流群，并附上你的 GitHub 账号与用途。

| 加我微信 | 加入交流群 | 赞赏支持 |
| :---: | :---: | :---: |
| <img src="images/wechat-user.jpg" width="220" alt="dos2unix 微信二维码"> | <img src="images/wechat-group.jpg" width="220" alt="command-hub 微信交流群二维码"> | <img src="images/wechat-reward.jpg" width="220" alt="dos2unix 赞赏码"> |
| 扫码添加作者微信 | 扫码加入交流群（7 天内有效） | 扫码赞赏支持 |
