dircolors
===

生成 LS_COLORS 配置的 shell 语句，让 GNU ls 按文件类型着色。

## 补充说明

dircolors 属于 GNU coreutils，读取颜色数据库（内置默认值或指定文件）并输出设置 `LS_COLORS` 的 shell 代码；真正给文件名着色的是 GNU `ls --color`，dircolors 只负责生成环境变量。

常见做法是在 shell 启动文件里写 `eval "$(dircolors -b)"`。BSD/macOS 自带的 `ls` 不读取 `LS_COLORS`，需要安装 GNU coreutils 并使用 `gls --color`，或者换用支持该变量的工具。

### 常用示例

```shell
# 查看内置颜色数据库，作为自定义配置的起点
dircolors --print-database | head

# 为 Bash 生成设置代码并立即生效
eval "$(dircolors -b)"

# 使用自定义数据库文件
eval "$(dircolors -b "$HOME/.dircolors")"

# 生成 C shell 语法
dircolors -c "$HOME/.dircolors"
```

## 易错点与排错

- 只运行 `dircolors` 不会改变当前 shell 的环境，必须把输出交给 `eval` 或 `source`，否则 `LS_COLORS` 仍为空。
- macOS 上 `ls` 是 BSD 版本，设置 `LS_COLORS` 没有效果；先用 `ls --version` 确认，或改用 `gls`。
- 输出的转义和引号是按目标 shell 生成的，`-b` 是 Bourne shell 语法；换 zsh/fish 时先确认兼容性。
- 数据库里写错颜色代码通常不报错，只是不生效；用 `ls --color=always | cat -v` 观察实际转义序列。

## 参考链接

- [GNU coreutils dircolors](https://www.gnu.org/software/coreutils/manual/html_node/dircolors-invocation.html)
- [man7 dircolors(1)](https://man7.org/linux/man-pages/man1/dircolors.1.html)
