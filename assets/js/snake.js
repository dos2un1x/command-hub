/**
 * 贪吃蛇页面:渲染 + 键盘 + 触屏 + 音效 + 最高分
 *
 * 纯逻辑在 snake-core.js,本文件只做 DOM / canvas / 输入 / 存储。
 */
import { createGame, turn, step, speedMsFor, DIRS } from './snake-core.js';

const $ = (id) => document.getElementById(id);

const BEST_KEY = '_snake_best_';
const MUTE_KEY = '_snake_mute_';

// localStorage 在隐私模式/被策略禁用时会抛异常:降级为"不记忆",不影响可玩性
const store = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* 忽略:存不上就算了 */
    }
  },
};

const canvas = $('board');
const ctx = canvas.getContext('2d');
const overlay = $('overlay');
const overlayTitle = $('overlay-title');
const overlayText = $('overlay-text');
const overlayKeys = $('overlay-keys');
const scoreEl = $('score');
const bestEl = $('best');
const muteBtn = $('mute');

let game = createGame();
let phase = 'idle';   // idle | running | paused | over
let acc = 0;          // 时间累加器(ms)
let last = 0;         // 上一帧时间戳
let best = Number(store.get(BEST_KEY)) || 0;
let muted = store.get(MUTE_KEY) === '1';
let newRecord = false;   // 本局是否破纪录(面板文案用)

/** 画布配色从 CSS 变量读,深浅色切换后重新读一次即可 */
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return {
    cellA: v('--snake-cell-a'),
    cellB: v('--snake-cell-b'),
    body: v('--snake-body'),
    head: v('--snake-head'),
    food: v('--snake-food'),
  };
}

let colors = readColors();

// ── 渲染 ────────────────────────────────────────────────
function resize() {
  const dpr = window.devicePixelRatio || 1;
  const size = canvas.clientWidth || 480;
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  draw();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
  ctx.fill();
}

function draw() {
  const cell = canvas.width / game.cols;
  for (let y = 0; y < game.rows; y++) {
    for (let x = 0; x < game.cols; x++) {
      ctx.fillStyle = (x + y) % 2 ? colors.cellB : colors.cellA;
      ctx.fillRect(x * cell, y * cell, cell + 1, cell + 1);
    }
  }
  if (game.food) {
    ctx.fillStyle = colors.food;
    ctx.beginPath();
    ctx.arc((game.food.x + 0.5) * cell, (game.food.y + 0.5) * cell, cell * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = game.snake.length - 1; i >= 0; i--) {
    const seg = game.snake[i];
    ctx.fillStyle = i === 0 ? colors.head : colors.body;
    roundRect(seg.x * cell + 1, seg.y * cell + 1, cell - 2, cell - 2, Math.max(2, cell * 0.18));
  }
}

// ── 音效(Web Audio 合成,无音频文件)────────────────────
let audioCtx = null;

function ensureAudio() {
  if (muted) return;
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      audioCtx = new AC();
    } catch {
      audioCtx = null;
      return;
    }
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
}

function beep(freqs, dur = 0.08, type = 'square') {
  if (muted || !audioCtx) return;
  try {
    const t0 = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    freqs.forEach((f, i) => osc.frequency.setValueAtTime(f, t0 + dur * i));
    gain.gain.setValueAtTime(0.06, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur * freqs.length);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + dur * freqs.length);
  } catch {
    /* 音效失败不影响游戏 */
  }
}

const playEat = () => beep([660, 880]);
const playDie = () => beep([320, 200, 120], 0.12, 'sawtooth');

// ── 状态与面板 ──────────────────────────────────────────
function renderOverlay() {
  if (phase === 'running') {
    overlay.hidden = true;
    return;
  }
  overlay.hidden = false;
  if (phase === 'idle') {
    overlayTitle.textContent = '贪吃蛇';
    overlayText.textContent = '方向键控制 · 吃满 5 个提速';
    overlayKeys.textContent = '回车(或点这里)开始 · 空格 返回首页';
  } else if (phase === 'paused') {
    overlayTitle.textContent = '已暂停';
    overlayText.textContent = '';
    overlayKeys.textContent = '回车 继续 · 空格 返回首页';
  } else {
    overlayTitle.textContent = game.reason === 'win' ? '通关!' : newRecord ? '新纪录!' : '游戏结束';
    overlayText.textContent = `本局 ${game.score} 分 · 最高 ${best} 分`;
    overlayKeys.textContent = '回车 再来一局 · 空格 返回首页';
  }
}

function setPhase(next) {
  phase = next;
  if (next === 'running') {
    acc = 0;
    last = 0;   // 重置时间基准,避免暂停期间的时间被一次性补进游戏
  }
  renderOverlay();
  draw();
}

function start() {
  game = createGame();
  newRecord = false;
  scoreEl.textContent = String(game.score);
  bestEl.textContent = String(best);
  setPhase('running');
}

function endGame() {
  if (game.score > best) {
    best = game.score;
    newRecord = true;
    bestEl.textContent = String(best);
    store.set(BEST_KEY, String(best));
  }
  setPhase('over');
}

function advance() {
  const r = step(game);
  if (r.ate) playEat();
  scoreEl.textContent = String(game.score);
  if (r.ended) {
    if (r.ended !== 'win') playDie();
    endGame();
  }
}

function confirm() {
  ensureAudio();
  if (phase === 'idle' || phase === 'over') start();
  else if (phase === 'paused') setPhase('running');
}

function press(dir) {
  ensureAudio();
  if (phase === 'running') turn(game, dir);
}

// ── 主循环 ──────────────────────────────────────────────
function frame(now) {
  requestAnimationFrame(frame);
  const interval = speedMsFor(game.score);
  // dt 上限一帧一步:窗口被挂起(休眠/锁屏/后台)而 blur 与 visibilitychange 都没触发时,
  // 唤醒后的第一帧会带上整段挂起时长;不设上限就会在"一帧内"把蛇一路送到墙上撞死。
  const dt = Math.min(last ? now - last : 0, interval);
  last = now;
  if (phase !== 'running') {
    acc = 0;
    return;
  }
  acc += dt;
  while (acc >= interval && phase === 'running') {
    acc -= interval;
    advance();
  }
  draw();
}

// ── 输入 ────────────────────────────────────────────────
const KEY_DIRS = {
  ArrowUp: DIRS.up,
  ArrowDown: DIRS.down,
  ArrowLeft: DIRS.left,
  ArrowRight: DIRS.right,
};

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;   // 不劫持浏览器快捷键

  // 焦点在原生控件上时,把「激活键」让给控件自己:链接用回车、按钮用回车与空格。
  // 否则下面的 preventDefault 会取消它们的激活行为 —— 键盘/读屏用户既打不开
  // 「← 返回首页」(回车会变成开局),也按不动静音开关。
  const el = e.target instanceof Element ? e.target : null;
  const onLink = el && el.closest('a[href]');
  const onButton = el && el.closest('button');
  if ((onLink || onButton) && e.key === 'Enter') return;
  if (onButton && (e.key === ' ' || e.key === 'Spacebar')) return;

  const dir = KEY_DIRS[e.key];
  if (dir) {
    e.preventDefault();
    press(dir);
    return;
  }
  if (e.key === ' ' || e.key === 'Spacebar') {
    e.preventDefault();
    if (e.repeat) return;
    if (phase === 'running') setPhase('paused');
    else location.href = 'index.html';
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.repeat) return;
    confirm();
  }
});

// 面板点击 = 回车(触屏用户的"确认")
overlay.addEventListener('pointerdown', () => {
  if (phase !== 'running') confirm();
});

function renderMute() {
  muteBtn.textContent = muted ? '🔇' : '🔊';
  muteBtn.setAttribute('aria-label', muted ? '取消静音' : '静音');
}

muteBtn.addEventListener('click', () => {
  muted = !muted;
  store.set(MUTE_KEY, muted ? '1' : '0');
  renderMute();
  muteBtn.blur();   // 别让按钮留住焦点,否则空格会去"点击"它
});

document.querySelectorAll('[data-dir]').forEach((btn) => {
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    press(DIRS[btn.dataset.dir]);
    btn.blur();   // 同静音按钮:不留下焦点,否则空格会去"点击"它
  });
});

// 切走/失焦时自动暂停,别让玩家回来发现蛇已经撞死
const autoPause = () => {
  if (phase === 'running') setPhase('paused');
};
window.addEventListener('blur', autoPause);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) autoPause();
});

// <dark-mode> 会改 documentElement 的 data-color-mode;变了就重新读色并重绘
new MutationObserver(() => {
  colors = readColors();
  draw();
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-color-mode'] });

// ── 启动 ────────────────────────────────────────────────
renderMute();
bestEl.textContent = String(best);
window.addEventListener('resize', resize);
resize();
renderOverlay();
requestAnimationFrame(frame);
