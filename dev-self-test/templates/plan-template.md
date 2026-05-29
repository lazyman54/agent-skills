# 自测计划：CreateOrder

> 本文档是真实样例，复制后按本项目场景替换。
> Feature 级上下文（PRD / 技术方案 / use-case 总览 / 文档冲突）见 [README.md](./README.md)。
> 实际执行记录见 `./round_N.md`，缺陷档案见 `./defects.md`。

## 目录

- [1. 场景概述](#1-场景概述)
- [2. 基础测试](#2-基础测试)
  - [2.1 必填参数缺失](#21-必填参数缺失)
  - [2.2 参数越界](#22-参数越界qty-范围-1-1000)
- [3. 业务测试](#3-业务测试)
  - [3.1 主路径成功创建](#31-主路径成功创建)
  - [3.2 幂等命中](#32-幂等命中同-req_id-重复调用)

## 1. 场景概述

| 项 | 值 |
|---|---|
| 入口 | `OrderService.CreateOrder`（gRPC） |
| 关联 UC | UC-001 创建订单 |
| 客户端工具 | `cmd/test_client/main.go` |
| 核心实现 | `internal/domain/order/service.create.go` |

---

## 2. 基础测试

> 模板见 SKILL "基础测试模板" 段。本场景适用项 + N/A 备注见 [README 2.5](./README.md#25-测试分类与覆盖)。

### 2.1 必填参数缺失

**目的**：验证必填字段缺失时早退于参数校验，不进入业务流程、不触达下游
**代码执行路径**：`CreateOrder` → `ValidateRequest` → **早退**（不调下游、不开事务）→ return `INVALID_ARGUMENT`
**测试方式**：单测（`service_create_test.go::TestRequiredParams`），原因：单测覆盖参数校验逻辑更稳定

#### 2.1.1 前置预期状态

**DB / 缓存基线**：无依赖（早退路径不触达 DB）。

**Setup 手段**：无。

#### 2.1.2 测试输入

按用例独立执行：

| 用例 | 入参 |
|---|---|
| userID 缺失 | `userID=0` 其他字段正常 |
| itemID 缺失 | `itemID=""` 其他字段正常 |
| reqID 缺失 | `reqID=""` 其他字段正常 |

#### 2.1.3 严格预期结果

**数据维度**

| 表 | 预期 |
|---|---|
| `orders` / `order_items` / `idempotency_records` | 0 行新增 |

**返回维度**
- 包头：gRPC status `INVALID_ARGUMENT`
- 包体：`Result == nil`，error message 含具体缺失字段名

**日志维度**

必有日志：

- **`OrderService_Create_ParamMissing`** — WARN
  - 必含字段：`trace_id`、`missingField`

必无日志：

| 日志 | 不应有的原因 |
|---|---|
| `InventoryReserve_*` | 早退于参数校验，不触达下游 |
| 任何 ERROR | 参数校验失败是用户错误，不报系统告警 |

**告警维度**：不应触发错误上报（用户参数错误，非系统异常）

#### 2.1.4 代码预审发现

无（`ValidateRequest` 已有完整必填校验）。

---

### 2.2 参数越界（qty 范围 [1, 1000]）

**目的**：验证 qty 超出业务允许范围时早退，不进入库存预占
**代码执行路径**：`CreateOrder` → `ValidateBusinessRules` → **早退** → return `BizCodeInvalidQty`
**测试方式**：单测，原因：边界值组合多，单测枚举更高效

#### 2.2.1 前置预期状态

**DB / 缓存基线**：无依赖。

**Setup 手段**：无。

#### 2.2.2 测试输入

| 用例 | 入参 |
|---|---|
| qty = 0 | qty=0 其他正常 |
| qty = -1 | qty=-1 其他正常 |
| qty = 1001 | qty=1001 其他正常 |
| qty = 1（边界） | qty=1 其他正常（应 PASS）|
| qty = 1000（边界）| qty=1000 其他正常（应 PASS）|

#### 2.2.3 严格预期结果

**数据维度**

| 用例 | 预期 |
|---|---|
| 越界用例（0/-1/1001）| 三表 0 行新增 |
| 边界 PASS 用例（1/1000）| 三表各 +1 行 |

**返回维度**
- 越界用例：包头 OK，包体 `Result.Code = 50`（`BizCodeInvalidQty`）
- 边界 PASS 用例：包头 OK，包体 `Result.Code = 0`

**日志维度**

必有日志（越界用例）：

- **`OrderService_Create_InvalidQty`** — WARN
  - 必含字段：`trace_id`、`qty`、`min`、`max`

**告警维度**：不应触发错误上报（业务规则拒绝）

#### 2.2.4 代码预审发现

无（`ValidateBusinessRules` 已校验 qty 范围）。

---

## 3. 业务测试

### 3.1 主路径成功创建

**目的**：验证下单链路成功路径，订单与库存数据最终一致
**代码执行路径**：`CreateOrder` → `CheckIdempotency` [miss] → `ReserveInventory(inventory-svc RPC)` → `BeginTx { InsertOrder + InsertOrderItems + InsertIdempotencyRecord } CommitTx` → return `OrderID`
**测试方式**：e2e

#### 3.1.1 前置预期状态

**DB / 缓存基线**：

| 表 / Key | 预期状态 |
|---|---|
| `orders` (user_id=90001) | 0 行 |
| `order_items` (user_id=90001) | 0 行 |
| `idempotency_records` (req_id=R001) | 0 行 |

**下游服务**：

| 服务 | 类型 | 预期状态 | mock 配置 |
|---|---|---|---|
| inventory-svc | gRPC | 运行中，itemID=I001 库存 ≥ 1 | 不 mock |

**消息中间件**：

| 类型 | topic | 前置状态 |
|---|---|---|
| Kafka producer | order-events | topic 存在；本测试只发不收 |

**Setup 手段**：选未用过 userID 号段（90001+），无需 SQL 清表。

#### 3.1.2 测试输入

```bash
cmd/test_client create-order -user=90001 -item=I001 -qty=1 -req=R001
```

请求体：
```json
{"user_id": 90001, "item_id": "I001", "qty": 1, "req_id": "R001"}
```

#### 3.1.3 严格预期结果

**数据维度**

| 表 | 预期 |
|---|---|
| `orders` | 新增 1 行：`user_id=90001, status='CREATED'` |
| `order_items` | 新增 1 行：`item_id='I001', qty=1` |
| `idempotency_records` | 新增 1 行：`req_id='R001', order_id=新生成` |

**返回维度**
- 包头：gRPC status `OK`
- 包体：`Result.Code = 0`，`OrderID` 19 位非空，`CreatedAt` 当前时间戳

**日志维度**

必有日志（覆盖度）：

- **`OrderService_Create_Begin`** — INFO
  - 必含字段：`trace_id`、`userID`、`itemID`、`reqID`
- **`InventoryReserve_Success`** — INFO
  - 必含字段：`trace_id`、`itemID`、`reservedQty`
- **`OrderService_Create_Success`** — INFO
  - 必含字段：`trace_id`、`userID`、`orderID`

必无日志：

| 日志 | 不应有的原因 |
|---|---|
| 任何 ERROR | 主路径不应出错 |

**告警维度**：不应触发错误上报（主路径成功）

#### 3.1.4 代码预审发现

无（代码 walkthrough 通过）。

---

### 3.2 幂等命中（同 req_id 重复调用）

**目的**：验证同 req_id 第二次调用返回原 `OrderID`，不新建订单、不重复扣库存
**代码执行路径**：`CreateOrder` → `CheckIdempotency` [hit] → 直接 return 原 `OrderID`（不开事务、不调下游）
**测试方式**：e2e（依赖 3.1 落库结果）

#### 3.2.1 前置预期状态

**DB 基线**：

| 表 / Key | 预期状态 |
|---|---|
| `orders` / `idempotency_records` | 复用 3.1 落库结果（不清表） |

**Setup 手段**：先跑完 3.1，不清表。

#### 3.2.2 测试输入

按步骤执行：

1. **复发请求**（等 3.1 落库后）：`cmd/test_client create-order -user=90001 -item=I001 -qty=1 -req=R001`（与 3.1 入参完全相同）

#### 3.2.3 严格预期结果

**数据维度**

| 表 | 预期 |
|---|---|
| `orders` | 行数不变（仍是 3.1 的 1 行）|
| `order_items` | 行数不变 |
| `idempotency_records` | 行数不变 |

**返回维度**
- 包头：gRPC status `OK`
- 包体：`Result.Code = 1`（`BizCodeIdempotentHit`），`OrderID` 与 3.1 返回相同

**日志维度**

必有日志：

- **`OrderService_IdempotentHit`** — INFO
  - 必含字段：`trace_id`、`reqID`、`originalOrderID`

必无日志：

| 日志 | 不应有的原因 |
|---|---|
| `OrderService_Create_TxErr` | DuplicateKey 是预期幂等命中，不是事务错误 |
| `InventoryReserve_*` | 幂等命中应短路，不再调库存 |

**告警维度**：不应触发错误上报（幂等命中是预期行为）

#### 3.2.4 代码预审发现

| 缺陷 | 简述 | 优先级 | 状态 |
|---|---|---|---|
| [BUG3](./defects.md#bug3-duplicatekey-未识别为幂等) | DuplicateKey 未识别为幂等 | P0 | ✅ 已修复 |

详见 [defects.md](./defects.md)。
