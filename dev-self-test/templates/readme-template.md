# 自测：feature/order-create（2026-05-29）

> 本文档是真实样例，复制后按本项目场景替换。
> Feature 级入口。
> 1 段（自测结论）：执行后填，给 reviewer / leader 看——能不能发版
> 2 段（自测依据）：执行前填，给 plan 编写者 / 审计者看——为什么这么测

## 目录

- [1. 自测结论](#1-自测结论)
  - [1.1 自测结果总览](#11-自测结果总览)
  - [1.2 发布前 checklist](#12-发布前-checklist)
  - [1.3 发布计划](#13-发布计划)
  - [1.4 已知问题与上线决策](#14-已知问题与上线决策)
- [2. 自测依据](#2-自测依据)
  - [2.1 Feature 元信息](#21-feature-元信息)
  - [2.2 输入文档](#22-输入文档)
  - [2.3 git diff 入口推导](#23-git-diff-入口推导)
  - [2.4 文档冲突清单](#24-文档冲突清单)
  - [2.5 测试分类与覆盖](#25-测试分类与覆盖)
  - [2.6 索引](#26-索引)

---

## 1. 自测结论

### 1.1 自测结果总览

| 场景 | 基础测试（PASS / FAIL）| 业务测试（PASS / FAIL）| 跑过轮次 | 状态 | 链接 |
|---|---|---|---|---|---|
| createorder | 2 / 0 | 4 / 0 | Run 1 | PASS | [round1](./round1.md) / [defects](./defects.md) |

> 多场景时一行一个场景；含未闭环时状态可标 PARTIAL。

### 1.2 发布前 checklist

> 依据 [技术方案 6.1 变更项](../../design/order-create-v2.md#61-变更项)。

**DB / 数据迁移**：
- [ ] DB 迁移脚本已合并到 main：`alembic_2026_05_29_001.sql`（PR [#1234](xxx)）
- [ ] dev / staging / prod 环境迁移已执行

**消息中间件**：
- [ ] Kafka topic 已建：`order-events`（分区=3 / 保留=7d 已确认）

**配置项**：
- [ ] `payment.timeout` 已在生产配置中心更新为 `30s`
- [ ] `order.max_qty` 已设为 `1000`

**上下游通知**：
- [ ] @gateway-team（接口变更）
- [ ] @billing-team（OrderCreated 事件订阅）
- [ ] @risk-team（用户风控集成）

**监控 / 告警**：
- [ ] 监控面板已建：[order-svc dashboard](xxx)
- [ ] 告警规则已配置：`order_create_error_rate > 1%` / `order_create_p99 > 500ms`

### 1.3 发布计划

> 灰度策略与回滚方案依据 [技术方案 6.2 回滚方案](../../design/order-create-v2.md#62-回滚方案)。

**灰度时间线**：
- 1% 灰度：2026-05-30 14:00（24h 观察期）
- 10% 灰度：2026-05-31 14:00
- 全量：2026-06-01

**失败回滚**：
- 关闭 feature flag `order_v2_enabled` → 旧链路立即生效
- DB 双写期 7 天，期间可回滚不丢数据

**应急联系**：
- Leader：@xxx
- Oncall：@yyy

### 1.4 已知问题与上线决策

**是否带病上线**：是

**未闭环遗留**（详见 [defects.md](./defects.md)）：

| 缺陷 | 优先级 | 影响 | 风险评估 | 应急方案 | 后续计划 |
|---|---|---|---|---|---|
| [BUG7](./defects.md#bug7-大订单-rt--200ms) RT > 200ms（百万级订单查询）| P2 | 0.5% 大订单 RT 超 SLA 100ms | 低，仅性能不达标，功能正确 | 网关层加 100ms 缓存（已部署）| 下迭代优化 SQL 索引 |

**已周知**：leader @xxx / QA @yyy / 运营 @zzz

> 禁含糊（"应该没问题"）。带病上线必须列：未解决项 + 风险评估 + 应急方案 + 已周知名单。

---

## 2. 自测依据

### 2.1 Feature 元信息

| 项 | 值 |
|---|---|
| 分支 | `feature/order-create` |
| 开测日期 | 2026-05-29 |
| 涉及服务 | order-svc |
| 触及对外入口 | 1 个（CreateOrder） |
| 自测形态 | 单场景平铺 |

### 2.2 输入文档

| 类别 | 文档 | 链接 / 路径 |
|---|---|---|
| 需求 | PRD | [PRD-2026-031](飞书链接) |
| 设计 | 技术方案 | `docs/design/order-create-v2.md` |
| 用例 | use-case | `docs/use-case/UC-001-create-order.md` |
| 历史 | 已有测试用例 | `docs/testcase/order.csv` |

### 2.3 git diff 入口推导

```bash
git diff main...HEAD --stat
```

输出：
```
internal/domain/order/service.create.go | 124 ++++++
proto/order.proto                        |  18 ++
```

**推导**：触及对外入口 1 个（`OrderService.CreateOrder`），无"顺手改动"。
**形态**：单场景 → plan / round / record / defects 平铺，无场景子目录。

### 2.4 文档冲突清单

> 4 类输入文档不一致点逐条列出，**用户已确认采信哪份**。

| # | 冲突点 | 涉及文档 | 采信 | 决议 |
|---|---|---|---|---|
| 1 | 幂等窗口期 | PRD 24h vs 技术方案 7d | 技术方案 | 7 天，PRD 待修订 |

> 如无冲突，写"无（4 类文档已对齐）"——但 4 份文档完全一致是稀有事件，"无"是可疑信号。

### 2.5 测试分类与覆盖

#### 基础测试（依据 [SKILL 基础测试模板](../../../dev-self-test/SKILL.md#基础测试模板))

| 子类 | 适用 | 备注 |
|---|---|---|
| 必填参数缺失 | ✓ | userID / itemID / reqID |
| 参数类型异常 | N/A | proto SDK 层强制类型，应用层拦不到 |
| 参数越界 | ✓ | qty 范围 [1, 1000] |
| 非法字符 / 注入 | N/A | itemID 为枚举类型，无注入风险 |
| 空集合 / null | N/A | 本 RPC 无数组 / 嵌套字段 |

> N/A 必须给原因。备注列空 → 退回。

具体分支见 [plan.md 2 基础测试](./plan.md#2-基础测试)。

#### 业务测试

按 use-case 接受准则推导：
- 主路径成功
- 幂等命中
- 库存不足
- 用户风控
- 上游异常

详见 [plan.md 3 业务测试](./plan.md#3-业务测试)。

### 2.6 索引

- [plan.md](./plan.md) — 测试计划（基础 + 业务）
- [round1.md](./round1.md) — Run 1 执行记录
- [defects.md](./defects.md) — 缺陷档案

> 多场景时本段改为表格：每个场景一行，列各文件链接。
