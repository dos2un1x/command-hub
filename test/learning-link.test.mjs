import test from 'node:test';
import assert from 'node:assert/strict';
import { learningLinkFor } from '../scripts/lib/learning-link.mjs';

const byName = new Map([
  ['linux-learning-path', { n: 'linux-learning-path', d: 'Linux 学习路径' }],
]);

test('learningLinkFor:命中分支时返回路径页面', () => {
  assert.equal(
    learningLinkFor('linux', { linux: 'linux-learning-path' }, byName)?.n,
    'linux-learning-path'
  );
});

test('learningLinkFor:未配置或页面缺失时返回 null', () => {
  assert.equal(learningLinkFor('k8s', { linux: 'linux-learning-path' }, byName), null);
  assert.equal(learningLinkFor('linux', { linux: 'missing' }, byName), null);
});
