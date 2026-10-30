# 集成测试用:官方 php:8.3-cli 默认不带 pdo_mysql/mysqli。
# 构建: docker build -f test/php-mysql.Dockerfile -t command-hub-php-mysql:8.3 .
FROM php:8.3-cli

RUN docker-php-ext-install -j"$(nproc)" pdo_mysql mysqli
