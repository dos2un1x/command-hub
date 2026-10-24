/** 详情页的“系统学习”入口:按分支映射到指南分支的学习路径页。 */
export function learningLinkFor(branch, links, byName) {
  const slug = (links || {})[branch];
  return slug ? byName.get(slug) || null : null;
}
