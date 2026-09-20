# 常规事项单 · 字段与踩坑速查

> 实证时间：2026-09-17 ~ 2026-09-18，空间 `futu-project`（FUTU富途）。

## 目录

- [空间与类型](#空间与类型)
- [必填 6 项（`workitem meta-create-fields` 可得）](#必填-6-项workitem-meta-create-fields-可得)
- [角色](#角色)
- [排期](#排期)
- [「空成功」清单（返回 success 但没落库）](#空成功清单返回-success-但没落库)
- [子任务](#子任务)
- [建单后必查：旧节点估分重复计入](#建单后必查旧节点估分重复计入)
- [流转](#流转)
- [回读命令](#回读命令)
- [关键 ID](#关键-id)
- [时间戳](#时间戳)

## 空间与类型

| 项 | 值 |
|----|----|
| 空间 key | `futu-project`（FUTU富途，key `6695050e72bf98fae08bced7`） |
| 类型 key | `665ae9bc588ebe27e6a44468`（常规事务） |
| 模板 | `1485307`（常规事项）；`1641486` 是休假单 |
| 流程类型 | **节点流**（`work_item_mod: 节点流`），不是状态流 |
| 节点链 | `started`(规划中) → `state_0`(进行中) → `state_1`(结束) |
| 单名规范 | `常规事项-YYYYMMDD`，YYYYMMDD = 下周一日期 |

## 必填 6 项（`workitem meta-create-fields` 可得）

| field_key | 含义 | 类型 | ericmao 常用值 |
|-----------|------|------|----------------|
| `name` | 事务名称 | text | `常规事项-20260921` |
| `field_fc9565` | 事务类型 | select | `xmf1t3p2d`（运营事项） |
| `field_985aa9` | 是否关联项目 | bool | `"false"` |
| `field_daee63` | 研发组织架构 | tree-select | `p991nl8w7`（增长产品研发部/增长平台研发中心/增长平台后端开发组） |
| `field_2d8752` | 所属团队 | radio | `ck89i64lo`（研发） |
| `template` | 模板 | — | `1485307` |

其他：`description` 同 `name`；拉群方式默认「不拉群」。

## 角色

| role_key | 角色 | 说明 |
|----------|------|------|
| `role_4c7e19` | 负责人 | 创建时自动带上创建者 |
| `role_1198ae` | 跟进人 | 创建时自动带上创建者 |
| `role_fb4d47` | 关注人 | ⚠️ **创建后为空，必须显式补** |

补关注人（`role_operate` 返回空成功，**必须回读验证**）：

```bash
meegle workitem update --work-item-id <id> --project-key futu-project \
  --role-operate '[{"op":"add","role_key":"role_fb4d47","user_keys":["7626451036340767674"]}]' --format json
```

## 排期

- 该类型**没有「排期」字段**，排期挂在节点上。
- 节点排期：`workflow update-node --node-id started --node-schedule '{"estimate_start_date":ms,"estimate_end_date":ms}'`
- 回读位置：`workitem get` 的 `work_item_current_node[].estimated_start_time / estimated_end_time`
- **节点 `points` 会自动同步为子任务估分之和**，不用手写。

## 「空成功」清单（返回 success 但没落库）

以下行为都实测过返回 `"success"` 而回读不变。**写完必须回读**：

| 操作 | 现象 |
|------|------|
| `workflow update-node --node-schedule '{"estimate_start_date":null,"estimate_end_date":null}'` | 返回 success，日期清不掉（`{}` 只能清 points） |
| `role_operate` 加关注人 | 返回空成功，需回读确认 |
| 子任务 create 时单独传 `points` | 被静默忽略（写 0.3/0.1 落库成 1/0） |
| 只改 `--schedule` 不带 `points` | 估分被重置成默认 1 |

## 子任务

```bash
meegle subtask update --action create --node-id state_0 --work-item-id <id> --project-key futu-project \
  --fields '[{"field_key":"name","field_value":"<名>"}]' \
  --schedule '{"estimate_start_date":<ms>,"estimate_end_date":<ms>,"points":<估分>}' \
  --assignee '["7626451036340767674"]' --format json
```

- 返回 `{ID: <sub_task_id>}`。
- 子任务挂在**当前 doing 节点**下；已 finished 的节点不要挂。
- **没有 delete action**（只有 create/update/confirm/rollback）。想「删」只能改名改期复用，真删要走页面。
- **必须串行创建**，并发会触发平台限流。

### 排期只有小时粒度

传进去的分钟会被吸附：`start` 向下取整到整点，`end` 吸附到**所传 end 所在小时的 `59:59`**。

- 传 09:45 → 10:00，落库成 09:00 → 10:59:59
- 传 09:45 → 09:59:59，落库成 09:00 → 09:59:59

取真实会议时段的写法：`start = 开始时间向下取整到整点`；`end = (结束时间 − 1 秒) 所在小时的 59:59`。

### 节点排期会被自动收敛

建完子任务后，节点 `start` 会被拉到**最早子任务 start**。手动改回去报：

```
ErrScheduleCheck,message=节点排期不得小于子任务总排期
```

这是正常收敛，不要手动往回拉。

## 建单后必查：旧节点估分重复计入

常规事务创建时 `started`(规划中) 节点自带**模板默认估分 4**。`workhour list-schedule` 把**已 passed 的节点也计入工作量**，于是同一张单出现两行（规划中 4 天 + 进行中 N 天），用户下周排期虚高 4 天。

- **预防**：设完节点排期后立刻 `--node-schedule '{}'` 清掉估分。
- 残留的一行 0 天记录影响为零，彻底去掉需页面操作或等单据结束。

## 流转

常规事务是**节点流**，用 `workflow transition`；用 `workflow list-state-transitions` 会报 `work item flow mode not state flow`。

```bash
meegle workflow transition --work-item-id <id> --project-key futu-project --node-id started --action confirm --format json
```

回读：`workflow get-node --node-id-list '["_all"]' --select "list.basic"`，看 `status`（finished/doing/not_started）。

> ⚠️ **API 流转会绕过节点必填校验。** `规划中` 节点上 `field_ee36bf`「业务确认通过」(radio, `is_required: True`，选项 通过=`25p0zftyb` / 不通过=`jsuuwf2h9`) 值为 null 时，`workflow transition` 照样返回 `"success"` 并放行 → 节点 finished 但必填字段为空。所以要**自己回读 form_items 检查必填是否留空**。
>
> ⚠️ 写「业务确认通过」= 代用户做业务事实断言，**必须用户确认后再写**。

## 回读命令

```bash
# 子任务
meegle workflow get-node --project-key futu-project --work-item-id <id> \
  --node-id-list '["state_0"]' --need-sub-task true --select "list.sub_tasks" --format json

# 节点状态
meegle workflow get-node --project-key futu-project --work-item-id <id> \
  --node-id-list '["_all"]' --select "list.basic" --format json

# 个人排期总量
meegle workhour list-schedule --project-key futu-project \
  --user-keys '["7626451036340767674"]' --start-time <YYYY-MM-DD> --end-time <YYYY-MM-DD> --format json

# 查重
meegle workitem query --project-key futu-project \
  --mql "SELECT name, work_item_id FROM \`futu-project\`.\`665ae9bc588ebe27e6a44468\` WHERE name LIKE '%常规事项-<label>%'" --format json
```

## 关键 ID

| 项 | 值 |
|----|----|
| ericmao user_key（Meego 侧） | `7626451036340767674` |
| ericmao open_id（飞书日历 / IM 侧） | `ou_a735e005fa3ddb9a8b59c745805db36e`（**同一个 ID 既用于识别日历里「我」那条参会人记录，也是 bot 推送目标**） |
| 日历参会人记录里的 attendee_id | `user_7626566622203006151`（与 Meego user_key 不同，别混用） |
| 事务类型 · 运营事项 | `xmf1t3p2d` |
| 所属团队 · 研发 | `ck89i64lo` |
| 组织架构 · 增长平台后端开发组 | `p991nl8w7` |

## 时间戳

毫秒。**用命令算，不要口算**：

```bash
python3 -c "import datetime as d; print(int(d.datetime(2026,9,20,0,0).timestamp()*1000))"
```
