import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RESERVED,
  contentInitError,
  countLearningPaths,
  hasRelatedSection,
  isStrayRootMarkdown,
  isValidSlug,
  missingHotCommands,
  parseSelfTests,
  parseSource,
  readCommandEntries,
  sanitizeCommandName,
  validateCategoryConfig,
} from '../scripts/lib/content.mjs';

test('parseSource:解析标题与描述', () => {
  const parsed = parseSource('ls\n===\n列出目录内容。\n\n## 补充说明\n');
  assert.equal(parsed.title, 'ls');
  assert.equal(parsed.desc, '列出目录内容。');
  assert.equal(parsed.hasTitle, true);
});

test('parseSource:缺少标题或描述时返回空值', () => {
  assert.deepEqual(parseSource('没有头部的正文'), {
    title: '',
    desc: '',
    hasTitle: false,
  });
  assert.equal(parseSource('ls\n===\n\n## 补充说明').desc, '');
});

test('sanitizeCommandName:去掉 BOM 与零宽字符', () => {
  assert.equal(sanitizeCommandName('﻿l​s‍'), 'ls');
  assert.equal(sanitizeCommandName('  ls  '), 'ls');
  assert.equal(sanitizeCommandName(null), '');
});

test('isValidSlug:只接受 ASCII slug', () => {
  for (const slug of ['ls', 'Get-ChildItem', 'systemd-run', 'a.b_c', '404']) {
    assert.equal(isValidSlug(slug), true, slug);
  }
  for (const slug of ['foo bar', '../x', 'a#b', '中文', '', '.hidden']) {
    assert.equal(isValidSlug(slug), false, slug);
  }
});

test('RESERVED:保留名包含会覆盖分支落地页的 index', () => {
  assert.equal(RESERVED.has('index'), true);
  assert.equal(RESERVED.has('ls'), false);
});

test('parseSelfTests:抽取三问三答', () => {
  const md = [
    'demo',
    '===',
    '演示页',
    '## 读完自测',
    '',
    '1. 第一问？',
    '2. 第二问？',
    '3. 第三问？',
    '',
    '<details>',
    '<summary>答案</summary>',
    '',
    '1. 第一答',
    '2. 第二答',
    '3. 第三答',
    '',
    '</details>',
  ].join('\n');
  assert.deepEqual(parseSelfTests(md), [
    { q: '第一问？', a: '第一答' },
    { q: '第二问？', a: '第二答' },
    { q: '第三问？', a: '第三答' },
  ]);
});

test('parseSelfTests:没有 details 或自测段时返回空数组', () => {
  assert.deepEqual(parseSelfTests('demo\n===\n描述\n## 补充说明'), []);
  assert.deepEqual(parseSelfTests('## 读完自测\n\n1. 只有问题？'), []);
});

test('countLearningPaths:统计学习路径段里的路径链接', () => {
  const md = [
    '## 学习路径',
    '',
    '- [Linux 学习路径](../guide/linux-learning-path.html) — 说明',
    '- [Windows 学习路径](../guide/windows-learning-path.html) — 说明',
    '',
    '## 心智模型',
    '- [不应计入](../guide/other.html)',
  ].join('\n');
  assert.equal(countLearningPaths(md), 2);
  assert.equal(countLearningPaths('没有这一段'), 0);
});

test('validateCategoryConfig:正常配置给页面挂上分类', () => {
  const items = [{ n: 'ls' }, { n: 'cd' }];
  const result = validateCategoryConfig({
    branchId: 'linux',
    items,
    cfg: {
      categories: [{ id: 'file', name: '文件', desc: '文件操作' }],
      assignments: { ls: 'file', cd: 'file' },
    },
  });
  assert.deepEqual(result.errors, []);
  assert.equal(items[0].cat, 'file');
  assert.deepEqual(
    result.byCat.get('file').map((x) => x.n),
    ['ls', 'cd']
  );
});

test('validateCategoryConfig:未归类、未知分类、多余映射、空分类都会报错', () => {
  const result = validateCategoryConfig({
    branchId: 'linux',
    items: [{ n: 'ls' }, { n: 'cd' }],
    cfg: {
      categories: [
        { id: 'file', name: '文件', desc: '文件操作' },
        { id: 'empty', name: '空', desc: '空分类' },
      ],
      assignments: { ls: 'file', cd: 'missing', ghost: 'file' },
    },
  });
  const text = result.errors.join('\n');
  assert.match(text, /cd 的分类 "missing" 不存在/);
  assert.match(text, /映射中的 "ghost" 没有对应页面/);
  assert.match(text, /分类 "empty" 没有页面/);
});

test('validateCategoryConfig:重复分类 id 会报错且不重复建分类', () => {
  const result = validateCategoryConfig({
    branchId: 'linux',
    items: [{ n: 'ls' }],
    cfg: {
      categories: [
        { id: 'file', name: '文件', desc: '文件操作' },
        { id: 'file', name: '文件二', desc: '重复' },
      ],
      assignments: { ls: 'file' },
    },
  });
  assert.match(result.errors.join('\n'), /分类 id 重复: file/);
  assert.equal(result.list.length, 2);
  assert.equal(result.byCat.get('file').length, 1);
});

test('contentInitError:command 为空时提示初始化私有子模块', () => {
  const message = contentInitError([]);
  assert.match(message, /git submodule update --init --recursive/);
  assert.match(message, /dos2un1x\/command/);
  assert.equal(contentInitError([{ name: 'linux' }]), '');
});

test('readCommandEntries:目录不存在时返回空数组,便于给出初始化提示', async () => {
  assert.deepEqual(await readCommandEntries('/definitely/not/a/command/dir'), []);
});

test('isStrayRootMarkdown:只允许根目录 README.md', () => {
  assert.equal(isStrayRootMarkdown('README.md'), false);
  assert.equal(isStrayRootMarkdown('readme.md'), true);
  assert.equal(isStrayRootMarkdown('notes.md'), true);
  assert.equal(isStrayRootMarkdown('README'), false);
  assert.equal(isStrayRootMarkdown('categories.json'), false);
});

test('validateCategoryConfig:没有分类或缺少 name/desc 会报错', () => {
  const empty = validateCategoryConfig({
    branchId: 'linux',
    items: [],
    cfg: { categories: [], assignments: {} },
  });
  assert.match(empty.errors.join('\n'), /没有 categories/);

  const broken = validateCategoryConfig({
    branchId: 'linux',
    items: [{ n: 'ls' }],
    cfg: {
      categories: [{ id: 'file', name: '', desc: '' }],
      assignments: { ls: 'file' },
    },
  });
  assert.match(broken.errors.join('\n'), /分类 file 缺少 name 或 desc/);
});

test('missingHotCommands:找出热门列表里没有对应页面的条目', () => {
  const names = new Map([
    ['ls', ['linux']],
    ['kubectl', ['k8s']],
  ]);
  assert.deepEqual(missingHotCommands(['ls', 'vim', 'kubectl', 'vim'], names), ['vim']);
  assert.deepEqual(missingHotCommands(['ls'], names), []);
});

test('hasRelatedSection:识别二级和三级相关区块', () => {
  assert.equal(hasRelatedSection('## 相关命令\n'), true);
  assert.equal(hasRelatedSection('### 相关条目\n'), true);
  assert.equal(hasRelatedSection('正文\n### 相关命令\n- x\n'), true);
  assert.equal(hasRelatedSection('## 参考链接\n'), false);
  assert.equal(hasRelatedSection(''), false);
});
