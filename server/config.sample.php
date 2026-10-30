<?php
/**
 * 访问统计接口配置示例。
 *
 * 虚拟主机：复制为同目录的 config.php，填写面板「数据库信息」里的
 * MySQL 5.7+ 主机、库名、用户名和密码。
 *
 * 独立服务器用 SQLite 时可以不需要本文件；需要改限流或路径时再复制。
 */
if (!defined('VISITS_APP')) {
    http_response_code(404);
    exit;
}

return [
    'driver' => 'mysql',
    'dsn' => 'mysql:host=localhost;port=3306;dbname=YOUR_DB;charset=utf8mb4',
    'user' => 'YOUR_USER',
    'pass' => 'YOUR_PASSWORD',

    // 每分钟每 IP 上限；0 关闭。主机前面有共享代理/WAF 时可调大或关闭。
    'rate_limit' => 120,

    // 用 SQLite 时改成：
    // 'driver' => 'sqlite',
    // 'sqlite_path' => __DIR__ . '/data/visits.sqlite',
];
