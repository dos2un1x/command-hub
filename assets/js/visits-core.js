/**
 * 首页访问统计的纯逻辑:补日期、柱高比例、格式化。
 *
 * 不含 DOM / fetch,便于 node:test 直接单测。
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDateKey(key) {
  if (typeof key !== 'string') return null;
  const m = DATE_RE.exec(key);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ts = Date.UTC(y, mo - 1, d);
  const dt = new Date(ts);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return ts;
}

function dateKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * 把接口返回的稀疏数组补齐为最近 count 天(含 today),缺失日期记 0。
 * 同一天重复时保留数组里最后一条;非法行直接忽略。
 */
export function fillDays(rows, today, count = 7) {
  const end = parseDateKey(today);
  if (end === null || !Number.isInteger(count) || count <= 0) return [];

  const byDate = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || parseDateKey(row.date) === null) continue;
    byDate.set(row.date, { pv: toCount(row.pv), uv: toCount(row.uv) });
  }

  const days = [];
  const start = end - (count - 1) * DAY_MS;
  for (let ts = start; ts <= end; ts += DAY_MS) {
    const key = dateKey(ts);
    const row = byDate.get(key);
    days.push({ date: key, pv: row ? row.pv : 0, uv: row ? row.uv : 0 });
  }
  return days;
}

/** 把 7 天数据转成柱子:percent 相对这 7 天的最大值,label 用 MM-DD。 */
export function buildBars(days) {
  const rows = Array.isArray(days) ? days : [];
  const max = rows.reduce((m, d) => Math.max(m, toCount(d && d.pv)), 0);
  return rows.map((d) => ({
    date: d && d.date,
    pv: toCount(d && d.pv),
    uv: toCount(d && d.uv),
    percent: barPercent(d && d.pv, max),
    label: shortDate(d && d.date),
  }));
}

/** 按最大值缩放为 0–100 的百分比;非零值至少 4,避免柱子看不见。 */
export function barPercent(value, max) {
  const v = toCount(value);
  const m = toCount(max);
  if (v === 0 || m === 0) return 0;
  return Math.min(100, Math.max(4, Math.round((v / m) * 100)));
}

/** 千分位;非法值按 0。 */
export function formatNumber(value) {
  return String(toCount(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 'YYYY-MM-DD' → 'MM-DD';非法值返回空串。 */
export function shortDate(value) {
  const m = typeof value === 'string' ? DATE_RE.exec(value) : null;
  return m ? `${m[2]}-${m[3]}` : '';
}
