import test from 'node:test';
import assert from 'node:assert/strict';
import { extractToc, insertToc, shouldShowToc, TOC_MIN_CHARS } from '../scripts/lib/toc.mjs';

test('extractToc:提取带 id 的二级标题', () => {
  const html =
    '<h1 id="top">标题</h1>' +
    '<h2 id="补充说明">补充说明</h2>' +
    '<h2 id="常用示例">常用<code>示例</code></h2>' +
    '<h2 id="参考链接">参考链接</h2>';
  assert.deepEqual(extractToc(html), [
    { id: '补充说明', text: '补充说明' },
    { id: '常用示例', text: '常用示例' },
    { id: '参考链接', text: '参考链接' },
  ]);
});

test('extractToc:不足三个标题时不生成目录', () => {
  const html = '<h2 id="a">A</h2><h2 id="b">B</h2>';
  assert.deepEqual(extractToc(html), []);
});

test('extractToc:忽略没有 id 的标题与重复 id', () => {
  const html =
    '<h2>无锚点</h2>' +
    '<h2 id="a">A</h2>' +
    '<h2 id="a">重复</h2>' +
    '<h2 id="b">B</h2>' +
    '<h2 id="c">C</h2>';
  assert.deepEqual(extractToc(html), [
    { id: 'a', text: 'A' },
    { id: 'b', text: 'B' },
    { id: 'c', text: 'C' },
  ]);
});

test('extractToc:解码常见 HTML 实体', () => {
  const html =
    '<h2 id="a">A &amp; B</h2>' +
    '<h2 id="b">&lt;code&gt;</h2>' +
    '<h2 id="c">C&nbsp;D</h2>';
  assert.deepEqual(extractToc(html), [
    { id: 'a', text: 'A & B' },
    { id: 'b', text: '<code>' },
    { id: 'c', text: 'C D' },
  ]);
});

test('insertToc:放在 H1 与紧随其后的简介段落之后', () => {
  const html = '<h1>标题</h1><p>简介</p><h2 id="a">A</h2>';
  assert.equal(
    insertToc(html, '<nav>TOC</nav>'),
    '<h1>标题</h1><p>简介</p><nav>TOC</nav><h2 id="a">A</h2>'
  );
});

test('insertToc:首个元素是章节标题时直接放在 H1 之后', () => {
  const html = '<h1>标题</h1><h2 id="a">A</h2><p>正文</p>';
  assert.equal(
    insertToc(html, '<nav>TOC</nav>'),
    '<h1>标题</h1><nav>TOC</nav><h2 id="a">A</h2><p>正文</p>'
  );
});

test('insertToc:没有 H1 时放在最前面', () => {
  assert.equal(insertToc('<p>正文</p>', '<nav>TOC</nav>'), '<nav>TOC</nav><p>正文</p>');
});

test('shouldShowToc:只对达到字数阈值的长页启用', () => {
  assert.equal(shouldShowToc('字'.repeat(TOC_MIN_CHARS - 1)), false);
  assert.equal(shouldShowToc('字'.repeat(TOC_MIN_CHARS)), true);
  assert.equal(shouldShowToc(`字 ${'字'.repeat(TOC_MIN_CHARS - 1)}`), true);
  // 与 content-report 一致:空白也计入长度。
  assert.equal(shouldShowToc('字 '.repeat(TOC_MIN_CHARS / 2)), true);
});
