---
name: mr-review
description: >-
  Use when reviewing someone else's GitLab MR code via glab CLI.
  Triggers: review MR / CR别人代码 / 帮我看看这个MR / review MR #N /
  code review MR / 审查MR / 看看这个MR.
  NOT for: handling review comments on your own MR (→ cr-resolve).
metadata:
  author: ericmao
  version: "0.1.0"
license: MIT
---

# mr-review — Review 他人 MR 代码

## Overview

对 GitLab MR 做 code review：拉取 diff → 对照规范分析 → 按文件组织 comments → 用户确认后批量发送。
与 `cr-resolve`（处理别人 review 你的代码）相对——`mr-review` 是你去 review 别人的代码。

## When to Use

**Use when:**
- 需要 review 他人提交的 MR，给出 review comments
- 使用 GitLab + `glab` CLI 的项目

**When NOT to use:**
- 处理别人 review 你的 MR comment → 使用 `cr-resolve`

---

## 行为约束

- **subagent 拉取分析，结果写 /tmp**：主 context 只接收紧凑摘要，不直接加载大 diff
- **按文件组织**：所有 comment 按文件路径分组展示，不混在一起
- **暂停等用户确认**：展示 comment 列表后，等用户确认再发送
- **最小化改动建议**：只指出真实问题，不做风格偏好输出

---

## 前提条件

- `glab` 已安装并完成认证（`glab auth status` 验证）
- 用户提供了 MR 号

---

## 执行流程

### 第一步：用 subagent 拉取 diff + 分析，结果写 /tmp

**派发 Explore subagent** 完成拉取和分析，全部结果写入 `/tmp`，主 context 只接收紧凑摘要：

```
Explore subagent 任务：

1. 拉取数据：
   glab mr view <N> --output json       → 提取 MR 基本信息、diff_refs（base_sha/head_sha）
   glab mr diff <N>                     → 获取完整 diff
   glab mr note list <N> --output json  → 已有 comments（避免重复）
   若存在 .specify/memory/constitution.md → 读取项目规范

2. 统计变更文件列表，写入 /tmp/mr-<N>-meta.json：
   { "files": ["a.go", "b.go"], "base_sha": "...", "head_sha": "...", "mr_title": "..." }

3. 对每个变更文件，读取完整文件内容，对照以下规范分析：
   - ~/.claude/rules/go-coding.md        (编码约束)
   - ~/.claude/rules/go-design-patterns.md (设计模式)
   - ~/.claude/rules/go-code-smells.md   (坏代码味道)
   - .specify/memory/constitution.md     (项目规范，如存在)

4. 将分析结果写入 /tmp/mr-<N>-comments.json：
   [{ "file": "internal/service/order.go",
      "line": 47,
      "severity": "blocking",
      "rule": "go-coding: error handling",
      "issue": "err 被 _ 忽略",
      "suggestion": "if err != nil { return nil, fmt.Errorf(\"...: %w\", err) }" }, ...]

5. 仅返回紧凑摘要（主 context 只看这部分）：
   files: 5 changed
   blocking(2): order.go:47 error ignored, repo.go:23 constitution violation
   suggestion(3): order.go:89 magic string, user.go:12 god struct smell, order.go:110 no table test
   nit(1): repo.go:67 naming distance
```

### 第二步：按文件展示 comments（暂停点）

从 `/tmp/mr-<N>-comments.json` 读取，**按文件路径字母序**组织，等用户确认：

```
## internal/adapter/repo.go（1 条）
| 行 | 严重度 | 规则来源 | 问题 | 建议 |
|----|--------|---------|------|------|
| 23 | 🔴 blocking | constitution | handler 层直接调用 sql.DB，违反 Repository 约束 | 移入 OrderRepository |

## internal/service/order.go（3 条）
| 行 | 严重度 | 规则来源 | 问题 | 建议 |
|----|--------|---------|------|------|
| 47 | 🔴 blocking | go-coding | err 被 _ 忽略 | 显式处理并用 %w 包装 |
| 89 | 🟡 suggestion | go-code-smells | Magic string "pending" | 用常量 StatusPending |
|110 | 🟡 suggestion | go-coding | 无 table-driven test | 改用 []struct{} 表格 |

## internal/domain/user.go（1 条）
| 行 | 严重度 | 规则来源 | 问题 | 建议 |
|----|--------|---------|------|------|
| 12 | 🟢 nit | go-code-smells | 变量名 u 跨 15 行 | 改为 userProfile |
```

**严重度分级：**

| 级别 | 含义 | 是否阻断合并 |
|------|------|------------|
| 🔴 blocking | 正确性/安全/constitution 违反 | 是 |
| 🟡 suggestion | 代码质量/规范问题 | 建议修复 |
| 🟢 nit | 小改进 | 可选 |

### 第三步：批量发送 comments

用户确认后，将所有 comment 用脚本批量发送：

```bash
# 每个文件发一条组织好的 comment（包含该文件所有问题）
glab mr note create <N> \
  --message "### internal/service/order.go

**🔴 L47** \`err\` 被 \`_\` 忽略 — 显式处理并用 \`%w\` 包装

**🟡 L89** Magic string \`\"pending\"\` — 用常量 \`StatusPending\`

**🟡 L110** 无 table-driven test — 改用 \`[]struct{}\` 表格"
```

> 每个有 comment 的文件发一条独立 note，文件间不混淆。
> 若需要 inline diff comment（行级），改用 `glab api`：
> `glab api -X POST "projects/:fullpath/merge_requests/<N>/discussions" --field body="..." --field "position[new_path]=..." --field "position[new_line]=<line>" --field "position[base_sha]=<base_sha>" --field "position[head_sha]=<head_sha>" --field "position[position_type]=text"`

### 第四步：发送总结 comment

所有文件 comment 发完后，发一条总览：

```bash
glab mr note create <N> --message "## Review Summary

🔴 blocking（必须修复）：2 条
🟡 suggestion（建议修复）：3 条
🟢 nit（可选）：1 条

blocking 问题修复后 LGTM，可 approve。"
```

---

## Common Mistakes

| 错误 | 后果 | 正确做法 |
|------|------|---------|
| 直接在主 context 读 diff | 大 MR 撑爆 context | 用 subagent 拉取，结果写 /tmp |
| 所有 comment 混在一条 note 里 | 难以追踪，作者不知道改哪里 | 每个文件一条独立 note |
| 未等用户确认就发 comments | 发出错误或质量低的 comment | 必须展示列表，等用户确认 |
| 指出风格偏好（"我觉得应该这样写"）| 不客观，增加无意义讨论 | 只指出有规则依据的问题，标注 rule 来源 |
| 不检查已有 comments | 重复他人已提的问题 | 第一步先拉取 existing notes |

## AI Checklist

执行前：
- [ ] `glab auth status` 无报错
- [ ] 已获取 MR 号

执行中：
- [ ] subagent 已拉取 diff + existing notes
- [ ] 分析已对照 go-coding / go-design-patterns / go-code-smells / constitution
- [ ] comments 已按文件分组，严重度已标注 rule 来源
- [ ] 用户已确认 comment 列表

执行后：
- [ ] 每个文件一条独立 note 已发送
- [ ] 总结 comment 已发送
