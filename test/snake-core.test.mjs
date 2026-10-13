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
