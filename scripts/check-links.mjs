/**
 * 产物内链完整性校验:全站零 404
 *
 * 检查:
 *  1. dt.js 每条记录对应的页面存在
 *  2. 所有 HTML 中的站内 href/src 可解析到真实文件
 *  3. 分支落地页存在
 */
import FS from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'build');

async function walk(dir, acc = []) {
  for (const e of await FS.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

const exists = async (p) => {
  try {
    await FS.access(p);
    return true;
  } catch {
    return false;
  }
};

const all = await walk(OUT);
const htmlFiles = all.filter((f) => f.endsWith('.html'));
const errors = [];
const rel = (p) => path.relative(OUT, p);

// ── 1. dt.js 记录 → 页面存在 ─────────────────────────────────
const dtSrc = await FS.readFile(path.join(OUT, 'js', 'dt.js'), 'utf8');
const commands = JSON.parse(dtSrc.match(/var commands=(\[[\s\S]*?\]);/)[1]);
const branches = JSON.parse(dtSrc.match(/var branches=(\[[\s\S]*?\]);/)[1]);

for (const c of commands) {
  if (!(await exists(path.join(OUT, c.p.replace(/^\//, '') + '.html')))) {
    errors.push(`dt.js 记录无对应页面: ${c.n} → ${c.p}.html`);
  }
}

for (const b of branches) {
  if (!(await exists(path.join(OUT, b.id, 'index.html')))) {
    errors.push(`分支 "${b.id}" 缺少落地页 ${b.id}/index.html`);
  }
}

// ── 2. sitemap / robots ─────────────────────────────────────
const sitemapPath = path.join(OUT, 'sitemap.xml');
const robotsPath = path.join(OUT, 'robots.txt');
let sitemapCount = 0;
if (!(await exists(sitemapPath))) {
  errors.push('缺少 sitemap.xml');
} else {
  const xml = await FS.readFile(sitemapPath, 'utf8');
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  sitemapCount = locs.length;
  for (const loc of locs) {
    let p = decodeURIComponent(new URL(loc).pathname);
    if (p.endsWith('/')) p += 'index.html';
    const target = path.join(OUT, p.replace(/^\//, ''));
    if (!(await exists(target))) errors.push(`sitemap 目标不存在: ${loc}`);
  }
}
if (!(await exists(robotsPath))) errors.push('缺少 robots.txt');

// ── 2.5 诊断向导数据:节点引用与结果链接 ──────────────────
const diagnosePath = path.join(OUT, 'data', 'diagnose.json');
let diagnoseTrees = 0;
let diagnoseLinks = 0;
if (!(await exists(diagnosePath))) {
  errors.push('缺少 data/diagnose.json');
} else {
  const trees = JSON.parse(await FS.readFile(diagnosePath, 'utf8'));
  diagnoseTrees = trees.length;
  for (const tree of trees) {
    if (!tree.start || !tree.nodes?.[tree.start]) {
      errors.push(`诊断树 "${tree.id}" 的 start 节点不存在`);
      continue;
    }
    for (const [nodeId, node] of Object.entries(tree.nodes)) {
      if (node.type === 'question') {
        for (const opt of node.options || []) {
          if (!opt.next || !tree.nodes[opt.next]) {
            errors.push(`诊断树 "${tree.id}" 节点 "${nodeId}" 指向不存在的节点 "${opt.next}"`);
          }
        }
      }
      if (node.type === 'result') {
        for (const link of node.links || []) {
          diagnoseLinks++;
          const target = path.join(OUT, String(link.href || '').replace(/^\//, ''));
          const candidates = [target, path.join(target, 'index.html')];
          let found = false;
          for (const c of candidates) {
            if (await exists(c)) {
              found = true;
              break;
            }
          }
          if (!found) errors.push(`诊断树 "${tree.id}" 链接不存在: ${link.href}`);
        }
      }
    }
  }
}

// ── 3. 解析每个 HTML 的站内链接 ──────────────────────────
const ATTR = /(?:href|src)\s*=\s*"([^"]*)"/gi;
let linkCount = 0;

for (const file of htmlFiles) {
  const html = await FS.readFile(file, 'utf8');
  const dir = path.dirname(file);

  for (const m of html.matchAll(ATTR)) {
    let url = m[1].trim();
    if (!url) continue;
    if (/^(https?:|mailto:|tel:|data:|javascript:|#|\/\/)/i.test(url)) continue;

    // 去掉查询串与锚点
    url = url.split('#')[0].split('?')[0];
    if (!url) continue;

    linkCount++;
    // 站内绝对路径(/k8s/...)按产物根目录解析;相对路径按当前页面目录解析。
    const target = url.startsWith('/')
      ? path.join(OUT, url.replace(/^\//, ''))
      : path.resolve(dir, url);
    const candidates = [target, path.join(target, 'index.html')];
    if (!(await candidates.reduce(async (acc, c) => (await acc) || (await exists(c)), Promise.resolve(false)))) {
      errors.push(`${rel(file)} → 断链 ${url}`);
    }
  }
}

// ── 4. 汇总 ─────────────────────────────────────────────────
console.log(`扫描 HTML      : ${htmlFiles.length}`);
console.log(`校验站内链接    : ${linkCount}`);
console.log(`dt.js 记录      : ${commands.length}`);
console.log(`sitemap          : ${sitemapCount} 条`);
console.log(`分支            : ${branches.map((b) => b.id).join(', ')}`);
console.log(`诊断向导        : ${diagnoseTrees} 棵树 / ${diagnoseLinks} 个链接`);

if (errors.length) {
  console.log(`\n✗ 发现 ${errors.length} 个问题:\n`);
  for (const e of errors.slice(0, 40)) console.log('  ' + e);
  if (errors.length > 40) console.log(`  … 另有 ${errors.length - 40} 个`);
  process.exit(1);
}
console.log('\n✓ 内链完整,零 404');
