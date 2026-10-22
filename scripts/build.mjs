/**
 * 多分支命令站构建管线
 *
 * 输入:command/<branch>/<slug>.md + branches.json + template/ + assets/
 * 输出:build/  (根页面、<branch>/ 页面、js/css/img)
 */
import FS from 'node:fs/promises';
import path from 'node:path';
import * as ejs from 'ejs';
import UglifyJS from 'uglify-js';
import { create } from 'markdown-to-html-cli';

const ROOT = path.resolve(import.meta.dirname, '..');
const COMMAND_DIR = path.join(ROOT, 'command');
const TEMPLATE_DIR = path.join(ROOT, 'template');
const ASSETS_DIR = path.join(ROOT, 'assets');
const OUT_DIR = path.join(ROOT, 'build');

const V = Date.now();
const esc = (s) => ejs.escapeXML(String(s == null ? '' : s));

/** 清理命令名：剥离 BOM 与零宽字符 */
function sanitizeCommandName(value) {
  return String(value || '')
    .replace(/^﻿/, '')
    .replace(/[​-‍⁠]/g, '')
    .trim();
}

async function rmrf(p) {
  await FS.rm(p, { recursive: true, force: true });
}
async function write(p, content) {
  await FS.mkdir(path.dirname(p), { recursive: true });
  await FS.writeFile(p, content);
}

/** 扫描 command/<branch>/*.md */
async function readSources(branches) {
  const entries = await FS.readdir(COMMAND_DIR, { withFileTypes: true });
  const stray = entries.filter((e) => e.isFile() && e.name.endsWith('.md'));
  if (stray.length) {
    throw new Error(
      `command/ 根目录下不应有 .md 文件(必须归入分支目录):${stray.map((e) => e.name).join(', ')}`
    );
  }
  const declared = new Set(branches.map((b) => b.id));
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  const orphanDirs = dirs.filter((d) => !declared.has(d));
  if (orphanDirs.length) {
    throw new Error(
      `command/ 下存在未在 branches.json 声明的目录:${orphanDirs.join(', ')}`
    );
  }
  for (const b of branches) {
    if (!dirs.includes(b.id)) throw new Error(`branches.json 声明的分支 "${b.id}" 缺少 command/${b.id}/ 目录`);
  }

  const out = [];
  for (const b of branches) {
    const files = (await FS.readdir(path.join(COMMAND_DIR, b.id))).filter((f) => f.endsWith('.md'));
    for (const f of files) {
      const slug = f.slice(0, -3);
      const raw = await FS.readFile(path.join(COMMAND_DIR, b.id, f), 'utf8');
      const m = raw.match(/^([^=]+?)\s*===/);
      const title = sanitizeCommandName(m ? m[1] : '');
      const dm = raw.match(/\n={1,}([\s\S]*?)##/i);
      const desc = dm ? dm[1].replace(/[\r\n]/g, '').trim() : '';

      if (title !== slug) {
        throw new Error(
          `命名不一致:command/${b.id}/${f} 的标题为 "${title}",与文件名 "${slug}" 不符。\n` +
            `  产物文件名取标题,而链接取文件名,二者不一致必然 404。(参见 gcc Bug)`
        );
      }
      if (!desc) throw new Error(`描述解析失败:command/${b.id}/${f}(需为 "标题\\n===\\n描述\\n## ..." 格式)`);

      out.push({ n: title, p: `/${b.id}/${slug}`, d: desc, b: b.id, md: raw, branchId: b.id });
    }
  }
  out.sort((a, b) => a.p.localeCompare(b.p));
  return out;
}

async function markdownToHTML(str) {
  const html = await create({
    rewrite: (node) => {
      if (
        node.type === 'element' &&
        node.properties?.href &&
        /.md/.test(node.properties.href) &&
        !/^(https?:\/\/)/.test(node.properties.href)
      ) {
        node.properties.href = node.properties.href.replace(
          /([^\.\/\\]+)\.(md|markdown)/gi,
          '$1.html'
        );
      }
    },
    markdown: str,
    document: undefined,
    'dark-mode': false,
  });
  // markdown-to-html-cli 即使传 dark-mode:false 也会注入一份隐藏的
  // <dark-mode> 与脚本；头部已加载 dark-mode.min.js，重复 define 会让
  // 浏览器抛 NotSupportedError。这里移除渲染器注入的那一份。
  return html.replace(
    /<dark-mode[^>]*display:\s*none;[^>]*><\/dark-mode><script>[\s\S]*?customElements\.define\("dark-mode",a\);<\/script>/,
    ''
  );
}

async function render(tplName, data) {
  const file = path.join(TEMPLATE_DIR, tplName);
  return ejs.render(await FS.readFile(file, 'utf8'), data, { filename: file });
}

/** 并发受限的 map */
async function pmap(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

const t0 = Date.now();

// ── 1. 配置与源 ─────────────────────────────────────────────
const config = JSON.parse(await FS.readFile(path.join(ROOT, 'branches.json'), 'utf8'));
const site = config.site;
const branches = config.branches;

const baseUrl = site.baseUrl ? String(site.baseUrl).replace(/\/$/, '') : '';
if (!baseUrl) {
  throw new Error('branches.json 的 site.baseUrl 未配置,无法生成 canonical 与 sitemap');
}

/** 按字符数截断(中文按 1 个字计),超出时补省略号 */
const clipText = (s, n) => {
  const chars = Array.from(String(s == null ? '' : s).replace(/\s+/g, ' ').trim());
  return chars.length > n ? chars.slice(0, Math.max(1, n - 1)).join('') + '…' : chars.join('');
};
/** 去掉 Markdown 标记,保留纯文本 */
const plainText = (s) =>
  String(s == null ? '' : s)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
/** 去掉句末标点,便于拼进 meta description */
const sentenceText = (s) => plainText(s).replace(/[。.!！?？;；,，]+$/, '');

/** 从页面的“## 读完自测”中抽取问答,供 /review.html 随机复习。 */
function parseSelfTests(md) {
  const marker = '## 读完自测';
  const start = md.indexOf(marker);
  if (start < 0) return [];
  const rest = md.slice(start + marker.length);
  const next = rest.search(/\n## /);
  const body = next >= 0 ? rest.slice(0, next) : rest;
  const cut = body.indexOf('<details>');
  if (cut < 0) return [];
  const qPart = body.slice(0, cut);
  const aPart = body.slice(cut);
  const questions = [...qPart.matchAll(/^\s*\d+\.\s+(.+)$/gm)].map((x) => x[1].trim());
  const answers = [...aPart.matchAll(/^\s*\d+\.\s+(.+)$/gm)].map((x) => x[1].trim());
  return questions
    .map((q, i) => ({ q, a: answers[i] || '' }))
    .filter((x) => x.q && x.a);
}
/** 标题里用的简短描述:去掉「是/用于/用来/可以/主要」等开头,过长则不用 */
const titlePhrase = (s) => {
  const t = sentenceText(s).replace(/^(是|用于|用来|可以|主要)+/, '');
  return Array.from(t).length <= 14 ? t : '';
};
/** 标题统一以「 - 站点名」结尾。不截断 head:分支名/命令名被截断比标题略长更糟 */
const brandTitle = (head) => `${head} - ${site.name}`;
/** 详情页标题:优先「命令名 命令详解:描述」,过长时降级,保证标题不会过长 */
function detailTitle(it, dTitle) {
  const suffix = ` - ${site.name}`;
  if (CONTENT_BRANCHES.has(it.b)) {
    // 指南/教程不是命令页,标题用描述里冒号前的短语,避免只显示英文 slug。
    const head = sentenceText(it.d).split(/[：:]/)[0];
    const chars = Array.from(head);
    const phrase = chars.length <= 24 ? head : chars.slice(0, 23).join('') + '…';
    const title = `${phrase}${suffix}`;
    return Array.from(title).length <= 42 ? title : `${it.n}${suffix}`;
  }
  const withDesc = dTitle ? `${it.n} 命令详解：${dTitle}${suffix}` : '';
  if (withDesc && Array.from(withDesc).length <= 36) return withDesc;
  const noDesc = `${it.n} 命令详解${suffix}`;
  if (Array.from(noDesc).length <= 36) return noDesc;
  return `${it.n}${suffix}`;
}

if (branches.filter((b) => b.default).length !== 1) {
  throw new Error('branches.json 中必须且只能有一个分支标记 "default": true');
}
const defaultBranch = branches.find((b) => b.default);
/** 非命令型分支:详情页标题与描述按“内容页”组织,不套用“命令详解”。 */
const CONTENT_BRANCHES = new Set(['guide', 'tutorial']);
/** 详情页页脚的量词:指南/教程/排障/AI 不是“命令”。 */
const branchUnit = (id) => (['guide', 'tutorial', 'troubleshoot', 'ai'].includes(id) ? '条目' : '命令');

const items = await readSources(branches);

/** 全站复习题库:每个“读完自测”的三道题。 */
const branchNameById = new Map(branches.map((b) => [b.id, b.name]));
const reviewQuestions = items.flatMap((it) =>
  parseSelfTests(it.md).map((qa, i) => ({
    id: `${it.b}/${it.n}#${i}`,
    q: plainText(qa.q),
    a: plainText(qa.a),
    n: it.n,
    d: it.d,
    p: `${it.b}/${it.n}.html`,
    b: it.b,
    bn: branchNameById.get(it.b) || it.b,
  }))
);
const logo = await FS.readFile(path.join(TEMPLATE_DIR, 'partials', 'logo-inline.svg'), 'utf8');

/** 故障诊断向导数据:构建时校验结构,链接由 check-links 统一校验。 */
const diagnoseData = JSON.parse(
  await FS.readFile(path.join(ASSETS_DIR, 'data', 'diagnose.json'), 'utf8')
);
if (!Array.isArray(diagnoseData) || !diagnoseData.length) {
  throw new Error('assets/data/diagnose.json 必须是非空数组');
}
for (const tree of diagnoseData) {
  if (!tree.id || !tree.title || !tree.start || !tree.nodes?.[tree.start]) {
    throw new Error(`诊断树 "${tree.id || '?'}" 缺少 id/title/start 或 start 节点不存在`);
  }
  let resultCount = 0;
  for (const [nodeId, node] of Object.entries(tree.nodes)) {
    if (node.type === 'question') {
      if (!Array.isArray(node.options) || !node.options.length) {
        throw new Error(`诊断树 "${tree.id}" 节点 "${nodeId}" 没有选项`);
      }
      for (const opt of node.options) {
        if (!opt.label) {
          throw new Error(`诊断树 "${tree.id}" 节点 "${nodeId}" 有空选项`);
        }
        if (!tree.nodes[opt.next]) {
          throw new Error(
            `诊断树 "${tree.id}" 节点 "${nodeId}" 的选项指向不存在的节点 "${opt.next}"`
          );
        }
      }
    } else if (node.type === 'result') {
      resultCount++;
    } else {
      throw new Error(`诊断树 "${tree.id}" 节点 "${nodeId}" 的 type 必须是 question 或 result`);
    }
  }
  if (!resultCount) throw new Error(`诊断树 "${tree.id}" 没有任何结果节点`);

  // 所有节点必须从 start 可达,避免数据里留下孤立分支。
  const seen = new Set([tree.start]);
  const queue = [tree.start];
  while (queue.length) {
    const current = tree.nodes[queue.shift()];
    for (const opt of current.options || []) {
      if (!seen.has(opt.next)) {
        seen.add(opt.next);
        queue.push(opt.next);
      }
    }
  }
  const unreachable = Object.keys(tree.nodes).filter((id) => !seen.has(id));
  if (unreachable.length) {
    throw new Error(`诊断树 "${tree.id}" 存在不可达节点: ${unreachable.join(', ')}`);
  }
}

// 保留字与跨分支冲突防护
const RESERVED = new Set(['index', 'list', 'hot', 'review', 'diagnose']);
for (const b of branches) {
  for (const it of items.filter((x) => x.b === b.id)) {
    if (RESERVED.has(it.n)) {
      throw new Error(`"${it.n}" 是保留名(会与 ${b.id}/index.html 或根页面冲突),不能作为页面名`);
    }
  }
}

// ── 分支二级分类(command/<branch>/categories.json)────────────
// 有分类文件的分支:校验每个页面有且只有一个分类,并给 item 挂上 cat。
const categoriesByBranch = new Map();
for (const b of branches) {
  const catPath = path.join(COMMAND_DIR, b.id, 'categories.json');
  let cfg;
  try {
    cfg = JSON.parse(await FS.readFile(catPath, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') continue;
    throw e;
  }

  const list = (cfg.categories || [])
    .map((c, i) => ({ ...c, order: Number.isFinite(c.order) ? c.order : i + 1 }))
    .sort((x, y) => x.order - y.order || x.id.localeCompare(y.id));
  if (!list.length) throw new Error(`${path.relative(ROOT, catPath)} 没有 categories`);

  const ids = new Set();
  for (const c of list) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(c.id)) throw new Error(`分类 id 不合法: ${c.id}`);
    if (!c.name || !c.desc) throw new Error(`分类 ${c.id} 缺少 name 或 desc`);
    ids.add(c.id);
  }

  const assignments = cfg.assignments || {};
  const branchItems = items.filter((it) => it.b === b.id);
  const byCat = new Map(list.map((c) => [c.id, []]));
  for (const it of branchItems) {
    const catId = assignments[it.n];
    if (!catId) {
      throw new Error(`command/${b.id}/${it.n}.md 未在 categories.json 中归类`);
    }
    if (!ids.has(catId)) {
      throw new Error(`command/${b.id}/categories.json: ${it.n} 的分类 "${catId}" 不存在`);
    }
    it.cat = catId;
    byCat.get(catId).push(it);
  }
  for (const slug of Object.keys(assignments)) {
    if (!branchItems.some((it) => it.n === slug)) {
      throw new Error(`command/${b.id}/categories.json: 映射中的 "${slug}" 没有对应页面`);
    }
  }
  for (const c of list) {
    if (!byCat.get(c.id).length) {
      throw new Error(`command/${b.id}/categories.json: 分类 "${c.id}" 没有页面`);
    }
  }
  categoriesByBranch.set(b.id, { list, byCat, config: cfg });
}

const categoryNavFor = (branchId) => {
  const cats = categoriesByBranch.get(branchId);
  if (!cats) return [];
  return cats.list.map((c) => ({
    id: c.id,
    name: c.name,
    count: cats.byCat.get(c.id).length,
  }));
};

// ── 同名页与热门命令 ────────────────────────────────────────
const dupes = items.map((i) => i.n).filter((n, i, a) => a.indexOf(n) !== i);
if (dupes.length) {
  console.log(`  提示:跨分支同名页 ${[...new Set(dupes)].join(', ')}(各自独立 URL,无冲突)`);
}

// 热门命令优先取默认分支的同名页,找不到才用其它分支。
const byNameAll = new Map();
for (const it of items) {
  if (!byNameAll.has(it.n)) byNameAll.set(it.n, []);
  byNameAll.get(it.n).push(it);
}
const byName = new Map();
for (const [name, list] of byNameAll) {
  byName.set(name, list.find((x) => x.b === defaultBranch.id) || list[0]);
}

// 首页「热门命令」:按常见使用频率挑一批,过滤掉当前内容里不存在的
const HOT_COMMAND_NAMES = [
  'ls', 'grep', 'find', 'awk', 'sed', 'tar', 'chmod', 'ps', 'top', 'df',
  'du', 'ssh', 'curl', 'systemctl', 'journalctl', 'git', 'vim', 'nano',
  'kubectl', 'helm', 'docker', 'github-actions', 'terraform',
  'nginx', 'psql', 'redis-cli', 'kafka-topics',
  'oom-killed', 'no-space-left', 'permission-denied', 'crashloopbackoff',
  'connection-refused', 'kubectl-cheatsheet',
  'build-k8s-cluster', 'migrate-docker-to-containerd',
  'build-postgresql-ha', 'migrate-iptables-to-nftables',
  'nvidia-smi', 'ollama', 'vllm', 'huggingface-cli', 'torchrun', 'mlflow',
  'dir', 'robocopy', 'ipconfig', 'Get-ChildItem', 'wsl', 'launchctl', 'brew',
  'windows-shortcuts', 'vim-basics',
];
const seenHot = new Set();
const hotCommands = HOT_COMMAND_NAMES.map((n) => byName.get(n))
  .filter((it) => {
    if (!it || seenHot.has(it.n)) return false;
    seenHot.add(it.n);
    return true;
  })
  .slice(0, 52);

const byBranch = {};
for (const b of branches) byBranch[b.id] = [];
for (const it of items) byBranch[it.b].push(it);
for (const id of Object.keys(byBranch)) byBranch[id].sort((a, b) => a.n.localeCompare(b.n));

console.log(`分支 ${branches.length} 个,条目 ${items.length} 个`);

// ── 2. 输出目录 ─────────────────────────────────────────────
await rmrf(OUT_DIR);
await FS.mkdir(OUT_DIR, { recursive: true });

// 静态资源
await FS.cp(path.join(ASSETS_DIR, 'img'), path.join(OUT_DIR, 'img'), { recursive: true });
await FS.cp(path.join(ASSETS_DIR, 'css'), path.join(OUT_DIR, 'css'), { recursive: true });
await FS.cp(path.join(ASSETS_DIR, 'js'), path.join(OUT_DIR, 'js'), { recursive: true });
await FS.cp(path.join(ASSETS_DIR, 'data'), path.join(OUT_DIR, 'data'), { recursive: true });
// 浏览器标签图标以 images/favicon.ico 为准，复制到产物根目录的 images/。
await FS.mkdir(path.join(OUT_DIR, 'images'), { recursive: true });
await FS.copyFile(path.join(ROOT, 'images', 'favicon.ico'), path.join(OUT_DIR, 'images', 'favicon.ico'));
await FS.rm(path.join(OUT_DIR, 'js', 'github-corners.js'), { force: true });
await FS.rm(path.join(OUT_DIR, 'css', 'index.legacy.css'), { force: true });

// index.js 压缩
{
  const src = await FS.readFile(path.join(ASSETS_DIR, 'js', 'index.js'), 'utf8');
  const min = UglifyJS.minify(src);
  if (min.error) throw min.error;
  await write(path.join(OUT_DIR, 'js', 'index.js'), min.code);
}

// 搜索索引
const dt = `var commands=${JSON.stringify(items.map(({ n, p, d, b }) => ({ n, p, d, b })))};\n` +
  `var branches=${JSON.stringify(branches.map(({ id, name, desc }) => ({ id, name, desc })))};\n`;
await write(path.join(OUT_DIR, 'js', 'dt.js'), dt);
await write(path.join(OUT_DIR, 'js', 'questions.json'), JSON.stringify(reviewQuestions));
console.log(`复习题库 ${reviewQuestions.length} 道`);

// ── 3. 公共渲染参数 ─────────────────────────────────────────
const total = items.length;
const branchCount = branches.length;
const categoryCount = [...categoriesByBranch.values()]
  .reduce((sum, c) => sum + c.list.length, 0);
const branchCards = branches.map((b) => {
  const cats = categoriesByBranch.get(b.id);
  return {
    id: b.id,
    name: b.name,
    desc: b.desc,
    count: byBranch[b.id].length,
    categoryCount: cats ? cats.list.length : 0,
    categories: cats ? cats.list.slice(0, 3).map((c) => c.name) : [],
  };
});

const BRANCH_SEO = {
  linux: {
    label: 'Linux 命令大全',
    intro: (n) =>
      `收录 ${n} 个 Linux 条目，覆盖文件与目录、文本处理、网络、系统管理、磁盘、存储、权限与主机安全等场景，提供语法、参数与使用示例。`,
  },
  k8s: {
    label: 'Kubernetes 命令手册',
    intro: (n) =>
      `收录 ${n} 个 Kubernetes 条目，覆盖集群管理、资源编排、故障排查与日常运维，提供语法、参数与使用示例。`,
  },
  devops: {
    label: 'DevOps 工具手册',
    intro: (n) =>
      `收录 ${n} 个 DevOps 条目，覆盖 CI/CD、发布自动化、云 CLI、IaC、容器、供应链安全、平台工程与可观测性。`,
  },
  troubleshoot: {
    label: '故障排查手册',
    intro: (n) =>
      `收录 ${n} 个排障条目，按报错与故障现象组织，覆盖系统、磁盘、网络、权限、JVM/Go/Node、Kubernetes 与中间件。`,
  },
  guide: {
    label: '学习路径、工具对比与速查表',
    intro: (n) =>
      `收录 ${n} 个指南条目，包含十二条领域学习路径、心智模型、工具对比、选型建议、Vim 编辑器、系统与软件快捷键、高频命令速查表和上线检查清单，帮助先建立方向，再在相似方案之间做决定。`,
  },
  middleware: {
    label: '中间件手册',
    intro: (n) =>
      `收录 ${n} 个中间件条目，覆盖日志与搜索、消息与协调、网关与接入、制品仓库、数据库连接池、Java 生态与向量检索。`,
  },
  tutorial: {
    label: '迁移、搭建与故障演练',
    intro: (n) =>
      `收录 ${n} 个教程条目，覆盖组件迁移、版本升级，以及 Kubernetes、Kafka、Redis、PostgreSQL 高可用、可观测性、密钥管理、发布策略搭建与本地故障演练。`,
  },
  ai: {
    label: 'AI 与 MLOps 工具手册',
    intro: (n) =>
      `收录 ${n} 个 AI 与 MLOps 条目，覆盖 GPU 监控、CUDA/NCCL、模型推理、分布式训练、微调、RAG 应用、实验跟踪、评估、Agent 与安全。`,
  },
  windows: {
    label: 'Windows 命令手册',
    intro: (n) =>
      `收录 ${n} 个 Windows 条目，覆盖 CMD、PowerShell、WSL、网络与 Windows Server/AD，提供语法、参数、示例与风险提示。`,
  },
  macos: {
    label: 'macOS 命令手册',
    intro: (n) =>
      `收录 ${n} 个 macOS 条目，覆盖 BSD 文件命令、launchctl、系统维护、网络与开发工具，标注与 Linux 的差异。`,
  },
};
const branchSeo = (b) =>
  BRANCH_SEO[b.id] || {
    label: `${b.name} 命令大全`,
    intro: (n) => `收录 ${n} 个 ${b.name} 命令，提供语法、参数与使用示例。`,
  };

/** 同前缀命令优先,不足 5 条用字母序邻居补齐 */
function relatedFor(it, list) {
  const idx = list.findIndex((x) => x.n === it.n);
  const base = (n) => n.split('-')[0];
  const family = list.filter(
    (x) =>
      x.n !== it.n &&
      (base(x.n) === base(it.n) || x.n.startsWith(it.n) || it.n.startsWith(x.n))
  );
  const neighbors = [];
  for (let d = 1; d <= 8; d++) {
    if (list[idx - d]) neighbors.push(list[idx - d]);
    if (list[idx + d]) neighbors.push(list[idx + d]);
  }
  const seen = new Set([it.n]);
  const out = [];
  for (const x of [...family, ...neighbors]) {
    if (seen.has(x.n)) continue;
    seen.add(x.n);
    out.push(x);
    if (out.length === 5) break;
  }
  return out;
}

function base(extra) {
  return {
    site,
    branches,
    logo,
    v: V,
    total,
    branchCount,
    categoryCount,
    ...extra,
  };
}

// ── 4. 根页面 ───────────────────────────────────────────────
const rootFooter = {
  footerCount: total,
  footerLabel: `个条目，覆盖 ${branchCount} 个分支`,
};

await write(
  path.join(OUT_DIR, 'index.html'),
  await render('index.ejs', base({
    relative_path: '',
    current_path: '/index.html',
    currentBranch: null,
    placeholder: '搜索命令、报错或工具',
    isHome: true,
    describe: { n: 'dos2unix 速查站', d: site.slogan },
    brand: site.name,
    pageTitle: brandTitle('命令、排障与工程实践速查'),
    metaDescription: `收录 ${total} 个条目，覆盖 Linux、Windows、macOS、Kubernetes、DevOps、故障排查、工具对比、中间件、迁移搭建教程、AI/MLOps、Vim 与快捷键，提供语法、示例与排错思路。`,
    metaKeywords: site.keywords,
    canonicalUrl: `${baseUrl}/`,
    ogType: 'website',
    hotCommands,
    branchCards,
    ...rootFooter,
  }))
);

await write(
  path.join(OUT_DIR, 'list.html'),
  await render('list.ejs', base({
    relative_path: '',
    current_path: '/list.html',
    currentBranch: null,
    placeholder: '搜索所有分支的条目',
    isHome: false,
    describe: { n: '搜索', d: site.slogan },
    brand: site.name,
    pageTitle: brandTitle('搜索命令与排障'),
    metaDescription: '搜索命令、报错、工具或中间件，输入关键词即可定位语法、示例与排错思路。',
    metaKeywords: '命令搜索,报错搜索,运维搜索,DevOps',
    canonicalUrl: `${baseUrl}/list.html`,
    robots: 'noindex,follow',
    ogType: 'website',
    ...rootFooter,
  }))
);

await write(
  path.join(OUT_DIR, 'hot.html'),
  await render('hot.ejs', base({
    relative_path: '',
    current_path: '/hot.html',
    currentBranch: null,
    placeholder: '搜索所有分支的条目',
    isHome: false,
    describe: { n: '全部条目', d: `全部 ${total} 个条目，覆盖 ${branchCount} 个分支` },
    brand: site.name,
    pageTitle: brandTitle(`全部条目列表（${total} 个）`),
    metaDescription: `dos2unix 速查站收录的全部 ${total} 个条目，覆盖命令、排障、工具对比、中间件、迁移搭建教程与 AI/MLOps，按分支和字母排序。`,
    metaKeywords: '命令列表,排障列表,DevOps工具,中间件,工具对比',
    canonicalUrl: `${baseUrl}/hot.html`,
    ogType: 'website',
    byBranch,
    ...rootFooter,
  }))
);

await write(
  path.join(OUT_DIR, 'snake.html'),
  await render('snake.ejs', base({
    relative_path: '',
    describe: { n: '贪吃蛇小游戏', d: '键盘就能玩的贪吃蛇:方向键控制,回车确认,空格返回' },
    brand: site.name,
    pageTitle: `贪吃蛇小游戏 - ${site.name}`,
    metaDescription: '键盘就能玩的贪吃蛇小游戏：方向键控制，回车确认，空格返回。',
    metaKeywords: '贪吃蛇,小游戏',
    canonicalUrl: `${baseUrl}/snake.html`,
    robots: 'noindex,follow',
    ogType: 'website',
    extraCss: [`css/snake.css?v=${V}`],
  }))
);

await write(
  path.join(OUT_DIR, 'tetris.html'),
  await render('tetris.ejs', base({
    relative_path: '',
    describe: { n: '俄罗斯方块小游戏', d: '键盘就能玩的俄罗斯方块:方向键移动旋转,回车落底,空格返回' },
    brand: site.name,
    pageTitle: `俄罗斯方块小游戏 - ${site.name}`,
    metaDescription: '键盘就能玩的俄罗斯方块小游戏：方向键移动旋转，回车落底，空格返回。',
    metaKeywords: '俄罗斯方块,小游戏',
    canonicalUrl: `${baseUrl}/tetris.html`,
    robots: 'noindex,follow',
    ogType: 'website',
    extraCss: [`css/tetris.css?v=${V}`],
  }))
);

await write(
  path.join(OUT_DIR, '404.html'),
  await render('404.ejs', base({
    relative_path: '',
    current_path: '/404.html',
    currentBranch: null,
    placeholder: '搜索命令、报错或工具',
    isHome: false,
    describe: { n: '页面不存在', d: '页面可能已迁移或删除' },
    brand: site.name,
    pageTitle: brandTitle('页面不存在'),
    metaDescription: '你访问的页面可能已经迁移或删除，可以返回首页或搜索命令与报错。',
    metaKeywords: '404,页面不存在',
    robots: 'noindex,follow',
    hotCommands,
    ...rootFooter,
  }))
);

// ── 5. 分支落地页 ───────────────────────────────────────────
await write(
  path.join(OUT_DIR, 'review.html'),
  await render('review.ejs', base({
    relative_path: '',
    current_path: '/review.html',
    currentBranch: null,
    placeholder: '搜索命令、报错或工具',
    isHome: false,
    describe: { n: '每日复习', d: '从全站自测中随机抽取 5 道题' },
    brand: site.name,
    pageTitle: brandTitle('每日复习：从自测中随机抽题'),
    metaDescription: `从全站 ${reviewQuestions.length} 道“读完自测”中随机抽取 5 道，先回答再核对，支持错题重练。`,
    metaKeywords: '每日复习,自测,命令练习,运维练习',
    canonicalUrl: `${baseUrl}/review.html`,
    ogType: 'website',
    robots: 'noindex,follow',
    questionCount: reviewQuestions.length,
    reviewBranches: branches.map((b) => ({ id: b.id, name: b.name })),
    extraCss: [`css/review.css?v=${V}`],
    ...rootFooter,
  }))
);

await write(
  path.join(OUT_DIR, 'diagnose.html'),
  await render('diagnose.ejs', base({
    relative_path: '',
    current_path: '/diagnose.html',
    currentBranch: null,
    placeholder: '搜索命令、报错或工具',
    isHome: false,
    describe: { n: '故障诊断向导', d: '按现象逐步判断，找到下一步该查什么' },
    brand: site.name,
    pageTitle: brandTitle('故障诊断向导：从现象到下一步'),
    metaDescription:
      '按现象逐步判断的故障诊断向导：502/504、Pod Pending/CrashLoopBackOff、磁盘满、DNS/网络不通、CPU/负载高、数据库连接满，每一步给出验证命令与对应页面。',
    metaKeywords: '故障诊断,排障向导,502,504,CrashLoopBackOff,磁盘满,DNS,CPU高,数据库连接',
    canonicalUrl: `${baseUrl}/diagnose.html`,
    ogType: 'website',
    diagnoseTreeCount: diagnoseData.length,
    extraCss: [`css/diagnose.css?v=${V}`],
    ...rootFooter,
  }))
);

// ── 5. 分支落地页 ───────────────────────────────────────────
for (const b of branches) {
  const seo = branchSeo(b);
  const count = byBranch[b.id].length;
  await write(
    path.join(OUT_DIR, b.id, 'index.html'),
    await render('branch.ejs', base({
      relative_path: '../',
      current_path: `/${b.id}/index.html`,
      currentBranch: b.id,
      placeholder: b.searchPlaceholder || '搜索条目',
      isHome: false,
      describe: { n: b.name, d: b.desc },
      brand: b.name,
      pageTitle: brandTitle(`${seo.label}（${count} 个条目）`),
      metaDescription: `${seo.label}：${seo.intro(count)}`,
      metaKeywords: `${b.name},${seo.label},${b.name}速查,命令速查`,
      canonicalUrl: `${baseUrl}/${b.id}/`,
      ogType: 'website',
      branchH1: seo.label,
      branchIntro: seo.intro(count),
      learningPath: b.learningPath || null,
      categoryNav: categoryNavFor(b.id),
      items: byBranch[b.id],
      footerCount: count,
      footerLabel: `个${b.name}条目`,
    }))
  );
}

// ── 6. 命令详情页 ───────────────────────────────────────────
console.log('渲染命令页…');
await pmap(items, 8, async (it) => {
  const b = branches.find((x) => x.id === it.b);
  const list = byBranch[it.b];
  const idx = list.findIndex((x) => x.n === it.n);
  const related = relatedFor(it, list);
  const prevItem = idx > 0 ? list[idx - 1] : null;
  const nextItem = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;
  const dText = sentenceText(it.d).replace(/^(是|用于|用来|可以|主要)+/, '');
  const dTitle = titlePhrase(it.d);
  const isContent = CONTENT_BRANCHES.has(it.b);
  let mdhtml = await markdownToHTML(it.md);
  if (isContent) {
    // 指南/教程的首行是 ASCII slug;正文 H1 用中文描述,避免页面标题只剩 slug。
    mdhtml = mdhtml
      .replace(
        /<h1[^>]*>[\s\S]*?<\/h1>/,
        `<h1 id="${esc(it.n)}">${esc(sentenceText(it.d))}</h1>`
      )
      // H1 已经用了描述,去掉紧跟其后的重复描述段落。
      .replace(/(<h1[^>]*>[\s\S]*?<\/h1>\s*)<p>[\s\S]*?<\/p>/, '$1');
  }
  const cats = categoriesByBranch.get(it.b);
  const category = cats ? cats.list.find((c) => c.id === it.cat) || null : null;
  const html = await render('details.ejs', base({
    relative_path: '../',
    current_path: it.p + '.html',
    currentBranch: it.b,
    placeholder: b.searchPlaceholder || '搜索命令',
    isHome: false,
    describe: { n: it.n, d: it.d },
    displayName: isContent ? sentenceText(it.d).split(/[：:]/)[0] : it.n,
    brand: b.name,
    pageTitle: detailTitle(it, dTitle),
    metaDescription: isContent
      ? `${clipText(dText, 50)}。本页提供操作步骤、注意事项与相关条目，支持在线速查。`
      : `${it.n} 命令：${clipText(dText, 40)}。本页提供 ${it.n} 的语法、常用选项、使用示例与相关命令，支持在线速查。`,
    metaKeywords: isContent
      ? `${it.n},${b.name},${site.name},速查`
      : `${it.n},${it.n}命令,${b.name}命令,命令速查`,
    canonicalUrl: `${baseUrl}/${it.b}/${it.n}.html`,
    ogType: 'article',
    category,
    related,
    prevItem,
    nextItem,
    mdhtml,
    footerCount: list.length,
    footerLabel: `个${b.name}${branchUnit(it.b)}`,
  }));
  await write(path.join(OUT_DIR, it.b, `${it.n}.html`), html);
});

// ── 7. 分类聚合页 ───────────────────────────────────────────
const categoryPages = [];
for (const b of branches) {
  const cats = categoriesByBranch.get(b.id);
  if (!cats) continue;
  const nav = categoryNavFor(b.id);
  for (const cat of cats.list) {
    const catItems = cats.byCat.get(cat.id);
    const urlPath = `/${b.id}/category/${cat.id}/`;
    const html = await render('category.ejs', base({
      relative_path: '../../../',
      branchPrefix: '../../',
      current_path: `${urlPath}index.html`,
      currentBranch: b.id,
      placeholder: b.searchPlaceholder || '搜索命令',
      isHome: false,
      describe: { n: cat.name, d: cat.desc },
      brand: b.name,
      branchName: b.name,
      pageTitle: `${cat.name}（${catItems.length} 个条目） - ${b.name} - ${site.name}`,
      metaDescription: `${cat.name}：${cat.desc}共收录 ${catItems.length} 个 ${b.name} ${cat.name}相关条目，包含用途说明与常用操作。`,
      metaKeywords: `${cat.name},${b.name} ${cat.name},${b.name},命令速查`,
      canonicalUrl: `${baseUrl}${urlPath}`,
      ogType: 'website',
      category: cat,
      categoryIntro: cat.longDesc || cat.desc,
      categoryNav: nav,
      items: catItems,
      footerCount: byBranch[b.id].length,
      footerLabel: `个${b.name}命令`,
    }));
    await write(path.join(OUT_DIR, b.id, 'category', cat.id, 'index.html'), html);
    categoryPages.push({ loc: `${baseUrl}${urlPath}`, priority: '0.7', changefreq: 'monthly' });
  }
}
if (categoryPages.length) console.log(`渲染分类页 ${categoryPages.length} 个…`);

// ── 8. sitemap / robots ─────────────────────────────────────
const lastmod = new Date().toISOString().slice(0, 10);
const hotNames = new Set(hotCommands.map((x) => x.n));
// 默认分支排在前面,热门命令优先级更高 —— 主动推送按 sitemap 顺序取前 N 条,
// 这样首页、分支页、热门命令会先被百度抓到。
const sitemapItems = [...items].sort((a, b) => {
  const da = a.b === defaultBranch.id ? 0 : 1;
  const db = b.b === defaultBranch.id ? 0 : 1;
  return da - db || a.n.localeCompare(b.n);
});
const sitemapEntries = [
  { loc: `${baseUrl}/`, priority: '1.0', changefreq: 'weekly' },
  { loc: `${baseUrl}/hot.html`, priority: '0.8', changefreq: 'weekly' },
  { loc: `${baseUrl}/diagnose.html`, priority: '0.8', changefreq: 'monthly' },
  ...branches.map((b) => ({ loc: `${baseUrl}/${b.id}/`, priority: '0.9', changefreq: 'weekly' })),
  ...categoryPages,
  ...sitemapItems.map((it) => ({
    loc: `${baseUrl}/${it.b}/${it.n}.html`,
    priority: hotNames.has(it.n) ? '0.8' : '0.6',
    changefreq: 'monthly',
  })),
];
const sitemap = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...sitemapEntries.map(
    (e) =>
      `  <url><loc>${esc(e.loc)}</loc><lastmod>${lastmod}</lastmod><changefreq>${e.changefreq}</changefreq><priority>${e.priority}</priority></url>`
  ),
  '</urlset>',
  '',
].join('\n');
await write(path.join(OUT_DIR, 'sitemap.xml'), sitemap);

const robots = [
  'User-agent: *',
  'Allow: /',
  '',
  `Sitemap: ${baseUrl}/sitemap.xml`,
  '',
].join('\n');
await write(path.join(OUT_DIR, 'robots.txt'), robots);

console.log(`生成 sitemap ${sitemapEntries.length} 条与 robots.txt`);

// ── 9. 完成 ─────────────────────────────────────────────────
console.log(`\n✓ 构建完成 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`  命令页   ${items.length}`);
console.log(`  分类页   ${categoryPages.length}`);
console.log(`  分支页   ${branches.length}`);
console.log(`  诊断树   ${diagnoseData.length}`);
console.log(`  sitemap  ${sitemapEntries.length}`);
console.log(`  产物目录 ${path.relative(process.cwd(), OUT_DIR)}/`);
