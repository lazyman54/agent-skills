---
name: rules-maintain
description: >-
  Use when the user wants to capture a recurring behavior constraint as a
  global Claude rule, audit existing rules for redundancy or gaps, or add a
  new rule file to ~/.claude/rules/. Triggers: 加个全局规则 / 记住这个行为约束 /
  全局规则整理 / 这个以后都要遵守 / 审查全局rules / add global rule /
  audit rules / rules 查重.
  NOT for: project-specific conventions (→ spec-maintain),
  one-off task instructions, business requirements.
metadata:
  author: ericmao
  version: "0.1.0"
license: MIT
---

# rules-maintain — 全局 Rule 管理

## Overview

将跨项目通用的行为约束沉淀到 `~/.claude/rules/` 或 `~/.claude/CLAUDE.md`，防止同类纠正反复出现。
核心原则：**判断 → 定位 → 查重 → 写入** — 先确认是否值得全局记录，再找对位置，最后写入。

## When to Use

**触发条件（满足任意一条）：**
- 用户纠正了 AI 行为，并说"以后都要这样" / "记住这条规则"
- 同一类问题被纠正了 2 次以上（说明是系统性缺失，不是一次性指令）
- 用户明确说要整理/审查现有全局 rules

**不适用场景：**
- 只在当前项目生效的约定 → 使用 `spec-maintain`
- 一次性对话指令（只在本轮任务有效）
- 需求变更、业务逻辑说明

---

## 执行步骤

### Step 1：判断是否值得全局记录

两个问题（**两个都要是"是"** 才继续）：

1. **"这条约束在任何项目里都适用，而不只是当前项目？"**
2. **"如果不记录，AI 下次还会犯同样的错？"**

典型需要记录：
- AI 行为模式（如"回复不加多余 emoji"、"代码注释不写 what 只写 why"）
- 特定工具的操作禁令（如"飞书含画板文档禁 replace_all"）
- 语言/格式偏好（如"回复用中文"）
- 特定技术域约束（如"Go 签名默认单行"）

典型不记录（停止）：
- 当前任务的业务特殊逻辑
- 已有 rule 覆盖的内容
- 只针对一个项目的架构约定（→ spec-maintain）

任意答案为"否" → **停止**，无需更新 rules

### Step 2：定位写入位置

```
优先级：
1. ~/.claude/CLAUDE.md         — 顶层哲学原则、工具链特有操作规则（如飞书）
2. ~/.claude/rules/<name>.md   — 特定域约束（Go、测试、特定工具）
```

**选 CLAUDE.md 的情形：**
- 影响 AI 所有行为的基础原则
- 特定 CLI 工具/平台的操作规范（飞书、glab 等）
- 语言/回复风格偏好

**选 rules/<name>.md 的情形：**
- 特定编程语言约束（Go / Python / Shell）
- 特定场景约束（测试、命名、格式）
- 需要通过 `globs` 限制生效范围的规则

**文件命名规则：** `<语言/域>-<约束主题>.md`，如 `go-signature-style.md`、`test-coverage-gate.md`

### Step 3：查重（避免重复记录）

读取目标文件，用关键词搜索是否已有相关约定：

```bash
grep -ri "关键词1\|关键词2" ~/.claude/rules/
grep -i "关键词" ~/.claude/CLAUDE.md
```

- 已有记录且表述清晰 → **停止**
- 已有记录但表述模糊 → 补充澄清，不要重复
- 未记录 → 继续 Step 4

### Step 4：确定写入格式

**rules/<name>.md 的 frontmatter：**

```yaml
---
description: 一句话说明约束内容和适用场景
alwaysApply: true          # 所有文件都生效时用这个
# 或
globs: "**/*.go"           # 只对特定文件生效时用这个
alwaysApply: false
---
```

**规则条目格式：**

```markdown
## <约束名称>

**规则**：[一句话，说明做什么和为什么]

- 禁止：[具体禁止行为]
- 要求：[具体要求行为]
- 原因：[违反后果，可选]
```

对于 CLAUDE.md 中的简短规则，直接一句话或一个 bullet 即可，不需要完整 H2 结构。

### Step 5：写入并告知用户

完成写入后说明：
- 写入了什么内容
- 写入到哪个文件
- frontmatter 中的 `alwaysApply` / `globs` 设置及原因
- 建议单独 commit：`docs(rules): 补充 <约束名称> 全局规则`

---

## 审查模式（用户要求整理现有 rules 时）

若用户说"整理 rules" / "审查 rules" / "rules 有哪些"，执行以下操作：

1. **列出所有来源**：`~/.claude/CLAUDE.md` + `~/.claude/rules/*.md`
2. **对每条规则标注**：
   - 适用范围（所有项目 / Go 专用 / 特定工具）
   - 加载时机（alwaysApply / globs / 手动引用）
3. **识别问题**：
   - 重复：两条规则核心意思相同
   - 缺 frontmatter：rules/ 下的文件未声明 globs/alwaysApply，加载行为不明确
   - 过于宽泛：规则表述模糊，agent 可以 rationalize

4. **给出改进建议**（等用户确认后再改）

---

## Common Mistakes

| 错误 | 后果 | 正确做法 |
|------|------|---------|
| 把项目约定写入全局 rules | 在其他项目里产生干扰或错误 | 项目约定 → spec-maintain |
| 一次性指令也写入 rules | rules 臃肿，无关内容干扰 AI | 问"下次还会犯吗？"不会则不记录 |
| 跳过查重直接写入 | 出现重复甚至冲突条目 | 总是先 grep 关键词 |
| rules/*.md 缺 frontmatter | 加载时机不明确 | 明确写 alwaysApply 或 globs |
| 写入 CLAUDE.md 但只对 Go 有效 | 非 Go 项目也加载，浪费 token | 迁移到 rules/go-xxx.md + globs |
| 规则表述太泛（"代码要简洁"） | Agent 无法操作，形同没有 | 写具体禁止行为和判断标准 |
