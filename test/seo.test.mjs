import test from 'node:test';
import assert from 'node:assert/strict';
import {
  brandTitle,
  clipText,
  detailTitle,
  plainText,
  sentenceText,
  titlePhrase,
} from '../scripts/lib/seo.mjs';

const opts = {
  siteName: '测试站',
  contentBranches: new Set(['guide', 'tutorial']),
};

test('clipText:按字符数截断并补省略号', () => {
  assert.equal(clipText('一二三四五', 4), '一二三…');
  assert.equal(clipText('一二三', 4), '一二三');
  assert.equal(clipText('  a   b  ', 10), 'a b');
});

test('plainText:去掉 Markdown 标记并压缩空白', () => {
  assert.equal(
    plainText('看 [文档](https://example.com) 和 `代码`\n\n> 引用'),
    '看 文档 和 代码 引用'
  );
  assert.equal(plainText('![图](x.png) 说明'), '说明');
});

test('sentenceText:去掉句末标点', () => {
  assert.equal(sentenceText('列出目录。'), '列出目录');
  assert.equal(sentenceText('这样？'), '这样');
  assert.equal(sentenceText('正常'), '正常');
});

test('titlePhrase:去掉常见开头，过长时不用', () => {
  assert.equal(titlePhrase('用于列出目录内容'), '列出目录内容');
  assert.equal(titlePhrase('这是一个明显超过十四个字符的很长很长的描述文本'), '');
});

test('brandTitle:统一追加站点名', () => {
  assert.equal(brandTitle('ls 命令详解', '测试站'), 'ls 命令详解 - 测试站');
});

test('detailTitle:内容分支用描述中的短句作标题', () => {
  const title = detailTitle(
    { n: 'linux-learning-path', b: 'guide', d: 'Linux 学习路径：从文件到安全' },
    'Linux 学习路径',
    opts
  );
  assert.equal(title, 'Linux 学习路径 - 测试站');
});

test('detailTitle:内容分支描述过长时截断到 23 字', () => {
  const long = '这是一个非常长的指南描述用来验证标题截断逻辑是否生效并且不会超过限制';
  const title = detailTitle({ n: 'guide-x', b: 'guide', d: long }, '', opts);
  assert.ok(Array.from(title).length <= 42, title);
  assert.ok(title.endsWith(' - 测试站'));
  assert.ok(title.includes('…'));
});

test('detailTitle:命令分支优先使用描述短语', () => {
  assert.equal(
    detailTitle({ n: 'ls', b: 'linux', d: '列出目录内容' }, '列出目录内容', opts),
    'ls 命令详解：列出目录内容 - 测试站'
  );
});

test('detailTitle:命令分支描述过长时降级，仍带命令名', () => {
  const title = detailTitle(
    { n: 'systemctl', b: 'linux', d: '管理 systemd 服务与系统状态' },
    '管理 systemd 服务与系统状态以及更多很长很长的补充说明',
    opts
  );
  assert.equal(title, 'systemctl 命令详解 - 测试站');
});
