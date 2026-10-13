/**
 * 贪吃蛇核心逻辑(纯逻辑:无 DOM、无 canvas、无定时器)
 *
 * 与渲染/输入分离,便于用 node:test 直接单测。
 * state 是普通对象,由 turn() / step() 原地修改。
 */

export const COLS = 20;
export const ROWS = 20;

export const POINTS_PER_FOOD = 10;
export const FOODS_PER_SPEEDUP = 5;
export const BASE_SPEED_MS = 150;
export const SPEED_STEP_MS = 12;
export const MIN_SPEED_MS = 70;

export const DIRS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const same = (a, b) => a.x === b.x && a.y === b.y;
const inSnake = (snake, cell) => snake.some((s) => same(s, cell));

/** 从空格中随机取一格;无空格(满盘)返回 null */
function spawnFood(state) {
  const free = [];
  for (let y = 0; y < state.rows; y++) {
    for (let x = 0; x < state.cols; x++) {
      if (!inSnake(state.snake, { x, y })) free.push({ x, y });
    }
  }
  if (!free.length) return null;
  return free[Math.floor(state.rng() * free.length)];
}

/** 新开一局:蛇长 3、居中、朝右 */
export function createGame({ cols = COLS, rows = ROWS, rng = Math.random } = {}) {
  const head = { x: Math.floor(cols / 2), y: Math.floor(rows / 2) };
  const state = {
    cols,
    rows,
    snake: [head, { x: head.x - 1, y: head.y }, { x: head.x - 2, y: head.y }],
    dir: { x: DIRS.right.x, y: DIRS.right.y },
    pendingDirs: [],
    food: null,
    score: 0,
    over: false,
    reason: null,
    rng,
  };
  state.food = spawnFood(state);
  return state;
}

/**
 * 入队一个转向。以下情况忽略:
 *  - 与「队尾方向」(没有队列时即当前方向)相同或相反(防 180° 掉头)
 *  - 队列已满(上限 2)
 * 返回是否被接受。
 */
export function turn(state, dir) {
  if (state.over) return false;
  const last = state.pendingDirs.length
    ? state.pendingDirs[state.pendingDirs.length - 1]
    : state.dir;
  if (same(dir, last)) return false;
  if (last.x + dir.x === 0 && last.y + dir.y === 0) return false;
  if (state.pendingDirs.length >= 2) return false;
  state.pendingDirs.push({ x: dir.x, y: dir.y });
  return true;
}
