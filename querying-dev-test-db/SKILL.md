---
name: querying-dev-test-db
description: Use when querying the dev or test MySQL database via the local mycli client — running read-only SELECT/DESCRIBE/SHOW against the internal dev/test scheduler DB, inspecting tables like workflow_instance / node_execution_record / workflow_summary, or converting bigint millisecond timestamps to readable datetimes. 触发词：查 dev 库、查 test 库、用 mycli 查数据库、看表数据、查 node_execution_record、bigint 时间转换。
---

# 用 mycli 查询 dev / test 数据库

## 目录

- [Overview](#overview)
- [连接别名](#连接别名)
- [非交互执行（agent 必用）](#非交互执行agent-必用)
- [已有收藏查询（\f <name> <参数>）](#已有收藏查询f-name-参数)
- [bigint 时间戳转换（本库为毫秒，需 /1000）](#bigint-时间戳转换本库为毫秒需-1000)
- [安全护栏（不可绕过）](#安全护栏不可绕过)
- [Common Mistakes](#common-mistakes)

## Overview

通过本地 `~/.myclirc` 里配好的 DSN 别名连 dev/test 库，**非交互执行只读 SQL**。
凭证只放在 `~/.myclirc` 的 `[alias_dsn]`，命令里只用别名（`dev` / `test`），永不写明文。

## 连接别名

| 别名 | 用途 | 说明 |
|------|------|------|
| `dev` | 日常查询（首选） | 业务账号，权限小，查询用它 |
| `dev-root` | 需要 root 权限时 | 慎用，**不要**用它做日常 SELECT |
| `test` | 测试环境 | 库 `db_ucircle_mkt_scheduler`（账号 `uc_scheduler`），与 dev 同库同表 |
| `manager` | mkt manager 库 | 库 `ucircle_mkt_manager`（账号 `mkt_manager`，`10.2.4.159`），与 scheduler 库不同表，时间字段单位需自行确认 |

## 非交互执行（agent 必用）

agent 无法进交互式 REPL，一律用 `-e` 单条执行：

```bash
mycli -d dev -e "SELECT * FROM workflow_instance WHERE instance_id='123' LIMIT 5"
mycli -d dev -e "DESCRIBE node_execution_record"
```

- `\f` 收藏查询在 `-e` 模式下可用：`mycli -d dev -e '\f node 2986881352634631893 5'`
- 实测会打印 `Ignoring STDIN since --execute was also given.`，是正常提示，忽略即可。

## 已有收藏查询（`\f <name> <参数>`）

| name | 作用 | 示例 |
|------|------|------|
| `node` | 按 instance_id 查 node_execution_record | `\f node <instance_id> <limit>` |
| `ins` | 按 instance_id 查 workflow_instance | `\f ins <instance_id>` |
| `sta` | 按 strategy_id 查 workflow_instance | `\f sta <strategy_id> <limit>` |
| `qs` / `qsl` | 任意表查前 N 行 | `\f qsl <table> <n>` |
| `myw` | 任意表带 WHERE | `\f myw users "id=1"` |
| `mydesc` / `qc` | 表结构 / 总行数 | `\f mydesc <table>` |

> `node`/`ins`/`sta`/`ws` 已内置时间转换：`SELECT *` 末尾自动追加 `create_at`/`update_at`/`archive_at` 等转换好的列，`\f` 调用即可看到 date，无需手写。`qs`/`qsl`/`myw` 是通用查询（任意表，字段未知），需按下方手动套 `FROM_UNIXTIME`。

## bigint 时间戳转换（本库为毫秒，需 /1000）

`db_ucircle_mkt_scheduler` 多数时间字段是 **13 位毫秒级 bigint**（`create_time`、`update_time`、`dispatched_at`、`finished_at`、`next_retry_at`），转换 `/1000` 即可。

⚠️ 例外：`node_execution_record.trigger_expire_at` **精度不统一**——同字段里 13 位毫秒与 16 位微秒混存（疑似写入端单位不一致的数据 bug）。固定 `/1000` 会让 16 位的值溢出 `FROM_UNIXTIME` 范围返回 NULL。要按位数归一化到秒：

```sql
FROM_UNIXTIME(NULLIF(trigger_expire_at,0)/POWER(10,LENGTH(NULLIF(trigger_expire_at,0))-10))
```

（`LENGTH-10` = 比秒级多出的位数；13 位→/1e3，16 位→/1e6。收藏查询 `node` 已用此写法。）

```bash
mycli -d dev -e "
SELECT id, instance_id,
       FROM_UNIXTIME(create_time/1000)  AS create_at,
       FROM_UNIXTIME(update_time/1000)  AS update_at
FROM node_execution_record
WHERE instance_id='2986881352634631893'
ORDER BY id DESC LIMIT 10"
```

- 只要日期：`DATE(FROM_UNIXTIME(create_time/1000))`
- 判断秒/毫秒：值 13 位是毫秒（/1000），10 位是秒（直接转）。

## 安全护栏（不可绕过）

- **只读优先**：查询用 `dev`，不用 `dev-root`；不在查询任务里跑 UPDATE/DELETE/DROP。
- **凭证保护**：skill 和任何输出里只用别名，绝不回显或写入明文密码；`~/.myclirc` / `~/.my.cnf` 含明文密码，不得 commit。
- `~/.myclirc` 已开 `destructive_warning`，DROP/DELETE/TRUNCATE/UPDATE 等会拦截确认——非交互模式下这类语句可能直接失败，符合预期，不要为绕过它改配置。

## Common Mistakes

- ❌ 用 `dev-root` 做日常查询 → 权限过大，改用 `dev`。
- ❌ 把 bigint 时间当秒转（`FROM_UNIXTIME(create_time)`）→ 本库是毫秒，结果为空/错乱，要 `/1000`。
- ❌ 把 `manager` 库当 scheduler 库查 → 两库表结构不同，`manager`（`ucircle_mkt_manager`）无 `node_execution_record` 等表，先 `SHOW TABLES` 确认。
- ❌ 在命令或回复里粘贴明文密码 → 永远只用别名。
