import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFreshness, FRESHNESS_MAX_AGE_DAYS } from '../scripts/lib/freshness.mjs';

const pages = [
  { path: 'k8s/kserve', raw: '2026-09-25 v0.21.0 GA 1.33 v1.6' },
  { path: 'k8s/old', raw: 'v1.2.0 2024-01-01 1.20' },
  { path: 'linux/ls', raw: '列出目录内容' },
  { path: 'ai/tgi', raw: 'v3.3.7 维护模式 2026-10' },
];

test('analyzeFreshness:版本敏感页缺少核对日期时报告 missing', () => {
  const report = analyzeFreshness(pages, { 'k8s/kserve': '2026-10-20' }, '2026-10-24');
  const missing = report.rows.filter((r) => r.status === 'missing');
  assert.deepEqual(missing.map((r) => r.path), ['ai/tgi', 'k8s/old']);
});

test('analyzeFreshness:超过最大天数报告 stale,未超期报告 ok', () => {
  const report = analyzeFreshness(
    pages,
    { 'k8s/kserve': '2026-10-20', 'k8s/old': '2026-01-01', 'ai/tgi': '2026-10-24' },
    '2026-10-24'
  );
  const byPath = Object.fromEntries(report.rows.map((r) => [r.path, r.status]));
  assert.equal(byPath['k8s/kserve'], 'ok');
  assert.equal(byPath['k8s/old'], 'stale');
  assert.equal(byPath['ai/tgi'], 'ok');
  assert.equal(report.stale, 1);
  assert.equal(report.missing, 0);
});

test('analyzeFreshness:非版本敏感页不进入报告', () => {
  const report = analyzeFreshness(pages, {}, '2026-10-24');
  assert.ok(!report.rows.some((r) => r.path === 'linux/ls'));
});

test('analyzeFreshness:非法日期按 missing 处理', () => {
  const report = analyzeFreshness(
    [{ path: 'k8s/x', raw: 'v1.0 2026-01 1.2' }],
    { 'k8s/x': 'not-a-date' },
    '2026-10-24'
  );
  assert.equal(report.rows[0].status, 'missing');
});

test('默认阈值是 180 天', () => {
  assert.equal(FRESHNESS_MAX_AGE_DAYS, 180);
});
