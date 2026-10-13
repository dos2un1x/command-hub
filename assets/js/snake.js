/**
 * 贪吃蛇页面:渲染 + 键盘 + 触屏 + 音效 + 最高分
 *
 * 纯逻辑在 snake-core.js,本文件只做 DOM / canvas / 输入 / 存储。
 */
import { createGame } from './snake-core.js';

const $ = (id) => document.getElementById(id);

const canvas = $('board');
const ctx = canvas.getContext('2d');
const overlay = $('overlay');
const overlayTitle = $('overlay-title');
const overlayText = $('overlay-text');
const overlayKeys = $('overlay-keys');
const scoreEl = $('score');

let game = createGame();

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

function renderOverlay() {
  overlayTitle.textContent = '贪吃蛇';
  overlayText.textContent = '方向键控制 · 吃满 5 个提速';
  overlayKeys.textContent = '回车(或点这里)开始 · 空格 返回首页';
}

scoreEl.textContent = String(game.score);
renderOverlay();
resize();
window.addEventListener('resize', resize);
