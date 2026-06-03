# 缺陷档案：CreateOrder

> 本文档是真实样例，复制后按本项目场景替换。
> feature 范围所有缺陷的 single source of truth。
> [`plan.md`](./plan.md) X.4 代码预审 / [`round_N.md`](./round1.md) X 执行实证 / [`README.md`](./README.md) 1.4 上线决策 都引用本档案。

## 1. 摘要

| 编号 | 简述 | 优先级 | 状态 | 发现源 | 修复 commit |
|---|---|---|---|---|---|
| [BUG3](#bug3-duplicatekey-未识别为幂等) | DuplicateKey 未识别为幂等 | P0 | 已修复 | plan 3.2 预审 + round1 3.2 实证 | `a3f1b2c` |
| [BUG7](#bug7-大订单-rt--200ms) | 大订单 RT > 200ms | P2 | 推迟下迭代 | round1 3.5 实测 | - |

> 优先级定义见 [SKILL.md "Bug 优先级"](../SKILL.md)。状态枚举：`已修复` / `修复中` / `推迟下迭代`。

## 2. 详情

### BUG3：DuplicateKey 未识别为幂等

| 项 | 值 |
|---|---|
| 优先级 | P0 |
| 状态 | 已修复 |
| 发现源 | [plan 3.2 代码预审](./plan.md#324-代码预审发现) + [round1 3.2 第 1 次实证](./round1.md#32-幂等命中) |
| 修复 commit | `a3f1b2c` `fix(BUG3): identify DuplicateKey as IdempotentHit` |
| 修复 round | Run 1 |
| 回归证据 | [round1 3.2 第 2 次执行 PASS](./round1.md#第-2-次执行修复后回归20260530-1012) |

**根因**：

`service.create.go:78` 对 `*mysql.DuplicateKeyError` 走 generic error 分支，未识别为幂等场景。

```go
// service.create.go:78（修复前）
_, err := s.repo.Insert(ctx, order)
if err != nil {
    return nil, fmt.Errorf("create order: %w", err)  // ❌ DuplicateKey 也走这里
}
```

调用栈：`InsertOrder` → 触发 `mysql.DuplicateKeyError`（idempotency_records 唯一键冲突）→ 包成 generic 错误 → 上层 ferror.Report 误告警 + 包体 `Code=9999`。

**修复方案**（代码 + 日志 + 告警三方一并改）：

代码层（`service.create.go:78`，diff 风格标记修复部分）：

```diff
  _, err := s.repo.Insert(ctx, order)
  if err != nil {
+     // 幂等命中：查原 orderID 返回，不再开事务、不再调下游
+     if mysqlErr, ok := err.(*mysql.DuplicateKeyError); ok && mysqlErr.IsIdempKey() {
+         record, err := s.idempRepo.Get(ctx, req.ReqID)
+         if err != nil { return nil, err }
+         log.Info("OrderService_IdempotentHit",
+             "trace_id", traceID, "reqID", req.ReqID, "originalOrderID", record.OrderID)
+         return &Response{Result: &Result{Code: BizCodeIdempotentHit}, OrderID: record.OrderID}, nil
+     }
      return nil, fmt.Errorf("create order: %w", err)
  }
```

日志层：
- 新增 `OrderService_IdempotentHit` INFO（含 `trace_id` / `reqID` / `originalOrderID`）
- 删除 DuplicateKey 路径的 `OrderService_Create_TxErr` ERROR（原本同一事件双告 ERROR + 内部 panic）

告警层：
- DuplicateKey 路径不再触发 `errreport.Report`（业务幂等命中不是系统异常）

**关联**：无相关 issue / PR。

---

### BUG7：大订单 RT > 200ms

| 项 | 值 |
|---|---|
| 优先级 | P2 |
| 状态 | 推迟下迭代 |
| 发现源 | [round1 3.5 实测](./round1.md#35) |
| 修复 commit | - |
| 推迟原因 | 性能问题需 SQL 索引重设计，工作量大；不影响功能正确性 |

**现象**：

百万级历史订单的用户查询，p99 RT 220ms，超过 SLA 100ms。

实测数据（来自 round1 3.5）：

| 用户类型 | 订单数 | p50 RT | p99 RT |
|---|---|---|---|
| 普通用户（< 1k 订单）| 100~999 | 18ms | 45ms |
| 大用户（1k~10k 订单）| 1k~10k | 56ms | 120ms |
| **超大用户（> 100k 订单）** | 100k+ | **150ms** | **220ms** ❌ |

**根因（初步分析）**：

`SELECT * FROM orders WHERE user_id = ?` 当前依赖 `(user_id)` 单列索引，超大用户全表扫描成本高。

候选修复（需进一步设计验证）：
- 加复合索引 `(user_id, created_at DESC)` 配合分页
- 历史订单冷热分离

**风险评估**：
- 影响范围：约 0.5% 大用户
- 业务影响：用户体验降级，**功能仍正确**

**应急方案**（已部署）：

网关层加 100ms 短缓存：

```yaml
# gateway/config.yaml
cache:
  - path: /api/orders/list
    ttl: 100ms
    key: user_id
```

预期效果：高频查询命中缓存，p99 降至 60ms 以下。

**后续计划**：

- 关联 issue: [#5678](xxx)
- 责任人：@xxx
- 计划版本：v2.1（2026-06）
- 解决方案：评估"复合索引" vs "冷热分离"，技术方案下迭代设计评审

**已周知**：leader @xxx / QA @yyy
