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

    // 访客/IP 哈希密钥：填 `openssl rand -hex 32` 的输出，只放服务器。
    // 留空则退回普通 SHA-256（数据库被拖走时 IP 可被枚举，不推荐）。
    'secret' => '',

    // 允许写入计数的域名（Origin 精确匹配）；只读展示不受此限制。
    // 新增域名在这里加一行即可，不需要改代码；GitHub Pages 镜像默认已包含。
    'allowed_origins' => [
        'https://www.dos2unix.cn',
        'https://dos2unix.cn',
        'http://www.dos2unix.cn',
        'http://dos2unix.cn',
        'https://dos2un1x.github.io',
    ],

    // SQLite 仅建议独立服务器使用；虚拟主机不要把 .sqlite 放 webroot。
    // 'driver' => 'sqlite',
    // 'sqlite_path' => __DIR__ . '/data/visits.sqlite',
];
