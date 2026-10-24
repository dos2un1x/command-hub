/** 命令页的“遇到问题?”入口:按名称取排障页,忽略缺失并去重。 */
export function selectTroubleshootLinks(byName, slugs, limit = 3) {
  const seen = new Set();
  const out = [];
  for (const slug of slugs || []) {
    if (seen.has(slug)) continue;
    const item = byName.get(slug);
    if (!item) continue;
    seen.add(slug);
    out.push(item);
    if (out.length === limit) break;
  }
  return out;
}
