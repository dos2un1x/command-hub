/** 详情页“版本信息最后核对”徽标:读取 content-freshness 登记表。 */
export function verifiedFor(registry, branch, slug) {
  const pages = registry?.pages || registry || {};
  return pages[`${branch}/${slug}`] || null;
}
