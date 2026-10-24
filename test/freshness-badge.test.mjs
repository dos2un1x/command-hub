import test from 'node:test';
import assert from 'node:assert/strict';
import { verifiedFor } from '../scripts/lib/freshness-badge.mjs';

test('verifiedFor:返回登记日期', () => {
  assert.equal(
    verifiedFor({ pages: { 'k8s/kserve': '2026-10-24' } }, 'k8s', 'kserve'),
    '2026-10-24'
  );
});

test('verifiedFor:未登记返回 null', () => {
  assert.equal(verifiedFor({ pages: {} }, 'k8s', 'kserve'), null);
  assert.equal(verifiedFor(null, 'k8s', 'kserve'), null);
});
