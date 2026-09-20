---
name: weekly-project-plan
version: 1.0.0
description: Use when a week's 常规事项 work item in 飞书项目 (Meego) needs to be created, refreshed, or fixed — missing entirely, out of sync with the calendar, or carrying subtasks whose meetings moved or were cancelled. Triggers on "建下周常规事项", "常规事项单", "下周的会议排进去", "常规事项单对不上", "会议改了/取消了", "飞书项目周计划", "weekly-project-plan", "+auto". NOT for: 飞书云文档的周计划（→ weekly-plan）、CLI/Skills 周报（→ weekly-report）。
---

# weekly-project-plan（飞书项目 · 下周常规事项单）

## Overview

每周要做的机械动作：**在飞书项目建一张下周的「常规事项」单，把下周的会议按真实时段排成子任务，再加一条固定的 OnCall 子任务。**

手工做这件事有两个反复踩的坑：

1. **按「周一到周五」猜工作日是错的。** 调休会把周六/周日变成上班日（2026 年有 6 天），也会把周五变成假日（2026-09-25 中秋）。猜错直接导致漏排或多排。
2. **Meego 的写接口有多个「返回 success 但没落库」的行为。** 不换读校验就会把残缺数据当成建好了。

这个 skill 把这两件事都固化了：工作日一律走 `scripts/workdays.py`（内含国务院调休表），每一步写完必须回读。

## Iron Laws（铁律）

1. **工作日必须跑脚本算，不许心算。** 任何涉及「本周/下周是哪几天」的判断，先跑 `scripts/workdays.py`，用它的输出，不要凭星期几推。
2. **建单前必须查重。** 同一张单建两次 = 两倍工作量，且 CLI 删不掉工作项。先 MQL 查 `常规事项-<label>` 是否存在。
3. **不猜业务。** 非会议事项、会议过滤的边界（tentative / needs_action 要不要算）由用户定。拿不到就留空并在推送里问，不要自己发明一条填进去。
4. **所有 Meego 写操作返回 `success` 都不算数，必须回读。** 见 [references/meego-routine-fields.md](references/meego-routine-fields.md) 的「空成功」清单。
5. **子任务的 `points` 必须塞进 `--schedule` 对象一起传。** 单独改排期会把估分重置成默认 1。

## 命令

| 命令 | 用途 | 触发方式 |
|------|------|----------|
| `+auto` | 无人值守全自动：算范围 → 查重 → 读日历 → 建单 → 建子任务 → 回读 → bot 推送 | launchd 周一~周六 14:00 |
| `+preview` | 只读预演：输出范围 + 会议清单 + 估分草案，**不写任何东西** | 用户在场时先看 |
| `+create` | 按已确认的草案执行建单 | 用户确认后 |

无命令时默认走 `+preview`，展示草案并等用户确认。

## 执行流程

> 下面命令里的 `$SKILL` 指本 skill 目录。launchd 无人值守跑时 cwd 是 `/Users/admin/Documents/week-report`，**相对路径 `scripts/...` 会找不到**，一律用绝对路径：
> `SKILL_DIR=~/.claude/skills/weekly-project-plan`

### Step 0 — 算工作日范围（所有命令的第一步）

```bash
SKILL_DIR=~/.claude/skills/weekly-project-plan
python3 "$SKILL_DIR/scripts/workdays.py"                  # 今天所在周 + 下周
python3 "$SKILL_DIR/scripts/workdays.py" --date 2026-09-30   # 指定「今天」（补建历史周用）
python3 "$SKILL_DIR/scripts/workdays.py" --check-today       # 触发日判定，exit 0 = 该跑
```

关键字段：

| 字段 | 含义 |
|------|------|
| `next_week.label` | 单名后缀，如 `20260921`（= 下周一日期） |
| `next_week.start` / `end` | **节点与固定子任务的排期起止**（真实工作日，可能含前置调休上班日） |
| `next_week.workdays` | 下周真实工作日列表 |
| `next_week.calendar_start` / `calendar_end` | **读日历用的范围**（覆盖整个自然周，含假日——假日也可能有已接受的会议） |
| `next_week.leading_makeup` | 下周一之前紧邻的调休上班日（如 2026-09-20 周日），属于本单覆盖范围，别漏 |
| `this_week.last_run_workday` | 本周触发日 |

> 脚本退出码 `3` = 目标年份的调休表未收录。**停下来问用户，不要猜**。国务院每年 11 月发布次年安排，届时补 `scripts/workdays.py` 的 `HOLIDAYS`。

### Step 1 — 查重并决定「建单」还是「刷新」

```bash
meegle workitem query --project-key futu-project \
  --mql "SELECT name, work_item_id FROM \`futu-project\`.\`665ae9bc588ebe27e6a44468\` WHERE name LIKE '%常规事项-<label>%'" \
  --format json
```

- **不存在** → 走「建单」（Step 3），子任务全部新建。
- **已存在** → 走「刷新」（Step 1.5），**不建单**。

> MQL 的 `LIKE` 必须带 `%`（写 `'常规事项-2026'` 会报 `should like %T%`）。类型 key 以数字开头，**必须反引号包裹**。

### Step 1.5 — 刷新：先对账，再决定动什么

**单子建完之后日历还会继续变**（会议改期、取消、新加）。刷新**不是**「把日历上的会议再建一遍」——那会产生重复子任务。

```bash
python3 "$SKILL_DIR/scripts/reconcile_subtasks.py" \
  --start <calendar_start> --end <calendar_end> \
  --work-item-id <id> \
  --range-start <next_week.start> --range-end <next_week.end>
```

> 这个脚本**内部已经跑了 Step 2 的日历过滤**，输出里带 `excluded` / `errors`，刷新路径不用再单独跑 `next_week_meetings.py`。

输出 6 类，逐类处置：

| 输出 | 含义 | 处置 |
|------|------|------|
| `create` | 日历有、单里没有 | 按 Step 4b 新建 |
| `update` | 配对上了但排期/估分不符 | 按 `now` 改期，**points 必须一起传** |
| `keep` | 配对上了且一致 | 不动 |
| `stale` | 单里有、日历上已无此会议 | **不自动处理**，见下 |
| `oncall` | 固定子任务 | `fix` 非空才改 |
| `untouched` | 非 `【会议】` 且非固定 OnCall | **一条都不许碰**（见 Step 4c） |

**配对规则由脚本固化，不要手工配**：按标题分组 → 同标题内按「开始时间最接近」贪心配对。
之所以不能只靠名字：单里可能有多条同名子任务（实例：两条 `【会议】平台后端晨会-现网系统`），只能靠时间区分。

**`stale` 的处置**：CLI **删不掉子任务**（只有 create/update/confirm/rollback）。两条路：

1. 让用户去页面删（最干净）
2. 先把 `points` 置 `0` 止损（工作量不再虚高），再提醒用户去页面删

> 🚫 **绝不把 stale 子任务改名去顶替别的会议。** 名字和实际会议对不上，下次对账会更乱。

### Step 2 — 读下周日历并过滤

```bash
python3 "$SKILL_DIR/scripts/next_week_meetings.py" --start <calendar_start> --end <calendar_end>
```

一条命令出结果：读日历 → 过滤 → 算估分 → 吸附排期，输出 `included` / `excluded` / `errors`。

**纳入规则**（**由 2026-09-18 对已建子任务的反推验证得出，不是推测**）：

1. 日程的 `self_rsvp_status == "accept"`
2. 且**除我之外至少有 1 个参会人**——`user` / `resource`(会议室) / `chat`(群) **任一都算**

> 为什么是「任一都算」而不是「至少 1 个其他 user」：验证样本里
> `旧奖品下线周例会` 我 accept、没有其他 user，但有 1 会议室 + 1 群 → 实际**建了**；
> `Self`（个人时间块）我 accept、0 参会人 → 实际**没建**。
> 只看 user 数会漏掉前者、放进后者。

**`excluded` 不要直接扔**：`tentative` / `needs_action` 的日程是边界，`+auto` 里写进推送让用户决定，不要自己算进去，也不要静默丢弃。

`errors` 非空（参会人查不到等）→ 同样进推送，**不要猜**。

**假日里的会议照建。** 日历范围覆盖整个自然周（含假日），落在假日的会议只要满足纳入规则就建子任务——用户 `accept` 了就是真要开，不要自作主张按假日过滤掉。

> ⚠️ 但要向用户说明副作用：**节点排期会自动收敛到子任务包络**，所以假日会议会把节点 `end` 拉到假日。
> 这是平台行为，改不了，**不要手动往回拉**（会报 `ErrScheduleCheck`）。

### Step 2.5 — 把结果给人看（`+preview` 到此为止）

把 `included` 按时间列出来，附上：会议时长、换算后的估分、吸附前后的时段。
**必须说明 0.1 下限的副作用**：0.25h 的晨会和 1h 的周会都是 0.1，这是口径的必然结果。

同时列出 `excluded` 及原因、`errors`。

### Step 3 — 建单

```bash
meegle workitem create --project-key futu-project --work-item-type 665ae9bc588ebe27e6a44468 --fields '[
  {"field_key":"template","field_value":"1485307"},
  {"field_key":"name","field_value":"常规事项-<label>"},
  {"field_key":"description","field_value":"常规事项-<label>"},
  {"field_key":"field_fc9565","field_value":"xmf1t3p2d"},
  {"field_key":"field_985aa9","field_value":"false"},
  {"field_key":"field_daee63","field_value":"p991nl8w7"},
  {"field_key":"field_2d8752","field_value":"ck89i64lo"}
]' --format json
```

拿到 `work_item_id` 后，**按顺序**做三件事：

**1. 设 `started` 节点排期，然后立刻清掉它的估分。**
模板给 `started` 默认 4 人天，而 `workhour list-schedule` 把**已 passed 的节点也算工作量**，不清会让个人排期虚高 4 天。

```bash
# 1a. 设排期
meegle workflow update-node --work-item-id <id> --project-key futu-project --node-id started \
  --node-schedule '{"estimate_start_date":<start_ms>,"estimate_end_date":<end_ms>}' --format json
# 1b. 清估分（{} 只清 points，清不掉日期；残留一行 0 天记录，影响为零）
meegle workflow update-node --work-item-id <id> --project-key futu-project --node-id started \
  --node-schedule '{}' --format json
```

**2. 补关注人**（`role_operate` 返回空成功，必须回读）：

```bash
meegle workitem update --work-item-id <id> --project-key futu-project \
  --role-operate '[{"op":"add","role_key":"role_fb4d47","user_keys":["7626451036340767674"]}]' --format json
```

**3. 流转 `started` → `state_0`**：

```bash
meegle workflow transition --work-item-id <id> --project-key futu-project --node-id started --action confirm --format json
```

> ⚠️ **不要自动填「业务确认通过」(`field_ee36bf`)。** API 流转会绕过这个必填校验（节点会 finished 但字段为空），但它是业务事实断言，必须用户自己确认。留空并在推送里提醒。

### Step 4 — 建子任务

全部挂在**当前 doing 节点**（`state_0`）。

**4a. 固定子任务**（每周必带，一条，不是两条）：

- 名称：`日常oncall+告警排查+团队事项`
- 估分：`1` 人天
- 排期：`next_week.start` 00:00:00 → `next_week.end` 23:59:59

**4b. 会议子任务**（每场会议一条，**不合并重复日程的多次实例**）：

直接消费 Step 2 脚本输出的 `included`，**不要自己重算**：

- `name` = 脚本给的 `【会议】<日程标题>`（前缀是历史惯例，别省）
- `points` / `estimate_start_ms` / `estimate_end_ms` = 脚本给的字段

脚本已固化的两条口径：

| 口径 | 规则 | 例 |
|------|------|-----|
| 估分 | `时长(h) ÷ 7`，四舍五入到 0.1，下限 0.1 | 0.25h→0.1、1h→0.1、2h→0.3 |
| 排期（只有小时粒度） | `start` 向下取整到整点；`end` = (结束 − 1 秒) 所在小时的 `59:59` | 09:45–10:00→09:00–09:59；16:30–17:30→16:00–17:59 |

> ⚠️ 下限 0.1 会让 0.25h 的晨会和 1h 的周会得到同一个估分。这是口径的必然结果，**要在推送里说明，不要偷偷抹平**。
> ⚠️ 不要写成整天 00:00–23:59（用户 2026-09-18 指出「时间跨度不对」）。

统一命令形态：

```bash
meegle subtask update --action create --node-id state_0 --work-item-id <id> --project-key futu-project \
  --fields '[{"field_key":"name","field_value":"<子任务名>"}]' \
  --schedule '{"estimate_start_date":<开始ms>,"estimate_end_date":<结束ms>,"points":<估分>}' \
  --assignee '["7626451036340767674"]' --format json
```

> 🚨 **必须串行创建**，不要并发——Meego 会限流。
> 🚨 时间戳换算用脚本/命令算，不要口算（`python3 -c "import datetime as d;print(int(d.datetime(2026,9,20,0,0).timestamp()*1000))"`）。

**4c. 非会议事项（不由脚本产生）**

`+auto` **不发明**非会议事项——Iron Law 3。固定项只有 4a 那一条 OnCall，其余靠用户补。

- **刷新时**：`reconcile_subtasks.py` 的 `untouched` 列表就是「本 skill 不认领的子任务」，**一条都不许动**
  （典型：用户手工加的「赠股巡检能力完善」）。列进推送让用户确认是否仍需要，但不要自作主张删改。
- **用户要加**：按 4a 同样的命令形态建，`points` 和排期由用户给，不要替用户估。

### Step 5 — 回读校验（必做，不许跳）

```bash
meegle workflow get-node --project-key futu-project --work-item-id <id> \
  --node-id-list '["state_0"]' --need-sub-task true --select "list.sub_tasks" --format json
```

逐条核对：**子任务条数**、**每条 name**、**每条 points**、**每条起止时间**。对不上就修，不要凭 create 的返回值宣称成功。

再核节点排期与个人总工作量：

```bash
meegle workhour list-schedule --project-key futu-project \
  --user-keys '["7626451036340767674"]' --start-time <start> --end-time <end> --format json
```

**新建场景检查点**：

- 不应出现 `started`（规划中）节点那一行——出现了说明 Step 3 的估分没清干净
- 子任务条数 == `included` 条数 + 1（固定 OnCall）

**刷新场景额外检查点**（`+auto` 撞上「单已存在」时必查）：

- `reconcile` 的 `create` / `update` 是否都已执行，且回读与 `now` 一致
- **节点 `end` 是否落在非工作日**——只有当日历上确实有假日会议时才算正常，否则说明有 stale 子任务在撑着节点排期
- 节点估分 == Σ 子任务 `points`（含 `untouched` 的）
- `untouched` 列表与刷新前一致（没被误动）

### Step 6 — bot 推送（`+auto` 必做）

```bash
lark-cli im +messages-send --as bot --user-id ou_a735e005fa3ddb9a8b59c745805db36e --markdown "<摘要>"
```

摘要必须包含：

- 单名 + 链接 + `work_item_id`
- 范围（`start` ~ `end`，标注哪几天是调休上班日 / 哪天是假日）
- 子任务条数与总人天
- **⚠️ 待人工处理**段：需要手动填的字段（`field_ee36bf` 业务确认通过）、tentative/needs_action 的会议、脚本算不出来的非会议事项
- **没有待办就不要硬凑这一段**

## 常见错误

| 现象 | 原因 / 处理 |
|------|-------------|
| `should like %T%` | MQL 的 LIKE 没带 `%` |
| `unexpected '2'` / `unrecognized character` | 类型 key 没加反引号，或空间 key 和类型 key 没同时加 |
| 子任务估分变成 1 | 改排期时没把 `points` 一起塞进 `--schedule` |
| 个人排期虚高 4 天 | `started` 节点的模板默认估分没清 |
| `节点排期不得小于子任务总排期` | 节点排期会自动收敛到子任务包络，别手动往回拉 |
| `event not found` | 重复性日程用了实例 ID，改用 `<base>_0` |
| 调休表退出码 3 | 年份未收录，补 `scripts/workdays.py` 的 `HOLIDAYS`，**别猜** |

## 定时任务

- launchd：`~/Library/LaunchAgents/com.ericmao.weekly-project-plan.plist`，**周一到周六 14:00**
- 包装脚本：`/Users/admin/bin/weekly-project-plan.sh`（先跑 `workdays.py --check-today` 做廉价守卫，不是触发日就直接退出，不启动 claude）
- 日志：`/tmp/weekly-project-plan.log`

> **为什么是「周一到周六」而不是「每周五」**：触发日 = 本周最后一个工作日，它可能是周四（2026-09-24，因为 09-25 是中秋）、也可能是周六（2026-10-10，调休上班）。写死周五会漏跑。守卫逻辑在脚本里，见 `scripts/workdays.py --check-today`。

## 相关

- 字段值、踩坑细节、可写入性清单：[references/meego-routine-fields.md](references/meego-routine-fields.md)
- 飞书云文档的周计划（另一套）：`weekly-plan` skill
- 调休表来源：国办发明电〔2025〕7号（2025-11-04）
