import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGame, nextType, move, rotate,
  gravityMsFor, softDropStep, tick, ghostY, hardDrop,
  COLS, ROWS, TYPES, PIECES, MAX_LEVEL, MIN_GRAVITY_MS, LOCK_RESET_LIMIT,
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

test('旋转:同向转 4 次回原位(T/I/O)', () => {
  for (const type of ['T', 'I', 'O']) {
    const g = createGame({ rng: seededRng(5) });
    g.current = { type, rot: 0, x: 3, y: 8 };
    const start = { x: g.current.x, y: g.current.y };
    for (let i = 0; i < 4; i++) assert.equal(rotate(g, 1), true);
    assert.equal(g.current.rot, 0);
    assert.deepEqual({ x: g.current.x, y: g.current.y }, start);
  }
});

test('SRS:贴左墙的 T 逆时针旋转被踢回(x -1 → 0)', () => {
  const g = createGame({ rng: seededRng(6) });
  g.current = { type: 'T', rot: 1, x: -1, y: 5 };   // 竖直态、贴左墙
  assert.equal(rotate(g, -1), true);
  assert.equal(g.current.rot, 0);
  assert.equal(g.current.x, 0);
  assert.equal(g.current.y, 5);
});

test('SRS:贴左墙的 I 顺时针转回来踢 +2(x -2 → 0)', () => {
  const g = createGame({ rng: seededRng(7) });
  g.current = { type: 'I', rot: 1, x: -2, y: 5 };   // 竖直态、贴左墙
  assert.equal(rotate(g, -1), true);
  assert.equal(g.current.rot, 0);
  assert.equal(g.current.x, 0);
});

test('SRS:地面上的 T 顺时针旋转被踢起(y 18 → 17,x 3 → 2)', () => {
  const g = createGame({ rng: seededRng(8) });
  g.current = { type: 'T', rot: 0, x: 3, y: 18 };   // 已贴底
  assert.equal(rotate(g, 1), true);
  assert.equal(g.current.rot, 1);
  assert.equal(g.current.x, 2);
  assert.equal(g.current.y, 17);
});

test('旋转:所有踢法都撞时返回 false 且状态不变', () => {
  const g = createGame({ rng: seededRng(9) });
  g.current = { type: 'T', rot: 0, x: 0, y: 0 };
  // T 在左上角,下方铺 2×2 障碍,封死 '0>1' 的四种可行踢法((-1,-1) 出界本就不可行):
  // (0,0) 撞 (1,2)、(-1,0) 撞 (0,2)、(0,+2) 撞 (1,3)、(-1,+2) 撞 (0,3)
  g.grid[2][0] = 'I';
  g.grid[2][1] = 'I';
  g.grid[3][0] = 'I';
  g.grid[3][1] = 'I';
  assert.equal(rotate(g, 1), false);
  assert.deepEqual(g.current, { type: 'T', rot: 0, x: 0, y: 0 });
});

test('速度曲线:1 级 1000ms、递减、下限 60ms', () => {
  assert.equal(gravityMsFor(1), 1000);
  assert.ok(Math.abs(gravityMsFor(2) - 793) < 1);
  let prev = Infinity;
  for (let l = 1; l <= MAX_LEVEL; l++) {
    const gm = gravityMsFor(l);
    assert.ok(gm <= prev, `等级 ${l} 不慢于上一级`);
    assert.ok(gm >= MIN_GRAVITY_MS);
    prev = gm;
  }
  assert.equal(gravityMsFor(MAX_LEVEL), MIN_GRAVITY_MS);
});

test('重力:按等级间隔下落,不足不动', () => {
  const g = createGame({ rng: seededRng(10) });
  g.current = { type: 'T', rot: 0, x: 3, y: 0 };
  tick(g, 400);
  tick(g, 400);
  assert.equal(g.current.y, 0);      // 共 800ms 不足 1000ms
  tick(g, 200);
  assert.equal(g.current.y, 1);      // 累计 1000ms
});

test('软降:40ms/格并且每格 +1 分', () => {
  const g = createGame({ rng: seededRng(11) });
  g.current = { type: 'T', rot: 0, x: 3, y: 0 };
  g.softDrop = true;
  tick(g, 40);
  assert.equal(g.current.y, 1);
  assert.equal(g.score, 1);
  tick(g, 40);
  assert.equal(g.current.y, 2);
  assert.equal(g.score, 2);
});

test('软降步进与到底停止', () => {
  const g = createGame({ rng: seededRng(12) });
  g.current = { type: 'T', rot: 0, x: 3, y: 17 };   // 初始态占两行,y=17 时底边到 18
  assert.equal(softDropStep(g), true);
  assert.equal(g.current.y, 18);                    // 到底
  assert.equal(g.score, 1);
  assert.equal(softDropStep(g), false);             // 不能再落
  assert.equal(g.score, 1);
  g.softDrop = true;
  tick(g, 100);                                     // 已到底:重力时间清零(不足锁定延迟,不会锁)
  assert.equal(g.current.y, 18);
  assert.equal(g.score, 1);
  assert.equal(g.gravityAcc, 0);
});

test('锁定延迟:落地 500ms 才锁,锁后写入棋盘并生成下一块', () => {
  const g = createGame({ rng: seededRng(13) });
  const next = g.queue[0];
  g.current = { type: 'T', rot: 0, x: 3, y: 18 };   // 已贴底
  tick(g, 499);
  assert.equal(g.grid[19][4], 0);                    // 未锁
  assert.ok(g.current);
  tick(g, 1);
  assert.equal(g.grid[19][4], 'T');                  // 锁定写入 (4,19)
  assert.equal(g.grid[19][3], 'T');
  assert.equal(g.grid[19][5], 'T');
  assert.equal(g.grid[18][4], 'T');
  assert.equal(g.current.type, next);                // 下一块已生成
  assert.deepEqual({ x: g.current.x, y: g.current.y, rot: g.current.rot }, { x: 3, y: 0, rot: 0 });
});

test('锁定重置:着地后移动会重置计时,上限 15 次', () => {
  const g = createGame({ rng: seededRng(14) });
  g.current = { type: 'T', rot: 0, x: 3, y: 18 };
  tick(g, 300);
  assert.equal(move(g, -1), true);
  assert.equal(g.lockTimer, 0);                      // 被重置
  assert.equal(g.lockResets, 1);
  tick(g, 300);
  assert.equal(g.grid[19][3], 0);                    // 未锁
  // 用满 15 次重置
  while (g.lockResets < LOCK_RESET_LIMIT) {
    const dx = g.lockResets % 2 ? 1 : -1;
    assert.equal(move(g, dx), true);
  }
  tick(g, 400);
  assert.equal(move(g, 1) === true || move(g, -1) === true, true);   // 移动仍可
  assert.equal(g.lockTimer, 400);                    // 但不再重置
  tick(g, 100);
  assert.ok(g.grid[19].includes('T'));               // 已锁定
});

test('顶出:生成位置被占 → over,之后一切操作无效', () => {
  const g = createGame({ rng: seededRng(15) });
  // 顶两行铺满但留出第 0 列:满行会变成"消行"而非"顶出",必须避免
  for (let x = 1; x < COLS; x++) {
    g.grid[0][x] = 'I';
    g.grid[1][x] = 'I';
  }
  g.current = { type: 'T', rot: 0, x: 3, y: 18 };
  tick(g, 500);
  assert.equal(g.phase, 'over');
  const snapshot = JSON.stringify({ grid: g.grid, cur: g.current });
  assert.equal(move(g, -1), false);
  assert.equal(rotate(g, 1), false);
  assert.equal(softDropStep(g), false);
  assert.deepEqual(tick(g, 1000), {});
  assert.equal(g.phase, 'over');
  assert.equal(JSON.stringify({ grid: g.grid, cur: g.current }), snapshot);
});

/** 把某行填满,跳过 exceptCols 指定的列 */
function fillRow(g, y, exceptCols = []) {
  for (let x = 0; x < COLS; x++) if (!exceptCols.includes(x)) g.grid[y][x] = 'J';
}

test('消行:单行移除,上方整体下移', () => {
  const g = createGame({ rng: seededRng(16) });
  fillRow(g, 19, [5]);
  g.grid[18][3] = 'L';                              // 记号:应随下移落到 19 行
  g.current = { type: 'I', rot: 1, x: 3, y: 16 };   // 竖直 I,占第 5 列 16..19 行
  tick(g, 500);                                     // 锁定 → 满行 → clearing
  assert.equal(g.phase, 'clearing');
  assert.deepEqual(g.clearRows, [19]);
  tick(g, 60);
  assert.equal(g.phase, 'clearing');                // 120ms 未到
  tick(g, 60);
  assert.equal(g.phase, 'playing');
  assert.equal(g.lines, 1);
  assert.equal(g.score, 100);
  assert.equal(g.grid[19][3], 'L');                 // 记号下移一行
  assert.equal(g.grid[19][5], 'I');                 // 原 18 行的 I 也下移一行
  assert.equal(g.grid[18][5], 'I');                 // 原 17 行 → 18 行
});

test('消行:四行(tetris)一次清 800 分', () => {
  const g = createGame({ rng: seededRng(17) });
  for (let y = 16; y <= 19; y++) fillRow(g, y, [5]);
  g.current = { type: 'I', rot: 1, x: 3, y: 16 };
  tick(g, 500);
  assert.deepEqual(g.clearRows, [16, 17, 18, 19]);
  tick(g, 120);
  assert.equal(g.lines, 4);
  assert.equal(g.score, 800);
  assert.equal(g.level, 1);
});

test('消行:多行清除时中间夹非满行正确下移', () => {
  const g = createGame({ rng: seededRng(18) });
  fillRow(g, 17, [5]);
  fillRow(g, 19, [5]);
  g.grid[18][2] = 'S';                              // 17 与 19 被清,18 行下移
  g.current = { type: 'I', rot: 1, x: 3, y: 16 };
  tick(g, 500);
  assert.deepEqual(g.clearRows, [17, 19]);
  tick(g, 120);
  assert.equal(g.lines, 2);
  assert.equal(g.score, 300);
  assert.equal(g.grid[19][2], 'S');                 // 原 18 行 → 19 行
});

test('消行:计分乘当前等级;每 10 行升级、上限 20', () => {
  const g = createGame({ rng: seededRng(19) });
  g.level = 3;
  fillRow(g, 19, [5]);
  g.current = { type: 'I', rot: 1, x: 3, y: 16 };
  tick(g, 500);
  tick(g, 120);
  assert.equal(g.score, 300);                       // 100 × 3

  const g2 = createGame({ rng: seededRng(20) });
  g2.lines = 9;
  fillRow(g2, 19, [5]);
  g2.current = { type: 'I', rot: 1, x: 3, y: 16 };
  tick(g2, 500);
  const ev = tick(g2, 120);
  assert.equal(g2.lines, 10);
  assert.equal(g2.level, 2);
  assert.equal(ev.levelUp, true);

  const g3 = createGame({ rng: seededRng(21) });
  g3.lines = 195;
  g3.level = 20;
  for (let y = 16; y <= 19; y++) fillRow(g3, y, [5]);
  g3.current = { type: 'I', rot: 1, x: 3, y: 16 };
  tick(g3, 500);
  tick(g3, 120);
  assert.equal(g3.lines, 199);
  assert.equal(g3.level, 20);                       // 不越上限
});

test('闪烁阶段:输入无效,到期才消除并生成下一块', () => {
  const g = createGame({ rng: seededRng(22) });
  const next = g.queue[0];
  fillRow(g, 19, [5]);
  g.current = { type: 'I', rot: 1, x: 3, y: 16 };
  tick(g, 500);
  assert.equal(g.phase, 'clearing');
  assert.equal(g.current, null);
  assert.equal(move(g, -1), false);
  assert.equal(rotate(g, 1), false);
  assert.equal(softDropStep(g), false);
  tick(g, 120);
  assert.equal(g.phase, 'playing');
  assert.equal(g.current.type, next);
  assert.equal(g.queue.length, 2);
});

test('幽灵落点 = 硬降落点,且硬降立即锁定并 +2 分/格', () => {
  const g = createGame({ rng: seededRng(23) });
  g.current = { type: 'T', rot: 0, x: 3, y: 0 };
  assert.equal(ghostY(g), 18);
  assert.equal(hardDrop(g), true);
  assert.equal(g.grid[19][4], 'T');                 // 落在底部
  assert.equal(g.score, 36);                        // 18 格 × 2
  assert.ok(g.current);                             // 已生成下一块(立即锁定)
  assert.equal(g.current.y, 0);
});

test('幽灵落点:堆叠上方正确停住', () => {
  const g = createGame({ rng: seededRng(24) });
  g.current = { type: 'T', rot: 0, x: 3, y: 0 };
  g.grid[19][4] = 'I';                              // 挡住中间列
  assert.equal(ghostY(g), 17);
  assert.equal(hardDrop(g), true);
  assert.equal(g.grid[18][4], 'T');
  assert.equal(g.score, 34);                        // 17 格 × 2
});

test('硬降:结束后无效', () => {
  const g = createGame({ rng: seededRng(25) });
  g.phase = 'over';
  assert.equal(hardDrop(g), false);
});
