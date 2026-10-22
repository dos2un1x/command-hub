/**
 * 标题、描述与摘要的公共文本处理
 *
 * 与内容源解耦，便于单测覆盖标题长度与降级规则。
 */

/** 按字符数截断(中文按 1 个字计),超出时补省略号 */
export const clipText = (s, n) => {
  const chars = Array.from(String(s == null ? '' : s).replace(/\s+/g, ' ').trim());
  return chars.length > n ? chars.slice(0, Math.max(1, n - 1)).join('') + '…' : chars.join('');
};

/** 去掉 Markdown 标记,保留纯文本 */
export const plainText = (s) =>
  String(s == null ? '' : s)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** 去掉句末标点,便于拼进 meta description */
export const sentenceText = (s) => plainText(s).replace(/[。.!！?？;；,，]+$/, '');

/** 标题里用的简短描述:去掉「是/用于/用来/可以/主要」等开头,过长则不用 */
export const titlePhrase = (s) => {
  const t = sentenceText(s).replace(/^(是|用于|用来|可以|主要)+/, '');
  return Array.from(t).length <= 14 ? t : '';
};

/** 标题统一以「 - 站点名」结尾。不截断 head:分支名/命令名被截断比标题略长更糟 */
export const brandTitle = (head, siteName) => `${head} - ${siteName}`;

/** 详情页标题:优先「命令名 命令详解:描述」,过长时降级,保证标题不会过长 */
export function detailTitle(it, dTitle, { siteName, contentBranches }) {
  const suffix = ` - ${siteName}`;
  if (contentBranches.has(it.b)) {
    // 指南/教程不是命令页,标题用描述里冒号前的短语,避免只显示英文 slug。
    const head = sentenceText(it.d).split(/[：:]/)[0];
    const chars = Array.from(head);
    const phrase = chars.length <= 24 ? head : chars.slice(0, 23).join('') + '…';
    const title = `${phrase}${suffix}`;
    return Array.from(title).length <= 42 ? title : `${it.n}${suffix}`;
  }
  const withDesc = dTitle ? `${it.n} 命令详解：${dTitle}${suffix}` : '';
  if (withDesc && Array.from(withDesc).length <= 36) return withDesc;
  const noDesc = `${it.n} 命令详解${suffix}`;
  if (Array.from(noDesc).length <= 36) return noDesc;
  return `${it.n}${suffix}`;
}
