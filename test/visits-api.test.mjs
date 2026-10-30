import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// 集成测试依赖 Docker 与 php:8.3-cli 镜像;默认跳过,避免拖慢 npm test。
// 运行: VISITS_API_TEST=1 node --test test/visits-api.test.mjs
const RUN = process.env.VISITS_API_TEST === '1';
const IMAGE = process.env.PHP_IMAGE || 'php:8.3-cli';
const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 18000 + Math.floor(Math.random() * 10000);
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function shanghaiToday() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

test(
  'visit.php: PV/UV、7 天窗口、只读、CORS、405/400',
  { skip: !RUN && 'set VISITS_API_TEST=1 to run Docker integration test' },
  async (t) => {
    execFileSync(
      'docker',
      ['run', '--rm', '-v', `${ROOT}:/app:ro`, IMAGE, 'php', '-l', '/app/server/visit.php'],
      { stdio: 'pipe' }
    );

    const dataDir = mkdtempSync(path.join(tmpdir(), 'visits-api-'));
    const name = `visits-api-${process.pid}-${Date.now()}`;
    let stderr = '';
    const container = spawn(
      'docker',
      [
        'run', '--rm', '--name', name,
        '-v', `${ROOT}:/app:ro`,
        '-v', `${dataDir}:/data`,
        '-e', 'VISITS_DB=/data/visits.sqlite',
        '-p', `127.0.0.1:${PORT}:8088`,
        IMAGE,
        'php', '-S', '0.0.0.0:8088', '/app/server/visit.php',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    container.stderr.on('data', (buf) => {
      stderr += buf.toString();
    });

    t.after(() => {
      try {
        execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
      } catch {
        // 容器可能已经退出
      }
      rmSync(dataDir, { recursive: true, force: true });
    });

    const base = `http://127.0.0.1:${PORT}/api/visit.php`;
    const post = (body, headers = {}) =>
      fetch(base, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': UA,
          Origin: 'https://www.dos2unix.cn',
          ...headers,
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });

    // 等 PHP 内置服务器起来
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (container.exitCode !== null) break;
      try {
        const res = await fetch(base, { method: 'GET' });
        if (res.status === 405) {
          ready = true;
          break;
        }
      } catch {
        // 还没监听
      }
      await sleep(200);
    }
    assert.ok(ready, `PHP server 未就绪。stderr:\n${stderr}`);

    const vidA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const vidB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    const first = await post({ vid: vidA });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.deepEqual(firstBody.today, { pv: 1, uv: 1 });
    assert.equal(firstBody.days.length, 7);
    assert.equal(firstBody.days[6].date, shanghaiToday());
    assert.match(firstBody.updated, /^\d{2}:\d{2}$/);

    const second = await post({ vid: vidA });
    assert.deepEqual((await second.json()).today, { pv: 2, uv: 1 });

    const third = await post({ vid: vidB });
    assert.deepEqual((await third.json()).today, { pv: 3, uv: 2 });

    // 只读请求返回同样的数据，但不计数（DNT 访客用）
    const readOnly = await fetch(`${base}?stats=1`, { method: 'GET' });
    assert.equal(readOnly.status, 200);
    assert.equal(readOnly.headers.get('access-control-allow-origin'), '*');
    assert.deepEqual((await readOnly.json()).today, { pv: 3, uv: 2 });

    const badJson = await post('{');
    assert.equal(badJson.status, 400);

    const get = await fetch(base, { method: 'GET' });
    assert.equal(get.status, 405);

    // GitHub Pages 等白名单 POST 的预检
    const preflight = await fetch(base, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://dos2un1x.github.io',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://dos2un1x.github.io');
    assert.match(preflight.headers.get('access-control-allow-methods') || '', /POST/);

    // 非白名单预检被拒
    const blockedPreflight = await fetch(base, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    assert.equal(blockedPreflight.status, 403);
    assert.equal(blockedPreflight.headers.get('access-control-allow-origin'), null);

    const bot = await post({ vid: vidA }, { 'User-Agent': 'Mozilla/5.0 Baiduspider/2.0' });
    assert.equal(bot.status, 204);

    const noUa = await post({ vid: vidA }, { 'User-Agent': '' });
    assert.equal(noUa.status, 204);

    // 白名单来源正常计数（GitHub Pages 默认在列表里）
    const otherOrigin = await post({ vid: vidA }, { Origin: 'https://dos2un1x.github.io' });
    assert.equal(otherOrigin.status, 200);
    assert.equal(otherOrigin.headers.get('access-control-allow-origin'), 'https://dos2un1x.github.io');
    assert.deepEqual((await otherOrigin.json()).today, { pv: 4, uv: 2 });

    // 非白名单写入被拒且不计数
    const blocked = await post({ vid: vidB }, { Origin: 'https://evil.example' });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.headers.get('access-control-allow-origin'), null);

    // 被拒绝的请求不应计数
    const fourth = await post({ vid: vidB });
    assert.deepEqual((await fourth.json()).today, { pv: 5, uv: 2 });

    const sameSite = await post({ vid: vidA }, { Origin: 'https://www.dos2unix.cn' });
    assert.deepEqual((await sameSite.json()).today, { pv: 6, uv: 2 });
  }
);
