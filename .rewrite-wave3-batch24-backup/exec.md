exec
===

用指定程序替换当前 shell 进程，或用重定向改变当前 shell 的文件描述符。

## 补充说明

带命令时，exec 不 fork，而是用目标程序替换当前 shell 的进程映像，PID 保持不变；成功后就再也没有原来的 shell，脚本中 exec 之后的语句不会执行。无命令时，重定向在当前 shell 生效并持续到 shell 结束或被改回。

这让 exec 适合在脚本末尾交接给守护进程，systemd 能直接把信号发给目标程序；也适合长期重定向日志。代价是没有返回路径：交互式终端里用错会直接关掉会话。

### 常用示例

```shell
# 脚本末尾交接给服务程序，保持同一 PID
exec /usr/local/bin/my-daemon --foreground

# 无命令：永久重定向当前 shell 的输出
exec >>"$HOME/session.log" 2>&1

# 保存原 stdout，再恢复
exec 3>&1
exec >"$HOME/out.log"
exec 1>&3 3>&-

# 打开或关闭文件描述符
exec 3>"$HOME/tmp.txt"; exec 3>&-
```

## 易错点与排错

- 交互式 shell 里执行 `exec some-program` 会替换当前 shell；程序退出后终端或 SSH 会话随之结束，未保存的 shell 状态全部丢失。先在子 shell 测试：`( exec some-program )`。
- 非交互脚本中 exec 失败，Bash 会直接退出（状态 126 或 127）；`shopt -s execfail` 可让脚本继续，但错误处理要自己补。
- `exec > file` 没有命令时是永久的；忘记保存原 fd 会让后续所有输出都进文件。先 `exec 3>&1` 保存。
- 对未打开的文件描述符执行 `exec 3>&-` 会报 Bad file descriptor；可先在子 shell 尝试。
- exec 成功时不会执行 EXIT trap，也没有返回值；依赖清理逻辑的脚本不要把 exec 放在 trap 之前。

## 参考链接

- [Bash Builtins (exec)](https://www.gnu.org/software/bash/manual/html_node/Bash-Builtins.html)
- [POSIX Shell Command Language](https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html)
