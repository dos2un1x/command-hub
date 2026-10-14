/**
 * 俄罗斯方块页面:渲染 + 键盘(DAS) + 触屏 + 主题,音效/存储见 Task 12。
 *
 * 纯逻辑在 tetris-core.js,本文件只做 DOM / canvas / 输入 / 存储。
 */
import {
  createGame, move, rotate, softDropStep, hardDrop, holdPiece,
  ghostY, tick, PIECES, COLS, ROWS, CLEAR_FLASH_MS,
} from './tetris-core.js';

const $ = (id) => document.getElementById(id);

const DAS_DELAY_MS = 170;
const DAS_REPEAT_MS = 50;
const LONG_PRESS_MS = 250;
const DT_CLAMP_MS = 100;   // 挂起唤醒后首帧可能带整段挂起时长,不设上限会瞬移/秒锁

const BEST_KEY = '_tetris_best_';
const MUTE_KEY = '_tetris_mute_';

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

const boardCanvas = $('board');
const bctx = boardCanvas.getContext('2d');
const nextCanvas = $('next');
const nctx = nextCanvas.getContext('2d');
const holdCanvas = $('hold');
const hctx = holdCanvas.getContext('2d');
const overlay = $('overlay');
const overlayTitle = $('overlay-title');
const overlayText = $('overlay-text');
const overlayKeys = $('overlay-keys');
const scoreEl = $('score');
const bestEl = $('best');
const levelEl = $('level');
const linesEl = $('lines');
const muteBtn = $('mute');

let game = createGame();
let phase = 'idle';     // idle | running | paused | over
let last = 0;
let heldDir = 0;        // -1 | 0 | 1(键盘与触屏共用)
let dasTimer = 0;
let dasNext = DAS_DELAY_MS;
let downPressTimer = null;   // 触屏 ▼ 的长按判定
let best = Number(store.get(BEST_KEY)) || 0;
let muted = store.get(MUTE_KEY) === '1';
let newRecord = false;

/** 画布配色从 CSS 变量读,深浅色切换后重新读一次即可 */
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return {
    bg: v('--tetris-bg'),
    line: v('--tetris-line'),
    ghost: v('--tetris-ghost'),
    flash: v('--tetris-flash'),
    cells: {
      I: v('--tetris-i'), O: v('--tetris-o'), T: v('--tetris-t'),
      S: v('--tetris-s'), Z: v('--tetris-z'), J: v('--tetris-j'), L: v('--tetris-l'),
    },
  };
}

let colors = readColors();

// ── 渲染 ────────────────────────────────────────────────
function resize() {
  const dpr = window.devicePixelRatio || 1;
  const w = boardCanvas.clientWidth || 300;
  boardCanvas.width = Math.round(w * dpr);
  boardCanvas.height = Math.round(w * 2 * dpr);   // 10:20
  for (const c of [nextCanvas, holdCanvas]) {
    const size = c.clientWidth || 72;
    c.width = Math.round(size * dpr);
    c.height = Math.round(size * dpr);
  }
  draw();
}

function tile(ctx, px, py, cell, color) {
  ctx.fillStyle = color;
  ctx.beginPath();
  const r = Math.max(2, cell * 0.16);
  if (ctx.roundRect) ctx.roundRect(px + 1, py + 1, cell - 2, cell - 2, r);
  else ctx.rect(px + 1, py + 1, cell - 2, cell - 2);
  ctx.fill();
}

function draw() {
  const cell = boardCanvas.width / COLS;
  const W = boardCanvas.width;
  const H = boardCanvas.height;
  bctx.fillStyle = colors.bg;
  bctx.fillRect(0, 0, W, H);

  bctx.strokeStyle = colors.line;
  bctx.lineWidth = 1;
  bctx.beginPath();
  for (let x = 1; x < COLS; x++) { bctx.moveTo(x * cell, 0); bctx.lineTo(x * cell, H); }
  for (let y = 1; y < ROWS; y++) { bctx.moveTo(0, y * cell); bctx.lineTo(W, y * cell); }
  bctx.stroke();

  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const t = game.grid[y][x];
      if (t) tile(bctx, x * cell, y * cell, cell, colors.cells[t]);
    }
  }

  if (game.phase === 'clearing') {
    const alpha = 0.25 + 0.6 * (game.clearTimer / CLEAR_FLASH_MS);
    bctx.globalAlpha = alpha;
    bctx.fillStyle = colors.flash;
    for (const y of game.clearRows) bctx.fillRect(0, y * cell, W, cell);
    bctx.globalAlpha = 1;
  }

  if (game.current && game.phase === 'playing') {
    const c = game.current;
    const gy = ghostY(game);
    bctx.globalAlpha = 0.25;
    bctx.fillStyle = colors.cells[c.type];
    for (const [cx, cy] of PIECES[c.type][c.rot]) {
      bctx.fillRect((c.x + cx) * cell + 1, (gy + cy) * cell + 1, cell - 2, cell - 2);
    }
    bctx.globalAlpha = 1;
  }
  if (game.current) {
    const c = game.current;
    for (const [cx, cy] of PIECES[c.type][c.rot]) {
      tile(bctx, (c.x + cx) * cell, (c.y + cy) * cell, cell, colors.cells[c.type]);
    }
  }

  drawPreview(nctx, nextCanvas, game.queue[0]);
  drawPreview(hctx, holdCanvas, game.hold);
}

function drawPreview(ctx, canvas, type) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!type) return;
  const cells = PIECES[type][0];
  const xs = cells.map((c) => c[0]);
  const ys = cells.map((c) => c[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const cell = canvas.width / 5;
  const w = (maxX - minX + 1) * cell;
  const h = (maxY - minY + 1) * cell;
  const ox = (canvas.width - w) / 2 - minX * cell;
  const oy = (canvas.height - h) / 2 - minY * cell;
  for (const [cx, cy] of cells) tile(ctx, ox + cx * cell, oy + cy * cell, cell, colors.cells[type]);
}

// ── 状态与面板 ──────────────────────────────────────────
function renderOverlay() {
  if (phase === 'running') {
    overlay.hidden = true;
    return;
  }
  overlay.hidden = false;
  if (phase === 'idle') {
    overlayTitle.textContent = '俄罗斯方块';
    overlayText.textContent = '方向键移动旋转 · 消行得分升级';
    overlayKeys.textContent = '回车(或点这里)开始 · 空格 返回首页';
  } else if (phase === 'paused') {
    overlayTitle.textContent = '已暂停';
    overlayText.textContent = '';
    overlayKeys.textContent = '回车 继续 · 空格 返回首页';
  } else {
    overlayTitle.textContent = newRecord ? '新纪录!' : '游戏结束';
    overlayText.textContent = `本局 ${game.score} 分 · 最高 ${best} 分 · 等级 ${game.level} · 消行 ${game.lines}`;
    overlayKeys.textContent = '回车 再来一局 · 空格 返回首页';
  }
}

function setPhase(next) {
  phase = next;
  if (next === 'running') {
    last = 0;                 // 重置时间基准,挂起时长不进游戏
    dasTimer = 0;
    dasNext = DAS_DELAY_MS;
  } else {
    heldDir = 0;              // 离开进行中:清空"按住"状态
    game.softDrop = false;
    if (downPressTimer) { clearTimeout(downPressTimer); downPressTimer = null; }
  }
  renderOverlay();
  draw();
}

const stats = { score: -1, best: -1, level: -1, lines: -1 };
function syncStats() {
  if (stats.score !== game.score) { stats.score = game.score; scoreEl.textContent = String(game.score); }
  if (stats.best !== best) { stats.best = best; bestEl.textContent = String(best); }
  if (stats.level !== game.level) { stats.level = game.level; levelEl.textContent = String(game.level); }
  if (stats.lines !== game.lines) { stats.lines = game.lines; linesEl.textContent = String(game.lines); }
}

function start() {
  ensureAudio();
  game = createGame();
  newRecord = false;
  setPhase('running');
  syncStats();
}

function endGame() {
  if (game.score > best) {
    best = game.score;
    newRecord = true;
    store.set(BEST_KEY, String(best));   // 新纪录立即落盘
  }
  syncStats();   // 最高分可能刚更新,顶栏立即跟上(帧循环在非进行中时不再同步)
  setPhase('over');
}

/** 每次操作/每帧后调用:核心判负则收尾 */
function checkOver() {
  if (phase === 'running' && game.phase === 'over') {
    playOver();
    endGame();
  }
}

/** 输入动作的统一入口:只在"进行中"生效 */
function act(fn) {
  if (phase !== 'running') return;
  ensureAudio();
  fn();
  checkOver();
}

function confirm() {
  ensureAudio();
  if (phase === 'idle' || phase === 'over') start();
  else if (phase === 'paused') setPhase('running');
  else if (game.phase === 'playing') act(() => hardDrop(game));
}

function beginHeld(dir) {
  if (phase !== 'running' || game.phase !== 'playing') return;
  ensureAudio();
  heldDir = dir;
  dasTimer = 0;
  dasNext = DAS_DELAY_MS;
  act(() => move(game, dir));
}

// ── 主循环 ──────────────────────────────────────────────
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(last ? now - last : 0, DT_CLAMP_MS);
  last = now;
  if (phase !== 'running') return;

  if (heldDir) {
    dasTimer += dt;
    while (dasTimer >= dasNext) {
      dasTimer -= dasNext;
      dasNext = DAS_REPEAT_MS;
      if (!move(game, heldDir)) break;
    }
  }

  const ev = tick(game, dt);
  if (ev.cleared) playClear(ev.cleared);      // Task 12 接音效
  checkOver();
  syncStats();
  draw();
}

// ── 输入:键盘 ───────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;   // 不劫持浏览器快捷键

  // 焦点在原生控件上时,把「激活键」让给控件自己:链接用回车、按钮用回车与空格。
  const el = e.target instanceof Element ? e.target : null;
  const onLink = el && el.closest('a[href]');
  const onButton = el && el.closest('button');
  if ((onLink || onButton) && e.key === 'Enter') return;
  if (onButton && (e.key === ' ' || e.key === 'Spacebar')) return;

  switch (e.key) {
    case 'ArrowLeft':
      e.preventDefault();
      if (!e.repeat) beginHeld(-1);
      return;
    case 'ArrowRight':
      e.preventDefault();
      if (!e.repeat) beginHeld(1);
      return;
    case 'ArrowUp': case 'x': case 'X':
      e.preventDefault();
      if (!e.repeat) act(() => rotate(game, 1));
      return;
    case 'z': case 'Z':
      e.preventDefault();
      if (!e.repeat) act(() => rotate(game, -1));
      return;
    case 'ArrowDown':
      e.preventDefault();
      if (!e.repeat && phase === 'running') game.softDrop = true;
      return;
    case 'c': case 'C':
      e.preventDefault();
      if (!e.repeat) act(() => holdPiece(game));
      return;
    case ' ':
    case 'Spacebar':
      e.preventDefault();
      if (e.repeat) return;
      if (phase === 'running') setPhase('paused');
      else location.href = 'index.html';
      return;
    case 'Enter':
      e.preventDefault();
      if (e.repeat) return;
      confirm();
      return;
    default:
  }
});

document.addEventListener('keyup', (e) => {
  if (e.key === 'ArrowDown') game.softDrop = false;
  if (e.key === 'ArrowLeft' && heldDir === -1) heldDir = 0;
  if (e.key === 'ArrowRight' && heldDir === 1) heldDir = 0;
});

// 面板点击 = 回车(触屏用户的"确认")
overlay.addEventListener('pointerdown', () => {
  if (phase !== 'running') confirm();
});

// ── 输入:触屏按钮 ──────────────────────────────────────
document.querySelectorAll('[data-act]').forEach((btn) => {
  const kind = btn.dataset.act;
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (kind === 'left' || kind === 'right') beginHeld(kind === 'left' ? -1 : 1);
    else if (kind === 'rotate') act(() => rotate(game, 1));
    else if (kind === 'hold') act(() => holdPiece(game));
    else if (kind === 'down') {
      act(() => softDropStep(game));            // 按下先软降一格
      if (downPressTimer) clearTimeout(downPressTimer);
      downPressTimer = setTimeout(() => {       // 按住满 250ms 升级为硬降
        downPressTimer = null;
        act(() => hardDrop(game));
      }, LONG_PRESS_MS);
    }
    btn.blur();   // 不留焦点,否则空格会去"点击"它
  });
  const endPress = () => {
    if (kind === 'left' && heldDir === -1) heldDir = 0;
    if (kind === 'right' && heldDir === 1) heldDir = 0;
    if (kind === 'down' && downPressTimer) { clearTimeout(downPressTimer); downPressTimer = null; }
  };
  btn.addEventListener('pointerup', endPress);
  btn.addEventListener('pointercancel', endPress);
  btn.addEventListener('pointerleave', endPress);
});

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

function playClear(lines) {
  const scale = [523, 659, 784, 1047];
  beep(scale.slice(0, Math.max(1, lines)));
}

function playOver() {
  beep([330, 247, 165], 0.12, 'sawtooth');
}

// ── 杂项 ────────────────────────────────────────────────
const autoPause = () => {
  if (phase === 'running') setPhase('paused');
};
window.addEventListener('blur', autoPause);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) autoPause();
});

new MutationObserver(() => {
  colors = readColors();
  draw();
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-color-mode'] });

window.addEventListener('resize', resize);

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

// ── 启动 ────────────────────────────────────────────────
renderMute();
resize();
syncStats();
renderOverlay();
requestAnimationFrame(frame);
