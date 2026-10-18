echo
===

输出参数并追加换行；Bash 内建与 /bin/echo 的行为并不完全一致。

## 补充说明

echo 把参数用空格连接后写到标准输出，通常追加一个换行。Bash 内建支持 `-n`（不换行）、`-e`（解释反斜杠转义）、`-E`（关闭转义，默认）；`/bin/echo` 的选项支持和默认行为随实现变化。

由于 `-n` 和转义是否默认开启没有统一标准，处理变量、用户输入或需要精确格式时应使用 `printf`；echo 更适合简单的人类可读输出。

### 常用示例

```shell
# 基本输出与不换行
echo "hello"
echo -n "loading..."; echo " done"

# Bash 内建用 -e 解释转义；$'...' 在解析阶段展开
echo -e 'a\tb\nc'
echo $'a\tb'

# 变量加引号，避免分词和通配符展开
file='a b.txt'; echo "$file"
```

## 易错点与排错

- `echo "$var"` 不做分词，`echo $var` 会；含空格、`*`、换行的值会被拆开或展开成文件名。
- Bash 内建的 `echo -- -n` 会把 `--` 也打印出来，并不像部分外部 echo 那样结束选项；变量以 `-` 开头时用 `printf '%s\n' "$var"`。
- `echo -e` 会解释变量里的 `\c`、`\xHH` 等序列，不可信内容可能截断输出或注入控制字符，不要对用户数据用 `-e`。
- dash 的 echo 默认解释转义，Bash 默认不解释；同一个脚本换 shell 结果会变，用 printf 或显式 `-e`/`-E`。
- 输出含 NUL 字节时 echo 会截断或丢失内容，二进制数据用 printf 或直接写文件描述符。

## 参考链接

- [Bash Builtins (echo)](https://www.gnu.org/software/bash/manual/html_node/Bash-Builtins.html)
- [POSIX echo](https://pubs.opengroup.org/onlinepubs/9699919799/utilities/echo.html)
