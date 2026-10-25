/**
 * 站内编辑性入链报告：找出孤立页与低入链页。
 *
 * 用法:
 *   npm run content-graph
 *   npm run content-graph -- --branch=guide --max=1
 *   npm run content-graph -- --json
 */
import FS from 'node:fs/promises';
import path from 'node:path';
import { lowInlinkPages } from './lib/content-graph.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const COMMAND_DIR = path.join(ROOT, 'command');
const config = JSON.parse(await FS.readFile(path.join(ROOT, 'branches.json'), 'utf8'));
const args = process.argv.slice(2);
const json = args.includes('--json');
const branchArg = args.find((a) => a.startsWith('--branch='))?.slice('--branch='.length);
const maxArg = args.find((a) => a.startsWith('--max='));
const max = maxArg ? Number(maxArg.split('=')[1]) : 1;

const pages = [];
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
    pages.push({
      branch: branch.id,
      slug: file.slice(0, -3),
      raw: await FS.readFile(path.join(dir, file), 'utf8'),
    });
  }
}

const scope = branchArg ? pages.filter((p) => p.branch === branchArg) : pages;
const all = lowInlinkPages(pages, max).filter((row) => !branchArg || row.path.startsWith(`${branchArg}/`));
const byBranch = {};
for (const row of all) {
  const branch = row.path.split('/')[0];
  byBranch[branch] ??= { total: 0, zero: 0 };
  byBranch[branch].total++;
  if (row.inbound === 0) byBranch[branch].zero++;
}

if (json) {
  console.log(JSON.stringify({ max, total: scope.length, pages: all }, null, 2));
} else {
  console.log(`编辑性入链 ≤${max} 的页面: ${all.length} / ${scope.length}\n`);
  console.log('| 分支 | 低入链 | 零入链 |');
  console.log('|---|---:|---:|');
  for (const [branch, stat] of Object.entries(byBranch).sort()) {
    console.log(`| ${branch} | ${stat.total} | ${stat.zero} |`);
  }
  console.log('');
  for (const row of all.slice(0, 80)) {
    console.log(`- ${row.path} (${row.inbound})`);
  }
  if (all.length > 80) console.log(`… 其余 ${all.length - 80} 页见 --json`);
}
