---
name: rules-maintain
description: >-
  Use when the user wants to capture a recurring AI behavior constraint as a
  global rule, or audit existing rules in ~/.claude/rules/ for structural
  issues. Triggers: 加个全局规则 / 记住这个行为约束 / 这个以后都要遵守 /
  全局rules整理 / 审查rules / add global rule / audit rules.
  NOT for: project-specific conventions (→ spec-maintain),
  one-off task instructions.
metadata:
  author: ericmao
  version: "0.1.0"
license: MIT
---

# rules-maintain — 全局 Rule 管理

## Overview

将跨项目通用的 AI 行为约束沉淀到 `~/.claude/rules/` 或 `~/.claude/CLAUDE.md`。
核心原则：**判断 → 路由 → 查重 → 写入**。

## When to Use

**新增规则触发条件（满足任意一条）：**
- 用户纠正了 AI 行为后说"以后都要这样"/"记住这条规则"
- 同一类问题被纠正 2 次以上（系统性缺失）

**不适用 → 立即路由到正确位置：**
- 用户说"这个项目里…" → **停止**，这是 `spec-maintain` 的范围
- 一次性对话指令（只在本轮任务有效）→ 不记录任何地方

---

## 新增规则流程

### Step 1：两问过滤（两个都必须是"是"）

1. **跨项目适用？**："这条约束在我所有项目里都成立，不只是当前这个？"
2. **会复发？**："如果不记录，AI 下次遇到类似代码还会犯同样的错？"

若任意一个"否" → **停止**，无需写 rule

### Step 2：查重（必须执行 grep，不能只靠推理）

```bash
grep -ri "关键词" ~/.claude/rules/
grep -i "关键词" ~/.claude/CLAUDE.md
```

- 已有且清晰 → 停止
- 已有但模糊 → 在原文件补充说明
- 未覆盖 → 继续

### Step 3：选写入位置

| 条件 | 写入位置 |
|------|---------|
| 影响所有语言/场景的行为原则 | `~/.claude/CLAUDE.md` |
| 特定编程语言约束 | `~/.claude/rules/<lang>-<topic>.md` + `globs: "**/*.<ext>"` |
| 特定工具/平台操作规范 | `~/.claude/rules/<tool>-<topic>.md` + `alwaysApply: true` |

**文件命名：** `<域>-<约束主题>.md`，如 `go-error-handling.md`

### Step 4：写入 frontmatter + 规则

**rules/*.md 必须有 frontmatter，否则加载行为不确定：**

```yaml
---
globs: "**/*.go"      # 只对特定文件生效
alwaysApply: false
# 或
alwaysApply: true     # 对所有场景生效
---
```

**规则格式（要可操作，禁止写"代码要简洁"这类空话）：**

```markdown
## <规则名>

禁止：[具体行为 + 反例代码]
要求：[具体行为 + 正例代码]
例外：[明确列出，如无则省略]
```

### Step 5：告知用户

说明：写了什么、写到哪里、frontmatter 设置原因。
建议单独 commit：`docs(rules): 补充 <规则名>`

---

## 审查模式（用户要求整理现有 rules 时）

逐一检查每个文件，输出标准格式报告：

**检查维度：**

| 维度 | 检查方法 |
|------|---------|
| 是否有 frontmatter | 读文件头，看有无 `---` frontmatter 块 |
| globs 与内容是否匹配 | 对比 globs 范围与规则适用对象 |
| 规则是否可操作 | 能否用"禁止/要求 + 具体行为"表达？不能则为无效规则 |
| 与其他文件是否重复 | grep 关键词跨文件检查 |

**输出格式：**

```
文件               | 问题类型       | 建议
go-signature.md   | 缺 frontmatter | 加 globs: "**/*.go"
CLAUDE.md         | 与 constitution 重叠 4 条 | 已知，更新时注意同步
powershell.md     | globs 宽，内容窄 | 二选一：缩 globs 或泛化内容
```

---

## Common Mistakes

| 错误 | 后果 | 正确做法 |
|------|------|---------|
| 用户说"这个项目里"却写入全局 rules | 约束泄漏到其他项目 | "这个项目" → 停止，转 spec-maintain |
| 靠推理判断查重，不执行 grep | 写出重复甚至冲突的条目 | 必须跑 grep 命令 |
| rules/*.md 缺 frontmatter | 规则存在但不自动加载 | 必须写 alwaysApply 或 globs |
| 写"代码要规范"/"注意安全"这类规则 | 空话，agent 无法操作 | 必须具体到禁止/要求的行为 |
| 一次性指令也写入 rules | rules 臃肿，无关内容干扰 | "下次还会犯吗？"—不会则不记录 |
