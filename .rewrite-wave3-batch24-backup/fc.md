fc
===

Bash 历史内建命令，用于列出、编辑并重新执行历史命令。

## 补充说明

fc 读取当前 shell 的历史列表：`-l` 列出而不执行，`-n` 去掉编号，`-r` 反向，`-e editor` 指定编辑器；不带 `-l` 时会把选中命令写入临时文件，退出编辑器后立即执行。`fc -s [old=new] [cmd]` 跳过编辑器，直接替换并重跑。

first 和 last 可以是历史编号、负数偏移（`-3` 表示倒数第三条）或以字符串开头的最新命令。它依赖交互式历史；非交互脚本默认没有历史可读。

### 常用示例

```shell
# 列出最近 10 条，带编号和不带编号
fc -l -10
fc -ln -10

# 用编辑器修改最近一条命令后执行
fc

# 直接重跑最近一条
fc -s

# 替换后重跑：把 cc 换成 gcc
fc -s cc=gcc

# 重跑指定编号的命令并替换
fc -s foo=bar 105
```

## 易错点与排错

- `fc` 默认编辑器顺序是 `$FCEDIT`、`$EDITOR`、vi；没有配置时可能进入不熟悉的编辑器，先设置 FCEDIT。
- `fc -s` 会立即执行，不会再次确认；先 `fc -ln` 看清楚要重跑哪条，尤其是含 rm、sudo 的历史。
- 非交互 shell 默认不启用历史，fc 可能报 history is empty；脚本里不要依赖它。
- 多个终端共享同一个 HISTFILE 时，历史顺序可能和你想的不同，并发写入还会互相覆盖。
- fc 是 POSIX 规定的历史工具，但不同 shell 的编辑器选择和扩展不同；跨 shell 脚本里不要使用。

## 参考链接

- [Bash History Builtins](https://www.gnu.org/software/bash/manual/html_node/Bash-History-Builtins.html)
- [POSIX fc](https://pubs.opengroup.org/onlinepubs/9699919799/utilities/fc.html)
