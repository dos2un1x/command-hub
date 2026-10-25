import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildInboundGraph,
  extractInternalLinks,
  lowInlinkPages,
  normalizeInternalLink,
} from '../scripts/lib/content-graph.mjs';

test('normalizeInternalLink:同分支与跨分支路径', () => {
  assert.equal(normalizeInternalLink('linux/ls', 'find.html'), 'linux/find');
  assert.equal(normalizeInternalLink('linux/ls', '../guide/runbook-etcd-restore.html'), 'guide/runbook-etcd-restore');
  assert.equal(normalizeInternalLink('linux/ls', 'https://example.com'), null);
  assert.equal(normalizeInternalLink('linux/ls', 'index.html'), null);
  assert.equal(normalizeInternalLink('linux/ls', 'find.html#examples'), 'linux/find');
});

test('extractInternalLinks:去重并忽略外链', () => {
  const links = extractInternalLinks(
    'guide/a',
    '[x](b.html) [y](b.html#top) [z](https://example.com) [i](../linux/ls.html)'
  );
  assert.deepEqual([...links].sort(), ['guide/b', 'linux/ls']);
});

test('buildInboundGraph:统计来源页面', () => {
  const pages = [
    { branch: 'guide', slug: 'a', raw: '[b](b.html)' },
    { branch: 'guide', slug: 'b', raw: '[a](a.html)' },
    { branch: 'guide', slug: 'c', raw: '[a](a.html) [b](b.html)' },
  ];
  const graph = buildInboundGraph(pages);
  assert.deepEqual([...graph.get('guide/a')].sort(), ['guide/b', 'guide/c']);
  assert.deepEqual([...graph.get('guide/b')].sort(), ['guide/a', 'guide/c']);
});

test('lowInlinkPages:按入链数排序', () => {
  const pages = [
    { branch: 'guide', slug: 'a', raw: '[b](b.html)' },
    { branch: 'guide', slug: 'b', raw: '' },
    { branch: 'guide', slug: 'c', raw: '' },
  ];
  const low = lowInlinkPages(pages, 0);
  assert.deepEqual(low.map((x) => x.path), ['guide/a', 'guide/c']);
});
