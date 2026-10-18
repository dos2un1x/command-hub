help
===

Bash 内建命令，显示内建命令的用法和说明。

## 补充说明

help 只查询 Bash 内建命令的帮助，不查外部程序；不带参数时列出内建名称和一句话说明，带 pattern 时显示匹配的详细帮助。`-s` 只输出用法摘要，`-d` 输出短描述，`-m` 输出 man 风格的 roff 源码。

pattern 按 shell 通配符匹配，可以一次查询多个。外部命令用 `man`、`info` 或 `cmd --help`；用 `type cmd` 先判断它到底是不是内建。

### 常用示例

```shell
# 列出所有内建
help

# 查看单个内建的详细帮助
help cd
help read

# 短描述和用法
help -d
help -s cd

# 通配符匹配；man 风格输出交给 man 渲染
help 'read*'
help -m read | man -l -
```

## 易错点与排错

- `help ls` 会提示没有匹配主题，因为 ls 是外部程序；改用 `man ls` 或 `ls --help`。
- `help -m` 输出的是 roff 源码，直接看不排版；管道给 `man -l -` 或 groff。
- pattern 不加引号会被当前目录的文件名先展开；查询带 `*` 或 `?` 时加单引号。
- help 是 Bash 内建，zsh 使用 run-help，fish 的 help 会打开浏览器；脚本里不要假设 help 一定存在。

## 参考链接

- [Bash Builtins (help)](https://www.gnu.org/software/bash/manual/html_node/Bash-Builtins.html)
- [man7 bash(1)](https://man7.org/linux/man-pages/man1/bash.1.html)
