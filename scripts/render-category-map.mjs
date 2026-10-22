/**
 * 把 command/<branch>/categories.json 渲染成可审阅的分类映射表
 *
 * 用途:分类归属需要人工确认,JSON 适合构建消费,Markdown 适合逐条 review。
 * 运行:npm run category-map
 */
import FS from 'node:fs/promises';
import path from 'node:path';
import { parseSource, validateCategoryConfig } from './lib/content.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const COMMAND_ROOT = path.join(ROOT, 'command');
const OUT_DIR = path.join(ROOT, 'docs', 'seo');

const siteConfig = JSON.parse(await FS.readFile(path.join(ROOT, 'branches.json'), 'utf8'));
const branchNames = new Map(siteConfig.branches.map((b) => [b.id, b.name]));

const branchDirs = (await FS.readdir(COMMAND_ROOT, { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

let rendered = 0;

for (const branchId of branchDirs) {
  const dir = path.join(COMMAND_ROOT, branchId);
  const configPath = path.join(dir, 'categories.json');
  let catConfig;
  try {
    catConfig = JSON.parse(await FS.readFile(configPath, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') continue;
    throw e;
  }

  const files = (await FS.readdir(dir))
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3));
  const items = files.map((n) => ({ n }));
  const { list: categories, byCat, errors } = validateCategoryConfig({
    branchId,
    cfg: catConfig,
    items,
  });
  if (errors.length) {
    console.error(`✗ ${branchId}: ${errors.length} 个问题`);
    for (const e of errors.slice(0, 40)) console.error('  ' + e);
    process.exit(1);
  }

  async function descFor(slug) {
    const raw = await FS.readFile(path.join(dir, `${slug}.md`), 'utf8');
    return parseSource(raw).desc.replace(/\|/g, '\\|');
  }

  const branchName = branchNames.get(branchId) || branchId;
  const lines = [
    `# ${branchName} ${files.length} 条分类映射`,
    '',
    `> 生成时间:${new Date().toISOString().slice(0, 10)} · 源文件:\`command/${branchId}/categories.json\``,
    '> 修改分类时请改 JSON,再运行 `npm run category-map` 重新生成本表。',
    '',
    '## 汇总',
    '',
    '| 分类 | id | 条目数 |',
    '|---|---|---:|',
  ];
  for (const c of categories) lines.push(`| ${c.name} | \`${c.id}\` | ${byCat.get(c.id).length} |`);
  lines.push(`| **合计** | | **${files.length}** |`, '');

  for (const c of categories) {
    const slugs = byCat.get(c.id).map((item) => item.n).sort();
    lines.push(`## ${c.name}(\`${c.id}\`)`, '', c.desc, '', '| slug | 简述 |', '|---|---|');
    for (const slug of slugs) {
      lines.push(`| \`${slug}\` | ${await descFor(slug)} |`);
    }
    lines.push('');
  }

  const outPath = path.join(OUT_DIR, `${branchId}-category-map.md`);
  await FS.mkdir(OUT_DIR, { recursive: true });
  await FS.writeFile(outPath, lines.join('\n'));
  console.log(`✓ ${path.relative(ROOT, outPath)}(${files.length} 条)`);
  for (const c of categories) console.log(`  ${c.name.padEnd(10)} ${byCat.get(c.id).length}`);
  rendered++;
}

if (!rendered) console.log('没有找到任何 categories.json');
