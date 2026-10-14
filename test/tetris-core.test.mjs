import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, nextType, move, COLS, ROWS, TYPES, PIECES,
} from '../assets/js/tetris-core.js';

/** 确定性 rng(用于 7-bag 等需要可复现的测试) */
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('初始局面:空盘、当前块在顶部中央、队列有两块', () => {
  const g = createGame({ rng: seededRng(1) });
  assert.equal(g.cols, COLS);
  assert.equal(g.rows, ROWS);
  assert.equal(g.grid.length, ROWS);
  assert.ok(g.grid.every((row) => row.length === COLS && row.every((c) => c === 0)));
  assert.equal(g.score, 0);
  assert.equal(g.lines, 0);
  assert.equal(g.level, 1);
  assert.equal(g.phase, 'playing');
  assert.equal(g.hold, null);
  assert.equal(g.holdUsed, false);
  assert.ok(TYPES.includes(g.current.type));
  assert.deepEqual({ rot: g.current.rot, x: g.current.x, y: g.current.y }, { rot: 0, x: 3, y: 0 });
  assert.equal(g.queue.length, 2);
  assert.ok(g.queue.every((t) => TYPES.includes(t)));
});

test('7-bag:每袋 7 个是全排列,袋空自动补满', () => {
  const g = createGame({ rng: seededRng(2) });
  g.bag = [];                       // 清空以对齐袋边界
  const first = TYPES.map(() => nextType(g));
  assert.deepEqual([...first].sort(), [...TYPES].sort());
  const second = TYPES.map(() => nextType(g));   // 自动补的新一袋
  assert.deepEqual([...second].sort(), [...TYPES].sort());
});

test('生成位置:所有方块初始态都落在 3..6 列、0..1 行', () => {
  for (const type of TYPES) {
    for (const [cx, cy] of PIECES[type][0]) {
      assert.ok(cx + 3 >= 3 && cx + 3 <= 6, `${type} 列越界`);
      assert.ok(cy >= 0 && cy <= 1, `${type} 行越界`);
    }
  }
});

test('move:左右移动成功,撞墙失败且不改状态', () => {
  const g = createGame({ rng: seededRng(3) });
  g.current = { type: 'T', rot: 0, x: 3, y: 5 };
  assert.equal(move(g, -1), true);
  assert.equal(g.current.x, 2);
  assert.equal(move(g, 1), true);
  assert.equal(g.current.x, 3);
  while (move(g, -1)) { /* 一直移到不能移 */ }
  assert.equal(g.current.x, 0);
  assert.equal(move(g, -1), false);
  assert.equal(g.current.x, 0);
});

test('move:撞到已固定方块失败', () => {
  const g = createGame({ rng: seededRng(4) });
  g.current = { type: 'T', rot: 0, x: 3, y: 5 };
  g.grid[6][2] = 'I';       // T 左移一格后 (2,6) 被占
  assert.equal(move(g, -1), false);
  assert.equal(g.current.x, 3);
});
