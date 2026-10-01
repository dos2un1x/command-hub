/**
 * 源文件结构校验(不构建)
 *
 * 在写内容后立刻可跑,用于在构建前拦住格式问题。
 * 构建时 build.mjs 也会做同样的检查,这里是独立入口。
 */
import FS from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const COMMAND_DIR = path.join(ROOT, 'command');
const RESERVED = new Set(['index', 'list', 'hot']);

const sanitize = (v) =>
  String(v || '')
    .replace(/^﻿/, '')
    .replace(/[​-‍⁠]/g, '')
    .trim();

const config = JSON.parse(await FS.readFile(path.join(ROOT, 'branches.json'), 'utf8'));
const declared = new Set(config.branches.map((b) => b.id));
const errors = [];
const warnings = [];

const entries = await FS.readdir(COMMAND_DIR, { withFileTypes: true });

for (const e of entries) {
  if (e.isFile() && e.name.endsWith('.md')) {
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

  for (const f of files) {
    total++;
    const slug = f.slice(0, -3);
    const raw = await FS.readFile(path.join(dir, f), 'utf8');
    const where = `command/${b.id}/${f}`;

    const m = raw.match(/^([^=]+?)\s*===/);
    if (!m) {
      errors.push(`${where}: 缺少 "标题\\n===" 头`);
      continue;
    }
    const title = sanitize(m[1]);
    if (title !== slug) {
      errors.push(`${where}: 标题 "${title}" ≠ 文件名 "${slug}"(会导致 404)`);
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) {
      errors.push(`${where}: 文件名不是合法 ASCII slug`);
    }
    if (RESERVED.has(slug)) {
      errors.push(`${where}: "${slug}" 是保留名,会与 index/list/hot 冲突`);
    }
    const dm = raw.match(/\n={1,}([\s\S]*?)##/i);
    if (!dm || !dm[1].replace(/[\r\n]/g, '').trim()) {
      errors.push(`${where}: 描述为空(需在 === 与第一个 ## 之间填写描述)`);
    }

    const key = slug;
    if (!names.has(key)) names.set(key, []);
    names.get(key).push(b.id);
  }
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
