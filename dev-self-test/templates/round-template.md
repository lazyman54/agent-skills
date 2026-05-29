# Run 1 执行记录：CreateOrder

> 本文档是真实样例，复制后按本项目场景替换。
> 计划见 [`./plan.md`](./plan.md)；缺陷详情见 [`./defects.md`](./defects.md)。

## 目录

- [1. 元信息](#1-元信息)
- [2. 本轮执行规划](#2-本轮执行规划)
- [3. 执行结果](#3-执行结果)
  - [2.1 必填参数缺失（基础测试）](#21-必填参数缺失基础测试--对应-planmd-21)
  - [2.2 参数越界（基础测试）](#22-参数越界基础测试--对应-planmd-22)
  - [3.1 主路径成功创建（业务测试）](#31-主路径成功创建业务测试--对应-planmd-31)
  - [3.2 幂等命中（业务测试）](#32-幂等命中业务测试--对应-planmd-32)
  - [3.7 DB panic 回滚（业务测试）](#37-db-panic-回滚业务测试--对应-planmd-37)
- [4. 本轮验收小结](#4-本轮验收小结)
- [5. 日志合理性回顾](#5-日志合理性回顾)

## 1. 元信息

| 项 | 值 |
|---|---|
| Run | Run 1 |
| 起止 | 2026-05-29 ~ 2026-05-30 |
| 执行人 | ericmao |
| 状态 | 已完成 |
| 自测环境 | 本地 dev（mac M1 / Go 1.22 / MySQL 8.0） |

## 2. 本轮执行规划

第一波：纯客户端调用（0 重启 / 0 改代码）→ 跑 2.1 / 2.2 / 3.1 / 3.2 / 3.3
第二波：加 mock-stock-zero token + 一次重启 → 跑 3.4 用户风控 / 3.5 库存不足
第三波：单测路径 → 跑 3.7 DB panic 回滚

## 3. 执行结果

> 每个分支显示：执行历史表 + 每次执行的实际入参 + 4 维度证据。
> 分支编号沿用 plan.md（基础 2.X / 业务 3.X），便于双向跳转。

### 2.1 必填参数缺失（基础测试 — 对应 [plan.md 2.1](./plan.md#21-必填参数缺失))

**执行历史**：

| # | 时间 | trace_id | 判定 | 概括 |
|---|---|---|---|---|
| 1 | 2026-05-29 14:10 | `1a2b3c4d5e6f7890abcdef1234567890` | PASS | 3 个用例（userID/itemID/reqID 缺失）全部命中 INVALID_ARGUMENT |

#### 第 1 次执行：2026-05-29 14:10:33

##### 实际入参

```bash
# 用例 1：userID 缺失
cmd/test_client create-order -user=0 -item=I001 -qty=1 -req=R001
# 用例 2：itemID 缺失
cmd/test_client create-order -user=90001 -item="" -qty=1 -req=R001
# 用例 3：reqID 缺失
cmd/test_client create-order -user=90001 -item=I001 -qty=1 -req=""
```

##### 4 维度结果

**数据维度**：3 用例后查表，三表（orders / order_items / idempotency_records）均无新增 ✅

**返回维度**：

| 用例 | 包头 | 包体 | message |
|---|---|---|---|
| userID 缺失 | `INVALID_ARGUMENT` ✅ | nil ✅ | "userID required" ✅ |
| itemID 缺失 | `INVALID_ARGUMENT` ✅ | nil ✅ | "itemID required" ✅ |
| reqID 缺失 | `INVALID_ARGUMENT` ✅ | nil ✅ | "reqID required" ✅ |

**日志维度**：trace 内 1 行 INFO（access log）+ 1 行 WARN（参数错）；ERROR/同源多 ERROR 均 0 命中 ✅

```
14:10:33.124 WARN  OrderService_Create_ParamMissing  trace_id=1a2b3c4d... missingField=userID
14:10:33.125 INFO  [gRPC] handle end                 trace_id=1a2b3c4d... response.code=INVALID_ARGUMENT
```

字段抽查：trace_id ✅ / missingField ✅ / 字段齐 ✅

**告警维度**：错误上报 0 触发 ✅（用户参数错误，非系统异常）

---

### 2.2 参数越界（基础测试 — 对应 [plan.md 2.2](./plan.md#22-参数越界-qty-范围-1-1000))

**执行历史**：

| # | 时间 | trace_id | 判定 | 概括 |
|---|---|---|---|---|
| 1 | 2026-05-29 14:15 | `2b3c4d5e6f7890abcdef1234567890ab` | PASS | 5 用例（0/-1/1001/1/1000）全部命中预期 |

#### 第 1 次执行：2026-05-29 14:15:08

##### 实际入参

```bash
cmd/test_client create-order -user=90011 -item=I001 -qty=0    -req=R011  # 越界
cmd/test_client create-order -user=90012 -item=I001 -qty=-1   -req=R012  # 越界
cmd/test_client create-order -user=90013 -item=I001 -qty=1001 -req=R013  # 越界
cmd/test_client create-order -user=90014 -item=I001 -qty=1    -req=R014  # 边界 PASS
cmd/test_client create-order -user=90015 -item=I001 -qty=1000 -req=R015  # 边界 PASS
```

##### 4 维度结果

**数据维度**：

| 用例 | orders 行数变化 | 结果 |
|---|---|---|
| qty=0 / -1 / 1001 | 不变 | ✅ |
| qty=1 / 1000 | +1 | ✅ |

**返回维度**：

| 用例 | 包头 | 包体 |
|---|---|---|
| 越界用例 | OK | `Code=50` (`BizCodeInvalidQty`) ✅ |
| 边界 PASS 用例 | OK | `Code=0` ✅ |

**日志维度**：越界用例命中 `OrderService_Create_InvalidQty` WARN（含 trace_id / qty / min / max）；边界 PASS 用例命中主路径 INFO 系列；ERROR 0 ✅

**告警维度**：错误上报 0 触发 ✅（业务规则拒绝）

---

### 3.1 主路径成功创建（业务测试 — 对应 [plan.md 3.1](./plan.md#31-主路径成功创建))

**执行历史**：

| # | 时间 | trace_id | 判定 | 概括 |
|---|---|---|---|---|
| 1 | 2026-05-29 14:23 | `8a7f1e2c4b9d3a5e6f7890abcdef1234` | PASS | 4 维度全部命中 |

#### 第 1 次执行：2026-05-29 14:23:11

##### 实际入参

```bash
cmd/test_client create-order -user=90001 -item=I001 -qty=1 -req=R001
```

请求体：
```json
{"user_id": 90001, "item_id": "I001", "qty": 1, "req_id": "R001"}
```

##### 4 维度结果

**数据维度**：

```sql
SELECT id, user_id, status, total FROM orders WHERE user_id=90001;
-- 1 行：id=1929381234567890123, user_id=90001, status=CREATED, total=12.50

SELECT * FROM idempotency_records WHERE req_id='R001';
-- 1 行：req_id=R001, order_id=1929381234567890123
```

**返回维度**：

```json
{"result": {"code": 0}, "order_id": "1929381234567890123", "created_at": 1748522591}
```

包头 `OK` ✅ / `Code=0` ✅ / OrderID 19 位 ✅

**日志维度**：trace 内 4 行 INFO（`grep 8a7f1e2c... | wc -l = 4`）。

| 必有日志 | 命中 | 关键字段抽查 |
|---|---|---|
| `OrderService_Create_Begin` | ✅ | userID=90001 itemID=I001 reqID=R001 |
| `InventoryReserve_Success` | ✅ | itemID=I001 reservedQty=1 |
| `OrderService_Create_Success` | ✅ | userID=90001 orderID=1929381... |
| gRPC access log | ✅ | response.code=0 response.order_id=1929381... |

| 必无日志 | 实测 |
|---|---|
| 任何 ERROR | 0 命中 ✅ |
| 任何 WARN | 0 命中 ✅ |

字段抽查（`OrderService_Create_Success`）：

```
14:23:11.234 INFO  OrderService_Create_Success  trace_id=8a7f1e2c4b9d3a5e6f7890abcdef1234  userID=90001  orderID=1929381234567890123  costMs=87
```
trace_id ✅ / userID ✅ / orderID ✅

**告警维度**：错误上报 0 触发 ✅（主路径成功）

---

### 3.2 幂等命中（业务测试 — 对应 [plan.md 3.2](./plan.md#32-幂等命中同-req_id-重复调用))

> FAIL → 修复 → PASS 样本

**执行历史**：

| # | 时间 | trace_id | 判定 | 概括 |
|---|---|---|---|---|
| 1 | 2026-05-29 14:25 | `def345abc6789012345678901234567ab` | FAIL | 实证 [BUG3](./defects.md#bug3-duplicatekey-未识别为幂等)：包体 `Code=9999`（预期 1）；触发误告警；缺 IdempotentHit INFO |
| 2 | 2026-05-30 10:12 | `abc678def0123456789012345678cdef` | PASS | BUG3 修复后回归，4 维度全部命中 |

#### 第 1 次执行（FAIL）：2026-05-29 14:25:42

##### 实际入参

```bash
cmd/test_client create-order -user=90001 -item=I001 -qty=1 -req=R001  # 与 3.1 完全相同
```

##### 4 维度结果

**数据维度**：

```sql
SELECT COUNT(*) FROM orders WHERE user_id=90001;             -- 1（仍是 3.1 的）✅
SELECT COUNT(*) FROM idempotency_records WHERE req_id='R001'; -- 1 ✅
```

数据维度 ✅（行数确实没增长）

**返回维度**：

```json
{"result": {"code": 9999, "message": "internal error: duplicate key"}}
```

| 字段 | 严格预期 | 实测 |
|---|---|---|
| 包头 | OK | OK ✅ |
| `Result.Code` | 1（`BizCodeIdempotentHit`） | **9999**（`BizCodeUnknown`）❌ |
| `OrderID` | 与 3.1 相同 | **空** ❌ |

**日志维度**：

| 必有日志 | 严格预期 | 实测 |
|---|---|---|
| `OrderService_IdempotentHit` INFO | 必有 | **缺失** ❌ |

| 必无日志 | 严格预期 | 实测 |
|---|---|---|
| `OrderService_Create_TxErr` ERROR | 不应有 | **出现 + stacktrace** ❌ |
| `InventoryReserve_*` | 不应有 | 0 命中 ✅ |

字段完整度：实际 ERROR 含 trace_id ✅；但缺 `OrderService_IdempotentHit` 业务日志，幂等场景定位困难。

**告警维度**：错误上报 **触发** ❌（DuplicateKey 是预期幂等命中，不应触发系统告警）

#### 修复关联

| 项 | 值 |
|---|---|
| 缺陷 | [BUG3](./defects.md#bug3-duplicatekey-未识别为幂等) DuplicateKey 未识别为幂等 |
| 优先级 | P0 |
| 修复 commit | **`a3f1b2c`** `fix(BUG3): identify DuplicateKey as IdempotentHit` |
| 关键改动 | 代码 + 日志 + 告警三方一并修，详见 [defects.md BUG3](./defects.md#bug3-duplicatekey-未识别为幂等) |

#### 第 2 次执行（修复后回归）：2026-05-30 10:12:05

##### 实际入参

```bash
# 步骤 1：先用新 userID 跑一次首次创建（落库 idempotency_records）
cmd/test_client create-order -user=90002 -item=I001 -qty=1 -req=R002
# 步骤 2：同 req_id 复发（预期幂等命中）
cmd/test_client create-order -user=90002 -item=I001 -qty=1 -req=R002
```

##### 4 维度结果

**数据维度**：第 2 步执行后行数不变 ✅

**返回维度**：

```json
{"result": {"code": 1, "message": "idempotent hit"}, "order_id": "1929381..."}
```

`Code=1` ✅ / `OrderID` 与第 1 步相同 ✅

**日志维度**：

| 必有日志 | 实测 |
|---|---|
| `OrderService_IdempotentHit` INFO（含 `originalOrderID`） | ✅ 命中 |

| 必无日志 | 实测 |
|---|---|
| `OrderService_Create_TxErr` | 0 命中 ✅ |
| `InventoryReserve_*` | 0 命中（幂等短路）✅ |

**告警维度**：错误上报未触发 ✅

---

### 3.7 DB panic 回滚（业务测试 — 对应 [plan.md 3.7](./plan.md#37-db-panic-回滚))

> 单测覆盖样本：测试方式不是 e2e，按"怎么做的怎么写"展示。

**执行历史**：

| # | 时间 | trace_id | 判定 | 概括 |
|---|---|---|---|---|
| 1 | 2026-05-30 11:00 | -（单测无 trace_id）| PASS | 单测 `service_create_test.go::TestPanicRollback` 在 CI [#5678](xxx) 通过；事务回滚 + 告警上报均符合预期 |

#### 第 1 次执行（单测）：2026-05-30 11:00（CI 触发）

##### 实际入参

```go
// service_create_test.go::TestPanicRollback
db.MockPanicAt("InsertOrder")
defer db.RestoreMock()

resp, err := service.CreateOrder(ctx, &CreateOrderRequest{
    UserID: 90099, ItemID: "I001", Qty: 1, ReqID: "R099",
})
```

##### 4 维度结果

**数据维度**：单测断言 `orders` / `order_items` 表 0 行新增（事务正确回滚）✅
**返回维度**：单测断言 gRPC `INTERNAL` 包头 + `Result == nil` ✅
**日志维度**：单测断言 `OrderService_Create_TxRollback` ERROR 出现，含 `panic` / `trace_id` ✅
**告警维度**：单测断言 `errreport.Report` 触发 ✅（系统级 panic 应告警）

> 4 维度断言完整代码见 [`service_create_test.go:120-180`](xxx)。

---

## 4. 本轮验收小结

本轮 5 个分支全部 PASS（2.1 / 2.2 / 3.1 / 3.2 / 3.7）。

发现并修复的缺陷：

- [BUG3](./defects.md#bug3-duplicatekey-未识别为幂等) DuplicateKey 未识别为幂等（P0） — 修复 commit `a3f1b2c`

## 5. 日志合理性回顾

| 子维度 | 通过 / 发现 |
|---|---|
| 覆盖度 | 1 项缺失 → [BUG3](./defects.md#bug3-duplicatekey-未识别为幂等) 缺 `IdempotentHit` INFO |
| 冗余度 | 1 项冗余 → [BUG3](./defects.md#bug3-duplicatekey-未识别为幂等) DuplicateKey 双告 ERROR |
| 字段完整度 | 全部齐全 |
| 告警合理性 | 1 项误告 → [BUG3](./defects.md#bug3-duplicatekey-未识别为幂等) DuplicateKey 误触发错误上报 |
