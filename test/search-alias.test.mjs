import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAliases } from '../scripts/lib/search-alias.mjs';

test('applyAliases:合并别名并保留原始字段', () => {
  const { items, unknown } = applyAliases(
    [{ n: 'kubectl', p: 'k8s/kubectl', d: '集群管理' }],
    { kubectl: ['k8s', 'kubernetes'] }
  );
  assert.deepEqual(unknown, []);
  assert.equal(items[0].a, 'k8s kubernetes');
  assert.equal(items[0].p, 'k8s/kubectl');
});

test('applyAliases:未知页面出现在 unknown 中且不影响其他条目', () => {
  const { items, unknown } = applyAliases(
    [{ n: 'grep', p: 'linux/grep', d: '文本搜索' }],
    { grep: ['search'], missing: ['nope'] }
  );
  assert.deepEqual(unknown, ['missing']);
  assert.equal(items[0].a, 'search');
});
