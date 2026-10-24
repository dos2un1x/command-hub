/** 搜索别名:按页面名合并同义词,供 dt.js 与前端匹配使用。 */
export function applyAliases(items, aliases) {
  const map = aliases || {};
  const names = new Set((items || []).map((item) => item.n));
  const unknown = Object.keys(map).filter((name) => !names.has(name));
  const out = (items || []).map((item) => {
    const list = map[item.n];
    return list && list.length ? { ...item, a: list.join(' ') } : item;
  });
  return { items: out, unknown };
}
