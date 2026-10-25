import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAB_STATUS_LABELS,
  labStatusFor,
  validateLabStatus,
} from '../scripts/lib/lab-status.mjs';

const labs = new Set(['lab-a', 'lab-b']);

test('validateLabStatus:完整且合法的状态表通过', () => {
  const errors = validateLabStatus(
    {
      'lab-a': { status: 'passed', checked: '2026-10-25', environment: 'Docker Compose' },
      'lab-b': { status: 'static', checked: '2026-10-25', environment: 'kind' },
    },
    labs
  );
  assert.deepEqual(errors, []);
});

test('validateLabStatus:缺少 Lab、未知 Lab 和非法状态都会报错', () => {
  const errors = validateLabStatus(
    {
      'lab-a': { status: 'done', checked: '2026-10-25', environment: 'Docker' },
      'lab-x': { status: 'passed', checked: '2026-10-25', environment: 'Docker' },
    },
    labs
  );
  assert.ok(errors.some((e) => e.includes('lab-a') && e.includes('状态')));
  assert.ok(errors.some((e) => e.includes('lab-x') && e.includes('不存在')));
  assert.ok(errors.some((e) => e.includes('lab-b') && e.includes('缺少')));
});

test('validateLabStatus:日期和环境字段必填', () => {
  const errors = validateLabStatus(
    {
      'lab-a': { status: 'partial', checked: '', environment: '' },
      'lab-b': { status: 'static', checked: '2026/10/25', environment: 'kind' },
    },
    labs
  );
  assert.ok(errors.some((e) => e.includes('lab-a') && e.includes('日期')));
  assert.ok(errors.some((e) => e.includes('lab-a') && e.includes('环境')));
  assert.ok(errors.some((e) => e.includes('lab-b') && e.includes('日期')));
});

test('labStatusFor:补上中文标签，未知页面返回 null', () => {
  const data = {
    'lab-a': { status: 'passed', checked: '2026-10-25', environment: 'Docker Compose' },
  };
  assert.equal(labStatusFor(data, 'lab-a').label, LAB_STATUS_LABELS.passed);
  assert.equal(labStatusFor(data, 'missing'), null);
});
