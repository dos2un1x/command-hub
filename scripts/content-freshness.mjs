/**
 * 版本敏感页新鲜度报告。
 *
 * 用法:
 *   npm run freshness
 *   npm run freshness -- --json
 *   npm run freshness -- --max-age=365 --strict
 *
 * 登记表:assets/data/content-freshness.json
 *   { "pages": { "k8s/kserve": "2026-10-24" } }
 */
import FS from 'node:fs/promises';
import path from 'node:path';
import { analyzeFreshness, FRESHNESS_MAX_AGE_DAYS } from './lib/freshness.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const COMMAND_DIR = path.join(ROOT, 'command');
const REGISTRY = path.join(ROOT, 'assets', 'data', 'content-freshness.json');

const args = process.argv.slice(2);
const json = args.includes('--json');
const strict = args.includes('--strict');
const scanAll = args.includes('--all');
const DEFAULT_BRANCHES = new Set(['ai', 'k8s', 'middleware']);
const maxArg = args.find((a) => a.startsWith('--max-age='));
const maxAgeDays = maxArg ? Number(maxArg.split('=')[1]) : FRESHNESS_MAX_AGE_DAYS;

const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());

const pages = [];
for (const branch of await FS.readdir(COMMAND_DIR)) {
  if (!scanAll && !DEFAULT_BRANCHES.has(branch)) continue;
  const dir = path.join(COMMAND_DIR, branch);
  const stat = await FS.stat(dir).catch(() => null);
  if (!stat?.isDirectory()) continue;
  for (const file of (await FS.readdir(dir)).filter((f) => f.endsWith('.md'))) {
    pages.push({
      path: `${branch}/${file.slice(0, -3)}`,
      raw: await FS.readFile(path.join(dir, file), 'utf8'),
    });
  }
}

let registry = {};
try {
  registry = JSON.parse(await FS.readFile(REGISTRY, 'utf8'));
} catch {
  registry = { pages: {} };
}

const report = analyzeFreshness(pages, registry, today, maxAgeDays);
if (json) {
  console.log(JSON.stringify({ today, ...report }, null, 2));
} else {
  console.log(`版本敏感页新鲜度(今天 ${today},阈值 ${maxAgeDays} 天)\n`);
  console.log('| 页面 | 最后核对 | 已过天数 | 状态 |');
  console.log('|---|---|---:|---|');
  const label = { ok: 'OK', stale: '已过期', missing: '未登记' };
  for (const row of report.rows) {
    console.log(`| ${row.path} | ${row.verified || '-'} | ${row.ageDays ?? '-'} | ${label[row.status]} |`);
  }
  console.log(
    `\n共 ${report.rows.length} 个版本敏感页:OK ${report.ok},过期 ${report.stale},未登记 ${report.missing}`
  );
}

if (strict && (report.stale > 0 || report.missing > 0)) process.exitCode = 1;
