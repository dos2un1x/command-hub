import test from 'node:test';
import assert from 'node:assert/strict';
import { pickFeatured } from '../scripts/lib/featured.mjs';

const items = [
  { n: 'ls', d: '列出目录' },
  { n: 'cp', d: '复制文件' },
  { n: 'find', d: '查找文件' },
  { n: 'rm', d: '删除文件' },
];

test('pickFeatured:按配置顺序返回页面', () => {
  assert.deepEqual(pickFeatured(items, ['find', 'ls']).map((x) => x.n), ['find', 'ls']);
});

test('pickFeatured:忽略不存在的 slug', () => {
  assert.deepEqual(pickFeatured(items, ['ls', 'missing', 'cp']).map((x) => x.n), ['ls', 'cp']);
});

test('pickFeatured:默认最多三篇且去重', () => {
  const out = pickFeatured(items, ['ls', 'ls', 'cp', 'find', 'rm']);
  assert.deepEqual(out.map((x) => x.n), ['ls', 'cp', 'find']);
});

test('pickFeatured:空配置返回空数组', () => {
  assert.deepEqual(pickFeatured(items, []), []);
  assert.deepEqual(pickFeatured(items, undefined), []);
});
