/**
 * 多分支命令站构建管线
 *
 * 输入:command/<branch>/<slug>.md + branches.json + template/ + assets/
 * 输出:build/  (根页面、<branch>/ 页面、c/ 跳转 stub、js/css/img)
 *
 * 与上游 build.mjs 的差异见 docs/superpowers/specs/2026-09-18-branch-architecture-design.md
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

/** 上游 sanitizeCommandName:剥离 BOM 与零宽字符 */
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
  return create({
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

if (branches.filter((b) => b.default).length !== 1) {
  throw new Error('branches.json 中必须且只能有一个分支标记 "default": true');
}
const defaultBranch = branches.find((b) => b.default);

const items = await readSources(branches);
const logo = await FS.readFile(path.join(TEMPLATE_DIR, 'partials', 'logo-inline.svg'), 'utf8');

// 保留字与跨分支冲突防护
const RESERVED = new Set(['index', 'list', 'hot']);
for (const b of branches) {
  for (const it of items.filter((x) => x.b === b.id)) {
    if (RESERVED.has(it.n)) {
      throw new Error(`"${it.n}" 是保留名(会与 ${b.id}/index.html 或根页面冲突),不能作为页面名`);
    }
  }
}

// ── 老 URL stub 的目标解析 ──────────────────────────────────
// 以 legacy-slugs.json 固化的「曾发布过的 slug 集合」为准,而不是按分支判断:
// 页面迁到别的分支后,老 URL 仍须可访问。
const legacyConfig = JSON.parse(await FS.readFile(path.join(ROOT, 'legacy-slugs.json'), 'utf8'));
const legacySlugs = legacyConfig.slugs;
const legacyAliases = legacyConfig.aliases || {};

const dupes = items.map((i) => i.n).filter((n, i, a) => a.indexOf(n) !== i);
if (dupes.length) {
  console.log(`  提示:跨分支同名页 ${[...new Set(dupes)].join(', ')}(各自独立 URL,无冲突)`);
}

// 老 URL 指向哪个页面:优先默认分支的同名页(默认分支即原始命名空间),
// 找不到才用其它分支的。这样 pv/service 这类跨分支同名页自然落到 linux,
// 而 kubectl 这类已迁走的落到 k8s。
const byNameAll = new Map();
for (const it of items) {
  if (!byNameAll.has(it.n)) byNameAll.set(it.n, []);
  byNameAll.get(it.n).push(it);
}
const byName = new Map();
const ambiguous = [];
for (const [name, list] of byNameAll) {
  if (list.length > 1) ambiguous.push(`${name}(${list.map((x) => x.b).join('/')})`);
  byName.set(name, list.find((x) => x.b === defaultBranch.id) || list[0]);
}

const legacyItems = [];
const unmappedSlugs = [];
const movedSlugs = [];
for (const slug of legacySlugs) {
  const target = byName.get(legacyAliases[slug] || slug);
  if (!target) {
    unmappedSlugs.push(slug);
    continue;
  }
  legacyItems.push({ slug, item: target });
  if (target.b !== defaultBranch.id) movedSlugs.push(`${slug}→${target.b}`);
}
if (ambiguous.length) {
  console.log(`  跨分支同名页 ${ambiguous.join(', ')},老 URL 均指向 ${defaultBranch.id}`);
}

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

// ── 3. 公共渲染参数 ─────────────────────────────────────────
const total = items.length;
const branchCount = branches.length;

function base(extra) {
  return {
    site,
    branches,
    logo,
    v: V,
    total,
    branchCount,
    ...extra,
  };
}

// ── 4. 根页面 ───────────────────────────────────────────────
const rootFooter = {
  footerCount: total,
  footerLabel: `个命令，覆盖 ${branchCount} 个分支`,
};

await write(
  path.join(OUT_DIR, 'index.html'),
  await render('index.ejs', base({
    relative_path: '',
    current_path: '/index.html',
    currentBranch: null,
    placeholder: '搜索所有分支的命令',
    isHome: true,
    describe: { n: 'Linux命令搜索引擎', d: site.sloganLegacy },
    brand: site.name,
    ...rootFooter,
  }))
);

await write(
  path.join(OUT_DIR, 'list.html'),
  await render('list.ejs', base({
    relative_path: '',
    current_path: '/list.html',
    currentBranch: null,
    placeholder: '搜索所有分支的命令',
    isHome: false,
    describe: { n: '搜索', d: site.sloganLegacy },
    brand: site.name,
    ...rootFooter,
  }))
);

await write(
  path.join(OUT_DIR, 'hot.html'),
  await render('hot.ejs', base({
    relative_path: '',
    current_path: '/hot.html',
    currentBranch: null,
    placeholder: '搜索所有分支的命令',
    isHome: false,
    describe: { n: '全部命令', d: `全部 ${total} 个命令，覆盖 ${branchCount} 个分支` },
    brand: site.name,
    byBranch,
    ...rootFooter,
  }))
);

// ── 5. 分支落地页 ───────────────────────────────────────────
for (const b of branches) {
  await write(
    path.join(OUT_DIR, b.id, 'index.html'),
    await render('branch.ejs', base({
      relative_path: '../',
      current_path: `/${b.id}/index.html`,
      currentBranch: b.id,
      placeholder: b.searchPlaceholder || '搜索命令',
      isHome: false,
      describe: { n: b.name, d: b.desc },
      brand: b.name,
      items: byBranch[b.id],
      footerCount: byBranch[b.id].length,
      footerLabel: `个${b.name}命令`,
    }))
  );
}

// ── 6. 命令详情页 ───────────────────────────────────────────
console.log('渲染命令页…');
await pmap(items, 8, async (it) => {
  const b = branches.find((x) => x.id === it.b);
  const html = await render('details.ejs', base({
    relative_path: '../',
    current_path: it.p + '.html',
    currentBranch: it.b,
    placeholder: b.searchPlaceholder || '搜索命令',
    isHome: false,
    describe: { n: it.n, d: it.d },
    brand: b.name,
    mdhtml: await markdownToHTML(it.md),
    footerCount: byBranch[it.b].length,
    footerLabel: `个${b.name}命令`,
  }));
  await write(path.join(OUT_DIR, it.b, `${it.n}.html`), html);
});

// ── 7. 老 URL 跳转 stub ─────────────────────────────────────
const baseUrl = site.baseUrl ? String(site.baseUrl).replace(/\/$/, '') : '';
if (unmappedSlugs.length) {
  console.log(`  警告:${unmappedSlugs.length} 个老 slug 找不到对应页面,将不生成 stub:`);
  console.log(`        ${unmappedSlugs.slice(0, 20).join(', ')}${unmappedSlugs.length > 20 ? ' …' : ''}`);
}
console.log(
  `生成跳转 stub ${legacyItems.length} 个` +
    (movedSlugs.length ? `(已迁移:${movedSlugs.join(', ')})` : '') +
    '…'
);
await pmap(legacyItems, 16, async ({ slug, item }) => {
  const html = await render('redirect.ejs', base({
    site,
    target: `../${item.b}/${item.n}.html`,
    canonical: `${baseUrl}/${item.b}/${item.n}.html`,
    hasBaseUrl: Boolean(baseUrl),
  }));
  await write(path.join(OUT_DIR, 'c', `${slug}.html`), html);
});

// ── 8. 完成 ─────────────────────────────────────────────────
console.log(`\n✓ 构建完成 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`  命令页   ${items.length}`);
console.log(`  跳转 stub ${legacyItems.length}`);
console.log(`  分支页   ${branches.length}`);
console.log(`  产物目录 ${path.relative(process.cwd(), OUT_DIR)}/`);
