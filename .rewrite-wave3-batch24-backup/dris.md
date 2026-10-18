dris
===

不是标准命令，通常是对 dirs 的拼写错误；这里说明如何识别并纠正。

## 补充说明

`dris` 在 Bash、POSIX 和 GNU coreutils 中都没有对应程序或内建，它几乎总是 `dirs`（显示目录栈）的误拼。网上一些命令手册沿用了这个错误拼写，实际执行只会得到 command not found。

如果目标是查看目录栈，应使用 `dirs`；如果想列出目录，可能是 `ls` 或 `find` 的笔误。先用 `type` 或 `command -v` 判断一个名字是内建、外部程序还是别名，再决定替代命令。

### 常用示例

```shell
# 确认 dris 不存在（预期失败）
type dris
command -v dris

# 真正要用的内建命令与目录栈操作
type dirs
pushd /tmp
dirs -v
popd
```

## 易错点与排错

- 启用了命令纠错插件或 `command_not_found_handle` 时，输入 `dris` 可能被提示纠正，但这不代表它是真实命令。
- 搜索引擎里大量 `dris` 页面是镜像站互相转载，应以 `man bash` 的 Directory Stack Builtins 小节为准。
- 脚本中不要把 `dris` 当成 `dirs` 的别名；不同发行版不会提供这个别名，直接写 `dirs`。
- 如果 `type dris` 命中了自定义函数或别名，用 `type -a dris` 查看全部来源，再决定是否删除。

## 参考链接

- [Bash Directory Stack Builtins](https://www.gnu.org/software/bash/manual/html_node/Directory-Stack-Builtins.html)
- [POSIX utilities index](https://pubs.opengroup.org/onlinepubs/9699919799/idx/utilities.html)
