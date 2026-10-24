import test from 'node:test';
import assert from 'node:assert/strict';
import { auditQuizzes, flagQuiz } from '../scripts/lib/quiz-quality.mjs';

test('flagQuiz:过短答案需要补充原因', () => {
  assert.equal(flagQuiz({ q: '为什么显存会不足？', a: '显存不足。' }), 'answer-too-short');
});

test('flagQuiz:是非题的简短确认需要展开', () => {
  assert.equal(flagQuiz({ q: '这是驱动版本吗？', a: '不是。' }), 'yes-no-short');
});

test('flagQuiz:有解释的是非题不标记', () => {
  assert.equal(
    flagQuiz({
      q: '这是已安装的 CUDA 版本吗？',
      a: '不是；它是驱动支持的最高版本，实际运行时版本要看 nvcc 或框架输出。',
    }),
    null
  );
});

test('flagQuiz:普通问答不标记', () => {
  assert.equal(
    flagQuiz({ q: 'DNS 解析失败先查什么？', a: '先看 /etc/resolv.conf 和 CoreDNS 日志，再用 dig 对比集群内外解析结果。' }),
    null
  );
});

test('auditQuizzes:按分支汇总并保留页面路径', () => {
  const report = auditQuizzes([
    { path: 'ai/demo', qa: [{ q: '为什么？', a: '不知道。' }] },
    { path: 'linux/ok', qa: [{ q: '怎么查？', a: '使用 ls 查看目录内容并确认权限与挂载点。' }] },
  ]);
  assert.equal(report.total, 2);
  assert.equal(report.flagged.length, 1);
  assert.equal(report.flagged[0].path, 'ai/demo');
  assert.equal(report.byBranch.ai, 1);
});
