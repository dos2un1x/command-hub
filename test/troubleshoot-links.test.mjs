import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTroubleshootLinks } from '../scripts/lib/troubleshoot-links.mjs';

const byName = new Map([
  ['no-space-left', { n: 'no-space-left', d: '磁盘满', p: '/troubleshoot/no-space-left' }],
  ['inode-exhausted', { n: 'inode-exhausted', d: 'inode 耗尽', p: '/troubleshoot/inode-exhausted' }],
  ['disk-readonly', { n: 'disk-readonly', d: '只读', p: '/troubleshoot/disk-readonly' }],
]);

test('selectTroubleshootLinks:按配置顺序返回存在的页面', () => {
  assert.deepEqual(
    selectTroubleshootLinks(byName, ['inode-exhausted', 'no-space-left']).map((x) => x.n),
    ['inode-exhausted', 'no-space-left']
  );
});

test('selectTroubleshootLinks:忽略缺失与重复项', () => {
  const out = selectTroubleshootLinks(byName, ['no-space-left', 'missing', 'no-space-left']);
  assert.deepEqual(out.map((x) => x.n), ['no-space-left']);
});

test('selectTroubleshootLinks:默认最多三条', () => {
  const out = selectTroubleshootLinks(byName, ['no-space-left', 'inode-exhausted', 'disk-readonly', 'no-space-left']);
  assert.equal(out.length, 3);
});
