---
name: self-test
description: Use when self-testing a feature/branch before commit/MR/merge — for code changes touching business logic. Triggers on "自测", "测试计划", "提测前", "回归测试", "用例缺口", "对照需求测一遍", "开发完了怎么测", or when validating implementation against PRD/技术方案/use-case/测试用例 documents before integration.
---

# Self-Test (计划与记录合一)

## 适用范围

适用于任何后端服务的 feature/branch 自测。本 skill 给方法论和模板骨架；项目专属的 UC 编号、表名、服务名、错误码号段从你项目的 use-case / 技术方案文档里读取，模板里用占位符或中性示例（如 `OrderService.CreateOrder` / `order_main`）演示结构，落到具体项目时替换。

## 核心约束

**每个 feature/branch 一份自测产出，路径根据场景数量决定**：

| feature 触及的对外入口数 | 文档形态 | 路径 |
|---|---|---|
| 仅 1 个场景（单 RPC / 单 Cron / 单 Consumer / 单 HTTP endpoint） | 单文件 | `docs/self-test/{branch_slug}_{date}.md` |
| ≥ 2 个场景 | **目录式** | `docs/self-test/{branch_slug}_{date}/` 内含 `README.md` + 每场景一份 `{scene}.md` |

- `{branch_slug}`：`/` 替换为 `-`（`ft/foo` → `ft-foo`）
- `{date}`：YYYY-MM-DD，自测开始那天，跨日继续追加同一文档/目录，**不每天新建**
- 场景 = 一个对外入口（一个 RPC method / 一个 Cron Job / 一个 Kafka Consumer / 一个 HTTP endpoint）

### 目录式的内容分工（≥2 场景时）

`README.md`（导航 + 跨场景共用部分）：
- 一、概述（feature 元信息 + 4 类输入文档列表 + git diff 入口推导）
- 二、跨场景验收口径（数据/日志/返回 三维度通用约定 + observability 短板）
- 三、场景索引（表格列出各场景 → 链接到对应 `.md`）
- 四、整体验收结论（跨场景汇总 + 发布声明）
- 五、Observability / 代码改进建议（跨场景共用清单）
- **已确认的文档冲突清单也放 README**（多场景共用）

各 `{scene}.md`（独立完整的场景文档）：
- 场景元信息（入口 / UC / 驱动方 / 客户端工具 / 核心实现路径）
- 现有用例覆盖度评估（仅本场景）
- 各分支细节（按"五段式 + 3.X.Y 编号"，详见 Step 2）
- 本场景验收小结（PASS/PARTIAL/FAIL/SKIP 计数）

文档间用相对链接互通：`[README §四](README.md#四整体验收结论)` / `[scene-a.md §3.6](scene-a.md#36-幂等场景)`

## What NOT to do（曾反复出问题，必须避免）

- ❌ 不要建 `evidence/round*/tc-*.{log,sql,rpc}` 多文件——证据**内嵌**主文档/场景文档
- ❌ 不要建 README.md 但把场景分支细节塞进去——README 只放跨场景共用部分，分支细节归各场景 `.md`
- ❌ 单场景 feature 不要无故拆目录——单文件够用就不建目录（避免目录里只放一个 `.md`）
- ❌ 不要拆成 gap-analysis.md / self-test-plan.md / acceptance-report.md——4 类文档信息归并到 README/单文档
- ❌ 不要按 Round 1/Round 2 组织——按 **场景 → 分支** 结构
- ❌ 不要列被测系统全部场景——**只覆盖本 feature 触及的**（git diff 推导）
- ❌ 不要在 heading 里放 emoji（✅/❌/⏸）——GFM 锚点会失效，emoji 写正文
- ❌ 文档间发现冲突却不告诉用户——**必须列冲突清单让用户确认采信哪个**
- ❌ 分支 h4 标题不写 `3.X.Y` 编号——会导致同名 h4（"测试前检查"等）锚点冲突

## 四步流程

### Step 1：梳理（必须收集 4 类文档）

输入文档（缺一不可，缺失须显式告知用户）：
- **PRD** / 需求文档（业务诉求）
- **技术方案** / 详细设计（实现路径）
- **use-case 文档**（用例规约，UC 编号从这里读取）
- **已有测试用例**（XMind / CSV / markdown）

执行：
```bash
git log main...HEAD --oneline
git diff main...HEAD --stat
```

产出（落到主文档/README 的"概述"章节）：
1. 本 feature 涉及的场景清单（按 git diff 入口推导）→ 决定走单文件还是目录式
2. 现有测试用例的覆盖度评估（哪些有用例、哪些是缺口）
3. **【强制】文档冲突清单** — 4 类文档之间不一致的地方逐条列出，**让用户确认采信哪个**，未确认前不进 Step 2

冲突示例：技术方案 §X vs use-case 描述差异 / PRD 边界条件 vs 测试用例边界值不同 / 已有用例验证已废弃设计。

### Step 2：计划（写骨架）

按 Step 1 推导的场景数量选骨架，参考 `templates/plan-and-record.md`。

#### 分支结构：五段式 + 3.X.Y 编号

每个分支必须按以下五段式组织（h4 标题用 `3.X.Y` 编号防 GFM 锚点冲突）：

```
### 3.X 分支名

**目的**：xxx
**测试方式**：e2e / 单测 / mock 短路

#### 3.X.1 测试前检查
  ##### 前置 SELECT（看当前 DB 状态）
  ##### 数据准备（清空 / setup SQL）
  ##### 准备后 SELECT（确认 setup 生效）

#### 3.X.2 构造入参
  （仅 client 调用 + 请求体 JSON / curl / mq 消息体，不再混 setup）

#### 3.X.3 预期结果
  ##### 数据
  ##### 日志
  ##### 返回

#### 3.X.4 实际结果
  ##### 数据
  ##### 日志
  ##### 返回
  （初始填 ⏸ 未执行）

#### 3.X.5 判定
  PASS / FAIL / SKIP / 未执行 + 备注
```

**测试前检查的"三步检查法"**（强制）：
1. **前置 SELECT**：看当前 DB 状态 + 用文字描述"预期现状"（可能有残留 / 应已存在某行）
2. **数据准备**：清空 / setup SQL（明确 affected_rows 期望）
3. **准备后 SELECT**：确认 setup 生效 + 用文字描述"预期 setup 后状态"（如 `cnt=0`）

把 setup 与调用分离的原因：旧三段式把清空 SQL 塞在"构造入参"段，"做了什么 / 为什么这么做 / 是否生效"混在一起；五段式让每段只承担一件事。

**前置改造的位置**：若分支需要改代码 / 改 conf / 加 mock 短路才能跑，把它放在最前面，编号 `3.X.1 前置改造`，其他段顺延为 `3.X.2 测试前检查` ... `3.X.6 判定`。

#### 目录两级嵌套示范

```markdown
- [3.1 正常创建 - 首次](#31-正常创建---首次)
  - [3.1.1 测试前检查](#311-测试前检查)
  - [3.1.2 构造入参](#312-构造入参)
  - [3.1.3 预期结果](#313-预期结果)
  - [3.1.4 实际结果](#314-实际结果)
  - [3.1.5 判定](#315-判定)
- [3.2 互斥拦截](#32-互斥拦截)
  - [3.2.1 测试前检查](#321-测试前检查)
  - ...
```

锚点 `#311-测试前检查` / `#321-测试前检查` 因前缀不同全局唯一，GFM 渲染稳定。

### Step 3：执行 + 内嵌证据

每跑一个分支：
1. 客户端响应 / `tail -n +N log/...` / DB CLI 拿真实输出
2. **直接 paste 到该分支 `3.X.4 实际结果`** 对应小节，全文内嵌
3. 不建独立 evidence 文件（曾尝试 `round*/tc-*.log` 等，最终全部冗余）
4. 真实输出超 50 行才考虑摘录关键 + 链接到外部文件（罕见，默认全文内嵌）
5. 当下补完该分支 `3.X.5 判定`，不留尾巴

执行纪律：
- 失败 TC 立即停下分析根因，不掩盖
- 禁止改测试代码 / 验证 SQL 让结果"看起来通过"
- 跳过的 TC 必须显式标 SKIP + 原因 + issue 链接

### Step 4：验收

**单文件形态**：在末章写整体验收结论 + 发布声明 + observability 建议。

**目录式形态**：
- 各场景 `.md` 末尾写"本场景验收小结"（本场景的 PASS/PARTIAL/FAIL/SKIP 计数）
- README 第四章做跨场景汇总 + 发布声明（"本次发布**不带/带**未解决问题上线"，禁含糊）
- README 第五章列 observability/代码改进建议（跨场景共用）

reviewer 视角的复核清单见 `templates/reviewer-checklist.md`，是 reviewer 单独使用的工具。

## 红旗信号 — STOP 重做

| 信号 | 重做方向 |
|------|---------|
| 在建 evidence/ 子目录或多个 .log/.sql 外部文件 | 删，证据内嵌主文档 |
| 单场景 feature 却拆成 README + 单个 scene.md | 合回单文件 |
| 多场景 feature 还在用单文件且已超 1000 行 | 改目录式，拆 README + 各场景 .md |
| README.md 里塞了某场景的具体分支细节 | 抽出共用部分到 README，分支细节归各场景 .md |
| 在创建第二个 .md（acceptance / gap-analysis）| 合到 README/主文档 |
| 文档结构按 Round 1/2/3 | 改场景化（场景 = 入口） |
| 把服务全部场景列了一遍 | 只留 feature 触及的，删其他 |
| 分支 h4 标题没写 3.X.Y 编号 | 全部加编号防锚点冲突 |
| 分支只有"构造入参"段，setup SQL 与调用混一起 | 拆出 3.X.1 测试前检查（三步检查法） |
| heading 含 ✅ ❌ ⏸ emoji | 移到正文，heading 保持纯文本 |
| 跳过 4 文档冲突分析 | 回 Step 1 |
| 用户没确认冲突就动手写计划 | 停下，先 ask |

## 项目规则联动

skill 启动时检测下列文件，存在即读取并以项目规则为准：
- `.claude/rules/*.md` — 项目领域规则（覆盖率、命名、状态机、错误码号段等）
- `.specify/memory/constitution.md` — 项目最高约束（如使用 spec-kit）
- `CLAUDE.md` / `AGENTS.md` — 项目根指引

UC 编号、错误码号段、表名、字段名、服务名、状态机定义等，**全部从项目自身的文档读取**，本 skill 不做硬编码。

## 不适用场景

- 写具体单测代码 → `superpowers:test-driven-development`
- 调试 bug → `superpowers:systematic-debugging`
- 已有完整自测计划只是要执行 → 直接读 plan 跑
- 单纯跑 `go test` / `pytest` 等 → 不需 skill
