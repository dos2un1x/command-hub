declare
===

Bash 内建命令，用于声明变量、设置属性以及定义或查看函数。

## 补充说明

declare 是 Bash 内建命令，用来给变量加属性：整数 `-i`、只读 `-r`、导出 `-x`、索引数组 `-a`、关联数组 `-A`、大小写转换 `-l`/`-u`、nameref `-n`。`declare -p name` 以可重新执行的格式打印变量的值和属性。

作用域是关键：在函数外声明的是全局变量；在函数内不带 `-g` 时等价于 local，函数返回即消失；带 `-g` 才会写入全局。declare 属于 Bash/ksh 系语法，POSIX sh 没有。

### 常用示例

```shell
# 查看值和属性；变量不存在时返回非 0
name=alice
declare -p name

# 整数属性；索引数组与关联数组
declare -i n=2+3; echo "$n"
declare -a fruits=(apple banana)
declare -A port=([http]=80 [https]=443)

# 只读；函数内默认局部，-g 强制全局
declare -r PI=3.14
f() { declare x=local; declare -g y=global; }
f; echo "${x:-empty} $y"
```

## 易错点与排错

- 函数里 `declare x=1` 不会修改同名全局变量，而是新建局部变量；要改全局用 `declare -g` 或直接赋值。
- `declare -r` 后无法用 `+r` 解除只读，`unset` 也会失败；只读与导出组合用 `declare -rx`。
- `declare -i` 下前导 0 按八进制解释：`declare -i x=08` 报 value too great for base，固定十进制用 `10#08`。
- 关联数组必须先 `declare -A`，否则 `map[k]=v` 会落到普通数组的索引 0 上。
- `declare -p` 的输出带引号和属性前缀，需要 `eval` 才能还原；不要直接拿字符串比较值。

## 参考链接

- [Bash Builtins](https://www.gnu.org/software/bash/manual/html_node/Bash-Builtins.html)
- [man7 bash(1)](https://man7.org/linux/man-pages/man1/bash.1.html)
