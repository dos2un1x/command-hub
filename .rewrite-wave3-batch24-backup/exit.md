exit
===

以指定状态退出当前 shell，状态码会被截断为 0 到 255。

## 补充说明

exit 结束当前 shell 进程；不带参数时使用上一条命令的退出状态。参数按 8 位取模：`exit 256` 得到 0，`exit -1` 得到 255。脚本的退出码最终由父进程通过 wait 读取。

在函数内 exit 结束整个 shell，不是只退出函数（用 return）；在 `( )` 子 shell 内只退出子 shell；在 source 的文件里会退出调用者的 shell。EXIT trap 会在正常退出前执行。

### 常用示例

```shell
# 成功与失败
exit 0
exit 1

# 使用上一条命令的状态
grep -q pattern file || exit

# 显式保留状态值；子 shell 退出不影响父 shell
command; status=$?; exit "$status"
( exit 3 ); echo "$?"

# 退出前清理
trap 'rm -f "$tmpfile"' EXIT; exit 0
```

## 易错点与排错

- `exit 256`、`exit 300` 不会报错，状态会被截断（分别变 0、44）；需要区分原因时保持在 0 到 255。
- `exit foo` 会报 numeric argument required 并以状态 2 退出；不要用未校验的变量直接做参数。
- 交互式 Bash 存在 stopped jobs 时会拒绝第一次 exit 并给出提示；处理作业后再退出，或再执行一次 exit。
- 在管道或子 shell 中调用 exit 只影响该子 shell，父脚本会继续；需要终止外层进程时不能用这种方式。
- 被 exec 替换或收到 SIGKILL 时不会执行 EXIT trap，不要只依赖 trap 做关键持久化。

## 参考链接

- [Bash Builtins (exit)](https://www.gnu.org/software/bash/manual/html_node/Bash-Builtins.html)
- [POSIX Shell Command Language](https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html)
