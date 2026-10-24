import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePage, summarizePages, formatReport } from '../scripts/lib/report.mjs';

const completePage = [
  'demo',
  '===',
  '演示页',
  '## 补充说明',
  '说明。' + 'x'.repeat(700),
  '## 常用示例',
  '```shell',
  'echo demo',
  '```',
  '## 易错点与排错',
  '- 注意。',
  '## 相关命令',
  '- [ls](../linux/ls.html)',
  '- [find](../linux/find.html)',
  '## 参考链接',
  '- [man7](https://man7.org/)',
  '## 读完自测',
  '',
  '1. 问题？',
  '',
  '<details>',
  '<summary>答案</summary>',
  '',
  '1. 答案。',
  '',
  '</details>',
].join('\n');

test('analyzePage:识别页面结构与内链数量', () => {
  const page = analyzePage(completePage);
  assert.equal(page.hasIntro, true);
  assert.equal(page.hasPitfalls, true);
  assert.equal(page.hasRelated, true);
  assert.equal(page.hasRefs, true);
  assert.equal(page.hasQuiz, true);
  assert.equal(page.links, 2);
  assert.equal(page.chars, completePage.length);
});

test('analyzePage:三级标题的易错点与相关条目也算覆盖', () => {
  const page = completePage
    .replace('## 易错点与排错', '### 易错点与排错')
    .replace('## 相关命令', '### 相关条目');
  const analyzed = analyzePage(page);
  assert.equal(analyzed.hasPitfalls, true);
  assert.equal(analyzed.hasRelated, true);
});

test('analyzePage:缺少章节和空自测都算未覆盖', () => {
  const page = analyzePage('demo\n===\n描述\n## 补充说明\n\n## 读完自测\n');
  assert.equal(page.hasQuiz, false);
  assert.equal(page.hasRelated, false);
  assert.equal(page.hasRefs, false);
  assert.equal(page.hasPitfalls, false);
  assert.equal(page.links, 0);
});

test('summarizePages:按分支汇总页数、覆盖与薄页', () => {
  const shortPage = 'b\n===\n短页\n## 补充说明\n';
  const summary = summarizePages([
    { branch: 'linux', slug: 'a', raw: completePage },
    { branch: 'linux', slug: 'b', raw: shortPage },
    { branch: 'k8s', slug: 'c', raw: completePage },
  ]);
  assert.equal(summary.total.pages, 3);
  assert.equal(summary.total.quizzes, 2);
  assert.equal(summary.total.refs, 2);
  assert.equal(summary.total.related, 2);
  assert.equal(summary.total.thin800, 1);
  assert.equal(summary.total.thin500, 1);
  assert.equal(summary.branches.length, 2);
  const linux = summary.branches.find((b) => b.branch === 'linux');
  assert.equal(linux.pages, 2);
  assert.equal(linux.quizzes, 1);
  assert.equal(linux.avgChars, Math.round((completePage.length + shortPage.length) / 2));
});

test('formatReport:输出表头与分支名', () => {
  const summary = summarizePages([
    { branch: 'linux', slug: 'a', raw: completePage },
  ]);
  const text = formatReport(summary);
  assert.match(text, /分支/);
  assert.match(text, /linux/);
  assert.match(text, /合计/);
});
