mapfile
===

Bash 内建命令，从标准输入或文件描述符按行读取到索引数组。

## 补充说明

mapfile（同义词 readarray）一次把输入行读入数组，默认数组名 MAPFILE，每行一个元素。`-t` 去掉行尾分隔符，`-n count` 限制行数，`-s count` 跳过开头，`-O origin` 指定起始下标，`-u fd` 选择输入，`-d delim` 改分隔符，`-C` 和 `-c` 设置每 N 行调用一次回调。

它比 `while read` 循环快，适合把命令输出、配置文件或 find 结果整体装进数组再处理。默认保留行尾换行符，读取时不做反斜杠转义。

### 常用示例

```shell
# 读文件到数组，并去掉行尾换行
mapfile -t lines < file.txt

# 从命令输出读取，进程替换不会丢掉数组
mapfile -t files < <(find . -maxdepth 1 -type f)

# 跳过前 2 行，只读 3 行
mapfile -t -s 2 -n 3 head_lines < file.txt

# 追加到已有数组末尾并确认
mapfile -t -O "${#lines[@]}" more < more.txt
declare -p lines
```

## 易错点与排错

- `cmd | mapfile -t arr` 会把 mapfile 放进管道子 shell，父 shell 里的 arr 仍为空；用 `< <(cmd)` 或输入重定向，或在 Bash 4.2+ 开启 `shopt -s lastpipe` 并关闭作业控制。
- 不加 `-t` 时元素保留换行，比较和拼接会出现意外空行；绝大多数场景都要加 `-t`。
- mapfile 默认从下标 0 覆盖数组，不会自动追加；追加要用 `-O "${#arr[@]}"`。
- 空输入时数组可能未定义，`set -u` 下直接展开要小心；先 `declare -a arr=()`。
- mapfile 是 Bash 4+ 内建，sh 和 dash 没有；处理含换行的文件名时用 `-d ''` 按 NUL 分隔。

## 参考链接

- [Bash Builtins (mapfile)](https://www.gnu.org/software/bash/manual/html_node/Bash-Builtins.html)
- [man7 bash(1)](https://man7.org/linux/man-pages/man1/bash.1.html)
