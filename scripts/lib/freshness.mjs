/** 版本敏感页的“最后核对日期”检查。 */
export const FRESHNESS_MAX_AGE_DAYS = 180;

const VERSION_PATTERN =
  /(20\d{2}[-年]\d{1,2}|v?\d+\.\d+(\.\d+)?|最新版本|已归档|停止维护|不再维护|维护模式|EOL|GA\b|弃用|废弃|deprecated|Deprecated)/g;

export function isVersionSensitive(raw) {
  return (String(raw || '').match(VERSION_PATTERN) || []).length >= 3;
}

function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) ? time : null;
}

/** 返回 {rows, ok, stale, missing, maxAgeDays};registry 支持 {pages:{...}} 或直接映射。 */
export function analyzeFreshness(pages, registry, today, maxAgeDays = FRESHNESS_MAX_AGE_DAYS) {
  const map = registry?.pages || registry || {};
  const todayTime = parseDate(today) ?? Date.now();
  const rows = [];
  for (const page of pages) {
    const registered = Object.prototype.hasOwnProperty.call(map, page.path);
    if (!registered && !isVersionSensitive(page.raw)) continue;
    const verified = map[page.path];
    const verifiedTime = parseDate(verified);
    let status = 'missing';
    let ageDays = null;
    if (verifiedTime !== null) {
      ageDays = Math.floor((todayTime - verifiedTime) / 86400000);
      status = ageDays > maxAgeDays ? 'stale' : 'ok';
    }
    rows.push({ path: page.path, verified: verified || null, ageDays, status });
  }
  rows.sort((a, b) => {
    const rank = { missing: 0, stale: 1, ok: 2 };
    return rank[a.status] - rank[b.status] || a.path.localeCompare(b.path);
  });
  return {
    rows,
    ok: rows.filter((r) => r.status === 'ok').length,
    stale: rows.filter((r) => r.status === 'stale').length,
    missing: rows.filter((r) => r.status === 'missing').length,
    maxAgeDays,
  };
}
