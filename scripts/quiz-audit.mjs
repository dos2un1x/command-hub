/** 自测题质量报告:标记答案过短、缺少原因的是非题。 */
import FS from 'node:fs/promises';
import path from 'node:path';
import { parseSelfTests } from './lib/content.mjs';
import { auditQuizzes } from './lib/quiz-quality.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const COMMAND_DIR = path.join(ROOT, 'command');
const args = process.argv.slice(2);
const json = args.includes('--json');
const only = args.find((a) => a.startsWith('--branch='))?.split('=')[1];

const pages = [];
for (const branch of await FS.readdir(COMMAND_DIR)) {
  if (only && branch !== only) continue;
  const dir = path.join(COMMAND_DIR, branch);
  if (!(await FS.stat(dir).catch(() => null))?.isDirectory()) continue;
  for (const file of (await FS.readdir(dir)).filter((f) => f.endsWith('.md'))) {
    const raw = await FS.readFile(path.join(dir, file), 'utf8');
    pages.push({ path: `${branch}/${file.slice(0, -3)}`, qa: parseSelfTests(raw) });
  }
}

const report = auditQuizzes(pages);
if (json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`自测题 ${report.total} 道,待改写 ${report.flagged.length} 道\n`);
  console.log('| 分支 | 待改写 |');
  console.log('|---|---:|');
  for (const [branch, count] of Object.entries(report.byBranch).sort()) {
    console.log(`| ${branch} | ${count} |`);
  }
  console.log('\n| 页面 | 类型 | 问题 | 当前答案 |');
  console.log('|---|---|---|---|');
  for (const f of report.flagged) {
    const clean = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
    console.log(`| ${f.path} | ${f.reason} | ${clean(f.q).slice(0, 60)} | ${clean(f.a).slice(0, 60)} |`);
  }
}
