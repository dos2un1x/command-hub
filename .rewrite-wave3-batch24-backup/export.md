export
===

把 shell 变量或函数标记为导出，使子进程能够继承。

## 补充说明

export 给变量加“导出”属性：之后 fork/exec 的子进程环境里会带上它。它不会把值写回父进程，也不影响已经启动的进程；子进程修改自己的副本不会传回当前 shell。

`export NAME=VALUE` 同时赋值并导出，`export NAME` 只加属性，`export -p` 列出，`export -n NAME` 取消导出但保留值，`export -f func` 导出函数。导出属性跟着变量走：在函数内修改一个全局变量的导出状态会持续生效，局部变量则随函数结束消失。

### 常用示例

```shell
# 赋值并导出
export APP_ENV=prod
export PATH="$PATH:/opt/app/bin"

# 只标记已有变量；取消导出但保留值
LOG_LEVEL=debug
export LOG_LEVEL
export -n LOG_LEVEL

# 只对一条命令生效，不改变当前 shell
env APP_ENV=dev ./app

# 导出函数给子 Bash（受安全策略限制）
export -f myfunc
```

## 易错点与排错

- 数组不能完整导出：Bash 不会把数组元素放进子进程环境，`export arr` 后子进程看不到内容。需要传数组时用分隔符拼接，或把 `declare -p` 文本交给子进程重建。
- `export VAR = value` 在等号两边加了空格，Bash 会把 `VAR` 当命令名；赋值时不能有空格。
- 只读与导出要一次设置：`declare -rx VAR=value`，之后无法赋值或 unset；配置需要被覆盖时不要加只读。
- `sudo`、`su -` 和 systemd 服务会重置或清理环境，导出的变量通常不会自动传过去；用 `sudo -E`、`sudo VAR=x cmd` 或服务单元的 `Environment=`。
- 子 shell 里 export 不影响父 shell：`( export X=1 ); echo "$X"` 输出为空。

## 参考链接

- [Bash Builtins (export)](https://www.gnu.org/software/bash/manual/html_node/Bash-Builtins.html)
- [POSIX Shell Command Language](https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html)
