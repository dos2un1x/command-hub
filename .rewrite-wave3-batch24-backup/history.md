history
===

Bash 历史内建命令，查看、清理和读写命令历史。

## 补充说明

history 管理当前 shell 的历史列表：不带参数按编号列出，带数字显示最近 N 条；`-c` 清空内存列表，`-d offset` 删除一条，`-a` 追加本次会话的新命令到文件，`-w` 覆盖写入，`-r` 读入并追加，`-n` 只读文件中尚未读过的行。

行为由变量控制：`HISTFILE` 文件位置、`HISTSIZE` 内存条数、`HISTFILESIZE` 文件条数、`HISTCONTROL`（ignorespace、ignoredups、erasedups）、`HISTIGNORE` 过滤模式、`HISTTIMEFORMAT` 时间格式。历史展开（`!!`、`!$`、`!n`）由 `set -H` 控制。

### 常用示例

```shell
# 查看最近 10 条
history 10

# 按编号删除并写回文件
history -d 1234; history -w

# 把本次会话的新命令追加到 HISTFILE
history -a

# 清空内存并覆盖历史文件
history -c; history -w

# 临时关闭记录（当前 shell），再恢复
set +o history
set -o history
```

## 易错点与排错

- `history -c` 只清内存，不删 `~/.bash_history`；要真正清掉文件必须接着执行 `history -w`。
- 多个终端同时打开时，退出时默认互相覆盖历史文件；在 `~/.bashrc` 里 `shopt -s histappend`，否则后退出者会吞掉前一个会话的记录。
- 非交互脚本默认不记录历史，history 为空；需要时显式 `set -o history` 并指定 HISTFILE。
- 历史展开发生在解析阶段，双引号内的 `!` 也会展开；单引号或反斜杠可阻止，`set +H` 完全关闭。
- `history -d` 只改内存，删除后编号不重排；脚本里不要按固定编号引用。

## 参考链接

- [Bash History Builtins](https://www.gnu.org/software/bash/manual/html_node/Bash-History-Builtins.html)
- [Bash History Interaction](https://www.gnu.org/software/bash/manual/html_node/History-Interaction.html)
