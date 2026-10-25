/** 生成详情页 JSON-LD：面包屑、FAQ、Lab HowTo。 */

const stripMd = (s) =>
  String(s || '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*_>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export function breadcrumbList(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: (items || [])
      .filter((x) => x && x.name && x.url)
      .map((x, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        name: x.name,
        item: x.url,
      })),
  };
}

export function faqPage(qas) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: (qas || [])
      .filter((x) => x && x.q && x.a)
      .map((x) => ({
        '@type': 'Question',
        name: x.q,
        acceptedAnswer: { '@type': 'Answer', text: x.a },
      })),
  };
}

export function howTo({ name, description, steps }) {
  const list = (steps || [])
    .filter((x) => x && x.name && x.text)
    .map((x) => ({ '@type': 'HowToStep', name: x.name, text: x.text }));
  return {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name,
    description,
    step: list,
  };
}

/** 从 Markdown 提取 Lab 的可执行步骤：优先“演练步骤”下的 H3，否则取关键 H2。 */
export function howToSteps(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const h3 = [];
  let inSteps = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s+/.test(line)) {
      inSteps = /^##\s+演练步骤\s*$/.test(line.trim());
      continue;
    }
    if (!inSteps) continue;
    const m = line.match(/^###\s+(.+)$/);
    if (!m) continue;
    const name = stripMd(m[1]).replace(/^\d+[.、]\s*/, '');
    const text = nextParagraph(lines, i + 1);
    if (name && text) h3.push({ name, text });
  }
  if (h3.length) return h3;

  const fallback = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+)$/);
    if (!m) continue;
    const name = stripMd(m[1]);
    if (!/^(环境准备|注入故障|观察现象|判断与定位|修复|恢复与回滚|验证|清理)$/.test(name)) continue;
    const text = nextParagraph(lines, i + 1);
    if (text) fallback.push({ name, text });
  }
  return fallback;
}

function nextParagraph(lines, start) {
  let buf = [];
  for (let i = start; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s) {
      if (buf.length) break;
      continue;
    }
    if (/^#{1,6}\s/.test(s) || /^\|/.test(s) || /^```/.test(s)) {
      if (buf.length) break;
      continue;
    }
    buf.push(s);
    if (buf.join(' ').length > 160) break;
  }
  return stripMd(buf.join(' ')).replace(/[：:]\s*$/, '').slice(0, 240);
}
