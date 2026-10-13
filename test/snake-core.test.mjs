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
