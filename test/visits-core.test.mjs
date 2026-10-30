import test from 'node:test';
import assert from 'node:assert/strict';
import { fillDays, barPercent, buildBars, formatNumber, shortDate } from '../assets/js/visits-core.js';

test('fillDays: 补齐最近 7 天，缺失日期记 0，按日期升序', () => {
  const rows = [
    { date: '2026-10-28', pv: 10, uv: 8 },
    { date: '2026-10-30', pv: 5, uv: 4 },
  ];
  const days = fillDays(rows, '2026-10-30');
  assert.deepEqual(
    days.map((d) => d.date),
    ['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']
  );
  assert.deepEqual(days.map((d) => [d.pv, d.uv]), [
    [0, 0], [0, 0], [0, 0], [0, 0], [10, 8], [0, 0], [5, 4],
  ]);
});

test('fillDays: 跨月、忽略窗口外和格式不合法的行', () => {
  const rows = [
    { date: '2026-10-26', pv: 1, uv: 1 },
    { date: '2026-10-27', pv: 2, uv: 2 },
    { date: '2026-11-01', pv: 3, uv: 3 },
    { date: '2026-11-02', pv: 4, uv: 4 },
    { date: 'not-a-date', pv: 99, uv: 99 },
    { date: '2026-11-02', pv: 40, uv: 30 },
  ];
  const days = fillDays(rows, '2026-11-02');
  assert.equal(days.length, 7);
  assert.equal(days[0].date, '2026-10-27');
  assert.deepEqual([days[0].pv, days[0].uv], [2, 2]);
  assert.deepEqual([days[5].pv, days[5].uv], [3, 3]);
  // 同一天重复时保留数组里最后一条
  assert.deepEqual([days[6].pv, days[6].uv], [40, 30]);
});

test('fillDays: today 不合法时返回空数组', () => {
  assert.deepEqual(fillDays([], '2026/10/30'), []);
});

test('barPercent: 按最大值缩放并限制在 0–100', () => {
  assert.equal(barPercent(0, 100), 0);
  assert.equal(barPercent(50, 100), 50);
  assert.equal(barPercent(100, 100), 100);
  assert.equal(barPercent(200, 100), 100);
  assert.equal(barPercent(1, 1000), 4);
  assert.equal(barPercent(0, 0), 0);
});

test('buildBars: 按 7 天最大值算柱高，零值不出柱', () => {
  const days = [
    { date: '2026-10-24', pv: 0, uv: 0 },
    { date: '2026-10-25', pv: 50, uv: 30 },
    { date: '2026-10-26', pv: 100, uv: 60 },
    { date: '2026-10-27', pv: 1, uv: 1 },
    { date: '2026-10-28', pv: 0, uv: 0 },
    { date: '2026-10-29', pv: 25, uv: 20 },
    { date: '2026-10-30', pv: 75, uv: 50 },
  ];
  const bars = buildBars(days);
  assert.deepEqual(bars.map((b) => b.percent), [0, 50, 100, 4, 0, 25, 75]);
  assert.deepEqual(bars.map((b) => b.label), [
    '10-24', '10-25', '10-26', '10-27', '10-28', '10-29', '10-30',
  ]);
  assert.equal(bars[2].pv, 100);
  assert.equal(bars[2].uv, 60);
});

test('formatNumber: 千分位，非法值按 0', () => {
  assert.equal(formatNumber(0), '0');
  assert.equal(formatNumber(999), '999');
  assert.equal(formatNumber(1000), '1,000');
  assert.equal(formatNumber(1234567), '1,234,567');
  assert.equal(formatNumber(-1), '0');
  assert.equal(formatNumber(NaN), '0');
});

test('shortDate: YYYY-MM-DD 转 MM-DD，非法值返回空串', () => {
  assert.equal(shortDate('2026-10-24'), '10-24');
  assert.equal(shortDate('2026/10/24'), '');
  assert.equal(shortDate(''), '');
});
