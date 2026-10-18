/**
 * 上游内容清单与重写进度校验
 *
 * 用法:
 *   node scripts/provenance.mjs
 *   node scripts/provenance.mjs --upstream /path/to/linux-command
 *   node scripts/provenance.mjs --mark linux/ls linux/grep
 *
 * --upstream 会对“已重写”页面做相似度检查:
 *   - 中文:连续 16 个汉字与上游相同
 *   - 英文:连续 8 个单词与上游相同
 * 代码块、行内代码、URL、标题标记不参与比较;命令语法和选项名不计入。
 */
import FS from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MANIFEST = path.join(ROOT, 'provenance.json');

const args = process.argv.slice(2);
const upstreamIdx = args.indexOf('--upstream');
const upstreamArg = upstreamIdx >= 0 ? args[upstreamIdx + 1] : '';
const markArgs = args.includes('--mark') ? args.slice(args.indexOf('--mark') + 1) : [];
if (upstreamIdx >= 0 && (!upstreamArg || upstreamArg.startsWith('--'))) {
  throw new Error('--upstream 需要一个已检出的 linux-command 目录');
}
const unknown = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--upstream') {
    i++;
    continue;
  }
  if (args[i] === '--mark') {
    while (i + 1 < args.length && !args[i + 1].startsWith('--')) i++;
    continue;
  }
  unknown.push(args[i]);
}

const keyOf = (p) => `${p.b}/${p.s}`;
const exists = async (p) => {
  try {
    await FS.access(p);
    return true;
  } catch {
    return false;
  }
};

const manifest = JSON.parse(await FS.readFile(MANIFEST, 'utf8'));
const errors = [];

if (!manifest.upstream?.commit || !Array.isArray(manifest.original_pages) || !Array.isArray(manifest.rewritten_pages)) {
  throw new Error('provenance.json 缺少 upstream.commit / original_pages / rewritten_pages');
}

const seenOriginal = new Set();
const seenRewritten = new Set();
for (const p of manifest.original_pages) {
  const k = keyOf(p);
  if (seenOriginal.has(k)) errors.push(`original_pages 重复: ${k}`);
  seenOriginal.add(k);
  if (!(await exists(path.join(ROOT, 'command', p.b, `${p.s}.md`)))) {
    errors.push(`original_pages 页面不存在: command/${p.b}/${p.s}.md`);
  }
}
for (const p of manifest.rewritten_pages) {
  const k = keyOf(p);
  if (seenRewritten.has(k)) errors.push(`rewritten_pages 重复: ${k}`);
  seenRewritten.add(k);
  if (seenOriginal.has(k)) errors.push(`同一页面同时出现在上游和已重写清单: ${k}`);
  if (!(await exists(path.join(ROOT, 'command', p.b, `${p.s}.md`)))) {
    errors.push(`rewritten_pages 页面不存在: command/${p.b}/${p.s}.md`);
  }
}

if (markArgs.length) {
  let moved = 0;
  for (const raw of markArgs) {
    if (raw.startsWith('--')) continue;
    let [b, s] = raw.includes('/') ? raw.split('/') : ['', raw];
    if (!b) {
      if (seenOriginal.has(`linux/${s}`) || (await exists(path.join(ROOT, 'command', 'linux', `${s}.md`)))) b = 'linux';
      else if (seenOriginal.has(`k8s/${s}`) || (await exists(path.join(ROOT, 'command', 'k8s', `${s}.md`)))) b = 'k8s';
    }
    const k = `${b}/${s}`;
    const idx = manifest.original_pages.findIndex((p) => keyOf(p) === k);
    if (idx < 0) {
      errors.push(`--mark 找不到上游页面: ${k}`);
      continue;
    }
    if (seenRewritten.has(k)) {
      errors.push(`--mark 页面已在已重写清单: ${k}`);
      continue;
    }
    const [page] = manifest.original_pages.splice(idx, 1);
    manifest.rewritten_pages.push(page);
    seenOriginal.delete(k);
    seenRewritten.add(k);
    moved++;
  }
  manifest.last_updated = new Date().toISOString().slice(0, 10);
  await FS.writeFile(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`已标记重写: ${moved} 页`);
}

const count = (list, b) => list.filter((p) => p.b === b).length;
console.log(`上游固定 commit : ${manifest.upstream.commit}`);
console.log(`原始基线        : ${manifest.original_pages.length + manifest.rewritten_pages.length} 页`);
console.log(`仍属上游        : ${manifest.original_pages.length} 页 (linux ${count(manifest.original_pages, 'linux')}, k8s ${count(manifest.original_pages, 'k8s')})`);
console.log(`已重写          : ${manifest.rewritten_pages.length} 页 (linux ${count(manifest.rewritten_pages, 'linux')}, k8s ${count(manifest.rewritten_pages, 'k8s')})`);

// ── 相似度检查 ─────────────────────────────────────────────
if (upstreamArg) {
  const upstreamRoot = path.resolve(upstreamArg);
  const upstreamFile = async (s) => {
    const a = path.join(upstreamRoot, 'command', `${s}.md`);
    if (await exists(a)) return a;
    const b = path.join(upstreamRoot, `${s}.md`);
    if (await exists(b)) return b;
    return '';
  };

  const prose = (text) => {
    const lines = text.split(/\r?\n/);
    const out = [];
    let fence = false;
    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        fence = !fence;
        continue;
      }
      if (!fence) out.push(line);
    }
    return out
      .join(' ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/`[^`]*`/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/^#{1,6}\s*/gm, ' ');
  };
  const han = (text) => text.replace(/[^㐀-鿿]/g, '');
  const words = (text) => text.toLowerCase().match(/[a-z]{2,}/g) || [];
  const shingles = (list, n) => {
    const set = new Set();
    for (let i = 0; i + n <= list.length; i++) set.add(list.slice(i, i + n).join('\u0001'));
    return set;
  };
  const shared = (a, b) => [...a].filter((x) => b.has(x));

  let flagged = 0;
  for (const p of manifest.rewritten_pages) {
    const local = await FS.readFile(path.join(ROOT, 'command', p.b, `${p.s}.md`), 'utf8');
    const upPath = await upstreamFile(p.s);
    if (!upPath) {
      errors.push(`相似度检查找不到上游原文: ${p.s}`);
      continue;
    }
    const up = await FS.readFile(upPath, 'utf8');
    const localHan = [...han(prose(local))];
    const upHan = [...han(prose(up))];
    const localWords = words(prose(local));
    const upWords = words(prose(up));
    const hanHits = shared(shingles(localHan, 16), shingles(upHan, 16));
    const wordHits = shared(shingles(localWords, 8), shingles(upWords, 8));
    if (hanHits.length || wordHits.length) {
      flagged++;
      const sample = (hits) => hits.slice(0, 2).map((x) => x.split('\u0001').join('')).join(' / ');
      errors.push(
        `${p.b}/${p.s}: 中文 16-gram ${hanHits.length} 处, 英文 8-gram ${wordHits.length} 处` +
          (hanHits.length ? `; 例: ${sample(hanHits)}` : '') +
          (wordHits.length ? `; 例: ${sample(wordHits)}` : '')
      );
    }
  }
  console.log(`相似度检查      : ${manifest.rewritten_pages.length} 页, ${flagged} 页命中`);
}

if (errors.length) {
  console.log(`\n✗ ${errors.length} 个问题:`);
  for (const e of errors.slice(0, 60)) console.log('  ' + e);
  if (errors.length > 60) console.log(`  … 另有 ${errors.length - 60} 个`);
  process.exit(1);
}
if (unknown.length) console.log(`(忽略未知参数: ${unknown.join(' ')})`);
console.log('\n✓ provenance 清单与相似度检查通过');
