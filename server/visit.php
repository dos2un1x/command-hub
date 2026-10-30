<?php
declare(strict_types=1);

/**
 * 站点访问计数接口(虚拟主机 / 独立服务器通用)。
 *
 * 部署：
 *   - 虚拟主机：把本文件放到站点根目录 api/visit.php，旁边放 config.php(MySQL)。
 *   - 独立服务器：放 webroot 外，nginx 用 location = /api/visit.php 映射；默认 SQLite。
 *
 * 配置(可选 config.php，或用 VISITS_CONFIG 指定路径):
 *   return [
 *     'driver' => 'mysql',                       // 默认 sqlite
 *     'dsn' => 'mysql:host=...;dbname=...;charset=utf8mb4',
 *     'user' => '...',
 *     'pass' => '...',
 *     'rate_limit' => 120,                       // 每分钟每 IP 上限；0 关闭
 *     'sqlite_path' => __DIR__ . '/data/visits.sqlite',
 *   ];
 *
 * 口径：
 *   - 所有部署（GitHub Pages、任意域名）统一请求 https://www.dos2unix.cn/api/visit.php
 *   - GET /api/visit.php?stats=1 只读返回统计，不计数（DNT 访客用）
 *   - 只统计页面脚本主动上报的访问（爬虫 UA、空 UA 不计）
 *   - PV = 上报次数；UV = 当日去重访客（优先 client id，回退 IP 哈希）
 *   - 不存原始 IP / UA / URL，只存按天加盐的 SHA-256
 */

define('VISITS_APP', true);

date_default_timezone_set('Asia/Shanghai');
ini_set('display_errors', '0');
ini_set('log_errors', '1');

header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store, max-age=0');
// 所有部署（GitHub Pages、任意域名）统一请求主站；公开聚合数据，无 Cookie/凭证。
header('Access-Control-Allow-Origin: *');

const BOT_PATTERN = '/bot\b|crawler|spider|slurp|scraper|baiduspider|yisouspider|bytespider|petalbot|sogou|360spider|yandex|semrush|ahrefs|mj12bot|dotbot|facebookexternalhit|twitterbot|telegrambot|discordbot|whatsapp|headlesschrome|lighthouse|pagespeed|pingdom|statuscake|uptime|zabbix|nagios|curl\/|wget\/|python-requests|go-http-client|okhttp|java\/|libwww|axios\/|node-fetch|undici|^node$/i';

function respond(int $status, ?array $body = null): void
{
    http_response_code($status);
    if ($status === 405) {
        header('Allow: POST');
    }
    if ($body !== null) {
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }
    exit;
}

function loadConfig(): array
{
    $envPath = getenv('VISITS_CONFIG');
    $path = ($envPath !== false && $envPath !== '') ? $envPath : __DIR__ . '/config.php';
    if (!is_file($path)) {
        if ($envPath !== false && $envPath !== '') {
            throw new RuntimeException('config not found: ' . $path);
        }
        return [];
    }
    $config = require $path;
    return is_array($config) ? $config : [];
}

/** @return array{0: PDO, 1: string} */
function connect(array $config): array
{
    $driver = (($config['driver'] ?? 'sqlite') === 'mysql') ? 'mysql' : 'sqlite';

    if ($driver === 'mysql') {
        $dsn = $config['dsn'] ?? '';
        $user = $config['user'] ?? '';
        $pass = $config['pass'] ?? '';
        if (!is_string($dsn) || $dsn === '' || !is_string($user) || $user === '') {
            throw new RuntimeException('MySQL config missing dsn/user');
        }
        $pdo = new PDO($dsn, $user, (string) $pass, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_TIMEOUT => 5,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
        return [$pdo, 'mysql'];
    }

    $dbPath = $config['sqlite_path'] ?? getenv('VISITS_DB');
    if (!is_string($dbPath) || $dbPath === '') {
        $dbPath = __DIR__ . '/data/visits.sqlite';
    }
    $dbDir = dirname($dbPath);
    if (!is_dir($dbDir) && !mkdir($dbDir, 0770, true) && !is_dir($dbDir)) {
        throw new RuntimeException('cannot create data dir ' . $dbDir);
    }
    $pdo = new PDO('sqlite:' . $dbPath, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_TIMEOUT => 5,
    ]);
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA synchronous = NORMAL');
    $pdo->exec('PRAGMA busy_timeout = 5000');
    return [$pdo, 'sqlite'];
}

function tryExec(PDO $pdo, string $sql): void
{
    try {
        $pdo->exec($sql);
    } catch (Throwable $e) {
        // 只读/增删改用户可能没有 CREATE 权限；表已手动导入时不影响使用。
        error_log('visits schema: ' . $e->getMessage());
    }
}

function initSchema(PDO $pdo, string $driver): void
{
    if ($driver === 'mysql') {
        tryExec($pdo, 'CREATE TABLE IF NOT EXISTS daily_pv (day DATE NOT NULL PRIMARY KEY, pv INT UNSIGNED NOT NULL DEFAULT 0) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
        tryExec($pdo, 'CREATE TABLE IF NOT EXISTS daily_uv (day DATE NOT NULL, vid_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, PRIMARY KEY (day, vid_hash)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
        tryExec($pdo, 'CREATE TABLE IF NOT EXISTS visit_rate (ip_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, minute INT UNSIGNED NOT NULL, hits INT UNSIGNED NOT NULL DEFAULT 0, PRIMARY KEY (ip_hash, minute)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
        return;
    }

    tryExec($pdo, 'CREATE TABLE IF NOT EXISTS daily_pv (day TEXT PRIMARY KEY, pv INTEGER NOT NULL DEFAULT 0)');
    tryExec($pdo, 'CREATE TABLE IF NOT EXISTS daily_uv (day TEXT NOT NULL, vid_hash TEXT NOT NULL, PRIMARY KEY (day, vid_hash)) WITHOUT ROWID');
    tryExec($pdo, 'CREATE TABLE IF NOT EXISTS visit_rate (ip_hash TEXT NOT NULL, minute INTEGER NOT NULL, hits INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (ip_hash, minute)) WITHOUT ROWID');
}

function rateLimited(PDO $pdo, string $driver, string $ipHash, int $limit): bool
{
    if ($limit <= 0) return false;

    $minute = intdiv(time(), 60);
    if ($driver === 'mysql') {
        $pdo->prepare('INSERT INTO visit_rate (ip_hash, minute, hits) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE hits = hits + 1')
            ->execute([$ipHash, $minute]);
    } else {
        $pdo->prepare('INSERT INTO visit_rate (ip_hash, minute, hits) VALUES (?, ?, 1) ON CONFLICT(ip_hash, minute) DO UPDATE SET hits = hits + 1')
            ->execute([$ipHash, $minute]);
    }
    $stmt = $pdo->prepare('SELECT hits FROM visit_rate WHERE ip_hash = ? AND minute = ?');
    $stmt->execute([$ipHash, $minute]);
    $hits = (int) ($stmt->fetchColumn() ?: 0);

    if (random_int(1, 200) === 1) {
        try {
            $pdo->prepare('DELETE FROM visit_rate WHERE minute < ?')->execute([$minute - 60]);
        } catch (Throwable $e) {
            error_log('visits rate cleanup: ' . $e->getMessage());
        }
    }
    return $hits > $limit;
}

function recordVisit(PDO $pdo, string $driver, string $day, ?string $uvKey): void
{
    $pdo->beginTransaction();
    try {
        if ($driver === 'mysql') {
            $pdo->prepare('INSERT INTO daily_pv (day, pv) VALUES (?, 1) ON DUPLICATE KEY UPDATE pv = pv + 1')
                ->execute([$day]);
            if ($uvKey !== null) {
                $pdo->prepare('INSERT IGNORE INTO daily_uv (day, vid_hash) VALUES (?, ?)')
                    ->execute([$day, $uvKey]);
            }
        } else {
            $pdo->prepare('INSERT INTO daily_pv (day, pv) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET pv = pv + 1')
                ->execute([$day]);
            if ($uvKey !== null) {
                $pdo->prepare('INSERT OR IGNORE INTO daily_uv (day, vid_hash) VALUES (?, ?)')
                    ->execute([$day, $uvKey]);
            }
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
}

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
if (!preg_match('#/api/visit(?:\.php)?$#', $path)) {
    respond(404);
}
$method = $_SERVER['REQUEST_METHOD'] ?? '';
if ($method === 'OPTIONS') {
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    header('Access-Control-Max-Age: 86400');
    respond(204);
}

$readOnly = $method === 'GET' && ($_GET['stats'] ?? '') === '1';
if (!$readOnly && $method !== 'POST') {
    respond(405);
}

$day = date('Y-m-d');
$ip = '';
$uvKey = null;

if (!$readOnly) {
    $ua = $_SERVER['HTTP_USER_AGENT'] ?? '';
    if ($ua === '' || preg_match(BOT_PATTERN, $ua) === 1) {
        respond(204);
    }

    $raw = file_get_contents('php://input');
    if ($raw === false || strlen($raw) > 4096) {
        respond(400, ['error' => 'bad request']);
    }
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        respond(400, ['error' => 'bad request']);
    }

    $vid = $data['vid'] ?? '';
    if (!is_string($vid) || preg_match('/^[A-Za-z0-9_-]{8,64}$/', $vid) !== 1) {
        $vid = '';
    }

    $ip = $_SERVER['REMOTE_ADDR'] ?? '';
    $uvKey = $vid !== ''
        ? hash('sha256', $day . '|id:' . $vid)
        : ($ip !== '' ? hash('sha256', $day . '|ip:' . $ip) : null);
}

try {
    $config = loadConfig();
    $rateLimit = max(0, (int) ($config['rate_limit'] ?? 120));
    [$pdo, $driver] = connect($config);
    initSchema($pdo, $driver);

    if (!$readOnly) {
        if ($ip !== '') {
            $ipHash = hash('sha256', 'rate|' . $ip);
            if (rateLimited($pdo, $driver, $ipHash, $rateLimit)) {
                respond(204);
            }
        }

        recordVisit($pdo, $driver, $day, $uvKey);
    }

    $start = date('Y-m-d', strtotime('-6 days'));
    $pvStmt = $pdo->prepare('SELECT day, pv FROM daily_pv WHERE day >= ? AND day <= ?');
    $pvStmt->execute([$start, $day]);
    $pv = [];
    foreach ($pvStmt as $row) {
        $pv[(string) $row['day']] = (int) $row['pv'];
    }

    $uvStmt = $pdo->prepare('SELECT day, COUNT(*) AS uv FROM daily_uv WHERE day >= ? AND day <= ? GROUP BY day');
    $uvStmt->execute([$start, $day]);
    $uv = [];
    foreach ($uvStmt as $row) {
        $uv[(string) $row['day']] = (int) $row['uv'];
    }

    $days = [];
    for ($i = 6; $i >= 0; $i--) {
        $d = date('Y-m-d', strtotime("-{$i} days"));
        $days[] = [
            'date' => $d,
            'pv' => $pv[$d] ?? 0,
            'uv' => $uv[$d] ?? 0,
        ];
    }
    $today = $days[6];

    // UV 明细只留 180 天，低频清理；清理失败不影响本次响应。
    try {
        if (random_int(1, 500) === 1) {
            $cutoff = date('Y-m-d', strtotime('-180 days'));
            $pdo->prepare('DELETE FROM daily_uv WHERE day < ?')->execute([$cutoff]);
        }
    } catch (Throwable $e) {
        error_log('visits cleanup: ' . $e->getMessage());
    }

    respond(200, [
        'today' => ['pv' => $today['pv'], 'uv' => $today['uv']],
        'days' => $days,
        'updated' => date('H:i'),
    ]);
} catch (Throwable $e) {
    error_log('visits: ' . $e->getMessage());
    if (isset($pdo) && $pdo instanceof PDO && $pdo->inTransaction()) {
        $pdo->rollBack();
    }
    respond(503, ['error' => 'unavailable']);
}
