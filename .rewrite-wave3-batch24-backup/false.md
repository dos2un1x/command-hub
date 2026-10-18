false
===

什么都不做并返回失败状态 1，用于条件分支与占位。

## 补充说明

false 是 POSIX 规定的工具，也有 Bash 内建；它忽略参数、不产生输出，退出状态恒为 1。常用来表示失败分支、初始化循环条件或在测试里占位。

对应的是 `true`（状态 0）和 `:`（内建空操作，状态 0）。在 `&&`、`||`、if、while 中，退出状态决定控制流，而不是输出。

### 常用示例

```shell
# 状态码是 1
false; echo "$?"

# 条件短路
false && echo "never"
false || echo "fallback"

# 占位函数与循环初始条件
not_implemented() { false; }
if not_implemented; then echo ok; else echo "not yet"; fi
while false; do echo "never"; done

# 取反
! false; echo "$?"
```

## 易错点与排错

- `false --help` 仍然返回 1，不会打印帮助；它不是带选项的普通命令，别用它测试参数解析。
- 管道只看最后一个命令的状态：`false | true` 的状态是 0；需要整条管道失败时开 `set -o pipefail`。
- 同名函数或别名可以覆盖 false，脚本里用 `command false` 或 `builtin false` 保证语义。
- `set -e` 遇到 false 会退出，但在 if、while、`&&`/`||`（非最后一项）和 `!` 后面不会；不要假设所有 false 都会终止脚本。
- 需要“成功但不做事”时用 `true` 或 `:`；把 false 当空操作会让条件判断反向。

## 参考链接

- [GNU coreutils false](https://www.gnu.org/software/coreutils/manual/html_node/false-invocation.html)
- [POSIX false](https://pubs.opengroup.org/onlinepubs/9699919799/utilities/false.html)
