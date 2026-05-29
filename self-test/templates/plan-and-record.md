# 自测计划与记录 — 模板

> 计划 + 记录合一。按 feature 触及的场景数量选模板：
> - **单场景**：直接用本文件"附录 A：单文件骨架"
> - **多场景（≥2）**：用"附录 B：目录式骨架"——README.md + 每场景一份 `{scene}.md`
>
> 共用约束：
> - heading 不带 emoji（✅/⏸/❌），状态写正文
> - 分支 h4 必须用 `3.X.Y` 编号，防 GFM 锚点冲突
> - 测试前检查段必须按"三步检查法"组织：前置 SELECT → 数据准备 → 准备后 SELECT
>
> **示例占位说明**：本模板用 `OrderService.CreateOrder` / `order_main` 等中性示例展示结构。
> 落到具体项目时，UC 编号、表名、字段名、服务名、客户端工具、错误码、字段语义全部从项目
> 自己的 use-case / 技术方案 / DB schema / proto 文件读取替换。

---

## 附录 A：单文件骨架（仅触及单一对外入口的 feature 用）

文件路径：`docs/self-test/{branch_slug}_{date}.md`

```markdown
# {feature 标题} - 自测计划与记录

## 目录
- [一、概述](#一概述)
- [二、验收口径](#二验收口径)
- [三、场景：{场景名}](#三场景场景名)
  - [3.1 {分支 1}](#31-分支-1)
    - [3.1.1 测试前检查](#311-测试前检查)
    - [3.1.2 构造入参](#312-构造入参)
    - [3.1.3 预期结果](#313-预期结果)
    - [3.1.4 实际结果](#314-实际结果)
    - [3.1.5 判定](#315-判定)
  - [3.2 {分支 2}](#32-分支-2)
    - [3.2.1 测试前检查](#321-测试前检查)
    - ...
- [四、整体验收结论](#四整体验收结论)
- [五、Observability / 代码改进建议](#五observability--代码改进建议)

## 一、概述
（同附录 B README "一、概述" 章节，去掉跨场景索引）

## 二、验收口径
（同附录 B README "二、跨场景验收口径" 章节）

## 三、场景：{场景名}
（同附录 B 场景文档"3.X 分支"骨架）

## 四、整体验收结论
（同附录 B README "四、整体验收结论"）

## 五、Observability / 代码改进建议
（同附录 B README "五"）
```

---

## 附录 B：目录式骨架（多场景 feature 用）

目录路径：`docs/self-test/{branch_slug}_{date}/`

```
docs/self-test/{branch_slug}_{date}/
├── README.md          # 导航 + 跨场景共用部分
├── {scene-a}.md       # 场景 1：例如 createorder.md
├── {scene-b}.md       # 场景 2：例如 cancelorder.md
└── {scene-c}.md       # 场景 3：例如 notify_consumer.md (Kafka Consumer)
```

### B.1 README.md 模板

```markdown
# {feature 标题} - 自测计划与记录（导航）

> **结构**：本 README 为导航/汇总层；具体分支细节在各场景文档内。

## 目录
- [一、概述](#一概述)
- [二、跨场景验收口径](#二跨场景验收口径)
- [三、场景索引](#三场景索引)
- [四、整体验收结论](#四整体验收结论)
- [五、Observability / 代码改进建议](#五observability--代码改进建议)

## 一、概述

| 项 | 值 |
|---|---|
| 分支 | `ft/...` |
| 起止 commit | `abc1234` ... `def5678` |
| 自测人 | xxx |
| 开测日期 | YYYY-MM-DD |
| 自测环境 | dev / pre / 本地（含 DB 实例标识） |
| 关联 MR | [!XX]() |

### 4 类输入文档

| 类别 | 路径 / 链接 | 提供状态 |
|------|-----------|---------|
| PRD / 需求文档 | xxx | ✅ / ❌ 缺 |
| 技术方案 | xxx | ✅ |
| use-case 文档 | xxx | ✅ |
| 已有测试用例 | xxx | ✅ / ❌ |

### 已确认的文档冲突

> 若 4 类文档无冲突，写"无"。若有冲突未确认，**不得进入 Step 2**。

| 编号 | 冲突描述（哪两份文档不一致） | 用户确认采信 | 后续动作 |
|------|--------------------------|------------|----------|
| C1   | 技术方案 §X vs use-case 描述 | 技术方案 v2 | 见 [{scene-a}.md §3.6]({scene-a}.md#36-xxx) |

### 本 feature 涉及的入口（基于 git diff 推导）

```
git diff main...HEAD --stat 摘要：
  internal/.../foo.go     ...
  internal/.../bar.go     ...
```

> **未涉及入口**：xxx（本 feature 不直接覆盖，本轮不测）

## 二、跨场景验收口径

每分支按三个维度对照预期 vs 实际：

| 维度 | 检查内容 |
|------|---------|
| 数据 | DB 表的状态变化（before/after） |
| 日志 | 服务端 trace_id 关联的 INFO/WARN/ERROR 行 |
| 返回 | RPC 响应 / Kafka 消息体 / Cron Job 执行结果 |

### {observability 短板}（如有）

- xxx 路径成功无业务日志，仅靠间接证据（list 间接证据）

### 通用验证 SQL（每分支跑完查）

```sql
SELECT ... FROM {primary_table} WHERE {biz_key} IN (...);
```

## 三、场景索引

| 场景 | 入口 | 关联 UC | 文档 | 状态 |
|------|------|---------|------|------|
| CreateOrder RPC | `OrderService.CreateOrder` | UC-XXX | [{scene-a}.md]({scene-a}.md) | 12 分支：PASS 3 / PARTIAL 1 / 待跑 8 |
| CancelOrder RPC | `OrderService.CancelOrder` | UC-YYY | [{scene-b}.md]({scene-b}.md) | 5 分支：全部待跑 |

## 四、整体验收结论

各场景小结由场景文档内部维护；此处只做跨场景汇总与发布声明。

### 汇总

| 场景 | PASS | PARTIAL | ⏸ 未执行 | FAIL | 总计 |
|------|------|---------|----------|------|------|
| [{scene-a}]({scene-a}.md#本场景验收小结) | 3 | 1 | 8 | 0 | 12 |
| **合计** | 3 | 1 | 8 | 0 | 12 |

### 发布声明

明确写明（不能含糊）：

> 本次发布**不带 / 带**未解决问题上线。
>
> {若带病上线，列具体未解决项 + 风险评估 + 应急方案 + 已周知 leader/QA}

## 五、Observability / 代码改进建议

跨场景共用建议清单。如某项仅适用单一场景，归入对应场景文档。

| 编号 | 问题 | 建议 | 优先级 |
|------|------|------|--------|
| O1 | xxx | xxx | P1 |
```

### B.2 场景文档模板（`{scene}.md`）

```markdown
# 场景：{场景名}（UC-XXX）

> 隶属于 [{feature} 自测导航](README.md)。本文件只包含本场景内容；跨场景共用部分见 README。

## 场景元信息

| 项 | 值 |
|---|---|
| 入口 | RPC `{Service}.{Method}` (method_id=0xN) / Cron `{job_name}` / Kafka topic `{topic}` |
| 关联 UC | UC-XXX（编号来自项目 use-case 文档） |
| 驱动方 | xxx |
| 客户端 | `{client tool path}` / `curl ...` / `kafka-console-producer ...` |
| 核心实现 | `internal/.../xxx.go` |
| 触及代码 | xxx |

## 目录

- [3.1 {分支 1}](#31-分支-1)
  - [3.1.1 测试前检查](#311-测试前检查)
  - [3.1.2 构造入参](#312-构造入参)
  - [3.1.3 预期结果](#313-预期结果)
  - [3.1.4 实际结果](#314-实际结果)
  - [3.1.5 判定](#315-判定)
- [3.2 {分支 2，需前置改造}](#32-分支-2需前置改造)
  - [3.2.1 前置改造](#321-前置改造)
  - [3.2.2 测试前检查](#322-测试前检查)
  - [3.2.3 构造入参](#323-构造入参)
  - [3.2.4 预期结果](#324-预期结果)
  - [3.2.5 实际结果](#325-实际结果)
  - [3.2.6 判定](#326-判定)
- [本场景验收小结](#本场景验收小结)

## 现有用例覆盖度评估

| 分支 | 旧 self-test-plan | gap-analysis | 本计划章节 |
|------|-------------------|-------------|----------|
| 主路径首创 | TC-1.1 | — | 3.1 |
| {分支 2} | — | 4.2 提到缺 | 3.2 |

---

### 3.1 {分支名}

**目的**：xxx
**测试方式**：e2e / 单测 / mock 短路

#### 3.1.1 测试前检查

> **三步检查法**：先 SELECT 看现状 → 清空/setup → 再 SELECT 确认。本分支验证"xxx"路径，必须保证测试前 xxx。

##### 前置 SELECT（看当前 DB 状态）

```sql
SELECT id, status, ...
FROM order_main WHERE order_id='test-001' AND user_id=10001;
```

**预期现状**：可能有历史残留（前轮测试遗留）。

##### 数据准备（清空）

```sql
DELETE FROM order_main   WHERE order_id='test-001' AND user_id=10001;
DELETE FROM order_detail WHERE order_id='test-001';
```

##### 准备后 SELECT（确认无记录）

```sql
SELECT COUNT(*) AS cnt FROM order_main
WHERE order_id='test-001' AND user_id=10001;
```

**预期 setup 后状态**：`cnt=0`，无该 (order_id, user_id) 记录。

#### 3.1.2 构造入参

```bash
{client tool} "127.0.0.1:{port}" "test-001"
```

请求体：
```json
{
  "user_id": 10001,
  "items": [{"req_id": "test-req-<unix-nano>", "item_id": "test-001", "qty": 1}]
}
```

#### 3.1.3 预期结果

##### 数据
| 表 | 预期 |
|----|------|
| `order_main`   | 新增 1 行：`status='ACTIVE'`、`version=1` |
| `order_detail` | 新增 1 行：`req_id=<本次>` |

##### 日志
- INFO `OrderService_CreateOrder_Success`（含 orderID/traceID）
- 无任何 ERROR/WARN

##### 返回
```json
{"results": [{"code": 0, "order_id": "<19位雪花>"}]}
```

#### 3.1.4 实际结果

> 跑前填 ⏸ 未执行；跑后 paste 真实输出。

##### 数据
```
⏸ 未执行
```

##### 日志
```
⏸ 未执行
```

##### 返回
```
⏸ 未执行
```

#### 3.1.5 判定

⏸ 未执行 / PASS / FAIL / SKIP — 备注。

---

### 3.2 {分支名，需前置改造}

**目的**：xxx
**测试方式**：xxx

#### 3.2.1 前置改造

> 本分支需要改代码 / conf / mock 才能跑，必须先做以下改造。

| 改造项 | 文件 | 操作 |
|--------|------|------|
| 加 mock 短路 | `internal/adapter/driven/rpc/{xxx}_acl.go` | 加 env-var `XXX_MOCK_FILE` 支持读本地文件 |
| 扩展 client flag | `cmd/{client_tool}/main.go` | 加 `--req-id` flag 支持手工传 reqID |

#### 3.2.2 测试前检查
（同 3.1.1 三步法）

#### 3.2.3 构造入参
（同 3.1.2）

#### 3.2.4 预期结果
（同 3.1.3）

#### 3.2.5 实际结果
（同 3.1.4）

#### 3.2.6 判定

⏸ 未执行 / PASS / FAIL / SKIP — 备注。

---

## 本场景验收小结

| 分支 | 状态 | 章节 | 备注 |
|------|------|------|------|
| 3.1 主路径首创 | PASS | §3.1 | — |
| 3.2 需前置改造 | ⏸ 未执行 | §3.2 | 待 client flag 扩展 |

**计数**：PASS x；PARTIAL x；FAIL x；SKIP x；⏸ x。
```
