---
name: test-env-triage
version: 1.0.0
description: Use when triaging a problem in the dev/test environment — RPC/interface errors, stuck workflow instances, wrong or missing data, service won't start, config not taking effect, cron not firing, MQ not consuming. Use when you don't know where to start looking, or are tempted to grep blindly / patch a symptom without locating the root cause. Triggers on "排查", "测试环境出问题", "接口报错怎么查", "工作流卡住", "实例不流转", "节点不执行", "数据不对", "服务起不来", "配置不生效", "cron 不触发", "从哪开始查", "定位根因".
---

# Test-Env Triage（测试环境问题分诊 + 排查导航）

## Overview

测试环境出问题时，最常见的浪费是**凭现象猜 + 一上来 grep 全项目 + 随手改一处看好没好**。这和瞎改代码一样：浪费时间、制造新问题、还可能把真根因盖住。

**核心原则：先分诊、再分层收窄、定位到根因层才交棒，禁止跳层瞎猜。**

这个 skill **不是又一套调试方法论**——它是 `superpowers:systematic-debugging` 的 **Phase 1（根因调查）在本项目测试环境的具象化 + 工具编排**。它把抽象的"reproduce / gather evidence at each component boundary / trace data flow"落成本项目的层（返回码 → 日志 → 数据 → 代码）和具体工具（observability / mycli / frpc）。走完它（定位到根因层 + 证据）= 正好完成 systematic-debugging 的 Phase 1，然后交棒给 Phase 3-4（假设 → 修复）或直接改。

## Iron Laws（铁律）

> 违反字面 = 违反精神。下面三条是底线。

1. **不给坐标不开查** — 没有具体抓手（trace_id / 实例 ID / 接口名 + 时间点 / 原始报错）就先帮用户拿到，禁止凭口头描述直接动手查。
2. **分层收窄不跳层** — 按 `现象坐标 → 起手层圈范围 → 日志看行为 → 代码看根因` 顺序走，不允许跳过日志直接改代码。
3. **浅层坐实不了必到代码** — 起手层（返回码 / 数据）只是抓手不是终点；除非在浅层就能完全坐实根因（典型：配置写错），否则每条主干都要收敛到「日志 + 代码」定位根因。

## When to Use

测试环境（含本地实例，二者都连测试库）出现下列任一现象：

- 接口 / RPC 报错（错误码、业务码异常、超时、连不上）
- 工作流 / 调度卡住（实例不流转、节点不执行、状态停在中间）
- 数据不对（落库字段错、状态不一致、该有的记录没有）
- 服务 / 配置 / 任务异常（服务起不来、配置不生效、cron 不触发、MQ 不消费）

**别跳过分诊的场景**：

- "这报错我一看就知道" — 见过的现象也有可能是新根因，先坐实坐标。
- "急着定位，直接改一处试试" — 分层收窄比 guess-and-check 快。
- 已经试改过一两处没好 — 越是这种越要回到 Step 0 重走。

**不适用**（直接走对应 skill）：

- 已定位到根因、要修复并写失败测试 → `superpowers:systematic-debugging` + `superpowers:test-driven-development`
- 主动验证新功能是否正确（不是排障）→ `auto-self-test`
- 只是想查一条数据 / 跑一句 SQL → 直接 `querying-dev-test-db`
- 只是想查一段日志 → 直接 `observability-skills`

## 排查流程（四步，逐步推进）

### Step 0：坐实坐标（不给坐标不开查）

先拿到能复现 / 定位的抓手，缺什么补什么：

| 现象 | 必须拿到的坐标 |
|---|---|
| 接口 / RPC 报错 | 接口名 + 调用时间点 + trace_id（或能复现的请求）+ 原始返回（错误码 / 业务码） |
| 工作流卡住 | workflow 实例 ID + 卡住的大致时间 |
| 数据不对 | 表名 + 主键 / 定位条件 + 期望值 vs 实际值 |
| 服务 / 配置 / 任务 | 服务名 + 现象（起不来 / 配置项名 / cron 名 / topic）+ 时间点 |

拿不到 trace_id 就先复现一次拿到。**这一步没完成，不进 Step 1。**

### Step 1：四主干分诊（选起手层）

按现象路由到一条主干，确定**从哪层起手最快圈定范围**：

| 主干 | 起手层（快速圈范围） |
|---|---|
| 接口 / RPC 报错 | 分**包头错误码**（框架 / 网络层）还是**包体业务码**（业务层），圈定方向 |
| 工作流 / 调度卡住 | 查 `workflow_instance` / `node_execution_record`，圈定卡在哪个节点、什么时序 |
| 数据不对 | 查库拿**实际落库值**对比期望，反推是哪个接口 / 任务写的 |
| 服务 / 配置 / 任务异常 | 按子类圈定：启动失败 / 配置不生效 / cron 不触发 / MQ 不消费 |

### Step 2：分层贯穿（起手层 → 日志 → 代码）

**能在浅层坐实就停，坐实不了就继续往代码走。** 各主干的贯穿路径：

**主干 A — 接口 / RPC 报错**

> FRPC 返回分两层：**包头错误码**（framework/transport 层——超时、连不上、路由失败、熔断限流）和**包体业务码**（业务逻辑返回的 code）。先分清错在哪层，方向完全不同——别只抓一条 error message 就下判断。

1. 包头错误码（超时 / 连不上 / 路由失败 / 熔断限流）→ 框架层：看服务是否存活、固定地址路由、客户端超时、resilience 配置 → `frpc-client` / `frpc-server` / `frpc-resilience`
2. 包体业务码 → 拿 trace_id 查日志定位抛错路径（`observability-skills`）→ **读代码看为什么抛**（业务码几乎必到代码）

**主干 B — 工作流 / 调度卡住**
1. 先查 `workflow_instance`（实例整体 status、当前节点、`updated_at` 距今多久——判断是真卡死还是慢），再查 `node_execution_record`（卡在哪个节点、节点 status、`end_time` 是否 NULL、`retry_count` 是否在反复重试）→ 判断：没调起 / 节点失败 / 状态没流转。**确切列名用 `querying-dev-test-db`（DESCRIBE）确认，bigint 毫秒时间戳记得转换，别硬编码列名瞎猜**
2. 拿该节点的 trace 查日志看为何没流转或失败 → **读该节点处理代码看根因**
3. 没调起的方向 → `frpc-scheduling`（singleton_mode、cron 是否触发）；等外部事件不来 → 看 MQ 消息是否投递、consumer group 是否配错

**主干 C — 数据不对**
1. 查库拿实际值，反推哪个接口 / 任务写的这条数据 → 拿那次操作的 trace_id 查日志
2. **读写入路径代码**，区分：没写 / 写错值 / 被覆盖

**主干 D — 服务 / 配置 / 任务异常**
1. 服务起不来 → 看启动日志 → `frpc-application`
2. 配置不生效 → 静态 vs FCC 优先级、merge 模式（看一眼配置常能直接坐实）→ `frpc-config` / `frpc-configcenter`
3. cron 不触发 → `frpc-scheduling`；MQ 不消费 → 看 consumer 日志与注册
4. 逻辑类仍要到代码

**动手工具规约**（项目专属，别用通用习惯硬套）：
- **查测试库**：`mycli --dsn <alias> -e "..."`（Bash 调）。**禁止 `mysql -u root -p` / `mysql -h <host>`**——本地实例和测试环境的 DB 都连同一个测试库，连接方式恒定走 mycli。
- **查日志 / trace**：测试环境用 `observability-skills`（FLS，Skill tool 调）。**不要默认 `grep log/` 或泛泛"去 Kibana/Loki 搜"**；只有本地实例才可能有本地 log。
- **形态别错配**：CLI 用 Bash、Skill 用 Skill tool、Web 用 WebFetch；别把 CLI 当 skill 调或把 skill 当命令跑。

### Step 3：交棒（定位到根因层 + 证据）

定位到根因层后，输出**结构化排查结论**（格式见下），然后：

- 根因明确、可直接改 → 修复（交用户或自己改）
- 根因需深挖 / 涉及多处假设验证 → 交棒 `superpowers:systematic-debugging` 走 Phase 3-4
- 自测场景触发的排查 → 回 `auto-self-test`，把缺陷登记 defects.md

**修复不归本 skill 管。** 本 skill 的终点是"定位到根因层 + 证据"。

## 测试环境特有：环境脏兜底

四层走到底仍找不到代码根因时，才谨慎考虑**测试环境特有的"假根因"**：

- 别人的测试数据 / 残留状态污染
- 配置漂移（测试环境配置和预期不一致）
- 版本不一致（部署的不是当前分支 / 镜像过期）

> ⚠️ systematic-debugging 的现实：95% 的"环境问题"其实是排查不彻底。**归因环境必须有证据**（贴出污染数据 / 配置差异 / 版本号对比），禁止一句"环境问题"甩锅了事。

## 排查结论格式（产出物）

默认在对话里给出结构化结论；**仅当问题重要 / 需周知 / 要复盘时**，落档到 `docs/test-env-triage/<简述>.md`（落档前先告知路径，确认后再建目录）。

```
## 排查结论：<现象一句话>

- 坐标：trace_id=xxx / 实例=xxx / 时间=xxx
- 主干：<接口报错 / 工作流卡住 / 数据不对 / 服务配置任务>
- 逐层定位：
  - 起手层：<返回码 / 数据 看到了什么>
  - 日志：<trace 内关键日志行 / must-have 命中情况>
  - 代码：<file_path:line 的问题点>
- 根因层：<落在 框架 / 业务代码 / 数据 / 配置 / 环境 哪一层>
- 根因假设：我认为是 X，因为 Y（证据：...）
- 交棒：<直接修 / 转 systematic-debugging / 回 auto-self-test>
```

## Red Flags — STOP，回 Step 0

发现自己在做下面任一件事，立即停下回到流程：

- 不看返回码是包头还是包体，就开始猜方向
- 跳过日志，直接改代码"试试看好没好"
- 一上来 `grep -r` 全项目找关键字（没有坐标的盲搜）
- 改 SQL / 改测试 / 改配置让现象"消失"，而不是定位根因
- 数据不对，不反查写入路径就断定"肯定是 XX 接口写的"
- 已经改了两处没好，还想"再改一处试试"
- 没有证据就说"环境问题 / 数据脏"
- 用 `mysql -u root` 连库、用 `grep log/` 或泛泛"去 Kibana 搜"查日志，而不用项目工具 `mycli` / `observability-skills`

## 常见借口与现实

| 借口 | 现实 |
|---|---|
| "这报错我见过，直接改" | 见过的现象可能是新根因。先坐实坐标，30 秒的事 |
| "日志太多，懒得查，直接看代码" | 跳过日志就不知道实际走了哪条路径，读代码全靠猜 |
| "数据不对肯定是那个接口写的" | 没反查写入路径 = 假设当结论。先用 trace_id 反推 |
| "急，先改一处看好没好" | guess-and-check 比分层收窄慢。第一步就走对最快 |
| "查不到根因，应该是环境问题" | 95% 是排查不彻底。归因环境必须贴证据 |
| "本地应该有日志，grep 一下就行" | 本地实例可能有本地 log，测试环境得用 observability-skills（FLS）。先定环境再定日志通道 |

## Quick Reference

| 步骤 | 关键动作 | 完成标准 |
|---|---|---|
| **Step 0 坐实坐标** | 拿 trace_id / 实例 ID / 接口+时间 / 原始报错 | 有可定位的抓手 |
| **Step 1 分诊** | 路由到四主干，选起手层 | 确定从哪层起手 |
| **Step 2 贯穿** | 起手层 → 日志 → 代码，浅层坐实即停 | 定位到根因所在层 |
| **Step 3 交棒** | 输出结论 + 证据，交修复方 | 根因层 + 证据明确 |

## 相关 skill / 工具

- **交棒去向**：`superpowers:systematic-debugging`（根因深挖 + 修复）、`auto-self-test`（自测缺陷登记）
- **动手工具**：`querying-dev-test-db`（mycli 查测试库 / bigint 时间转换）、`observability-skills`（FLS 日志 / trace）
- **框架层排查**：`frpc-client` / `frpc-server` / `frpc-application` / `frpc-config` / `frpc-configcenter` / `frpc-scheduling`
