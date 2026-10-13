import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, COLS, ROWS, DIRS } from '../assets/js/snake-core.js';

// 确定性 rng:永远选空格列表的第一格
const firstCell = () => 0;

test('初始状态:蛇长 3、居中、朝右、0 分、未结束', () => {
  const g = createGame({ rng: firstCell });
  assert.equal(g.snake.length, 3);
  assert.deepEqual(g.snake[0], { x: Math.floor(COLS / 2), y: Math.floor(ROWS / 2) });
  assert.deepEqual(g.snake[1], { x: Math.floor(COLS / 2) - 1, y: Math.floor(ROWS / 2) });
  assert.deepEqual(g.snake[2], { x: Math.floor(COLS / 2) - 2, y: Math.floor(ROWS / 2) });
  assert.deepEqual(g.dir, DIRS.right);
  assert.equal(g.score, 0);
  assert.equal(g.over, false);
  assert.equal(g.reason, null);
  assert.deepEqual(g.pendingDirs, []);
});

test('初始食物落在棋盘内,且不在蛇身上', () => {
  const g = createGame({ rng: firstCell });
  assert.ok(g.food, '初始就应有食物(未开始界面要能看到)');
  assert.ok(g.food.x >= 0 && g.food.x < COLS);
  assert.ok(g.food.y >= 0 && g.food.y < ROWS);
  assert.ok(!g.snake.some((s) => s.x === g.food.x && s.y === g.food.y));
});

import { turn } from '../assets/js/snake-core.js';

test('转向:禁止 180° 掉头', () => {
  const g = createGame({ rng: firstCell }); // 朝右
  assert.equal(turn(g, DIRS.left), false);
  assert.deepEqual(g.pendingDirs, []);
});

test('转向:与当前方向相同则忽略', () => {
  const g = createGame({ rng: firstCell });
  assert.equal(turn(g, DIRS.right), false);
  assert.deepEqual(g.pendingDirs, []);
});

test('转向:队列上限 2,第三次被忽略(长按 auto-repeat 不会撑爆队列)', () => {
  const g = createGame({ rng: firstCell }); // 朝右
  assert.equal(turn(g, DIRS.up), true);
  assert.equal(turn(g, DIRS.left), true);
  assert.equal(turn(g, DIRS.down), false); // 队列已满
  assert.deepEqual(g.pendingDirs, [DIRS.up, DIRS.left]);
});

test('转向:相对「队尾方向」判定,同一帧连按 ↑← 都合法', () => {
  const g = createGame({ rng: firstCell }); // 朝右
  assert.equal(turn(g, DIRS.up), true);
  // 若按「当前方向(右)」判定,left 会被误判成掉头而丢弃
  assert.equal(turn(g, DIRS.left), true);
});

import { step, POINTS_PER_FOOD } from '../assets/js/snake-core.js';

/** 手搓一个局面,只填本用例关心的字段 */
function makeState({ snake, dir = DIRS.right, food = { x: 0, y: 0 }, cols = 20, rows = 20, score = 0 }) {
  return { cols, rows, snake, dir, pendingDirs: [], food, score, over: false, reason: null, rng: firstCell };
}

test('推进:不吃食物时头进尾出,长度不变', () => {
  const g = makeState({ snake: [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }], food: { x: 0, y: 0 } });
  const r = step(g);
  assert.deepEqual(r, { ate: false, ended: null });
  assert.equal(g.snake.length, 3);
  assert.deepEqual(g.snake[0], { x: 6, y: 5 });
  assert.deepEqual(g.snake[2], { x: 4, y: 5 });
});

test('推进:吃掉食物变长、加分,新食物不在蛇身上', () => {
  const g = makeState({ snake: [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }], food: { x: 6, y: 5 } });
  const r = step(g);
  assert.equal(r.ate, true);
  assert.equal(g.snake.length, 4);
  assert.equal(g.score, POINTS_PER_FOOD);
  assert.ok(!g.snake.some((s) => s.x === g.food.x && s.y === g.food.y));
});

test('推进:同一 tick 消费一个排队方向', () => {
  const g = makeState({ snake: [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }] });
  turn(g, DIRS.up);
  turn(g, DIRS.left);
  step(g);
  assert.deepEqual(g.snake[0], { x: 5, y: 4 });   // 先上
  step(g);
  assert.deepEqual(g.snake[0], { x: 4, y: 4 });   // 再左
  assert.deepEqual(g.pendingDirs, []);
});

test('推进:尾巴豁免 —— 不吃食物时头进入原尾格不算碰撞', () => {
  // 2×2 的回环:头 (1,1) 向右进 (2,1),而 (2,1) 正是尾格,本 tick 会移走
  const g = makeState({
    snake: [{ x: 1, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 1 }],
    dir: DIRS.right,
    food: { x: 0, y: 0 },
  });
  const r = step(g);
  assert.deepEqual(r, { ate: false, ended: null });
  assert.deepEqual(g.snake[0], { x: 2, y: 1 });
  assert.equal(g.over, false);
});

test('结束:撞墙 —— 出界即结束、不移动、reason=wall', () => {
  const g = makeState({ snake: [{ x: 19, y: 10 }, { x: 18, y: 10 }, { x: 17, y: 10 }] });
  const r = step(g);
  assert.deepEqual(r, { ate: false, ended: 'wall' });
  assert.equal(g.over, true);
  assert.equal(g.reason, 'wall');
  assert.deepEqual(g.snake[0], { x: 19, y: 10 });
});

test('结束:撞自己 —— reason=self', () => {
  // 头 (5,5) 向下进 (5,6),而 (5,6) 是身体第二格(不是尾巴,不会移走)
  const g = makeState({
    snake: [{ x: 5, y: 5 }, { x: 5, y: 6 }, { x: 6, y: 6 }, { x: 6, y: 5 }, { x: 7, y: 5 }],
    dir: DIRS.down,
    food: { x: 0, y: 0 },
  });
  const r = step(g);
  assert.deepEqual(r, { ate: false, ended: 'self' });
  assert.equal(g.over, true);
  assert.equal(g.reason, 'self');
});

test('结束:结束后再 step 不改变局面', () => {
  const g = makeState({ snake: [{ x: 19, y: 10 }, { x: 18, y: 10 }, { x: 17, y: 10 }] });
  step(g);
  const before = JSON.stringify(g.snake);
  const r = step(g);
  assert.deepEqual(r, { ate: false, ended: 'wall' });
  assert.equal(JSON.stringify(g.snake), before);
});

test('胜利:吃掉最后一格空格后判定通关,food=null,不死循环', () => {
  // 2×2 棋盘:蛇占 3 格,唯一空格 (1,0) 放食物 → 吃掉即满盘
  const g = makeState({
    cols: 2,
    rows: 2,
    snake: [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
    dir: DIRS.right,
    food: { x: 1, y: 0 },
  });
  const r = step(g);
  assert.deepEqual(r, { ate: true, ended: 'win' });
  assert.equal(g.over, true);
  assert.equal(g.reason, 'win');
  assert.equal(g.food, null);
  assert.equal(g.snake.length, 4);
});

import { speedMsFor, BASE_SPEED_MS, MIN_SPEED_MS } from '../assets/js/snake-core.js';

test('速度:开局 150ms,每吃满 5 个减 12ms', () => {
  assert.equal(speedMsFor(0), BASE_SPEED_MS);          // 0 个
  assert.equal(speedMsFor(40), BASE_SPEED_MS);         // 4 个,还没到 5
  assert.equal(speedMsFor(50), BASE_SPEED_MS - 12);    // 5 个
  assert.equal(speedMsFor(100), BASE_SPEED_MS - 24);   // 10 个
});

test('速度:下限 70ms,不会无限加速', () => {
  assert.equal(speedMsFor(100000), MIN_SPEED_MS);
});
