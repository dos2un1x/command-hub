import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAliases } from '../scripts/lib/search-alias.mjs';

const items = [
  { n: 'kubectl', d: 'Kubernetes 命令行' },
  { n: 'postgresql', d: '关系型数据库' },
  { n: 'ls', d: '列出目录' },
];

test('applyAliases:给命中页面加 a 字段', () => {
  const { items: out, unknown } = applyAliases(items, { kubectl: ['k8s', 'kubernetes'] });
  assert.equal(out.find((x) => x.n === 'kubectl').a, 'k8s kubernetes');
  assert.deepEqual(unknown, []);
});

test('applyAliases:未配置的页面保持原样', () => {
  const { items: out } = applyAliases(items, { kubectl: ['k8s'] });
  assert.equal(out.find((x) => x.n === 'ls').a, undefined);
});

test('applyAliases:记录不存在的别名键', () => {
  const { unknown } = applyAliases(items, { missing: ['x'], kubectl: ['k8s'] });
  assert.deepEqual(unknown, ['missing']);
});

test('applyAliases:不修改输入数组', () => {
  const input = [{ n: 'kubectl', d: 'x' }];
  applyAliases(input, { kubectl: ['k8s'] });
  assert.equal(input[0].a, undefined);
});
