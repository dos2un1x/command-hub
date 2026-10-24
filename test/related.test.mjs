import test from 'node:test';
import assert from 'node:assert/strict';
import { pickRelated } from '../scripts/lib/content.mjs';

const page = (n, cat = 'misc') => ({ n, cat, d: `${n} 描述` });
const list = [
  page('awk', 'text'),
  page('bat', 'text'),
  page('cat', 'text'),
  page('autossh', 'network'),
  page('axel', 'network'),
  page('badblocks', 'disk'),
];

test('pickRelated:同分类页面优先', () => {
  const out = pickRelated(list[0], list, 3);
  assert.deepEqual(out.map((x) => x.n), ['bat', 'cat', 'autossh']);
});

test('pickRelated:不重复且不包含自身', () => {
  const out = pickRelated(list[0], list, 5);
  const names = out.map((x) => x.n);
  assert.equal(new Set(names).size, names.length);
  assert.ok(!names.includes('awk'));
});

test('pickRelated:找不到自身时返回空数组', () => {
  assert.deepEqual(pickRelated({ n: 'missing', cat: 'text' }, list, 3), []);
});

test('pickRelated:同前缀命令优先于普通同分类页面', () => {
  const items = [
    page('git', 'vcs'),
    page('git-status', 'vcs'),
    page('git-commit', 'vcs'),
    page('grep', 'text'),
    page('gunzip', 'archive'),
  ];
  const out = pickRelated(items[0], items, 2);
  assert.deepEqual(out.map((x) => x.n), ['git-status', 'git-commit']);
});
