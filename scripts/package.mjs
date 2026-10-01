/**
 * 发布打包:把 build/ 暂存为 public/ 并打成 public.zip
 *
 * 由 `npm run package` 调用(先跑 verify 再执行本脚本),也可单独运行 ——
 * 单独运行时直接使用现有 build/,不重新构建。
 *
 * 打包用系统 zip,自动排除 macOS 的 __MACOSX/AppleDouble 元数据与
 * .DS_Store(Linux/Windows 解包时不会多出一堆 ._* 文件)。
 * 完成后自检产物:条目数、解压体积与 build/ 一致,且无元数据垃圾。
 */
import FS from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const BUILD = path.join(ROOT, 'build');
const PUBLIC = path.join(ROOT, 'public');
const ZIP = path.join(ROOT, 'public.zip');

async function walk(dir, acc = []) {
  for (const e of await FS.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

// ── 1. build/ 必须存在 ──────────────────────────────────────
try {
  await FS.access(BUILD);
} catch {
  console.log('✗ 缺少 build/。请先 npm run build,或直接 npm run package(会先跑 verify)');
  process.exit(1);
}

// ── 2. 暂存:public/ = build/ 的完整副本 ────────────────────
const files = await walk(BUILD);
const sizes = await Promise.all(files.map(async (f) => (await FS.stat(f)).size));
const totalBytes = sizes.reduce((a, b) => a + b, 0);

await FS.rm(PUBLIC, { recursive: true, force: true });
await FS.cp(BUILD, PUBLIC, { recursive: true });
console.log(`暂存 public/   : ${files.length} 个文件`);

// ── 3. 打包(排除 macOS 元数据) ─────────────────────────────
await FS.rm(ZIP, { force: true });
try {
  await run('zip', ['-rqX', 'public.zip', 'public', '-x', '__MACOSX/*', '-x', '*.DS_Store'], { cwd: ROOT });
} catch (e) {
  console.log(`✗ 打包失败:${e.message}(依赖系统 zip 命令)`);
  process.exit(1);
}

// ── 4. 自检:条目数、解压体积、无 __MACOSX/.DS_Store ─────────
let entries;
try {
  const { stdout } = await run('unzip', ['-l', 'public.zip'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  entries = stdout
    .split('\n')
    .map((l) => l.match(/^\s*(\d+)\s+\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}\s+(.+)$/))
    .filter(Boolean)
    .map((m) => ({ size: Number(m[1]), name: m[2].trim() }));
} catch {
  console.log('· 跳过自检(系统缺少 unzip)');
}

if (entries) {
  const junk = entries.filter((e) => e.name.startsWith('__MACOSX/') || path.basename(e.name) === '.DS_Store');
  const zipped = entries.filter((e) => !e.name.endsWith('/'));
  const zippedBytes = zipped.reduce((a, e) => a + e.size, 0);
  const problems = [];
  if (junk.length) problems.push(`${junk.length} 个 macOS 元数据条目(如 ${junk[0].name})`);
  if (zipped.length !== files.length) problems.push(`条目数 ${zipped.length} ≠ build/ 文件数 ${files.length}`);
  if (zippedBytes !== totalBytes) problems.push(`解压体积 ${zippedBytes} ≠ build/ 体积 ${totalBytes}`);
  if (problems.length) {
    console.log(`\n✗ 产物自检未通过:${problems.join(';')}`);
    process.exit(1);
  }
  console.log(`产物自检       : ${zipped.length} 条,无 __MACOSX / .DS_Store`);
}

const zipSize = (await FS.stat(ZIP)).size;
console.log(`\n✓ 打包完成:public.zip(${(zipSize / 1024 / 1024).toFixed(1)} MB,${files.length} 个文件)`);
