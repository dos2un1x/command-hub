local
===

Bash 内建命令，在函数内部声明局部变量。

## 补充说明

local 只能在函数内使用，创建的变量在函数返回时自动消失；同名全局变量会被临时遮蔽，而不是被修改。它的作用域是动态的：当前函数调用的其他函数也能看到这些局部变量。

它可以加与 declare 相同的属性：`-a` 索引数组、`-A` 关联数组（Bash 4+）、`-i` 整数、`-r` 只读、`-n` nameref（Bash 4.3+）。local 是 Bash 和部分 shell 的扩展，POSIX 没有规定。

### 常用示例

```shell
# 局部变量遮蔽全局变量
name=global
f() { local name=local; echo "$name"; }
f; echo "$name"

# 局部数组、关联数组与只读变量
g() {
    local -a arr=(one two); local -r limit=10
    local -A map=([a]=1 [b]=2)
    echo "${arr[1]} ${map[b]} $limit"
}

# 先声明再赋值，保留命令的退出状态
h() { local out; out=$(false); echo "$?"; }
```

## 易错点与排错

- `local out=$(cmd)` 的退出状态是 local 自己的（通常 0），不是 cmd 的；要检查命令结果必须先 `local out` 再 `out=$(cmd)`。
- local 变量会遮蔽同名全局变量，函数返回后全局值恢复；如果函数里直接赋值而没有先 local，改的才是全局变量。
- 动态作用域意味着被调用函数能读到调用者的 local；不要把它当词法作用域，递归时尤其要显式传参。
- `local -r` 后函数内不能再赋值或 unset；只读属性只作用于这个局部变量，函数返回后消失。
- 在函数外使用 local 会报错；dash 的 local 支持有限，跨 shell 脚本不要依赖数组和 nameref 等属性。

## 参考链接

- [Bash Builtins (local)](https://www.gnu.org/software/bash/manual/html_node/Bash-Builtins.html)
- [man7 bash(1)](https://man7.org/linux/man-pages/man1/bash.1.html)
