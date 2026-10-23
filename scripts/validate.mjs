/**
 * 源文件结构校验(不构建)
 *
 * 在写内容后立刻可跑,用于在构建前拦住格式与分类问题。
 * build.mjs 复用 scripts/lib/content.mjs 的同一套解析规则。
 */
import FS from 'node:fs/promises';
import path from 'node:path';
import {
  RESERVED,
  contentInitError,
  isStrayRootMarkdown,
  isValidSlug,
  missingHotCommands,
  parseSource,
  readCommandEntries,
  validateCategoryConfig,
} from './lib/content.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const COMMAND_DIR = path.join(ROOT, 'command');

const config = JSON.parse(await FS.readFile(path.join(ROOT, 'branches.json'), 'utf8'));
const declared = new Set(config.branches.map((b) => b.id));
const errors = [];
const warnings = [];

const branchIds = config.branches.map((b) => b.id);
const duplicateBranchIds = branchIds.filter((id, i, list) => list.indexOf(id) !== i);
if (duplicateBranchIds.length) {
  errors.push(`branches.json 存在重复分支 id:${[...new Set(duplicateBranchIds)].join(', ')}`);
}
for (const b of config.branches) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(b.id)) {
    errors.push(`branches.json 的分支 id 不合法: ${b.id}`);
  }
}

const entries = await readCommandEntries(COMMAND_DIR);
const initError = contentInitError(entries);
if (initError) {
  console.log(`\n✗ ${initError}`);
  process.exit(1);
}

for (const e of entries) {
  if (e.isFile() && isStrayRootMarkdown(e.name)) {
    errors.push(`command/ 根目录下的 ${e.name} 必须归入分支目录`);
  }
  if (e.isDirectory() && !declared.has(e.name)) {
    errors.push(`command/${e.name}/ 未在 branches.json 声明`);
  }
}

let total = 0;
const names = new Map();

for (const b of config.branches) {
  const dir = path.join(COMMAND_DIR, b.id);
  let files;
  try {
    files = (await FS.readdir(dir)).filter((f) => f.endsWith('.md'));
  } catch {
    errors.push(`branches.json 声明了 "${b.id}",但缺少 command/${b.id}/ 目录`);
    continue;
  }
  if (!files.length) warnings.push(`分支 "${b.id}" 没有任何页面`);

  const branchItems = [];
  for (const f of files) {
    total++;
    const slug = f.slice(0, -3);
    const raw = await FS.readFile(path.join(dir, f), 'utf8');
    const where = `command/${b.id}/${f}`;
    const parsed = parseSource(raw);
    branchItems.push({ n: slug });

    if (!parsed.hasTitle) {
      errors.push(`${where}: 缺少 "标题\\n===" 头`);
      continue;
    }
    if (parsed.title !== slug) {
      errors.push(`${where}: 标题 "${parsed.title}" ≠ 文件名 "${slug}"(会导致 404)`);
    }
    if (!isValidSlug(slug)) {
      errors.push(`${where}: 文件名不是合法 ASCII slug`);
    }
    if (RESERVED.has(slug)) {
      errors.push(`${where}: "${slug}" 是保留名,会与 index/list/hot/review/diagnose 冲突`);
    }
    if (!parsed.desc) {
      errors.push(`${where}: 描述为空(需在 === 与第一个 ## 之间填写描述)`);
    }

    if (!names.has(slug)) names.set(slug, []);
    names.get(slug).push(b.id);
  }

  // 有 categories.json 的分支:未归类、未知分类、空分类、重复 id 都在这里拦住。
  try {
    const cfg = JSON.parse(await FS.readFile(path.join(dir, 'categories.json'), 'utf8'));
    const { errors: catErrors } = validateCategoryConfig({
      branchId: b.id,
      cfg,
      items: branchItems,
    });
    for (const error of catErrors) {
      errors.push(`command/${b.id}/categories.json: ${error}`);
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

const missingHot = missingHotCommands(config.site?.hotCommands || [], names);
if (missingHot.length) {
  errors.push(`branches.json 的 hotCommands 引用了不存在的页面: ${missingHot.join(', ')}`);
}

const dupes = [...names.entries()].filter(([, brs]) => brs.length > 1);
for (const [slug, brs] of dupes) {
  warnings.push(`跨分支同名页 "${slug}" 存在于 ${brs.join(', ')}(允许,URL 各自独立)`);
}

console.log(`分支      : ${config.branches.length} (${config.branches.map((b) => b.id).join(', ')})`);
console.log(`页面      : ${total}`);

if (warnings.length) {
  console.log(`\n提示 ${warnings.length} 条:`);
  for (const w of warnings) console.log('  · ' + w);
}

if (errors.length) {
  console.log(`\n✗ ${errors.length} 个错误:`);
  for (const e of errors) console.log('  ' + e);
  process.exit(1);
}
console.log('\n✓ 源文件结构校验通过');
