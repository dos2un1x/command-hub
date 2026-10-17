/**
 * 把 command/<branch>/categories.json 渲染成可审阅的分类映射表
 *
 * 用途:分类归属需要人工确认,JSON 适合构建消费,Markdown 适合逐条 review。
 * 运行:npm run category-map
 */
import FS from 'node:fs/promises';
import path from 'node:path';

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

  const categories = catConfig.categories || [];
  const assignments = catConfig.assignments || {};
  const files = (await FS.readdir(dir))
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3));

  const errors = [];
  const byCat = Object.fromEntries(categories.map((c) => [c.id, []]));
  for (const slug of files) {
    const cat = assignments[slug];
    if (!cat) errors.push(`未分类: ${slug}`);
    else if (!byCat[cat]) errors.push(`未知分类 "${cat}": ${slug}`);
    else byCat[cat].push(slug);
  }
  for (const slug of Object.keys(assignments)) {
    if (!files.includes(slug)) errors.push(`映射里多出: ${slug}`);
  }
  if (errors.length) {
    console.error(`✗ ${branchId}: ${errors.length} 个问题`);
    for (const e of errors.slice(0, 40)) console.error('  ' + e);
    process.exit(1);
  }

  async function descFor(slug) {
    const raw = await FS.readFile(path.join(dir, `${slug}.md`), 'utf8');
    const m = raw.match(/\n={1,}([\s\S]*?)##/i);
    return m ? m[1].replace(/[\r\n|]/g, ' ').replace(/\|/g, '\\|').trim() : '';
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
  for (const c of categories) lines.push(`| ${c.name} | \`${c.id}\` | ${byCat[c.id].length} |`);
  lines.push(`| **合计** | | **${files.length}** |`, '');

  for (const c of categories) {
    lines.push(`## ${c.name}(\`${c.id}\`)`, '', c.desc, '', '| slug | 简述 |', '|---|---|');
    for (const slug of [...byCat[c.id]].sort()) {
      lines.push(`| \`${slug}\` | ${await descFor(slug)} |`);
    }
    lines.push('');
  }

  const outPath = path.join(OUT_DIR, `${branchId}-category-map.md`);
  await FS.mkdir(OUT_DIR, { recursive: true });
  await FS.writeFile(outPath, lines.join('\n'));
  console.log(`✓ ${path.relative(ROOT, outPath)}(${files.length} 条)`);
  for (const c of categories) console.log(`  ${c.name.padEnd(10)} ${byCat[c.id].length}`);
  rendered++;
}

if (!rendered) console.log('没有找到任何 categories.json');
