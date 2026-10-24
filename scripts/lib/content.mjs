/**
 * 内容源解析与校验的公共实现
 *
 * build/validate/render-category-map 共用这一份规则，避免三处逻辑漂移。
 */
import FS from 'node:fs/promises';

/** 分支内的保留名:index 会覆盖分支落地页,其余与根页面同名,便于统一约束。 */
export const RESERVED = new Set(['index', 'list', 'hot', 'review', 'diagnose']);

/**
 * 读取 command/ 的条目;目录不存在时返回空数组。
 *
 * command/ 现在是私有内容子模块。未初始化时目录可能不存在,
 * 由 contentInitError 给出可操作的提示,而不是抛 ENOENT。
 */
export async function readCommandEntries(dir) {
  try {
    return await FS.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

/** 私有内容子模块为空时的提示;已初始化返回空字符串。 */
export function contentInitError(entries) {
  if (entries.length) return '';
  return [
    'command/ 内容为空:它是私有内容子模块,不是普通目录。',
    '  请先运行:git submodule update --init --recursive',
    '  并确认当前 GitHub 账号对 dos2un1x/command 有读取权限。',
  ].join('\n');
}

/** command 根目录只允许 README.md 作为仓库说明;其余 .md 必须归入分支目录。 */
export function isStrayRootMarkdown(name) {
  return name.endsWith('.md') && name !== 'README.md';
}

/** 正文是否已有手工维护的相关命令/相关条目区块(二级或三级标题)。 */
export function hasRelatedSection(md) {
  return /^#{2,3} (相关命令|相关条目)\s*$/m.test(String(md || ''));
}

/** 相关命令:同分类同前缀 > 同分类 > 同前缀 > 字母序邻居。 */
export function pickRelated(it, list, limit = 5) {
  const idx = list.findIndex((x) => x.n === it.n);
  if (idx < 0) return [];
  const base = (n) => String(n).split('-')[0];
  const family = (x) =>
    x.n !== it.n &&
    (base(x.n) === base(it.n) || x.n.startsWith(it.n) || it.n.startsWith(x.n));
  const sameCatFamily = list.filter((x) => x.cat && x.cat === it.cat && family(x));
  const sameCat = list.filter((x) => x.cat && x.cat === it.cat && !family(x));
  const otherFamily = list.filter((x) => x.cat !== it.cat && family(x));
  const neighbors = [];
  for (let d = 1; d <= 8; d++) {
    if (list[idx - d]) neighbors.push(list[idx - d]);
    if (list[idx + d]) neighbors.push(list[idx + d]);
  }
  const seen = new Set([it.n]);
  const out = [];
  for (const x of [...sameCatFamily, ...sameCat, ...otherFamily, ...neighbors]) {
    if (seen.has(x.n)) continue;
    seen.add(x.n);
    out.push(x);
    if (out.length === limit) break;
  }
  return out;
}

/** 热门命令必须能解析到页面;返回缺失的名字(去重,保持声明顺序)。 */
export function missingHotCommands(hotNames, pagesByName) {
  const seen = new Set();
  return (Array.isArray(hotNames) ? hotNames : []).filter((name) => {
    if (seen.has(name)) return false;
    seen.add(name);
    return !pagesByName.has(name);
  });
}

/** 清理命令名:剥离 BOM 与零宽字符 */
export function sanitizeCommandName(value) {
  return String(value || '')
    .replace(/^﻿/, '')
    .replace(/[​-‍⁠]/g, '')
    .trim();
}

/** 解析 "标题\n===\n描述\n## ..." 头部；缺少时返回空字符串。 */
export function parseSource(raw) {
  const titleMatch = raw.match(/^([^=]+?)\s*===/);
  const descMatch = raw.match(/\n={1,}([\s\S]*?)##/i);
  return {
    title: sanitizeCommandName(titleMatch ? titleMatch[1] : ''),
    desc: descMatch ? descMatch[1].replace(/[\r\n]/g, '').trim() : '',
    hasTitle: Boolean(titleMatch),
  };
}

/** 文件名即 URL slug,只允许 ASCII 字母、数字、点、下划线与连字符。 */
export function isValidSlug(slug) {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(slug);
}

/** 从页面的“## 读完自测”中抽取问答,供 /review.html 随机复习。 */
export function parseSelfTests(md) {
  const marker = '## 读完自测';
  const start = md.indexOf(marker);
  if (start < 0) return [];
  const rest = md.slice(start + marker.length);
  const next = rest.search(/\n## /);
  const body = next >= 0 ? rest.slice(0, next) : rest;
  const cut = body.indexOf('<details>');
  if (cut < 0) return [];
  const qPart = body.slice(0, cut);
  const aPart = body.slice(cut);
  const questions = [...qPart.matchAll(/^\s*\d+\.\s+(.+)$/gm)].map((x) => x[1].trim());
  const answers = [...aPart.matchAll(/^\s*\d+\.\s+(.+)$/gm)].map((x) => x[1].trim());
  return questions
    .map((q, i) => ({ q, a: answers[i] || '' }))
    .filter((x) => x.q && x.a);
}

/** 统计学习路径页里“学习路径”段的路径链接数量。 */
export function countLearningPaths(md) {
  const marker = '## 学习路径';
  const start = md.indexOf(marker);
  if (start < 0) return 0;
  const rest = md.slice(start + marker.length);
  const next = rest.search(/\n## /);
  const body = next >= 0 ? rest.slice(0, next) : rest;
  return (body.match(/^- \[[^\]]+\]\([^)]*learning-path[^)]*\.html\)/gm) || []).length;
}

/**
 * 校验分支分类配置,并把分类挂到 item.cat。
 *
 * @param {{branchId: string, cfg: any, items: Array<{n: string, cat?: string}>}} input
 * @returns {{list: any[], byCat: Map<string, any[]>, errors: string[]}}
 */
export function validateCategoryConfig({ branchId, cfg, items }) {
  const errors = [];
  const rawList = Array.isArray(cfg?.categories) ? cfg.categories : [];
  const list = rawList
    .map((c, i) => ({ ...c, order: Number.isFinite(c.order) ? c.order : i + 1 }))
    .sort((x, y) => x.order - y.order || x.id.localeCompare(y.id));

  if (!list.length) errors.push(`${branchId}: 没有 categories`);

  const ids = new Set();
  for (const c of list) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(c.id)) {
      errors.push(`分类 id 不合法: ${c.id}`);
      continue;
    }
    if (ids.has(c.id)) {
      errors.push(`分类 id 重复: ${c.id}`);
      continue;
    }
    if (!c.name || !c.desc) errors.push(`分类 ${c.id} 缺少 name 或 desc`);
    ids.add(c.id);
  }

  const assignments = cfg?.assignments || {};
  const byCat = new Map([...ids].map((id) => [id, []]));
  for (const item of items) {
    const catId = assignments[item.n];
    if (!catId) {
      errors.push(`页面 ${item.n} 未在 categories.json 中归类`);
      continue;
    }
    if (!ids.has(catId)) {
      errors.push(`页面 ${item.n} 的分类 "${catId}" 不存在`);
      continue;
    }
    item.cat = catId;
    byCat.get(catId).push(item);
  }
  for (const slug of Object.keys(assignments)) {
    if (!items.some((item) => item.n === slug)) {
      errors.push(`映射中的 "${slug}" 没有对应页面`);
    }
  }
  for (const id of ids) {
    if (!byCat.get(id).length) errors.push(`分类 "${id}" 没有页面`);
  }

  return { list, byCat, errors };
}
