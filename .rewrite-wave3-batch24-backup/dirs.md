dirs
===

Bash 内建命令，显示由 pushd/popd 维护的目录栈。

## 补充说明

dirs 显示当前 shell 的目录栈，栈顶就是当前目录；它本身不改变目录，配合 `pushd`（压栈并切换）和 `popd`（弹栈并切换）使用。默认把家目录缩写成 `~`，多个条目显示在一行里。

`+N` 从左往右数（0 是栈顶），`-N` 从右往左数（0 是栈底）；`-v` 带编号逐行显示，`-p` 逐行但不带编号，`-l` 不缩写家目录，`-c` 清空栈。目录栈保存在 shell 进程内，不会写回磁盘。

### 常用示例

```shell
# 切换目录并把旧位置压栈
pushd /tmp
pushd /usr/local
dirs -v

# 按编号查看：+1 是第二个条目，-0 是栈底
dirs +1
dirs -0

# 返回上一处并清空栈
popd
dirs -c
```

## 易错点与排错

- `dirs`、`pushd`、`popd` 是 Bash、zsh、csh 的内建，dash 和多数 `/bin/sh` 没有；脚本用 `#!/bin/sh` 会报 `dirs: not found`，先用 `type dirs` 确认。
- 子 shell 和管道修改的是副本：`( pushd /tmp; dirs )` 或 `bash -c 'pushd /tmp'` 不会影响当前 shell 的栈。
- `cd` 只改变当前目录并更新 `OLDPWD`，不会自动压栈；不要以为 `cd` 之后 `dirs` 会保留历史。
- 栈为空时 `popd` 会报错；脚本里先检查 `${#DIRSTACK[@]}` 或显式处理失败。

## 参考链接

- [Bash Directory Stack Builtins](https://www.gnu.org/software/bash/manual/html_node/Directory-Stack-Builtins.html)
- [man7 bash(1)](https://man7.org/linux/man-pages/man1/bash.1.html)
