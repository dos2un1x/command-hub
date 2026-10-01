/**
 * 产物内链完整性校验:全站零 404
 *
 * 检查:
 *  1. dt.js 每条记录对应的页面存在
 *  2. 每个跳转 stub 的目标存在
 *  3. 所有 HTML 中的站内 href/src 可解析到真实文件
 *  4. 分支落地页存在
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

// ── 2 & 3. 解析每个 HTML 的站内链接 ──────────────────────────
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
    const target = path.resolve(dir, url);
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
console.log(`分支            : ${branches.map((b) => b.id).join(', ')}`);

if (errors.length) {
  console.log(`\n✗ 发现 ${errors.length} 个问题:\n`);
  for (const e of errors.slice(0, 40)) console.log('  ' + e);
  if (errors.length > 40) console.log(`  … 另有 ${errors.length - 40} 个`);
  process.exit(1);
}
console.log('\n✓ 内链完整,零 404');
