# 上游内容重写计划

目标：保持 URL、标题、描述和站内链接不变，把 `PROVENANCE.md` 中 621 个上游页面逐页替换为独立撰写的内容，最终从 `LICENSE` 移除第三方 MIT 段。

本计划不采用删除页面的方案。Linux 现有 862 页，其中 618 页来自上游；直接删除会让 Linux 降到 244 页，学习路径、速查表和交叉链接大量断链。

## 一、重写规则（clean-room）

1. **不读取现有 `command/linux/<slug>.md` 的内容。** 现有文件是上游衍生内容，读它会污染重写。只允许参考：
   - `man <slug>`、`<slug> --help`；
   - man7.org、GNU manual、发行版官方文档；
   - 项目官方文档；
   - 自己对该命令的既有知识。
2. 用 `Write` 写到一个全新的临时路径，再用 `mv` 覆盖目标文件；不要用 `Edit` 改现有正文。
3. 保留 slug（第一行）、`===`、一行中文描述；标题与文件名必须一致。
4. 代码围栏一律用 ` ```shell `；不要引入其它语言标记。
5. 默认不写 `## 相关命令` 手工链接，避免 404；详情页会自动生成相关条目。
6. 原文中有 `## 读完自测` 的页面，重写时必须保留 3 问 3 答；其余页面可选。
7. 不复制上游的段落、例子和句式。命令语法、选项名、参数名不受限制。

## 二、页面模板

~~~~text
<slug>
===

<一行中文描述>

## 补充说明

<2 段：它是什么、解决什么问题、边界和常见替代方案>

### 常用示例

```shell
# 场景说明
command ...
```

## 易错点与排错

- <真实坑点，含现象、原因、验证方式>
- ...

## 参考链接

- [官方文档](https://...)
~~~~

有自测的页面追加：

~~~~text
## 读完自测

合上页面，先回答，再展开对照。

1. ...
2. ...
3. ...

<details>
<summary>答案</summary>

1. ...
2. ...
3. ...

</details>
~~~~

篇幅建议：高频页 50–80 行，中频页 35–60 行，长尾页 25–45 行。

## 三、批次安排

### 阶段 1：工具与基线

- `provenance.json`：机器可读的 621 页基线、已重写清单、上游 commit。
- `scripts/provenance.mjs`：清单校验、相似度检查、标记重写完成。
- `npm run provenance`：默认只读检查；`--upstream <dir>` 对比固定上游；`--mark` 迁移清单。

### 阶段 2：高频 50 页（已完成 2026-10-18）

| 批次 | 页面 | 状态 |
|---|---|---|
| 1 | ls, grep, find, awk, sed, tar, cat, chmod, chown, ps | 已完成 |
| 2 | top, df, du, ssh, curl, systemctl, journalctl, git, cp, mv | 已完成 |
| 3 | rm, mkdir, ln, mount, ip, ss, dig, crontab, dmesg, lsof | 已完成 |
| 4 | strace, tail, nano, kill, pkill, free, vmstat, iostat, netstat, route | 已完成 |
| 5 | iptables, firewall-cmd, useradd, usermod, passwd, su, sudo, rsync, scp, tmux | 已完成 |

50 页全部通过 `scripts/provenance.mjs --upstream` 的 16-gram/8-gram 相似度检查（0 页命中），并已从 `provenance.json` 的上游清单移入 `rewritten_pages`。

其中 26 页需要保留自测：awk, cat, chmod, chown, crontab, curl, df, dig, dmesg, du, find, git, grep, ip, journalctl, ls, lsof, mount, ps, sed, ss, ssh, strace, systemctl, tar, top。

### 阶段 3：中频 150 页（约 8 批）

按文件与文本、进程与资源、网络、磁盘与文件系统、开发与构建、权限与安全、数据库客户端分组；每批 15–25 页。优先处理仍被学习路径、速查表和排障页引用的页面。

### 阶段 4：长尾 418 页 + 3 个 K8s 页（约 18–20 批）

按类别批量重写，每批 20–25 页。`docker`、`helm`、`kubectl` 优先于长尾页。对长期无搜索价值、内容重复度高的页面，可评估合并或下线，但必须先处理站内链接。

### 阶段 5：收尾

- 621 页全部通过相似度检查和人工抽查。
- 从 `LICENSE` 移除第三方段，只保留本站自有内容许可。
- 更新 README、CONTRIBUTING、PROVENANCE，保留历史记录。
- 评估是否重写 Git 历史：当前树替换不会删除旧 commit 中的上游内容；如果历史也必须干净，需要重写历史或新建仓库。

## 四、验收标准

每批完成后必须：

1. `node scripts/provenance.mjs --upstream /path/to/linux-command` 通过：
   - 已重写页面无连续 16 个中文字符或 8 个英文单词与上游相同（命令语法、选项名除外）；
   - 已重写页面不在上游清单；
   - 上游清单与已重写清单无交集。
2. `npm run verify` 通过：页面数不减少、站内链接零 404。
3. 抽查 3–5 页，确认不是“同义改写”：
   - 段落顺序、例子选择、坑点表述与上游不同；
   - 至少有一个自己的判断或验证方法。
4. 更新 `provenance.json`、`PROVENANCE.md` 进度、`LICENSE` 数量、README 数量。

## 五、进度与回滚

- 2026-10-18：已完成 210/621 页（50 个高频页 + 160 个文件/文本/权限/进程页），剩余 411 页（Linux 408 + K8s 3）。
- 进度以 `provenance.json` 的 `rewritten_pages` 为准；`PROVENANCE.md` 保留原始 621 页基线。
- 每批单独 commit，提交信息写明批次和页面数，便于回滚。
- 如果某页相似度超标，整页重写，不做局部换词。
- 在任何一批完成前，不删除 LICENSE 的上游 MIT 段。

## 六、风险

1. **改写不等于重写**：边看上游边换词仍是衍生作品。必须按 clean-room 规则执行。
2. **历史提交仍含上游内容**：只改当前树，旧 commit 仍可按 MIT 获取；彻底清历史是另一个工程。
3. **内容质量回退**：短页可能丢失细节。高频页必须保留示例、坑点和验证命令；长尾页可以更短，但不能错误。
4. **站内链接回退**：不在重写页里手工加未验证链接；每批跑 `check-links`。
5. **自测丢失**：26 个高频页必须保留 3 问 3 答，否则复习题库会减少。
