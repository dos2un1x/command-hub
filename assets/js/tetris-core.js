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
  return true;
}

function place(state, type) {
  state.current = { type, rot: 0, x: SPAWN_X, y: 0 };
  state.gravityAcc = 0;
  state.lockTimer = 0;
  state.lockResets = 0;
}

function spawn(state) {
  state.holdUsed = false;
  place(state, state.queue.shift());
  state.queue.push(nextType(state));
}
