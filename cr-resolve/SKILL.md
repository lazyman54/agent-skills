---
name: cr-resolve
description: >-
  Use when an MR has reviewer comments to address via glab CLI (GitLab).
  Triggers: 处理CR / fix CR / 处理MR反馈 / 解决review comment / 处理审查意见 /
  看看MR有什么要改的 / CR反馈 / CR comments /
  handle CR / process MR feedback / resolve review comments.
  NOT for: proactive code review (→ /review).
metadata:
  author: ericmao
  version: "0.3.0"
license: MIT
---

# cr-resolve — 处理 MR CR 反馈

## Overview

Handle GitLab MR Code Review feedback end-to-end: fetch all comments, classify with user confirmation, fix each in its own commit, reply with the commit link in the original thread.
与 /review（主动审代码）相对——cr-resolve 是处理别人审完我的代码后留下的 comment。

## When to Use

**Use when:**
- 你的 MR 收到了 reviewer 留下的 comment，需要逐条处理
- 需要确保每条 comment 都有对应 commit 且回复了原线程
- 使用 GitLab + `glab` CLI 的项目

**When NOT to use:**
- 主动审查他人代码 → 使用 `/review`
- GitHub PR（`glab` 命令不适用）

---

## 行为约束

- **count check 不通过，禁止继续**：必须先确认拉到了所有 comment
- **分类表必须用户确认**：展示分析结果后，等用户确认再开始 fix
- **每条 fix 独立 commit**：不要把多条修复合并成一个 commit
- **最小化改动**：不顺手重构，只改 CR comment 指出的问题
- **必须在原线程回复**：fix 完成后在对应 discussion 下回复 commitID
- **修复手段不明确时先确认**：展示分类表前必须确保每条 unresolved comment 的修复手段已明确

---

## 前提条件

- `glab` 已安装并完成认证（`glab auth status` 验证）
- 当前目录为 Git 仓库根目录
- 用户提供了 MR 号（可多个）

---

## 项目配置（首次使用时询问）

| 配置项 | 说明 | 示例 |
|--------|------|------|
| **Backlog 文件** | 跨阶段问题记录到哪里 | `docs/TODO.md` / `BACKLOG.md` / `impl-plan.md` |
| **构建/测试命令** | 项目的验证命令 | `go test ./...` / `npm test` / `cargo test` |

---

## 执行流程

### 第一步：用 subagent 拉取并验证 comment 完整性

**派发 Explore subagent** 完成拉取和解析，减少主 context 占用：

```
Explore subagent 任务：
1. 运行以下命令拉取 MR #N 的所有 discussions：
   glab mr view <N> --output json   → 提取 user_notes_count 作为 EXPECTED
   glab mr note list <N> --output json > /tmp/mr_notes_<N>.json

2. 解析 JSON，过滤掉 system=true 的自动注释

3. 输出结构化报告：
   - EXPECTED vs ACTUAL 数量
   - 每条 discussion 的：discussion_id、resolved(true/false)、
     作者、文件路径、行号、comment 正文
```

**若 ACTUAL ≠ EXPECTED**：报告缺口，终止流程，提示用户手动核查或检查 glab 分页。

### 第二步：分析 + 确定修复手段（暂停点）

拿到 subagent 返回的结构化 discussion 列表后：

#### 2a. 已 resolved：仅展示文件统计

```
已 Resolved 汇总（N 条）：
- internal/domain/order.go：2 条
- internal/adapter/repo.go：1 条
```

无需逐条展示，不占分析表格空间。

#### 2b. 未 resolved：分析并确定修复手段

**为每条 unresolved comment 各派发一个 Explore subagent，并行分析**（N 条 comment 并行，分析时间不随数量增长）：

```
每个 Explore subagent 的任务模板（每条 comment 独立一个）：
读取 <文件路径> 中第 <行号> 行前后 20 行的代码，
针对 reviewer comment："<comment 正文>"，分析并给出：
- 分析意见：reviewer 指出的问题是否成立？根因是什么？
- 修复手段：具体如何修改（要足够具体，例如"把 db.Begin() 移到 UnitOfWork 封装"）
  如果修复手段不确定，明确标注"待确认"
```

等所有 subagent 返回结果后汇总。

**若有任何修复手段标注"待确认"**：
- 向用户逐条说明不确定原因
- **等用户确认修复方向后**，再展示完整分类表
- 不得在修复手段未明确时就开始 fix

#### 2c. 展示分类表（等用户确认）

按**文件路径字母序**排列，等用户确认后再动手：

| # | 作者 | 文件行 | Comment 摘要 | 分析意见 | 分类 | 修复手段 |
|---|------|--------|-------------|---------|------|---------|
| 1 | carol | `internal/application/command.go:33` | 事务边界不对 | 事务在 domain 层开启，违反分层约束 | 可操作 fix | 移到 application 层，注入 UnitOfWork |
| 2 | bob | `internal/adapter/repo.go:55` | N+1 查询 | 循环内调单条查询，应批量 | 可操作 fix | 改用 IN 查询一次拉取所有记录 |
| 3 | carol | `internal/domain/user.go:67` | 为何用 pointer receiver？ | 该方法不修改状态，value receiver 更合适 | 可操作 fix | 改为 value receiver |

**分类规则**：

| 类别 | 判断标准 |
|------|---------|
| **可操作 fix** | 明确指出代码问题，修复手段已确定 |
| **讨论/已澄清** | 已在线程里解释，不需要改代码 |
| **跨阶段/设计** | 改动超出本 PR 范围，需记录 TODO |

### 第三步：用 subagent 并行实现修复

对于**可操作 fix**，按文件依赖关系分组，**独立文件的 fix 可并行派发 subagent**：

```
策略：
- 不同文件的独立修复 → 并行 subagent
- 同一文件的多处修复 → 单个 subagent 处理（避免冲突）
- 有依赖关系的修复（如 domain 层改动影响 adapter 层）→ 串行

每个 subagent 任务模板：
  - 读取目标文件
  - 按照确定的修复手段实施修改
  - 说明具体改了什么（供主 agent 做 commit message）
  - 如有必要，同步修改对应测试文件
```

**subagent 完成后，主 agent**：

每条 fix 独立 commit：

```bash
git add <受影响文件>
git commit -m "fix(<scope>): <一句话描述本条 CR comment 的修复>"
FULL_SHA=$(git log --format="%H" -1)
SHORT_SHA=$(git log --format="%h" -1)
REMOTE_URL=$(git remote get-url origin)
GITLAB_HOST=$(echo "$REMOTE_URL" | sed 's|https://||;s|git@||;s|[:/].*||')
PROJECT_PATH=$(echo "$REMOTE_URL" | sed "s|.*${GITLAB_HOST}[:/]||;s|\.git\$||")
COMMIT_URL="https://${GITLAB_HOST}/${PROJECT_PATH}/-/commit/${FULL_SHA}"
```

对于**跨阶段/设计**类：
- 在项目 backlog 文件追加 TODO 条目
- **若找到多个 backlog/plan 文件**，列出候选列表并询问用户，**不得擅自选择**
- 格式：`> TODO(MR #N): <问题描述，待 <里程碑/阶段> 处理>`

### 第四步：在原 comment 线程回复

每条 fix commit 后**立即**回复，不要等到最后统一回复：

```bash
# 可操作 fix → 回复可点击的 commit 链接
glab mr note create <mr_number> \
  --reply "<discussion_id>" \
  --message "Fixed in [${SHORT_SHA}](${COMMIT_URL}): <一句话修复摘要>"

# 跨阶段/设计 → 回复说明
glab mr note create <mr_number> \
  --reply "<discussion_id>" \
  --message "设计问题，已记录到 <backlog 文件>，本 PR 暂不处理"

# 讨论/已澄清 → 不回复（线程已有解释，无需重复）
```

> `discussion_id` 从第一步 subagent 返回的结构化数据中直接取用。

### 第五步：规范沉淀（可选）

处理完所有 comment 后，检查是否有 comment 揭示了**项目/架构特有的通用约定**：

> 判断标准：这条规则是否同时满足——(1) 其他开发者写类似代码时也应该遵守；(2) 是项目/架构特有的，而非语言通用常识？

如果有 → **调用 `spec-maintain` skill** 将该约定沉淀到项目规范文件。

### 第六步：全量验证 + 推送

```bash
<build command>
<test command>
git push origin <branch>
```

---

## Common Mistakes

| 错误 | 后果 | 正确做法 |
|------|------|---------|
| count check 不符就强行继续 | 漏掉 comment，CR 未完整处理 | 必须终止，提示用户手动核查分页 |
| 已 resolved 的 comment 也逐条展示 | 表格冗长，重点不突出 | resolved 只展示文件维度统计 |
| 修复手段未明确就展示分类表 | 表格信息不完整，用户无法有效确认 | 先读代码确定修复手段，有"待确认"项先问用户 |
| 用一个 subagent 串行分析所有 comment | 分析耗时随 comment 数线性增长 | 每条 comment 独立一个 Explore subagent 并行分析 |
| 独立 fix 未用 subagent 并行处理 | 修复耗时长，主 context 占用大 | 不同文件的独立修复并行派发 subagent |
| 多条 fix 合并进一个 commit | 无法追溯单条 CR comment 的修复点 | 每条 fix 对应一个独立 commit |
| 所有 fix 完再统一回复线程 | 中途出错则部分线程未回复 | 每条 fix commit 后**立即**回复对应 discussion |
| 忘记过滤 `system=true` 自动注释 | 将 pipeline 状态/push 记录误分类为 comment | 由第一步 subagent 完成过滤 |
| 擅自选择 backlog 文件 | 写错位置，用户难以发现 | 找到多个候选文件时必须列出让用户选择 |

---

## AI Checklist

执行前：
- [ ] `glab auth status` 无报错
- [ ] 已获取 MR 号
- [ ] 已知 backlog 文件位置
- [ ] 已知构建/测试命令

执行中：
- [ ] count check：`len(discussions) == user_notes_count`（由第一步 subagent 完成）
- [ ] 已 resolved comment 仅展示文件统计
- [ ] 所有 unresolved comment 的修复手段已明确（无"待确认"）
- [ ] 分类表已按文件路径排序并获得用户确认
- [ ] 独立 fix 已并行派发 subagent
- [ ] 每条 fix 对应独立 commit（无批量合并）
- [ ] 每条 fix 完成后立即回复对应线程
- [ ] 跨阶段问题已写入 backlog 文件

执行后：
- [ ] 构建通过
- [ ] 测试全绿
- [ ] 检查是否有 comment 揭示了项目/架构特有的通用约定（有则调用 spec-maintain）
- [ ] `git push` 已推送
