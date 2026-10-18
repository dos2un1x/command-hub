fishshell
===

fish 是一款强调交互体验、与 POSIX shell 语法不兼容的命令行 shell。

## 补充说明

fish（Friendly Interactive SHell）提供开箱即用的自动建议、语法高亮和补全；它的语法与 Bash/POSIX 不同：变量用 `set` 管理，命令替换用 `(cmd)`，代码块以 `end` 结束，`&&` 和 `||` 在 3.0 之后才支持。

它适合交互式使用和编写 fish 脚本，不适合当作 `/bin/sh`，也不能直接运行 Bash 脚本。配置在 `~/.config/fish/config.fish`，函数在 `~/.config/fish/functions/`，可用 `fish_config` 打开网页配置界面。

### 常用示例

```shell
# 启动 fish（设为登录 shell 前需先在 /etc/shells 注册）
fish

# 作用域：-g 全局、-l 局部、-x 导出、-U 通用持久
set -g name alice
set -x EDITOR vim
set -U fish_greeting ""

# 列表就是数组；命令替换用 (cmd)
fish_add_path /opt/bin
set files (ls)
if test (count $files) -gt 0; echo "found"; end
```

## 易错点与排错

- 直接 `fish script.sh` 运行 Bash 脚本会报语法错误；用 `bash script.sh`，或把 shebang 写成 `#!/usr/bin/env fish` 并重写语法。
- `set VAR=value` 是错的：fish 用空格分隔，等号会成为值的一部分；也没有 `export VAR=value`，用 `set -x VAR value`。
- `set -U` 的通用变量会写入 fish_variables 并跨会话生效；用 `set -Ue VAR` 删除，用 `set -S VAR` 检查作用域。
- `$status` 是上一条命令的退出码，不是 `$?`；管道各段状态在 `$pipestatus` 列表里。
- 从 Bash 迁移时，`$(...)`、`[[ ]]`、local、declare、export 都要改写；不要假设源码兼容。

## 参考链接

- [fish documentation](https://fishshell.com/docs/current/)
- [fish language reference](https://fishshell.com/docs/current/language.html)
