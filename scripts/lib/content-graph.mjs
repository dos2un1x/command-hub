/** 站内编辑性入链图：统计 Markdown 中指向其他页面的链接。 */

export function normalizeInternalLink(sourcePath, href) {
  if (!href || /^(https?:)?\/\//.test(href) || href.startsWith('#')) return null;
  const clean = href.split('#')[0].split('?')[0];
  if (!clean.endsWith('.html')) return null;
  if (clean === 'index.html' || clean.endsWith('/index.html')) return null;
  const sourceBranch = sourcePath.split('/')[0];
  let target = clean.replace(/^\.\//, '');
  if (target.startsWith('../')) {
    const parts = target.split('/');
    target = parts.slice(1).join('/');
  } else if (!target.includes('/')) {
    target = `${sourceBranch}/${target}`;
  }
  target = target.replace(/\.html$/, '');
  return target === sourcePath ? null : target;
}

export function extractInternalLinks(sourcePath, markdown) {
  const links = new Set();
  for (const match of String(markdown || '').matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = normalizeInternalLink(sourcePath, match[1]);
    if (target) links.add(target);
  }
  return links;
}

/** pages: [{ branch, slug, raw }] → Map<path, Set<sourcePath>>。 */
export function buildInboundGraph(pages) {
  const known = new Set(pages.map((p) => `${p.branch}/${p.slug}`));
  const inbound = new Map([...known].map((path) => [path, new Set()]));
  for (const page of pages) {
    const source = `${page.branch}/${page.slug}`;
    for (const target of extractInternalLinks(source, page.raw)) {
      if (known.has(target) && target !== source) inbound.get(target).add(source);
    }
  }
  return inbound;
}

/** 返回入链数 ≤ max 的页面，按入链数和路径排序。 */
export function lowInlinkPages(pages, max = 1) {
  const graph = buildInboundGraph(pages);
  return [...graph.entries()]
    .filter(([, sources]) => sources.size <= max)
    .map(([path, sources]) => ({ path, inbound: sources.size, sources: [...sources].sort() }))
    .sort((a, b) => a.inbound - b.inbound || a.path.localeCompare(b.path));
}
