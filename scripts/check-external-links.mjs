/**
 * 外部参考链接可用性检查（默认只查 Markdown 的“参考链接”章节）。
 *
 * 用法:
 *   npm run check-external
 *   npm run check-external -- --json
 *   npm run check-external -- --strict --timeout=10000 --concurrency=16
 *   npm run check-external -- --page=guide/runbook-k8s-upgrade --limit=50
 */
import FS from 'node:fs/promises';
import path from 'node:path';
import { checkExternalLinks, mergeReferenceLinks } from './lib/external-links.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const COMMAND_DIR = path.join(ROOT, 'command');

const args = process.argv.slice(2);
const json = args.includes('--json');
const strict = args.includes('--strict');
const pageFilter = args.find((a) => a.startsWith('--page='))?.slice('--page='.length);
const limitArg = args.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : null;
const timeoutArg = args.find((a) => a.startsWith('--timeout='));
const timeoutMs = timeoutArg ? Number(timeoutArg.split('=')[1]) : 8000;
const concurrencyArg = args.find((a) => a.startsWith('--concurrency='));
const concurrency = concurrencyArg ? Number(concurrencyArg.split('=')[1]) : 12;

const config = JSON.parse(await FS.readFile(path.join(ROOT, 'branches.json'), 'utf8'));
const pageMarkdowns = {};
for (const branch of config.branches) {
  const dir = path.join(COMMAND_DIR, branch.id);
  let files;
  try {
    files = (await FS.readdir(dir)).filter((f) => f.endsWith('.md'));
  } catch (error) {
    if (error.code === 'ENOENT') continue;
    throw error;
  }
  for (const file of files) {
    const pagePath = `${branch.id}/${file.slice(0, -3)}`;
    if (pageFilter && pagePath !== pageFilter) continue;
    pageMarkdowns[pagePath] = await FS.readFile(path.join(dir, file), 'utf8');
  }
}

let entries = [...mergeReferenceLinks(pageMarkdowns).entries()];
if (Number.isFinite(limit) && limit > 0) entries = entries.slice(0, limit);

console.error(`检查 ${entries.length} 个唯一外链（并发 ${concurrency}，超时 ${timeoutMs}ms）…`);
const results = await checkExternalLinks(entries, { concurrency, timeoutMs });
const failed = results.filter((r) => !r.ok);

if (json) {
  console.log(JSON.stringify({ total: results.length, failed: failed.length, results: failed }, null, 2));
} else {
  console.log(`外链总数: ${results.length}，失败: ${failed.length}`);
  for (const row of failed) {
    const pages = row.pages.slice(0, 3).join(', ') + (row.pages.length > 3 ? ` 等 ${row.pages.length} 页` : '');
    console.log(`- [${row.status ?? row.error}] ${row.url}  ← ${pages}`);
  }
  if (!failed.length) console.log('✓ 参考链接全部可访问');
}

if (strict && failed.length) process.exitCode = 1;
