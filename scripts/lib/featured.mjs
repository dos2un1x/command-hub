/** 分类页“先读这三篇”:按配置顺序取页面,忽略缺失项并去重。 */
export function pickFeatured(items, slugs, limit = 3) {
  const byName = new Map((items || []).map((item) => [item.n, item]));
  const seen = new Set();
  const out = [];
  for (const slug of slugs || []) {
    if (seen.has(slug) || !byName.has(slug)) continue;
    seen.add(slug);
    out.push(byName.get(slug));
    if (out.length === limit) break;
  }
  return out;
}
