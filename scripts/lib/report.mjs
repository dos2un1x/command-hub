/**
 * 内容质量报告:统计页面结构覆盖与薄页,供 content-report 与后续批次使用。
 *
 * 指标只做“有没有”,不判断内容是否正确;正确性仍由 validate/build/人工抽查负责。
 */
import { parseSelfTests } from './content.mjs';

const PITFALLS = /^#{2,3} (易错点与排错|易错点|常见坑|常见误区)\s*$/m;
const RELATED = /^#{2,3} (相关命令|相关条目)\s*$/m;

/** 分析单个页面是否具备关键结构。 */
export function analyzePage(raw) {
  const text = String(raw || '');
  return {
    chars: text.length,
    hasIntro: /^## 补充说明\s*$/m.test(text),
    hasPitfalls: PITFALLS.test(text),
    hasRelated: RELATED.test(text),
    hasRefs: /^## 参考链接\s*$/m.test(text),
    hasQuiz: parseSelfTests(text).length > 0,
    links: (text.match(/\]\([^)]*\.html\)/g) || []).length,
  };
}

function emptyStats(branch) {
  return {
    branch,
    pages: 0,
    chars: 0,
    quizzes: 0,
    refs: 0,
    related: 0,
    pitfalls: 0,
    links: 0,
    thin800: 0,
    thin500: 0,
  };
}

/**
 * 汇总页面。
 *
 * @param {Array<{branch: string, slug: string, raw: string}>} pages
 * @returns {{branches: Array<object>, total: object}}
 */
export function summarizePages(pages) {
  const byBranch = new Map();
  const total = emptyStats('合计');

  for (const page of pages) {
    if (!byBranch.has(page.branch)) byBranch.set(page.branch, emptyStats(page.branch));
    const stats = byBranch.get(page.branch);
    const a = analyzePage(page.raw);

    for (const s of [stats, total]) {
      s.pages++;
      s.chars += a.chars;
      s.links += a.links;
      if (a.hasQuiz) s.quizzes++;
      if (a.hasRefs) s.refs++;
      if (a.hasRelated) s.related++;
      if (a.hasPitfalls) s.pitfalls++;
      if (a.chars < 800) s.thin800++;
      if (a.chars < 500) s.thin500++;
    }
  }

  const branches = [...byBranch.values()].map((s) => ({
    ...s,
    avgChars: s.pages ? Math.round(s.chars / s.pages) : 0,
  }));
  total.avgChars = total.pages ? Math.round(total.chars / total.pages) : 0;
  return { branches, total };
}

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '0%');
const perPage = (n, d) => (d ? (n / d).toFixed(1) : '0.0');

/** 输出 Markdown 表格,便于在终端直接阅读。 */
export function formatReport(summary) {
  const lines = [
    '| 分支 | 页数 | 均字数 | 自测 | 参考 | 相关 | 易错 | <800 | <500 | 内链/页 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const b of summary.branches) {
    lines.push(
      `| ${b.branch} | ${b.pages} | ${b.avgChars} | ${pct(b.quizzes, b.pages)} | ${pct(b.refs, b.pages)} | ${pct(b.related, b.pages)} | ${pct(b.pitfalls, b.pages)} | ${b.thin800} | ${b.thin500} | ${perPage(b.links, b.pages)} |`
    );
  }
  const t = summary.total;
  lines.push(
    `| 合计 | ${t.pages} | ${t.avgChars} | ${pct(t.quizzes, t.pages)} | ${pct(t.refs, t.pages)} | ${pct(t.related, t.pages)} | ${pct(t.pitfalls, t.pages)} | ${t.thin800} | ${t.thin500} | ${perPage(t.links, t.pages)} |`
  );
  return lines.join('\n');
}
