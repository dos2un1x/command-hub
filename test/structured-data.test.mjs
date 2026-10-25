import test from 'node:test';
import assert from 'node:assert/strict';
import {
  breadcrumbList,
  faqPage,
  howTo,
  howToSteps,
} from '../scripts/lib/structured-data.mjs';

test('breadcrumbList:按首页、分支、分类、页面生成位置', () => {
  const data = breadcrumbList([
    { name: '首页', url: 'https://example.com/' },
    { name: '指南', url: 'https://example.com/guide/' },
    { name: '术语与索引', url: 'https://example.com/guide/category/reference/' },
    { name: '术语表', url: 'https://example.com/guide/glossary-index.html' },
  ]);
  assert.equal(data['@type'], 'BreadcrumbList');
  assert.equal(data.itemListElement.length, 4);
  assert.deepEqual(
    data.itemListElement.map((x) => [x.position, x.name]),
    [[1, '首页'], [2, '指南'], [3, '术语与索引'], [4, '术语表']]
  );
});

test('faqPage:三道自测题转成 FAQ 条目', () => {
  const data = faqPage([
    { q: '为什么 A？', a: '因为 B。' },
    { q: '怎么 C？', a: '先 D。' },
  ]);
  assert.equal(data['@type'], 'FAQPage');
  assert.equal(data.mainEntity.length, 2);
  assert.equal(data.mainEntity[0].acceptedAnswer.text, '因为 B。');
});

test('howToSteps:优先取演练步骤下的三级标题，并带首段说明', () => {
  const md = [
    'lab-x',
    '===',
    '说明',
    '## 环境准备',
    '先准备 Docker 和目录。',
    '## 演练步骤',
    '### 1. 创建集群',
    '运行 compose up，等待 ready。',
    '### 2. 注入故障',
    '停止上游进程。',
    '## 验证',
    '检查返回码。',
  ].join('\n');
  const steps = howToSteps(md);
  assert.deepEqual(steps.map((x) => x.name), ['创建集群', '注入故障']);
  assert.equal(steps[0].text, '运行 compose up，等待 ready。');
});

test('howToSteps:没有演练步骤时退回关键二级章节', () => {
  const md = [
    '## 环境准备',
    '准备环境。',
    '## 注入故障',
    '停掉进程。',
    '## 观察现象',
    '查看日志。',
    '## 复盘',
    '回答问题。',
  ].join('\n');
  assert.deepEqual(howToSteps(md).map((x) => x.name), ['环境准备', '注入故障', '观察现象']);
});

test('howTo:生成 HowTo 结构并过滤空步骤', () => {
  const data = howTo({ name: '演练', description: '说明', steps: [{ name: 'A', text: 'B' }, { name: '', text: '' }] });
  assert.equal(data['@type'], 'HowTo');
  assert.equal(data.step.length, 1);
});
