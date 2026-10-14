/**
 * 俄罗斯方块核心逻辑:纯函数 + 可变状态对象,不碰 DOM / canvas / 定时器。
 *
 * 坐标约定:x 向右,y 向下;方块的 4 个旋转态预先展开成 4 组格坐标(相对各自包围盒)。
 * SRS 偏移表按屏幕坐标(y 向下)书写 —— 上游资料是 y 向上,已整体翻转,勿再翻。
 */

export const COLS = 10;
export const ROWS = 20;
export const LINES_PER_LEVEL = 10;
export const MAX_LEVEL = 20;
export const SOFT_DROP_MS = 40;
export const LOCK_DELAY_MS = 500;
export const LOCK_RESET_LIMIT = 15;
export const CLEAR_FLASH_MS = 120;
export const MIN_GRAVITY_MS = 60;

export const TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
const LINE_SCORES = [0, 100, 300, 500, 800];
const SPAWN_X = 3;

/** 每个方块 4 个旋转态(0=初始,1=顺时针,2=180°,3=逆时针),每态 4 格 */
export const PIECES = {
  I: [
    [[0, 1], [1, 1], [2, 1], [3, 1]],
    [[2, 0], [2, 1], [2, 2], [2, 3]],
    [[0, 2], [1, 2], [2, 2], [3, 2]],
    [[1, 0], [1, 1], [1, 2], [1, 3]],
  ],
  O: [
    [[1, 0], [2, 0], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [2, 1]],
  ],
  T: [
    [[1, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [2, 1], [1, 2]],
    [[0, 1], [1, 1], [2, 1], [1, 2]],
    [[1, 0], [0, 1], [1, 1], [1, 2]],
  ],
  S: [
    [[1, 0], [2, 0], [0, 1], [1, 1]],
    [[1, 0], [1, 1], [2, 1], [2, 2]],
    [[2, 1], [1, 1], [0, 2], [1, 2]],
    [[0, 0], [0, 1], [1, 1], [1, 2]],
  ],
  Z: [
    [[0, 0], [1, 0], [1, 1], [2, 1]],
    [[2, 0], [2, 1], [1, 1], [1, 2]],
    [[2, 2], [1, 2], [1, 1], [0, 1]],
    [[0, 2], [0, 1], [1, 1], [1, 0]],
  ],
  J: [
    [[0, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [1, 2]],
    [[0, 1], [1, 1], [2, 1], [2, 2]],
    [[1, 0], [1, 1], [0, 2], [1, 2]],
  ],
  L: [
    [[2, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [1, 2], [2, 2]],
    [[0, 1], [1, 1], [2, 1], [0, 2]],
    [[0, 0], [1, 0], [0, 1], [0, 2]],
  ],
};

export function createGame({ rng = Math.random } = {}) {
  const state = {
    cols: COLS,
    rows: ROWS,
    rng,
    grid: Array.from({ length: ROWS }, () => Array(COLS).fill(0)),
    bag: [],
    queue: [],
    current: null,
    hold: null,
    holdUsed: false,
    score: 0,
    lines: 0,
    level: 1,
    phase: 'playing',
    gravityAcc: 0,
    softDrop: false,
    lockTimer: 0,
    lockResets: 0,
    clearRows: [],
    clearTimer: 0,
  };
  state.queue.push(nextType(state), nextType(state));
  spawn(state);
  return state;
}

/** 从袋中取一个方块;袋空先补满一袋(7 个全排列) */
export function nextType(state) {
  if (!state.bag.length) {
    const bag = [...TYPES];
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(state.rng() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    state.bag = bag;
  }
  return state.bag.pop();
}

/** SRS 踢墙偏移(屏幕坐标,y 向下),键为 "起态>止态" */
export const KICKS_JLSTZ = {
  '0>1': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '1>0': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '1>2': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '2>1': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '2>3': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '3>2': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '3>0': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '0>3': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
};

export const KICKS_I = {
  '0>1': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  '1>0': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  '1>2': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
  '2>1': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  '2>3': [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  '3>2': [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  '3>0': [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  '0>3': [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
};

function collides(state, type, rot, x, y) {
  for (const [cx, cy] of PIECES[type][rot]) {
    const gx = x + cx;
    const gy = y + cy;
    if (gx < 0 || gx >= state.cols || gy < 0 || gy >= state.rows) return true;
    if (state.grid[gy][gx]) return true;
  }
  return false;
}

export function move(state, dx) {
  if (state.phase !== 'playing' || !state.current) return false;
  const c = state.current;
  if (collides(state, c.type, c.rot, c.x + dx, c.y)) return false;
  c.x += dx;
  resetLockIfGrounded(state);
  return true;
}

export function rotate(state, dir) {
  if (state.phase !== 'playing' || !state.current) return false;
  const c = state.current;
  const from = c.rot;
  const to = (from + dir + 4) % 4;
  const table = c.type === 'I' ? KICKS_I : KICKS_JLSTZ;
  for (const [ox, oy] of table[`${from}>${to}`]) {
    if (!collides(state, c.type, to, c.x + ox, c.y + oy)) {
      c.rot = to;
      c.x += ox;
      c.y += oy;
      resetLockIfGrounded(state);
      return true;
    }
  }
  return false;
}

function place(state, type) {
  state.current = { type, rot: 0, x: SPAWN_X, y: 0 };
  state.gravityAcc = 0;
  state.lockTimer = 0;
  state.lockResets = 0;
  if (collides(state, type, 0, SPAWN_X, 0)) state.phase = 'over';   // 顶出
}

function spawn(state) {
  state.holdUsed = false;
  place(state, state.queue.shift());
  state.queue.push(nextType(state));
}

/** 官方重力公式:每格毫秒数,下限 60 */
export function gravityMsFor(level) {
  const l = Math.max(1, Math.min(MAX_LEVEL, level));
  const sec = Math.pow(0.8 - (l - 1) * 0.007, l - 1);
  return Math.max(MIN_GRAVITY_MS, sec * 1000);
}

function canMoveDown(state) {
  const c = state.current;
  return !collides(state, c.type, c.rot, c.x, c.y + 1);
}

/** 软降一格(触屏 ▼ 轻点);成功 +1 分 */
export function softDropStep(state) {
  if (state.phase !== 'playing' || !state.current) return false;
  if (!canMoveDown(state)) return false;
  state.current.y += 1;
  state.score += 1;
  state.gravityAcc = 0;
  return true;
}

/** 着地状态下成功移动/旋转会重置锁定计时,累计上限 15 次 */
function resetLockIfGrounded(state) {
  if (!canMoveDown(state) && state.lockResets < LOCK_RESET_LIMIT) {
    state.lockTimer = 0;
    state.lockResets += 1;
  }
}

function lockNow(state) {
  const { type, rot, x, y } = state.current;
  for (const [cx, cy] of PIECES[type][rot]) state.grid[y + cy][x + cx] = type;
  state.current = null;
  state.gravityAcc = 0;
  state.lockTimer = 0;
  state.lockResets = 0;
  spawn(state);
}

export function tick(state, dtMs) {
  if (state.phase === 'over') return {};
  const interval = state.softDrop ? SOFT_DROP_MS : gravityMsFor(state.level);
  state.gravityAcc += dtMs;
  while (state.gravityAcc >= interval) {
    state.gravityAcc -= interval;
    if (canMoveDown(state)) {
      state.current.y += 1;
      if (state.softDrop) state.score += 1;
    } else {
      state.gravityAcc = 0;   // 到底:不把时间存起来
      break;
    }
  }
  if (canMoveDown(state)) {
    state.lockTimer = 0;
  } else {
    state.lockTimer += dtMs;
    if (state.lockTimer >= LOCK_DELAY_MS) {
      lockNow(state);
      return { locked: true, over: state.phase === 'over' };
    }
  }
  return {};
}
