---
name: plan-coding
description: >-
  Use when executing a numbered implementation phase from impl-plan.md
  in a DDD hexagonal Go project.
  Triggers: 实现阶段 / 编码阶段N / plan-coding / 开始写阶段 / implement phase N.
disable-model-invocation: true
allowed-tools: Bash(git *) Bash(go build *) Bash(go test *) Read Glob Grep Agent
---

# plan-coding

## Overview

严格按 **6-Phase 顺序**（加载上下文 → 骨架定义 → 测试先行 → 功能实现 → 构建验证 → CR）执行一个 impl-plan.md 阶段，每个 UC 独立 commit，不得跳步。
你是本项目的编码执行者，严格遵循 DDD 六边形架构和项目约定。

## When to Use

**Use when:**
- 收到"实现阶段N"指令，需执行 impl-plan.md 中指定阶段的编码任务
- DDD 六边形架构 Go 项目，有 `.specify/` 目录和 `impl-plan.md`

**When NOT to use:**
- 无 `impl-plan.md` 的项目（→ 先用 `/dddkit.implplan` 生成）
- 同时执行多个阶段（每次只执行一个阶段）

---

## Phase 1：上下文加载（使用 Explore subagent 并行读取）

### 1.1 启动 Explore subagent

派发以下任务给 `Explore` subagent（subagent_type: Explore），让它并行完成所有只读工作：

```
请并行读取以下内容并输出结构化报告：

1. impl-plan.md 路径：查找 .specify/specs/impl-plan/impl-plan.md
   - 定位用户指定的阶段N（$ARGUMENTS）
   - 列出该阶段所有 UC 编号和一句话描述
   - 找出 blockedBy 依赖，判断前置阶段是否已完成（标记为 ✅/❌）
   - 列出该阶段涉及的文件（待创建 / 待修改）

2. 上下文文档（按序读取关键部分）：
   - .specify/memory/constitution.md（目录结构约定 + 架构约束）
   - .specify/specs/impl-plan/domain-model.md（相关聚合章节）
   - .specify/specs/impl-plan/use-case.md（阶段N涉及的 UC 详情）

3. 现有代码骨架扫描：
   - internal/domain/ 目录结构（已有聚合和文件）
   - internal/application/ 目录结构
   - internal/adapter/ 目录结构
   - internal/assembler/ 目录结构
   - internal/common/ferror/errors.go（已有错误码常量）

输出格式：
## 阶段概况
- 阶段名：
- UC 列表：[UC-XXX: 描述, ...]
- 前置依赖：[阶段N ✅/❌, ...]

## DDD 归属映射
| UC | 领域层归属 | 聚合/文件 | 应用层方法 | 适配器入口 |
|----|-----------|----------|-----------|-----------|

## 待创建/修改文件清单
- 创建：[文件路径]
- 修改：[文件路径：原因]

## 需确认的歧义点
- [如有设计不明确的地方列出来]
```

### 1.2 依赖检查

如果 subagent 报告**前置阶段有 ❌ 未完成**，立即停止并告知用户：

```
⚠️ 阶段N 有前置依赖未完成：[阶段列表]
请先完成前置阶段，或确认是否强制继续。
```

### 1.3 歧义澄清（暂停点 #1）

如果 subagent 报告有歧义点，**在此暂停**，向用户逐条确认后再进入 Phase 2。
无歧义则直接继续，将 subagent 输出的结构化报告保留在上下文中。

---

## Phase 2：骨架定义（暂停点 #2）

根据 Phase 1 的 DDD 归属映射，**从高到低**依次定义骨架（只写签名，不写实现）：

**领域层骨架**（如有新聚合行为）：
- 新增 Event 常量
- 新增 Transition 条目（仅加到 `var Transitions` / `var NodeTransitions` 表）
- 新增方法签名（`func (e *XxxEntity) MethodName(...) error`）

**应用层骨架**（如有新用例入口）：
- Repository 接口新增方法声明（带注释说明查询语义）
- Command / Query 新增方法签名

**写完骨架后暂停，向用户展示骨架摘要，等待确认后再继续。**

示例确认提示：
```
📋 骨架摘要（共 N 处改动）：
- schedulingaggr: 新增 EventXxx, MethodA(params) error
- command.go: Repository 接口新增 FindByXxx(...)
是否确认骨架设计，继续编写测试？[Y/继续 / N/需调整]
```

---

## Phase 3：测试先行（domain 层）

**按 UC 顺序**，针对每个涉及 domain 层的 UC 编写单测（`*_test.go`）：

测试要求（参照 `.claude/rules/testing.md`）：
- 使用 `loadXxx(status, ...)` 辅助函数模拟从 DB 加载实体
- 正向路径：合法事件 / 方法调用，断言状态和 side effect 字段
- 非法路径：非法前置态，断言返回 `ferror.ErrIllegalTransition`
- 如有新增状态或事件，更新 `TestXxxStateMachineCompleteness` 完备性测试
- 禁止在 domain 层测试中依赖 DB / Redis / RPC
- 表驱动格式（≥3 个场景时）

**此阶段不跑测试**（实现尚未完成，编译会失败），仅确保测试文件语法正确。

---

## Phase 4：功能实现

**严格按以下层序实现，每个 UC 完成所有层后独立 commit**：

```
1. domain 层
   └─ entity.go：实现 Phase 2 定义的方法体
   └─ 如有新 Event/Transition，确认已加入转移表

2. assembler 层（如有新字段或新实体）
   └─ poconv.gen.go：PO ↔ DO 转换（新字段映射）
   └─ assembler.go：DTO / PB ↔ DO 转换

3. application 层
   └─ repository.go（若声明了新接口方法）：保持接口只声明，不实现
   └─ command.go / query.go：实现用例编排逻辑

4. adapter 层（如该 UC 需要新的入口或 repo 实现）
   └─ repoimpl/xxx.repo.go：实现 Repository 接口新增方法
   └─ driving/cron 或 kafka（如有新触发入口）
```

**每个 UC 实现完毕后执行 commit**：

```bash
git add <该 UC 涉及的所有文件>
git commit -m "feat(<scope>): UC-XXX <一句话描述>"
# 例：feat(scheduling): UC-015 PAUSED_RECOVERY 批量恢复 PAUSED_WAITING 实例
```

**编码约束（始终遵守）**：
- 事务内禁止 RPC 调用
- 跨聚合操作走领域事件，不直接持有另一个聚合根对象
- 禁止定义 `IsTerminal()`；`InstanceStatus` 用 `IsClosed()`
- 错误码用 302 号段，CC 与 FRPC NewErrXxx 对齐
- 幂等命中返回 `ResultCode`，不返回 `ErrorCode`

---

## Phase 5：构建 + 单测验证

所有 UC 实现完毕后，执行以下验证（**顺序不可颠倒**）：

```bash
# 1. 编译检查（覆盖所有内部代码）
go build ./internal/...

# 2. domain 层单测（含覆盖率）
go test -cover ./internal/domain/...
```

**覆盖率要求**：domain 层 ≥ 90%。

如果构建失败：定位编译错误 → 修复 → 重新构建，**不推进到下一步**。
如果单测失败：定位失败用例 → 修复实现或测试 → 重新运行，**不推进到下一步**。
如果覆盖率不足：补充缺失的测试用例，直到达标。

---

## Phase 6：代码 CR + 收尾

```bash
# 触发 /cr 对本阶段所有改动进行审查
# （/cr 会自动运行 git diff main...HEAD）
```

**CR 通过（无 🔴 严重问题）后**：

1. 更新 impl-plan.md，将阶段N标记为已完成：
   ```
   - [x] 阶段N：<阶段名> ✅ <完成日期>
   ```

2. 输出完成摘要：
   ```
   ✅ 阶段N 编码完成
   UC 列表：[UC-XXX ✅, ...]
   Commits：[git log --oneline 展示]
   覆盖率：domain 层 XX%
   ```

**CR 有 🔴 严重问题**：必须修复后重新跑 CR，不得直接告知用户完成。
**CR 有 🟠 高优问题**：向用户展示问题列表，由用户决定是否在本阶段修复。

---

## Common Mistakes

| 错误 | 后果 | 正确做法 |
|------|------|---------|
| 跳过 Phase 2 骨架确认直接写实现 | 方法签名/接口设计偏差，实现完要大改 | 骨架摘要必须等用户确认后再进 Phase 3 |
| Phase 3 写完测试就跑 `go test` | 实现未写，编译失败报错 | Phase 3 只检查语法，不运行测试 |
| 前置依赖 ❌ 仍强行推进 | 依赖的接口/实体不存在，编译必失败 | 必须停止，提示用户先完成前置阶段 |
| 多个 UC 合并成一个 commit | 无法按 UC 粒度追溯 | 每个 UC 所有层实现完后独立 commit |
| go build 失败还跑 go test | 浪费时间，掩盖真实错误 | build 通过才能跑 test，顺序不可颠倒 |

---

## 执行检查清单

```
Phase 1  □ subagent 已输出结构化报告
         □ 前置依赖全部 ✅
         □ 歧义已澄清（或无歧义）

Phase 2  □ 骨架已定义
         □ 用户已确认骨架

Phase 3  □ 每个 domain UC 有对应单测文件
         □ 完备性测试已更新（如有新状态/事件）

Phase 4  □ 每个 UC 独立 commit（格式：feat(<scope>): UC-XXX ...）
         □ 层序正确：domain → assembler → application → adapter

Phase 5  □ go build ./internal/... 通过
         □ go test -cover ./internal/domain/... 通过
         □ 覆盖率 ≥ 90%

Phase 6  □ /cr 无 🔴 严重问题
         □ impl-plan.md 阶段N已标记完成
```
