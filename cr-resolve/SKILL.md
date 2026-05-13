---
name: cr-resolve
description: >-
  处理 MR Code Review 反馈：验证 comment 完整性（count check）、分类确认、
  逐条 fix（每条独立 commit）、在原线程回复 commitID，
  跨阶段问题记录到项目 backlog 文件并回复说明。
  与 /review（主动审代码）相对——cr-resolve 是处理别人审完我的代码后留下的 comment。
  触发词：处理CR、fix CR、处理MR反馈、解决review comment、处理审查意见、
  看看MR有什么要改的、处理一下MR的comment、CR反馈、CR comments、
  handle CR、process MR feedback、resolve review comments
  不处理：主动做代码审查（→ /review）
metadata:
  author: ericmao
  version: "0.1.0"
license: MIT
---

# cr-resolve — 处理 MR CR 反馈

> Handle MR Code Review feedback end-to-end.
> 与 /review（主动审代码）相对——cr-resolve 是处理别人审完我的代码后留下的 comment。

## 行为约束

- **count check 不通过，禁止继续**：必须先确认拉到了所有 comment
- **分类表必须用户确认**：展示三类分类后，等用户确认再开始 fix
- **每条 fix 独立 commit**：不要把多条修复合并成一个 commit
- **最小化改动**：不顺手重构，只改 CR comment 指出的问题
- **必须在原线程回复**：fix 完成后在对应 discussion 下回复 commitID

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

### 第一步：拉取并验证 comment 完整性

```bash
# 获取预期总 discussion 数
EXPECTED=$(glab mr view <N> --output json | python3 -c \
  "import sys,json; d=json.load(sys.stdin); print(d['user_notes_count'])")

# 拉取所有 discussion（JSON 格式，含 discussion_id 供后续回复使用）
glab mr note list <N> --output json > /tmp/mr_notes_<N>.json

# Count check
ACTUAL=$(python3 -c "import json; print(len(json.load(open('/tmp/mr_notes_<N>.json'))))")
echo "Expected: $EXPECTED, Actual: $ACTUAL"
```

**若 ACTUAL ≠ EXPECTED**：报告缺口，终止流程，提示用户手动核查或检查 glab 分页。

过滤掉每个 discussion 中 `system=true` 的自动注释（如 push 记录、pipeline 状态、跨引用等），只展示人工 comment。

### 第二步：分类并展示给用户确认

以表格形式输出，**等用户确认后再动手**：

| # | 作者 | Comment 摘要 | 分类 | 说明 |
|---|------|-------------|------|------|
| 1 | alice | "missing nil check" | 可操作 fix | 需加防御校验 |
| 2 | alice | "why this pattern?" | 讨论/已澄清 | 原作者已解释 |
| 3 | bob | "consider redesign" | 跨阶段/设计 | 超出本 PR 范围 |

**分类规则**：

| 类别 | 判断标准 |
|------|---------|
| **可操作 fix** | 明确指出代码问题，且原作者认可（回复里有"是的/可以/加一下"等） |
| **讨论/已澄清** | 原作者在线程里已解释，不需要改代码 |
| **跨阶段/设计** | 改动超出本 PR 范围，需记录 TODO |

### 第三步：逐条 fix（每条独立 commit）

每条可操作 fix：
1. 定位受影响代码
2. 最小化改动 + 必要时补测试
3. 阶段构建验证：运行项目构建命令
4. 独立 commit：

```bash
git add <受影响文件>
git commit -m "fix(<scope>): <一句话描述本条 CR comment 的修复>"
# 用 git log --oneline -1 记录 commitID
```

对于**跨阶段/设计**类：
- 在项目 backlog 文件追加 TODO 条目
- **若找到多个 backlog/plan 文件**，列出候选列表并询问用户选择哪一个，**不得擅自选择**
- 格式：`> TODO(MR #N): <问题描述，待 <里程碑/阶段> 处理>`

### 第四步：在原 comment 线程回复

每条处理完后立即回复，不要等到最后统一回复：

```bash
# 可操作 fix → 回复 commitID
glab mr note create <mr_number> \
  --reply "<discussion_id>" \
  --message "Fixed in <commitID>: <一句话修复摘要>"

# 跨阶段/设计 → 回复说明
glab mr note create <mr_number> \
  --reply "<discussion_id>" \
  --message "设计问题，已记录到 <backlog 文件>，本 PR 暂不处理"

# 讨论/已澄清 → 不回复（线程已有解释，无需重复）
```

> `discussion_id` 从第一步的 JSON 中提取（每个 discussion 对象的 `id` 字段）。

### 第五步：全量验证 + 推送

```bash
# 运行项目构建和测试命令（按项目配置适配）
<build command>
<test command>

git push origin <branch>
```

---

## AI Checklist

执行前：
- [ ] `glab auth status` 无报错
- [ ] 已获取 MR 号
- [ ] 已知 backlog 文件位置
- [ ] 已知构建/测试命令

执行中：
- [ ] count check：`len(discussions) == user_notes_count`
- [ ] 分类表已展示并获得用户确认
- [ ] 每条 fix 对应独立 commit（无批量合并）
- [ ] 每条 fix 完成后立即回复对应线程
- [ ] 跨阶段问题已写入 backlog 文件

执行后：
- [ ] 构建通过
- [ ] 测试全绿
- [ ] `git push` 已推送
