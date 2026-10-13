/**
 * 贪吃蛇页面:渲染 + 键盘 + 触屏 + 音效 + 最高分
 *
 * 纯逻辑在 snake-core.js,本文件只做 DOM / canvas / 输入 / 存储。
 */
import { createGame, turn, step, speedMsFor, DIRS } from './snake-core.js';

const $ = (id) => document.getElementById(id);

const canvas = $('board');
const ctx = canvas.getContext('2d');
const overlay = $('overlay');
const overlayTitle = $('overlay-title');
const overlayText = $('overlay-text');
const overlayKeys = $('overlay-keys');
const scoreEl = $('score');
const bestEl = $('best');

let game = createGame();
let phase = 'idle';   // idle | running | paused | over
let acc = 0;          // 时间累加器(ms)
let last = 0;         // 上一帧时间戳
let best = 0;            // 内存中的最高分(Task 10 接入 localStorage)
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
  }
  setPhase('over');
}

function advance() {
  const r = step(game);
  scoreEl.textContent = String(game.score);
  if (r.ended) endGame();
}

function confirm() {
  if (phase === 'idle' || phase === 'over') start();
  else if (phase === 'paused') setPhase('running');
}

function press(dir) {
  if (phase === 'running') turn(game, dir);
}

// ── 主循环 ──────────────────────────────────────────────
function frame(now) {
  requestAnimationFrame(frame);
  const dt = last ? now - last : 0;
  last = now;
  if (phase !== 'running') {
    acc = 0;
    return;
  }
  acc += dt;
  const interval = speedMsFor(game.score);
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

// ── 启动 ────────────────────────────────────────────────
window.addEventListener('resize', resize);
resize();
renderOverlay();
requestAnimationFrame(frame);
