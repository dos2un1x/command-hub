/**
 * 内容质量报告
 *
 * 统计各分支的自测、参考链接、相关链接、易错点覆盖与薄页数量。
 * 用法:npm run content-report [-- --json]
 */
import FS from 'node:fs/promises';
import path from 'node:path';
import { contentInitError, readCommandEntries } from './lib/content.mjs';
import { formatReport, summarizePages } from './lib/report.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const COMMAND_DIR = path.join(ROOT, 'command');
const config = JSON.parse(await FS.readFile(path.join(ROOT, 'branches.json'), 'utf8'));

const entries = await readCommandEntries(COMMAND_DIR);
const initError = contentInitError(entries);
if (initError) {
  console.error(`\n✗ ${initError}`);
  process.exit(1);
}

const pages = [];
for (const b of config.branches) {
  const dir = path.join(COMMAND_DIR, b.id);
  let files;
  try {
    files = (await FS.readdir(dir)).filter((f) => f.endsWith('.md'));
  } catch (e) {
    if (e.code === 'ENOENT') continue;
    throw e;
  }
  for (const f of files) {
    pages.push({
      branch: b.id,
      slug: f.slice(0, -3),
      raw: await FS.readFile(path.join(dir, f), 'utf8'),
    });
  }
}

const summary = summarizePages(pages);
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(formatReport(summary));
}
