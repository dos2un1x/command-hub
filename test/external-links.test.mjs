import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkExternalLinks,
  extractReferenceLinks,
  mergeReferenceLinks,
} from '../scripts/lib/external-links.mjs';

test('extractReferenceLinks:只取参考链接章节并去掉尾部标点', () => {
  const markdown = [
    '# 页面',
    '正文 https://example.com/body',
    '## 参考链接',
    '- [A](https://example.com/a).',
    '- [B](https://example.com/b)，另见 https://example.com/c。',
    '## 读完自测',
    'https://example.com/quiz',
  ].join('\n');
  const links = extractReferenceLinks(markdown, 'guide/x');
  assert.deepEqual([...links.keys()].sort(), [
    'https://example.com/a',
    'https://example.com/b',
    'https://example.com/c',
  ]);
  assert.deepEqual([...links.get('https://example.com/a')], ['guide/x']);
});

test('mergeReferenceLinks:同一 URL 合并来源页面', () => {
  const merged = mergeReferenceLinks({
    'guide/a': '## 参考链接\n- https://example.com/x\n',
    'guide/b': '## 参考链接\n- https://example.com/x\n',
  });
  assert.deepEqual([...merged.get('https://example.com/x')].sort(), ['guide/a', 'guide/b']);
});

test('checkExternalLinks:HEAD 成功', async () => {
  const fakeFetch = async () => ({ status: 200 });
  const [row] = await checkExternalLinks([['https://example.com/a', new Set(['guide/a'])]], {
    fetchImpl: fakeFetch,
    concurrency: 1,
  });
  assert.equal(row.ok, true);
  assert.equal(row.status, 200);
});

test('checkExternalLinks:HEAD 405 时回退 GET', async () => {
  const calls = [];
  const fakeFetch = async (_url, options) => {
    calls.push(options.method);
    return { status: options.method === 'HEAD' ? 405 : 200 };
  };
  const [row] = await checkExternalLinks([['https://example.com/a', new Set()]], {
    fetchImpl: fakeFetch,
    concurrency: 1,
  });
  assert.deepEqual(calls, ['HEAD', 'GET']);
  assert.equal(row.ok, true);
});

test('checkExternalLinks:404 与网络错误都标记失败', async () => {
  const fakeFetch = async (url) => {
    if (url.endsWith('/404')) return { status: 404 };
    throw new Error('boom');
  };
  const rows = await checkExternalLinks(
    [
      ['https://example.com/404', new Set(['guide/a'])],
      ['https://example.com/down', new Set(['guide/b'])],
    ],
    { fetchImpl: fakeFetch, concurrency: 1 }
  );
  assert.equal(rows[0].ok, false);
  assert.equal(rows[0].status, 404);
  assert.equal(rows[1].ok, false);
  assert.equal(rows[1].error, 'Error');
});
