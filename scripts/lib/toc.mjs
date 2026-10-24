/** 长页目录:从渲染后的 HTML 提取二级标题,供详情页模板使用。 */
export const TOC_MIN_CHARS = 8000;

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole);
}

function plainHeading(inner) {
  return decodeEntities(inner.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/** 达到长页阈值才生成目录;口径与 content-report 的 chars 一致(含空白)。 */
export function shouldShowToc(markdown) {
  return String(markdown || '').length >= TOC_MIN_CHARS;
}

/** 把目录放在 H1 与简介段落之后;若 H1 后直接是 H2,则紧跟 H1。 */
export function insertToc(html, tocHtml) {
  const text = String(html || '');
  if (!tocHtml) return text;
  const h1End = text.indexOf('</h1>');
  if (h1End < 0) return tocHtml + text;
  const afterH1 = h1End + 5;
  const pEnd = text.indexOf('</p>', afterH1);
  const h2Start = text.indexOf('<h2', afterH1);
  const pIsIntro = pEnd >= 0 && (h2Start < 0 || pEnd < h2Start);
  const cut = pIsIntro ? pEnd + 4 : afterH1;
  return text.slice(0, cut) + tocHtml + text.slice(cut);
}

/** 提取带 id 的 h2;少于 3 条时返回空数组,避免短页出现噪声目录。 */
export function extractToc(html) {
  const out = [];
  const seen = new Set();
  const re = /<h2\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/gi;
  let match;
  while ((match = re.exec(String(html || '')))) {
    const id = match[1];
    const text = plainHeading(match[2]);
    if (!id || !text || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, text });
  }
  return out.length >= 3 ? out : [];
}
