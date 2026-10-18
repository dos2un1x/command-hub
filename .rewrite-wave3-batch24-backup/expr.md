expr
===

求值表达式并打印结果，常用于 POSIX shell 的整数与字符串运算。

## 补充说明

expr 是 coreutils 外部程序，把参数当作一个表达式求值后输出；运算符之间必须有空格，`+ - * / % = !=`、比较、括号、`length`、`substr`、`index`、`match`、`:` 都可用。字符串比较和正则匹配是它相对 shell 算术的优势。

退出状态有特殊含义：结果为 0 或空串时返回 1，否则返回 0；表达式错误返回 2 或 3。因此它既能输出值，也能直接放进 if。Bash 里通常优先用 `$(( ))`、`[[ ]]` 和参数展开，expr 留给需要 POSIX 可移植性的脚本。

### 常用示例

```shell
# 算术：运算符两侧必须有空格，* 要转义
expr 2 + 3
expr 6 \* 7

# 字符串长度、子串与位置（位置从 1 开始）
s=hello
expr length "$s"
expr substr "$s" 2 3

# 正则匹配：返回匹配长度，\(...\) 取捕获内容
expr "$s" : '.*\(ell\)'

# 空值先补 0
n=${n:-0}; expr "$n" + 1
```

## 易错点与排错

- 变量为空时 `expr $n + 1` 会退化成 `expr + 1`，报语法错误；给变量加引号并用 `${n:-0}`。
- `expr 1 - 1` 输出 0 但退出状态是 1，`set -e` 下会让脚本直接退出；用 `result=$(expr ... || true)` 或改用算术展开。
- 未转义的 `*` 会被 shell 当通配符展开成文件名，`(`、`)`、`>` 同理；用引号或反斜杠。
- `:` 默认从字符串开头锚定；搜索中间内容要把模式写成 `.*\(...\)`，不要以为它像 grep 一样任意位置匹配。
- 两边都像整数时按数值比较，否则按字典序；比较版本号这类内容要自己拆分，不能直接交给 expr。

## 参考链接

- [GNU coreutils expr](https://www.gnu.org/software/coreutils/manual/html_node/expr-invocation.html)
- [POSIX expr](https://pubs.opengroup.org/onlinepubs/9699919799/utilities/expr.html)
