import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// MySQL 集成测试依赖 Docker、mysql:8.0 和带 pdo_mysql 的 PHP 镜像。
// 构建 PHP 镜像: docker build -f test/php-mysql.Dockerfile -t command-hub-php-mysql:8.3 .
// 运行: VISITS_API_TEST=1 node --test test/visits-api-mysql.test.mjs
const RUN = process.env.VISITS_API_TEST === '1';
const PHP_IMAGE = process.env.PHP_MYSQL_IMAGE || 'command-hub-php-mysql:8.3';
const MYSQL_IMAGE = process.env.MYSQL_IMAGE || 'mysql:5.7';
const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 20000 + Math.floor(Math.random() * 10000);
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
  'visit.php (MySQL): PV/UV、7 天窗口、只读、CORS、405/400',
  { skip: !RUN && 'set VISITS_API_TEST=1 to run Docker integration test' },
  async (t) => {
    try {
      execFileSync('docker', ['image', 'inspect', PHP_IMAGE], { stdio: 'ignore' });
    } catch {
      throw new Error(
        `缺少 PHP 测试镜像 ${PHP_IMAGE};先运行 ` +
          'docker build -f test/php-mysql.Dockerfile -t command-hub-php-mysql:8.3 .'
      );
    }

    const stamp = `${process.pid}-${Date.now()}`;
    const net = `visits-net-${stamp}`;
    const mysqlName = `visits-mysql-${stamp}`;
    const phpName = `visits-php-${stamp}`;
    const configDir = mkdtempSync(path.join(tmpdir(), 'visits-mysql-'));
    writeFileSync(
      path.join(configDir, 'config.php'),
      `<?php
if (!defined('VISITS_APP')) { http_response_code(404); exit; }
return [
    'driver' => 'mysql',
    'dsn' => 'mysql:host=${mysqlName};port=3306;dbname=visits;charset=utf8mb4',
    'user' => 'visits',
    'pass' => 'visits',
    'rate_limit' => 120,
    'secret' => 'test-secret-for-hmac',
];
`
    );

    let phpStderr = '';
    t.after(() => {
      try {
        execFileSync('docker', ['rm', '-f', phpName], { stdio: 'ignore' });
      } catch {
        // 容器可能已经退出
      }
      try {
        execFileSync('docker', ['rm', '-f', mysqlName], { stdio: 'ignore' });
      } catch {
        // 容器可能已经退出
      }
      try {
        execFileSync('docker', ['network', 'rm', net], { stdio: 'ignore' });
      } catch {
        // 网络可能已经被清理
      }
      rmSync(configDir, { recursive: true, force: true });
    });

    execFileSync('docker', ['network', 'create', net], { stdio: 'pipe' });
    execFileSync(
      'docker',
      [
        'run', '-d', '--rm', '--name', mysqlName, '--network', net,
        '-e', 'MYSQL_ROOT_PASSWORD=root',
        '-e', 'MYSQL_DATABASE=visits',
        '-e', 'MYSQL_USER=visits',
        '-e', 'MYSQL_PASSWORD=visits',
        MYSQL_IMAGE,
      ],
      { stdio: 'pipe' }
    );

    let mysqlReady = false;
    for (let i = 0; i < 120; i++) {
      try {
        execFileSync(
          'docker',
          ['exec', mysqlName, 'mysqladmin', 'ping', '-h', '127.0.0.1', '-uroot', '-proot', '--silent'],
          { stdio: 'ignore' }
        );
        mysqlReady = true;
        break;
      } catch {
        // 初始化中
      }
      await sleep(500);
    }
    assert.ok(mysqlReady, 'MySQL 未就绪(等待 60s)');

    const php = spawn(
      'docker',
      [
        'run', '--rm', '--name', phpName, '--network', net,
        '-v', `${ROOT}:/app:ro`,
        '-v', `${configDir}:/config:ro`,
        '-e', 'VISITS_CONFIG=/config/config.php',
        '-p', `127.0.0.1:${PORT}:8088`,
        PHP_IMAGE,
        'php', '-S', '0.0.0.0:8088', '/app/server/visit.php',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    php.stderr.on('data', (buf) => {
      phpStderr += buf.toString();
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

    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (php.exitCode !== null) break;
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
    assert.ok(ready, `PHP server 未就绪。stderr:\n${phpStderr}`);

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
