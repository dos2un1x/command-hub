env
===

在修改后的环境变量下运行程序，或打印当前环境。

## 补充说明

env 是 coreutils 提供的外部程序：不带命令时打印环境变量；带 `NAME=VALUE` 和命令时，先构造新环境再 exec 该命令。`-i` 清空环境，`-u NAME` 删除单项，`-C DIR` 切换目录，`-S` 拆分字符串，`-0` 用 NUL 分隔输出。

它只影响被 exec 的进程，不会修改当前 shell 的变量；要持久设置当前 shell 用 `export`。env 也常用于 shebang：`#!/usr/bin/env python3` 通过 PATH 查找解释器。

### 常用示例

```shell
# 查看环境变量
env | sort | head

# 只对这条命令生效
env LANG=C LC_ALL=C sort file.txt

# 空环境启动 Bash；-u 删除指定变量
env -i HOME="$HOME" TERM="$TERM" bash --noprofile --norc
env -u LD_PRELOAD command

# -S 拆分参数；-0 用 NUL 分隔输出
env -S 'python3 -u' script.py
env -0 | tr '\0' '\n' | head
```

## 易错点与排错

- `env FOO=bar echo $FOO` 打印空值：`$FOO` 在 env 启动前已由当前 shell 展开；写成 `env FOO=bar sh -c 'echo "$FOO"'`。
- `env cd /tmp` 失败：env 只能 exec 外部程序，`cd` 是 shell 内建；用 `env VAR=x bash -c 'cd /tmp && ...'`。
- `env -i` 会连 PATH 一起清掉，随后按命令名查找可能失败；显式给出 `PATH=/usr/bin:/bin`。
- 退出码要区分：命令正常结束时是命令的状态；env 自身失败约为 125，命令存在但不能执行是 126，找不到命令是 127。
- `env` 看不到未导出的 shell 变量和函数，排查时用 `export -p` 对照，别误以为变量丢失。

## 参考链接

- [GNU coreutils env](https://www.gnu.org/software/coreutils/manual/html_node/env-invocation.html)
- [man7 env(1)](https://man7.org/linux/man-pages/man1/env.1.html)
