---
name: spec-maintain
description: >-
  Use when a code review comment reveals a general coding convention or
  architectural rule that may be missing from the project specification.
  Triggers: 规范缺失 / 项目约定未记录 / reviewer 提到通用规则 / 这条规范要不要加到文档 /
  constitution 需要更新 / update project spec / sync convention to spec.
  NOT for: updating business requirements docs, changing API contracts.
---

# spec-maintain

## Overview

将 CR 中发现的通用规范沉淀到项目规范文件，防止同类问题反复出现。
核心原则：**识别 → 查重 → 写入** — 先判断是否通用，再确认未记录，最后写入正确位置。

## When to Use

**触发条件（满足任意一条）：**
- Reviewer 评论指出了一个"项目约定"或"通用规则"（而非只针对当前代码）
- 你修复的问题在多个地方存在，说明这是系统性约定缺失
- 用户问"这条规范要记录吗？记到哪里？"

**不适用场景：**
- Reviewer 只是建议改善当前这段代码的写法（局部优化，不是全局约定）
- 规范已在 constitution.md 中有明确记录
- 需求变更、API 合约修改（改需求文档，不是规范文件）

## 执行步骤

### Step 1：判断是否为通用规范

问两个问题（**两个都要是"是"** 才继续）：

1. **"如果另一个开发者写类似代码，他应该遵守这条规则吗？"**
2. **"这条规则是项目/架构特有的，而不是语言最佳实践或行业常识？"**

**需要记录（典型例子）：**
- 架构约束（禁止跨聚合引用、事务边界规则）
- 项目特定的错误码段划分
- 领域事件命名或发布约定
- 分层禁止规则（如 domain 层禁止 RPC）

**不需要记录（停止）：**
- 基础编码风格（变量命名要有语义、避免魔法数字）→ 这是行业常识
- 只针对当前代码的局部改进建议
- 规范已在文件中有记录

任意一个答案为"否" → **停止**，无需更新规范

### Step 2：定位规范文件

按优先级搜索：

```bash
# 首选：项目 constitution（最高约束文件）
find . -name "constitution.md" -path "*/.specify/*" | head -1

# 次选：项目级开发规范
find . -name "AGENTS.md" -maxdepth 2 | head -1

# 如果两者都没有
echo "需要创建规范文件，建议路径：.specify/memory/constitution.md"
```

### Step 3：查重（避免重复记录）

读取规范文件，用关键词搜索是否已有相关约定：

```bash
grep -i "关键词1\|关键词2" .specify/memory/constitution.md
```

- 已有记录且表述清晰 → **停止**，无需修改
- 已有记录但表述模糊 → 补充澄清，不要重复
- 未记录 → 继续 Step 4

### Step 4：确定写入位置

规范文件通常有章节结构，找最匹配的章节：

| 规范类型 | 写入章节 |
|---------|---------|
| 聚合/领域边界 | `## DDD 约束` 或 `## 聚合设计` |
| 事务管理 | `## 数据库约定` 或 `## 基础设施约束` |
| 错误处理 | `## 错误码规范` |
| 分层约束 | `## 架构约束` |
| 命名规范 | `## 命名约定` |

如果找不到匹配章节，在文件末尾新建合适的 `##` 章节。

### Step 5：写入规范条目

写入格式：

```markdown
- **[规范名称]**：[一句话描述，说明做什么和为什么]
  - 禁止：[具体的禁止行为]
  - 要求：[具体的要求行为]
  - 原因：[违反后果，可选]
```

示例（跨聚合约束）：

```markdown
- **跨聚合协作**：聚合之间禁止直接持有对方聚合根引用，跨聚合操作必须通过领域事件驱动。
  - 禁止：在聚合内 inject 或 return 另一个聚合根对象
  - 要求：通过 ID 关联，状态变更走 DomainEvent + EventHandler
  - 原因：直接引用会扩大事务边界，导致循环依赖和并发冲突
```

### Step 6：告知用户

完成写入后，向用户说明：
- 写入了什么规范
- 写入到哪个文件的哪个章节
- 如需提交，建议单独一个 commit：`docs(spec): 补充 [规范名称] 约束`

## Common Mistakes

| 错误 | 后果 | 正确做法 |
|------|------|---------|
| 跳过查重直接写入 | 规范文件出现重复甚至冲突的条目 | 总是先 grep 关键词 |
| 把局部优化当通用规范记录 | 规范文件被无关条目污染 | 用 Step 1 的两个问题同时判断 |
| 把编码常识当项目规范记录（如"变量要有语义"）| 规范文件充斥显而易见的内容，失去价值 | Step 1 第二问：是否项目/架构特有？ |
| 写入位置随意 | 规范散乱，难以查找 | 匹配现有章节，找不到才新建 |
| 与 CR 修复合并为一个 commit | 规范变更和代码变更混在一起，难以追溯 | 规范更新单独 commit |
| constitution.md 不存在就放弃 | 规范永远没有落地 | 找不到文件时建议创建，路径用 `.specify/memory/constitution.md` |
