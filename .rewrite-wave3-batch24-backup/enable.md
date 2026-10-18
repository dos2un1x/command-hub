enable
===

Bash 内建命令，启用、禁用或列出 shell 内建命令。

## 补充说明

enable 控制当前 Bash 进程里的内建命令表。`enable -n name` 禁用内建后，同名命令会按 PATH 查找外部程序；`enable name` 恢复；`enable -a` 列出全部内建及启用状态，`-p` 输出可重用形式，`-s` 只看 POSIX 特殊内建。

它只影响当前 shell 及其子 shell 的命令解析，不修改文件系统。常见用途是强制使用外部程序做对照，或在受限环境里移除危险内建；普通生产脚本一般不需要。

### 常用示例

```shell
# 查看 echo 的实际解析顺序
type -a echo

# 禁用内建 echo，改用 PATH 中的外部 echo
enable -n echo
type -a echo
enable echo

# 列出全部内建及启用状态；只显示已禁用的
enable -a | head
enable -n
```

## 易错点与排错

- 禁用内建后，同名函数或别名仍可能优先命中；用 `type -a name` 查看顺序，用 `builtin name` 直接调用内建。
- 禁用 `test`、`[`、`printf` 等会改变后续所有片段的行为；子 shell 会继承禁用状态，恢复前不要执行不可信代码。
- `enable -f file name` 从共享对象加载内建，需要该 .so 按 Bash 内建 API 编译；加载来源不可信等于执行任意代码。
- 非交互脚本里的 enable 修改不会传回父 shell，脚本退出即失效。

## 参考链接

- [Bash Builtins (enable)](https://www.gnu.org/software/bash/manual/html_node/Bash-Builtins.html)
- [man7 bash(1)](https://man7.org/linux/man-pages/man1/bash.1.html)
