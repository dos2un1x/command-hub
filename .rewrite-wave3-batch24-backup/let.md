let
===

Bash 算术内建命令，对表达式求值并按结果返回状态。

## 补充说明

let 把每个参数当作算术表达式求值，变量名不需要 `$`；多个参数从左到右依次计算，最后一个是 0 时返回 1，否则返回 0。它支持赋值、自增自减、位运算、比较和三元运算。

含空格或 `*`、`<`、`>`、`&`、`|` 的表达式必须整体加引号，否则会被 shell 拆分或当成重定向和管道。Bash 中通常更推荐 `(( expression ))`，可读性和状态语义相同；需要 POSIX 可移植时用 `$(( ))`。

### 常用示例

```shell
# 基本求值
let "x = 2 + 3"; echo "$x"

# 自增与复合赋值
i=0
let "i += 1"
let i++

# 位运算与比较
let "mask = 1 << 4"
if let "mask & 16"; then echo set; fi

# 多个表达式，最后一个决定状态
let "a = 1" "b = a * 2"; echo "$a $b"
```

## 易错点与排错

- `let i++` 在 i 为 0 时返回 1（后自增返回旧值 0），`set -e` 会让脚本意外退出；改用 `i=$((i + 1))` 或 `let "++i"`。
- `let x = 1` 因为空格被拆成多个参数，可能报语法错误或执行意外表达式；写成 `let x=1` 或整体加引号。
- 前导 0 按八进制解释：`let x=08` 报 value too great for base；固定十进制用 `10#08`。
- 除以 0 会打印错误并返回失败；未设置的变量按 0 处理，容易掩盖配置缺失。
- let 不是 POSIX 内建，dash 等 shell 可能没有；跨 shell 脚本用 `$(( ))`。

## 参考链接

- [Bash Builtins (let)](https://www.gnu.org/software/bash/manual/html_node/Bash-Builtins.html)
- [Bash Arithmetic Evaluation](https://www.gnu.org/software/bash/manual/html_node/Arithmetic-Evaluation.html)
