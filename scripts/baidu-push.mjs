/**
 * 百度普通收录主动推送
 *
 * 从 build/sitemap.xml 取 URL,只推送新增或有改动的页面;已推送状态记在
 * deploy/baidu-pushed.json(默认每天推送 100 条,避免一次耗尽当日额度)。
 *
 * 用法:
 *   npm run baidu:push
 *   npm run baidu:push -- --limit=50
 *   npm run baidu:push -- --all
 *   npm run baidu:push -- --site=dos2unix.cn   # 推送裸域版本(默认 www)
 *   npm run baidu:push -- --dry-run
 *
 * Token 读取顺序:--token= > BAIDU_TOKEN 环境变量 > .baidu-token 文件。
 * 不要把 token 写进仓库。
 */
import FS from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUILD = path.join(ROOT, 'build');
const SITEMAP = path.join(BUILD, 'sitemap.xml');
const STATE = path.join(ROOT, 'deploy', 'baidu-pushed.json');

const args = process.argv.slice(2);
const getArg = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const hasFlag = (name) => args.includes(`--${name}`);

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const token = getArg('token') || process.env.BAIDU_TOKEN || '';
const tokenFile = path.join(ROOT, '.baidu-token');

let resolvedToken = token;
if (!resolvedToken) {
  try {
    resolvedToken = (await FS.readFile(tokenFile, 'utf8')).trim();
  } catch {
    // 文件不存在时继续走下面的报错
  }
}
if (!resolvedToken) {
  fail('缺少百度推送 token。请设置 BAIDU_TOKEN 或创建 .baidu-token 文件。');
}

const site = String(getArg('site') || process.env.BAIDU_SITE || 'www.dos2unix.cn')
  .replace(/^https?:\/\//, '')
  .replace(/\/$/, '');
const doAll = hasFlag('all');
const dryRun = hasFlag('dry-run');
const limit = doAll ? Infinity : Math.max(1, Number(getArg('limit') || 100));

let sitemap;
try {
  sitemap = await FS.readFile(SITEMAP, 'utf8');
} catch {
  fail('缺少 build/sitemap.xml。请先运行 npm run build。');
}

const entries = [...sitemap.matchAll(/<url>([\s\S]*?)<\/url>/g)]
  .map((m) => {
    const loc = m[1].match(/<loc>([^<]+)<\/loc>/)?.[1];
    const priority = Number(m[1].match(/<priority>([^<]+)<\/priority>/)?.[1] || 0);
    return { url: loc ? loc.replace(/&amp;/g, '&').trim() : '', priority };
  })
  .filter((e) => e.url);
if (!entries.length) fail('sitemap.xml 里没有 URL。');

/** sitemap URL → build/ 下的本地文件 */
function fileFor(url) {
  const { pathname } = new URL(url);
  let p = decodeURIComponent(pathname);
  if (p.endsWith('/')) p += 'index.html';
  return path.join(BUILD, p.replace(/^\//, ''));
}

async function hashFor(url) {
  try {
    const buf = await FS.readFile(fileFor(url));
    return crypto.createHash('sha1').update(buf).digest('hex');
  } catch {
    return null;
  }
}

let state = {};
try {
  state = JSON.parse(await FS.readFile(STATE, 'utf8'));
} catch {
  // 首次运行
}

// 计算每个 URL 的当前内容指纹,找出新增/变更的页面
const current = [];
for (const entry of entries) {
  const hash = await hashFor(entry.url);
  if (!hash) continue;
  current.push({ ...entry, hash, key: `${site}|${entry.url}` });
}

// 首页/分支页/热门命令优先,稳定排序保留 sitemap 内的顺序
const pending = (doAll ? current : current.filter((u) => state[u.key] !== u.hash)).sort(
  (a, b) => b.priority - a.priority
);
console.log(`站点 ${site}:共 ${current.length} 条,待推送 ${pending.length} 条`);
if (!pending.length) {
  console.log('✓ 没有新增或变更的页面');
  process.exit(0);
}

const batch = pending.slice(0, limit);
const pushUrls = batch.map((u) => {
  if (site === 'www.dos2unix.cn') return u.url;
  return u.url.replace(/^https?:\/\/www\.dos2unix\.cn/, `https://${site}`);
});

console.log(`本次推送 ${pushUrls.length} 条${dryRun ? '(dry-run,不实际发送)' : ''}…`);
if (dryRun) {
  console.log(pushUrls.slice(0, 10).join('\n'));
  if (pushUrls.length > 10) console.log(`… 另有 ${pushUrls.length - 10} 条`);
  process.exit(0);
}

const endpoint =
  `http://data.zz.baidu.com/urls?site=${encodeURIComponent(site)}` +
  `&token=${encodeURIComponent(resolvedToken)}`;

let res, text;
try {
  res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: pushUrls.join('\n'),
    signal: AbortSignal.timeout(30000),
  });
  text = await res.text();
} catch (e) {
  fail(`请求百度接口失败:${e.message}`);
}

let data;
try {
  data = JSON.parse(text);
} catch {
  fail(`百度返回非 JSON(HTTP ${res.status}):${text.slice(0, 300)}`);
}

if (!res.ok || data.error) {
  fail(`百度返回错误(HTTP ${res.status}):${text.slice(0, 300)}`);
}

console.log(
  `success=${data.success ?? 0} remain=${data.remain ?? '?'}` +
    (data.not_same_site?.length ? ` not_same_site=${data.not_same_site.length}` : '') +
    (data.not_valid?.length ? ` not_valid=${data.not_valid.length}` : '')
);

for (const key of ['not_same_site', 'not_valid']) {
  if (data[key]?.length) {
    console.log(`  ${key}:`);
    for (const u of data[key].slice(0, 5)) console.log(`    ${u}`);
  }
}

// 只有整批都成功才记为已推送,避免额度不足时漏推
const success = Number(data.success || 0);
if (success >= pushUrls.length) {
  for (const u of batch) state[u.key] = u.hash;
  await FS.mkdir(path.dirname(STATE), { recursive: true });
  await FS.writeFile(STATE, JSON.stringify(state, null, 2) + '\n');
  console.log(`✓ 已记录 ${batch.length} 条推送状态`);
} else {
  console.log('· 未整批成功,本次不记录状态;下次运行会重试这批 URL');
}

const rest = pending.length - batch.length;
if (rest > 0) console.log(`· 还有 ${rest} 条待推送,可明天继续或调大 --limit`);
