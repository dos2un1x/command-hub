/**
 * 首页访问统计:向主站 /api/visit.php 上报一次访问,并在首页渲染今日/近 7 天数据。
 *
 * 展示走只读 GET(所有域名可用);计数走 POST(主站按 Origin 白名单限制)。
 * DNT 访客只读展示不计数;读取失败时区块保持 hidden。
 */

import { fillDays, buildBars, formatNumber, shortDate } from './visits-core.js';

const VID_KEY = 'dos2unix.vid';
// GitHub Pages / 任意域名都统一请求主站；接口返回 CORS 头。
const API = new URL('https://www.dos2unix.cn/api/visit.php');
const READ_API = new URL('https://www.dos2unix.cn/api/visit.php?stats=1');
const block = document.getElementById('site-visits');

function start() {
  if (block) void loadStats();
  if (!dntEnabled()) void countVisit();
}

if (document.prerendering) {
  document.addEventListener(
    'prerenderingchange',
    () => {
      if (!document.prerendering) start();
    },
    { once: true }
  );
} else {
  start();
}

function dntEnabled() {
  return (
    navigator.doNotTrack === '1' ||
    navigator.doNotTrack === 'yes' ||
    window.doNotTrack === '1' ||
    navigator.msDoNotTrack === '1'
  );
}

function visitorId() {
  let saved = '';
  try {
    saved = localStorage.getItem(VID_KEY) || '';
  } catch {
    return '';
  }
  if (/^[A-Za-z0-9_-]{8,64}$/.test(saved)) return saved;

  const id = makeId();
  try {
    localStorage.setItem(VID_KEY, id);
  } catch {
    // 存不下就不上报 client id,服务端会回退到当日 IP 哈希
    return '';
  }
  return id;
}

function makeId() {
  if (globalThis.crypto && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (globalThis.crypto && typeof crypto.getRandomValues === 'function') {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
      b.toString(16).padStart(2, '0')
    ).join('');
  }
  return 'v' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function loadStats() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(READ_API, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      keepalive: true,
      signal: controller.signal,
    });
    if (!res.ok || res.status === 204) return;
    render(await res.json());
  } catch {
    // 读取失败时区块保持 hidden
  } finally {
    clearTimeout(timer);
  }
}

async function countVisit() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vid: visitorId() }),
      credentials: 'same-origin',
      cache: 'no-store',
      keepalive: true,
      signal: controller.signal,
    });
  } catch {
    // 计数失败不影响展示;写入是否成功由主站白名单/限流决定
  } finally {
    clearTimeout(timer);
  }
}

function render(data) {
  const rows = Array.isArray(data && data.days) ? data.days : [];
  if (!rows.length) return;

  let latest = '';
  for (const row of rows) {
    if (row && typeof row.date === 'string' && row.date > latest) latest = row.date;
  }
  const days = fillDays(rows, latest, 7);
  if (days.length !== 7) return;

  const bars = buildBars(days);
  const today = data.today && Number.isFinite(Number(data.today.pv)) ? data.today : days[6];

  const pvEl = block.querySelector('[data-visits-pv]');
  const uvEl = block.querySelector('[data-visits-uv]');
  if (pvEl) pvEl.textContent = formatNumber(today.pv);
  if (uvEl) uvEl.textContent = formatNumber(today.uv);

  const updated = block.querySelector('[data-visits-updated]');
  if (updated) {
    if (typeof data.updated === 'string' && /^\d{2}:\d{2}$/.test(data.updated)) {
      updated.textContent = ` · 更新于 ${data.updated}`;
      updated.hidden = false;
    } else {
      updated.hidden = true;
    }
  }

  const list = block.querySelector('[data-visits-bars]');
  const readout = block.querySelector('[data-visits-readout]');
  const baseReadout = readout ? readout.textContent : '';
  if (list) {
    const frag = document.createDocumentFragment();
    bars.forEach((bar, i) => {
      const isToday = i === bars.length - 1;
      const li = document.createElement('li');
      li.className = 'home-visits-day' + (isToday ? ' is-today' : '');
      li.style.setProperty('--i', String(i));

      const mark = document.createElement('span');
      mark.className = 'home-visits-bar';
      mark.tabIndex = 0;
      mark.setAttribute('role', 'img');
      const label = `${bar.label}：${formatNumber(bar.pv)} 次访问，${formatNumber(bar.uv)} 位访客`;
      mark.setAttribute('aria-label', label);
      if (readout) {
        const show = () => {
          readout.textContent = label;
        };
        const reset = () => {
          readout.textContent = baseReadout;
        };
        mark.addEventListener('mouseenter', show);
        mark.addEventListener('focus', show);
        mark.addEventListener('mouseleave', reset);
        mark.addEventListener('blur', reset);
      }

      const fill = document.createElement('span');
      fill.className = 'home-visits-bar-fill';
      fill.style.height = `${bar.percent}%`;
      mark.appendChild(fill);

      const date = document.createElement('span');
      date.className = 'home-visits-date';
      date.textContent = isToday ? '今天' : bar.label;

      li.append(mark, date);
      frag.appendChild(li);
    });
    list.replaceChildren(frag);
  }

  const table = block.querySelector('[data-visits-table]');
  if (table) {
    const frag = document.createDocumentFragment();
    for (const day of days) {
      const tr = document.createElement('tr');
      for (const value of [shortDate(day.date), formatNumber(day.pv), formatNumber(day.uv)]) {
        const td = document.createElement('td');
        td.textContent = value;
        tr.appendChild(td);
      }
      frag.appendChild(tr);
    }
    table.replaceChildren(frag);
  }

  block.hidden = false;
  requestAnimationFrame(() => block.classList.add('is-ready'));
}
