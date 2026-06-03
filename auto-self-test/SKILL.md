---
name: auto-self-test
version: 1.1.0
description: Use when a developer self-tests a feature/branch before commit/MR/merge — for code changes touching business logic, or before writing self-test docs (plan.md / round_N.md / defects.md), or when validating implementation against PRD/技术方案/use-case docs. Triggers on "自测", "测试计划", "提测前", "回归测试", "用例缺口", "对照需求测一遍", "开发完了怎么测", "提测自测", "发版前自测".
---

# Self-Test (README + plan + round_N + defects 四件套)

## 目录

- [Iron Laws](#iron-laws)
- [核心约束](#核心约束)
- [Run vs Wave 概念](#run-vs-wave-概念)
- [Bug 优先级与状态](#bug-优先级与状态)
- [4 维度判定（每分支必跑）](#4-维度判定每分支必跑)
- [基础测试模板与测试方式](#基础测试模板与测试方式)
- [修复约束](#修复约束)
- [自测流程](#自测流程)
- [违规清单（看到 STOP 重做）](#违规清单看到-stop-重做)
- [常见合理化与现实](#常见合理化与现实)
- [项目规则联动](#项目规则联动)
- [不适用场景](#不适用场景)
- [References](#references)

## Iron Laws

> **违反字面 = 违反精神**。下列三条是底线，任何"我是按精神做的"都不算豁免。

1. **plan 先于 round** — 没有 plan.md 不开测；round 写到一半发现 plan 不全，回去补 plan，不要边跑边补。
2. **4 维度证据缺一不算 PASS** — 数据 / 返回 / 日志 / 告警，逐项核对。仅"功能跑通"不算 PASS。
3. **缺陷必入 defects.md** — P0/P1 必修；P2 推迟下迭代也要登记。bug 不进档 = bug 隐身。

## 核心约束

**每个 feature 自测产出 4 类文件，职责单一不重叠：**

| 文件 | 内容 | 谁看 | 变化频率 |
|---|---|---|---|
| `README.md` | feature 级入口：**1. 自测结论**（执行后填） + **2. 自测依据**（执行前填） | reviewer / leader / 自测人 / 审计 | 1 段执行后填，2 段开测前填 |
| `plan.md` | 场景级测试计划：1.场景概述 / 2.基础测试 / 3.业务测试 | plan 编写者 / reviewer | 需求/设计变才改 |
| `round_N.md` | 第 N 轮执行记录：实际入参 + 4 维度证据 + 修复 commit | 自测人 / reviewer | Run 进行中追加，结束后冻结 |
| `defects.md` | 缺陷档案 single source of truth：BUG 摘要 + 详情 | reviewer / leader | 缺陷状态变化时更新 |

**路径形态：**

| feature 触及对外入口数 | 形态 | 路径示例 |
|---|---|---|
| 仅 1 场景 | **平铺**（同目录）| `docs/auto-self-test/{branch}/{README,plan,round1,defects}.md` |
| ≥ 2 场景 | **场景子目录** + 顶层 README | `docs/auto-self-test/{branch}/README.md` + `docs/auto-self-test/{branch}/{scene}/{plan,round1,defects}.md` |

多场景目录树示意：

```
docs/auto-self-test/feature-order-create/
├── README.md                  # feature 级（跨场景）
├── createorder/
│   ├── plan.md
│   ├── round1.md
│   ├── round2.md              # 可选，第 2 轮
│   └── defects.md
├── cancelorder/
│   ├── plan.md
│   ├── round1.md
│   └── defects.md
└── ...
```

**命名规则：**
- `{branch}`：分支名 `/` 替换为 `-`（`feature/order-create` → `feature-order-create`）
- 目录名**不带日期**——日期归 round_N.md 元信息段，目录跟随分支生命周期；同分支多次自测沿用同目录、追加 round_(N+1).md
- `{scene}`：场景名小写 + 短横线（`createorder` / `notify-strategy-change`），与目录名一致
- 场景 = 一个对外入口（一个 RPC method / Cron Job / Kafka Consumer / HTTP endpoint）

**目录不存在时**：先告知用户将创建的完整路径（如 `docs/auto-self-test/feature-order-create/`），**确认后再 `mkdir`**，禁止不打招呼直接建目录。

**编号约定：**
- 不用 `§` 符号，直接写 `2.1` / `3.X.Y`，跳转用 markdown 链接 `[2.1](#21-xxx)`
- 章节号按文档实际顺序，不依赖 magic prefix
- plan.md 分支编号：`2.X` 基础测试 / `3.X` 业务测试（基础在前，业务在后）
- round.md 沿用 plan 的分支编号便于双向跳转

## Run vs Wave 概念

| 概念 | 含义 | 边界 |
|---|---|---|
| **Run（轮）** | 一次完整自测周期 | 触发：发版前 / 重大变更 / 长时间未测；Run N+1 与 Run N 完全独立，新建 round_(N+1).md |
| **Wave（波）** | 单 Run 内的执行批次 | 按"是否需重启 / 是否需改代码 / 是否依赖前波 setup"切分。在 round_N.md 的 2. 本轮执行规划 落地（第一波 / 第二波 / ...）|
| **Run 内单分支多次执行** | 同分支在同 Run 内反复跑 | 第 1 次 FAIL → 当场修复 → 第 N+1 次重测 PASS。**收尾时所有分支最后一次必须 PASS**，否则 Run 不算完 |

## Bug 优先级与状态

**优先级（按是否影响本次自测严格预期判定）：**

| 优先级 | 含义 | 处理 |
|---|---|---|
| **P0** | 影响本次自测的严格预期结果（4 维度任一 FAIL）| **必修**——预审发现→测前修；跑测发现→留 FAIL 证据 + 测中修 |
| **P1** | 不影响本次自测，但有生产风险 | 登记 → 用户决策（测前修 / 后续迭代）|
| **P2** | 边缘 / 性能 / 优化类，不影响验收 | 登记 → 推迟下迭代 |

**状态枚举（极简）：**
- `已修复`——已 commit + 回归 PASS
- `修复中`——当前 Run 进行中尚未完结（罕见）
- `推迟下迭代`——P2 类，不阻塞本次发版

不存在"未修复"作为最终状态——P0/P1 必修，到不了 round 收尾。

**编号**：`BUG{N}`（按发现顺序，全 feature 范围连续）

## 4 维度判定（每分支必跑）

| 维度 | 检查内容 | 判定标准 |
|---|---|---|
| **数据** | DB / 缓存 / 文件状态变化 | 行数 / 字段值符合严格预期 |
| **返回** | RPC / HTTP 响应（包头错误码 + 包体业务码两层）| 完全对齐严格预期，**两层都断言**漏一层即 FAIL |
| **日志（合理性）** | 见下方 3 子维度 | 全部命中 |
| **告警（合理性）** | 错误上报库（如 `errreport.Report`）| 该报报、不该报不报 |

**日志合理性 3 子维度：**

| 子维度 | 检查 | 反例 |
|---|---|---|
| **覆盖度** | 关键路径有业务 INFO / metric（不只 access log）| 早退分支只有 access log，业务定位困难 |
| **冗余度** | 同一事件不打多条 ERROR / 同源 stacktrace | DuplicateKey 触发 `_Save_Err` + `_TxErr` 双告 |
| **字段完整度** | 业务日志含 trace_id + 业务 ID（userID / orderID / reqID）| INFO 只打部分 ID，跨服务追踪困难 |

**告警合理性：**
- 真异常（DB 不可达 / 上游超时 / panic / DSL 解析失败）触发上报 ✅
- 预期内行为（业务规则拒绝 / 幂等命中）**不应**触发上报 ❌

**自测目标包含日志 / 告警体系验证**——不只验功能正确性。每个 round_N.md 的 5. 日志合理性回顾 段必填。

## 基础测试模板与测试方式

**基础测试 5 子类（mandatory baseline）：**

每个对外入口都必须在 plan.md 的 2. 基础测试 段落地以下子类。按场景实际选择适用项；N/A 子类必须在 README 2.5 显式给出原因。

| 子类 | 检查内容 | 典型测试方式 |
|---|---|---|
| **必填参数缺失** | 必填字段空 / 0 / null / missing 时应早退于参数校验 | 单测 / e2e 短路 |
| **参数类型异常** | 类型不匹配（脚本 / 跨语言调用场景）应被拦截 | 单测（正常 SDK 调用由 proto 保证）|
| **参数越界** | 超过 max / min 应早退或返回业务码 | 单测 |
| **非法字符 / 注入** | SQL 注入 / XSS / 特殊字符应被消毒或拦截 | 单测 |
| **空集合 / null** | 数组字段空 / 嵌套 null 应有明确处理 | 单测 |

**核心约束：**
- 基础测试**也是测试**，也要有 PASS / FAIL 结果
- plan.md 编号靠前（2.X），业务测试靠后（3.X）
- 分支结构与业务测试一致（4 子段：前置预期 / 测试输入 / 严格预期 / 代码预审发现）
- N/A 必须给原因，reviewer 看原因合理才放行

**测试方式（基础 + 业务测试通用）：**

> **硬原则：端到端（e2e）优先，单测是兜底。** 原则上每个分支都走 e2e；只有 e2e **实在无法稳定复现**的故障类场景（panic 模拟 / CAS 竞态 / 注入故障）才退到单测。"嫌 e2e 麻烦"不是理由——能造场景就必须 e2e。

每个分支必填"测试方式"字段，**默认 e2e**；不是 e2e 时必须说明原因。

| 测试方式 | 适用 | 必须说明的"为什么不 e2e" |
|---|---|---|
| `e2e` | 默认（绝大多数分支）| - |
| `单测` | **仅限** e2e 无法稳定复现：panic 模拟 / CAS 竞态 / 注入故障 | "e2e 难稳定造场景" / "并发竞态需 mock" |
| `mock token 短路` | 上游服务异常类（超时 / 不可控）| "上游服务不可控" / "回避不稳定的真实依赖" |
| `单测 + e2e` | 混合：主路径 e2e，故障路径单测兜底 | 说明哪部分用什么 |

**e2e 促成手段**：很多"看似要 mock"的场景可用辅助手段促成 e2e、不必退单测——改 SQL 造数据/状态、本地 producer 触发 MQ、http 触发 cron、改配置命中分支。**这些手段必须记入 round_N.md 对应分支**（具体 SQL / 命令），否则 PASS 不可复现。

**单测分支同样按 4 维度展开**：测试方式 = 单测的分支，round.md 也要列「输入 / 数据（mock 期望）/ 返回 / 日志（断言点）/ 告警（断言点）」5 项；不允许只列"PASS"或"go test 输出全绿"了事。判定标准与 e2e 完全一致。

**单测分支同样按 4 维度展开**：测试方式 = 单测的分支，round.md 也要列「输入 / 数据（mock 期望）/ 返回 / 日志（断言点）/ 告警（断言点）」5 项；不允许只列"PASS"或"go test 输出全绿"了事。判定标准与 e2e 完全一致。

**特殊入口形态（cron / Kafka consumer / 后台 job）：**

| 形态 | 4 维度落地特殊点 | 基础测试落地 |
|---|---|---|
| **cron / 后台扫描** | 返回维度 = `Tick(ctx)` 返回 `nil` / `error`（无 RPC 包头/包体）；"输入"是表数据条件 + 时间窗口 + 配置 | 5 子类按"扫描条件入参"判定（如 `time.Now()-2min` 边界、limit 上限、空结果集）；不可全 N/A |
| **Kafka consumer** | 返回维度 = handler 返回 `nil`（ACK）/ `error`（NAK）；"输入"是消息体 | 必填字段缺失 / 反序列化失败 / 字段类型异常 必有；空集合按消息体判定 |
| **HTTP / RPC** | 返回维度按包头 + 包体两层断言（默认形态） | 5 子类按 SKILL 默认形态全适用 |

> ⚠️ "我是 cron 没有业务入参"不是跳过基础测试的理由——后台 job 的"输入"是表数据 + 时间 + 配置，5 子类要逐项给 N/A 原因，不允许整段省略。

> 上表是 plan 期「验什么」。cron / 后台 job 的**执行手段**（怎么触发一次）属执行期：用 **http 触发端点主动触发**，不等自然调度——详见 [Step 3 环境与工具发现](#step-3跑测试--写-round_nmd)。

## 修复约束

| 约束 | 原因 |
|---|---|
| **每个缺陷独立 commit** | 便于回滚 / cherry-pick / review |
| **commit message 引用 BUG 编号** | 如 `fix(BUG3): identify DuplicateKey as IdempotentHit` |
| **commit ID 必须填入 round.md 修复段 + defects.md** | 未填 = 修复未完成 |
| **修复后必须重测原失败 case** | 同分支段下"第 N+1 次执行"，留前后对照 |
| **代码 + 日志 + 告警三方一并改** | 修 bug 同步检查日志覆盖度 / 抑制误告警 |

## 自测流程

> Step 0 先判断走哪条路，再按 Step 1-4 执行。**不要默认从零写 plan**——已有 plan 多半只需执行或局部更新。

### Step 0：入口判断（走哪条路）

定路线靠两样：**意图**（用户措辞，只是*信号*）+ **状态**（事实）。探测状态三件事：①有无 plan（看 `docs/auto-self-test/{branch}/`）②基线 = 父分支（复用 `git-mr-target-branch` 确定法，不确定问用户）③`git diff <父分支>...HEAD` 取全量改动点。

**意图 × 状态校验——矛盾必停，不盲从措辞**：

| 意图 | 状态 | 动作 |
|---|---|---|
| 创建 | 已有 plan | ⚠️ 停：重建覆盖？还是想更新 / 执行？默认不覆盖 |
| 更新 | 无 plan | ⚠️ 停：无 plan 可更新，是否改为创建？ |
| 执行 | 无 plan | ⚠️ 停：无 plan 没法跑，是否先创建？ |
| 执行 | plan 未覆盖新改动 | ⚠️ 停：plan 过时，先更新再跑 |
| 意图与状态一致 | — | ✓ 按下方分流 |

**四路分流**（校验通过后按状态走；改动点先列清单标「新增/修改/无需动」让用户确认，不自行判定就改）：

| 状态 | 路线 |
|---|---|
| 无 plan | ① 从零 → Step 1→2→3→4 |
| plan 已全覆盖 | ② 执行 → 锁定范围 → 直接 Step 3 |
| 新入口未覆盖 | ③ 增加 → 原 plan 追加（**不升版本**）→ Step 2→3 |
| 已覆盖入口逻辑变了（bug 修复 / 逻辑调整）| ④ 修改 → **升版本** → Step 2→3 |

**plan 版本机制（仅 ④ 修改用例启用）**：修改会让"历史 round 跑的旧预期"与"现在的新预期"对不上，需可追溯。三处同步：plan 头部 `> plan 版本：vN` + plan 内嵌版本历史表（版本/日期/变更/commit，样例见 plan-template）+ README 记当前版本。新增用例只增不改，不升版本。

### Step 1：开测前准备 — 写 README 2 段（自测依据）

**输入文档收集协议（必须逐项 ask，禁止猜测 / 自行 grep 推断）：**

需要 4 类输入文档，每类**单独问用户一次**，拿到链接 / 路径或显式"无"才能进入下一项。AskUserQuestion 4 个问题一次问完即可，但 4 类必须独立成项，不允许合并成"请把 4 类文档发我"。

| 序号 | 询问内容 | 用户可能的回答形态 | 拿不到时 |
|---|---|---|---|
| 1 | PRD / 需求文档在哪？ | 飞书链接 / Confluence URL / 项目内 `docs/prd-xxx.md` 路径 | 用户回"无 PRD"→ 在 README 2.2 显式标注"PRD 缺失"+ 列出风险（无业务诉求依据） |
| 2 | 技术方案 / 详细设计文档在哪？ | 同上 | 用户回"无技术方案"→ README 2.2 标注 + 提示发布前 checklist / 回滚方案需现场补 |
| 3 | use-case / 接受准则文档在哪？ | 同上，或一段口述 use-case | 用户回"无 use-case"→ 退回让用户至少口述一份接受准则；不允许 skill 自己根据 PRD 反推 |
| 4 | 已有测试用例 / 测试计划文档在哪？ | `docs/test-plan.md` / 历史 round_N.md / 单测目录 | 用户回"无"或"全新功能"→ README 2.2 标注"无历史用例" |

**询问形态**：每个问题给 2-3 个 option（常见路径模式 + "无此文档"），用户选 Other 自填具体链接。

**禁止行为**：
- 不问用户直接 `grep -r PRD docs/` 自行查找 → 找到的可能不是当前 feature 的 PRD
- 不问用户假设"PRD 没有就跳过 2.4 文档冲突分析" → 必须用户显式说"无"
- 4 类合并问"把相关文档发我" → 用户容易漏发，必须逐项确认

**收集完成后执行**：
```bash
git log main...HEAD --oneline
git diff main...HEAD --stat
```

> 环境与观测工具（在哪测、用什么发起、用什么查）属于**执行期**关注点，不在 Step 1 收集——见 [Step 3 环境与工具发现](#step-3跑测试--写-round_nmd)。Step 1 只管"验什么的依据"，不碰"在哪验/用什么验"。

**README 2 段产出：**
1. 2.1 Feature 元信息（分支 / 日期 / **功能变更摘要（改了哪些功能）** / 涉及服务 / 触及入口数 / 自测形态）
2. 2.2 输入文档（4 类链接）
3. 2.3 git diff 入口推导 → 决定单场景 vs 多场景目录形态
4. 2.4 文档冲突清单 — 4 类文档不一致点逐条让用户确认采信哪份（写"无"是可疑信号）
5. 2.5 测试分类与覆盖矩阵（基础测试适用项 + N/A 原因 / 业务测试用 case 大纲）
6. 2.6 索引（4 件套链接）

### Step 2：写 plan.md + 代码预审

> **关注点分离原则**：plan 只写「**验什么**」（4 维度严格预期：必有哪些日志、哪些表字段变成什么、返回什么、该不该告警），**不写**「在哪验 / 用什么验」（日志去本机还是 FLS、用什么 client 发请求、连哪个库）——后者是 Step 3 执行期的事，跟 plan 无关。plan 跨环境复用：同一份 plan 既能在本地实例跑，也能在测试环境跑。

按 `templates/plan-template.md` 骨架填写每个场景的 plan.md。

**plan.md 必含：**
- 1. 场景概述（入口 / UC / 客户端工具 / 核心实现）
- 2. 基础测试 2.X（按 README 2.5 适用项落地）
- 3. 业务测试 3.X（按 use-case 接受准则推导）

每个分支结构：
- 标题 + 目的 + **代码执行路径** + 测试方式
- X.1 前置预期状态（DB / 下游 / 消息中间件 / Setup 手段）
- X.2 测试输入（命令行 + 请求体；多步用编号列表）
- X.3 严格预期结果（数据 / 返回 / 日志 / 告警 4 维度，**粗体段名**非 H5）
- X.4 代码预审发现（缺陷概要表，详情链 defects.md）

**代码预审（subagent）：**

写完 plan.md 的 X.3 严格预期后，dispatch Explore 或 general-purpose subagent：

> 任务：Read code along the 代码执行路径 of branch X. Compare actual implementation against 严格预期 X.3 (4 dimensions). Report bugs with priority P0/P1/P2.

Subagent 返回的 bug 候选 → 登记 defects.md → 在 plan.md X.4 概要表填上 BUG 编号 + 优先级 + 状态。

P0 缺陷必须在跑测前修复（commit hash 入 defects.md）。修复完再跑一次 subagent 预审验证；通过后 plan.md X.4 状态改 ✅。

### Step 3：跑测试 + 写 round_N.md

按 `templates/round-template.md` 骨架。

**环境与工具发现（Step 3 开场，先定后跑；结果记入 round_N.md 元信息「自测环境」段）：**

1. **选环境**（AskUserQuestion 二选一）：

   | | 本地实例 | 测试环境实例 |
   |---|---|---|
   | 服务跑在 | 本机（IDE / 本地进程）| 测试环境部署 |
   | 适合 | 易造数据 / 改状态 / 触发 cron，改代码即时验 | 链路接近线上、依赖真实下游 |

   > 注意：**两种环境的 DB 都连测试库**（如 `10.2.4.131`），所以数据查询工具一致，差异主要在"执行手段连到哪"和"日志去哪查"。

2. **执行手段**（统一用本地 client 发起，按入口形态选）：

   | 入口 | 本地 client | 连到 |
   |---|---|---|
   | RPC | grpc client / 自研 cli | 本地端口 / 测试环境 RPC 地址 |
   | HTTP | curl / 内部网关 | 对应环境 |
   | Kafka | 本地 kafka producer（`kafka-console-producer` / 项目 producer 脚本）| 对应环境 broker |
   | **cron / 后台 job** | **本地 curl 打 http 触发端点主动触发**（不等自然调度），如 `curl -X POST http://<host>/internal/cron/trigger?job=<name>` | 对应环境 http 入口 |
   | 单测 | `go test -run XXX` | 进程内（不连环境）|

3. **观测工具**（都在本机跑，指向随环境变）：
   - 数据：`mycli` 连测试库（恒定，Bash 调 `mycli --dsn <alias> -e "..."`）
   - 日志：本地 log grep（本地实例）/ `Skill observability-skills`→FLS（测试环境）
   - 告警：告警平台 web / 单测 mock collector

4. 全轮严格按本段记录执行，**不临时换工具**；CLI 形态用 Bash、Skill 形态用 Skill tool、Web 用 WebFetch，禁止形态错配。

**round_N.md 必含 5 段：**
1. 元信息（Run 编号 / 起止 / 执行人 / 状态 / 自测环境）
2. 本轮执行规划（第一波 / 第二波 / 第三波，简短列分支即可）
3. 执行结果（每分支：执行历史表 + 每次执行的实际入参 + 4 维度结果）
4. 本轮验收小结（极简：N 个分支全 PASS + 修复缺陷列表）
5. 日志合理性回顾（4 子维度 PASS / 发现表）

**执行纪律：**
- 失败立即停下分析根因，**不掩盖**
- 禁止改测试代码 / 验证 SQL 让结果"看起来通过"
- 跑出 FAIL → 必修（commit + 回归 PASS）→ 才算分支完成
- 单测分支也要在 round.md 出现（按"怎么做的怎么写"形态）；不存在 SKIP 状态

**PASS 分支日志最小证据**（防"贴 3 行说没问题"）：
- trace_id + trace 内总条数（**按 round_N.md 自测环境段记录的观测工具查**——CLI 形态用 Bash 调命令，Skill 形态用 Skill tool 调用，Web 形态用 WebFetch；禁止形态错配）
- must-have 命中清单（对照 plan.md X.3 必有日志逐条核对）
- must-not-have 检查（plan.md X.3 必无日志逐条核对 + ERROR/WARN 数声明）
- 字段完整度抽查（截 1-2 条业务 INFO 原文）
- 告警维度独立判定（错误上报触发与否 + 合理性）

数据维度同理：按 round_N.md 自测环境段记录的工具查（如 Bash `mycli --dsn xxx -e "..."`），禁止默认 `mysql -u root -p`。

仅当全部通过才能写 PASS。仅贴 3 行 access log 就 PASS = 红旗。

### Step 4：维护 defects.md + 填 README 1 段验收

**defects.md 必含 2 段：**
1. 摘要（编号 / 简述 / 优先级 / 状态 / 发现源 / 修复 commit）
2. 详情 — 每个 BUG 一段 H3：
   - 字段表（优先级 / 状态 / 发现源 / 修复 commit / 修复 round / 回归证据）
   - **根因（强制格式三件套）**：
     - ① 文件路径 + 行号（如 `internal/domain/core/scheduling/service.alert_waiting.go:50-52`）
     - ② 贴问题代码块，**用行内注释标问题点**（`// ❌ ...` / `// ← 缺这个` / `// 注意：...` 等）；多个相关代码段并列贴出便于对比
     - ③ 一句话总结问题本质（如"字段不对称导致归档跳过日志查询时无法直接定位 DAG 节点"）
     - 不允许只用纯文字描述根因，必须贴代码
   - **修复方案（代码层 + 日志层 + 告警层 三方分组）**：
     - 代码层：贴修复后代码块，**标记修复部分**——可选 diff 风格 `+ / -`、行内注释 `// 新增` / `// 修改`、或贴"修复前 vs 修复后"两块代码对比，让 reviewer 一眼看到改动边界
     - 日志层：列出新增 / 删除 / 改名的日志事件
     - 告警层：列出新增 / 删除 / 抑制的告警调用
   - 关联 / 后续计划（推迟类必含现象 / 风险 / 应急 / 后续计划 / 已周知）

**README 1 段产出：**
1. 1.1 自测结果总览（场景 / 基础测试 PASS-FAIL / 业务测试 PASS-FAIL / 跑过轮次 / 状态 / 链接）
2. 1.2 发布前 checklist（依据技术方案的发布计划段，**勾选动作**而非复制设计）
3. 1.3 发布计划（依据技术方案的回滚方案段；灰度时间线 + 失败回滚 + 应急联系）
4. 1.4 已知问题与上线决策（带病上线必含：未解决项 + 风险 + 应急 + 已周知名单）

## 违规清单（看到 STOP 重做）

> 违反字面 = 违反精神。看到任一违规模式 → 停下，按修正方向重做。

| 违规模式 | 修正方向 |
|---|---|
| **文件结构类** | |
| 建 evidence/ 子目录 / 多个 .log / .sql 外部文件 | 证据内嵌主文档 |
| 按 Round 1/2 拆 acceptance.md / round1-summary.md | 多轮直接用 round1.md / round2.md，不拆汇总文件 |
| 把 plan 和 round 合在一份文件里 | 强分离四件套 |
| 列被测系统全部场景（不是 git diff 推导出的）| 只覆盖本 feature 触及的入口 |
| heading 里放 emoji（✅/❌/⏸） | 移到正文，heading 保持纯文本 |
| 跨文档锚点用中文 GFM slug 失效 | 给被引用 H 加 inline `<a id="x"></a>`（同行末尾），引用用 short id |
| **流程类** | |
| 照用户措辞硬干（说"创建"就建，已有 plan 也覆盖；说"跑自测"就跑，无 plan 也硬上）| Step 0 意图 × 状态校验：矛盾必停下 ask，不盲从措辞 |
| 跳过 4 文档冲突分析直接写 plan | 回 Step 1 收集 4 类输入 |
| Step 1 不问用户、自行 grep 项目找 PRD / 技术方案 / use-case | 退回逐项 ask 用户给链接或路径，每类独立确认 |
| 4 类输入文档合并问"请把相关文档发我" | 拆成 4 个独立 ask（PRD / 技术方案 / use-case / 已有用例），用户漏发的就显式标"无"+ 风险 |
| 跑测不问环境 / 观测工具，默认 `grep log/` / `mysql -u root` | Step 3 开场必须先选环境（本地/测试）+ 确定执行手段 + 观测工具，记入 round_N.md 自测环境段 |
| 把"环境与工具"塞进 Step 1 / README 2.1 | 环境与工具是执行期关注点，归 Step 3 + round_N.md；README/plan 只记"验什么" |
| 用户已确定 mycli DSN alias，跑测时却用 Bash `mysql ...` | 必须 Bash `mycli --dsn <alias>` 调用，禁止换工具；切换工具 = 偏离 round_N.md 自测环境段记录 |
| 把 CLI 当 skill 调（`Skill mycli`）或把 skill 当 CLI 跑（`bash observability-skills`）| round_N.md 自测环境段必须显式记「形态」（CLI / Skill / Web），跑测时按形态选 Bash / Skill tool / WebFetch |
| cron / 后台 job 等自然调度触发，干等几十秒 | 用 http 触发端点主动触发一次（`curl -X POST .../cron/trigger?job=<name>`）|
| BUG 根因只用文字描述，不贴代码 | 必须文件路径+行号 → 代码块带行内注释标问题点（`// ❌` / `// ←`）→ 一句话总结。三件套缺一不可 |
| BUG 修复方案贴了修复后代码但不标"修改了哪几行" | 必须用 diff 风格 / `// 新增` `// 修改` 注释 / 或修复前后并列对比，让 reviewer 一眼看到改动边界 |
| 用户没确认冲突就动手写 plan | 停下，先 ask |
| 基础测试 N/A 列没原因 | 退回 README 2.5 要求填理由 |
| 单测分支不在 round.md 出现 | 单测也是测试方式之一，必须有 PASS 结果 |
| 4 文件信息互相覆盖 | 按职责分边界：依据归 README 2 / 计划归 plan / 实测归 round / 缺陷归 defects |
| **断言完整度类** | |
| 跳过 4 维度判定 | 每分支必按数据/返回/日志/告警 4 维度对照 |
| 自测分支只断一层 code | 必须包头 + 包体两层都断言 |
| plan.md 返回维度只写 `code=X` 没说包头还是包体 | 补两层断言（包头错误码 + 包体业务码） |
| PASS 分支日志小节只贴 3-5 行 + "无 ERROR" | 补 5 项最小证据（trace_id / must-have / must-not-have / 字段抽查 / 告警） |
| TC 表里每条只标 ✅ 不展开 4 维度 | 概览表可压缩，但每条 TC 必须有独立段落展开数据/返回/日志/告警 4 维度证据 |
| 单测分支只列 "PASS" 或 "go test ... ok" | 单测也按"输入/数据 mock 期望/返回/日志断言点/告警断言点" 5 项展开 |
| 能 e2e 却图省事走单测 | e2e 是硬原则；单测仅限 panic / CAS / 注入等 e2e 无法稳定复现的场景。能造场景就必须 e2e |
| e2e 靠改 SQL / 触发 MQ 促成，但 round 没记手段 | 促成手段（具体 SQL / 触发命令 / 改的配置）必须记进 round_N.md 对应分支，否则 PASS 不可复现 |
| "必有日志"用三列表格塞"必含字段"多值 | 改用列表（每条独立项 + 必含字段子项） |
| **修复 / 缺陷类** | |
| 修复 bug 只改代码不补日志 | 代码 + 日志 + 告警三方一并改 |
| 缺陷修复混在其他 commit 里 | 每个缺陷独立 commit + commit ID 入档 |
| 修复段 commit ID 留空 | 修复未完成，不允许标 PASS |
| 在 round.md 详细展开修复 commit / 改动 | 修复细节归 defects.md，round.md 只引用 |
| plan.md 写"修复方向 / 修复细节" | plan 只留概要 + 状态，详情归 defects.md |
| round.md 写"问题与修复"内联段（不分文件） | bug 全部拆到 defects.md，round.md 只引用 BUG{N} 编号 |
| bug 用"问题 1 / Issue / Bug N / 缺陷 N"等命名 | 必须用 `BUG{N}` 全 feature 范围连续编号；defects.md 摘要表 + 详情 H3 都用此编号 |
| defects.md 缺优先级 / commit hash 任一字段 | P0/P1/P2 + commit hash + 状态 三件套缺一不可 |
| **执行纪律类** | |
| Round 2 修改了 Round 1 的 FAIL 证据 | 撤回，FAIL 历史保留作为缺陷发现痕迹 |
| Run 内 case 第 1 次 FAIL 后没第 N+1 次执行就标 PASS | 必须重测，不允许跳过 |

## 常见合理化与现实

| 借口 | 现实 |
|---|---|
| "这个分支太简单，4 维度走形式" | 4 维度对照 30 秒就能跑完。基础分支恰恰最容易漏掉日志/告警维度问题 |
| "我先跑了再补 plan" | 没 plan 跑出的结果无法对照严格预期，不能算自测——只是手动验证 |
| "PASS 直通分支贴 3 行 access log + '无 ERROR' 就够了" | PASS 5 项最小证据缺一不可——trace_id / must-have / must-not-have / 字段抽查 / 告警 |
| "代码预审是 reviewer 干的事，自测前不用做" | 代码预审是开测前 walkthrough，发现 bug 测前修；不是替代后续 reviewer |
| "这个 bug 简单，直接修了不用登记 defects.md" | P0/P1/P2 都要登记。bug 不入档 = bug 隐身 = 后续 reviewer / 自己回顾时无法追溯 |
| "单测分支不用进 round.md，CI 跑过就行" | 单测也是测试方式之一，必须在 round.md 出现 PASS 结果，按"怎么做的怎么写"展示 |
| "互斥 / 频控拒绝是错误，应该 ferror.Report" | 业务规则拒绝不是系统异常，告警合理性维度会判 FAIL |
| "测试方式没填，反正都是 e2e" | 测试方式必填。是 e2e 也要写 `e2e`；不是 e2e 必须给"为什么不 e2e"理由 |
| "这个 case 要造数据/造状态麻烦，走单测算了" | 先试 e2e 促成手段：改 SQL 造数据、手动触发 MQ、http 触发 cron。只有 panic/CAS 这类真的造不出来才退单测 |
| "cron / 后台 job 没业务入参，基础测试 5 子类全 N/A 不用列" | 后台 job 的"输入"是表数据条件 + 时间窗口 + 配置；5 子类要在 README 2.5 逐项列 N/A 原因，不允许整段省略。常见命中项：扫描时间窗口边界、limit 上限、空结果集 |
| "bug 写在 round.md '问题与修复' 段更紧凑，不用拆 defects.md" | 缺陷必须独立到 defects.md：①跨轮跟踪同一 bug 时不必翻多个 round；②README 1.4 上线决策段需要直接引用编号；③reviewer 看缺陷只看一份文件。round.md 只列 BUG{N} 编号 + 引用链 |
| "我自测发现的 bug 简单，叫 '问题 1' 就行" | 必须 BUG{N} 全 feature 连续编号。命名混乱 = 多轮 round / 多场景跨引时无法对齐 |
| "查日志直接 `grep <trace_id> log/...` 就行，应该有本地日志吧" | 本地实例可能有本地 log，测试环境得用 FLS（observability-skills）。Step 3 选完环境再定日志查询通道，记 round_N.md 自测环境段，别想当然 |
| "MySQL 直接 `mysql -u root -p` 连一下" | 不管本地还是测试环境都连测试库，用 `mycli`（CLI）。Step 3 确定连接 alias，禁止瞎试 `mysql -u root` |
| "cron 自测等它 30s 自己跑一次就行" | 干等浪费时间且难对齐时序；用 http 触发端点主动触发一次，立即验证 |

## 项目规则联动

skill 启动时检测下列文件，存在即读取：
- `.claude/rules/testing.md` — 项目测试规范（覆盖率、命名）
- `.claude/rules/<domain>.md` — 领域规则
- `AGENTS.md` / `.specify/memory/constitution.md` — 项目最高约束
- `CLAUDE.md` — 项目根指引

## 不适用场景

- 写具体单测代码 → `superpowers:test-driven-development`
- 调试 bug → `superpowers:systematic-debugging`
- 已有完整 plan.md 只是要执行 → 直接读 plan 写 round_N.md
- 单纯跑 `go test` → 不需 skill

## References

- [`templates/readme-template.md`](templates/readme-template.md) — README.md 真实样例（1. 自测结论 + 2. 自测依据 两段）
- [`templates/plan-template.md`](templates/plan-template.md) — plan.md 真实样例（场景概述 + 基础测试 + 业务测试）
- [`templates/round-template.md`](templates/round-template.md) — round_N.md 真实样例（含 PASS 直通 / FAIL→修→PASS / 单测三种分支形态）
- [`templates/defects-template.md`](templates/defects-template.md) — defects.md 真实样例（含已修 / 推迟两种缺陷形态 + 代码片段示意）

> 4 个模板均用统一示例（订单服务 CreateOrder + BUG3 幂等命中缺陷 + BUG7 性能问题）贯穿，复制结构后按本项目实际场景替换。
