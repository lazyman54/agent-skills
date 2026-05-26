# DEVELOPER — 研发扩展指引

> **AI-Notify (for Feishu/Lark)**：本文面向想扩展、贡献或移植的研发，包含代码结构、Hook 开发规范、Bot API 文档和调试方法。
>
> 系统设计请看 [ARCHITECTURE.md](./ARCHITECTURE.md)，安装使用请看 [USER_GUIDE.md](./USER_GUIDE.md)。

---

## 代码结构

```
feishu-notify/
├── hooks/                          # Python Hook 脚本
│   ├── feishu_perm_lib.py          # 共享库：决策总线、notify_bot_decision、CLI 入口
│   ├── feishu_permission_request.py # PermissionRequest 事件处理
│   ├── feishu_perm_post_tool.py    # PostToolUse 事件：同步卡片状态
│   ├── feishu_stop.py              # Stop 事件：回合结束通知
│   ├── feishu_task_completed.py    # TaskCompleted 事件
│   └── feishu_notification.py      # Notification 事件（降级提醒）
├── bot/                            # feishu-notify-bot (Node.js)
│   ├── src/
│   │   ├── server.js               # 入口，HTTP 路由注册
│   │   ├── claude/                 # Claude 相关卡片逻辑
│   │   ├── feishu/                 # 飞书 OpenAPI 封装（发消息、patch 卡片）
│   │   ├── session/                # 会话/Token 状态管理
│   │   └── admin/                  # Admin API
│   ├── config.example.json         # 配置模板
│   └── package.json
├── bin/
│   └── feishu-approve              # 终端批准 CLI（Python console_scripts 入口）
├── cursor/                         # Cursor IDE 适配
│   ├── install.sh
│   └── hooks/                      # Cursor 专用 hook 脚本
├── scripts/
│   └── validate-permission-flow.sh # 端到端验证脚本
└── docs/                           # 文档（本文所在目录）
```

---

## Hook 开发规范

### Claude Code Hook 机制

Claude Code 在生命周期事件发生时，向 Hook 脚本的 **stdin** 写入 JSON，Hook 脚本处理后通过 **stdout** 返回结果（部分事件）。

```
Claude Code
    │ stdin: JSON 事件数据
    ▼
Hook 脚本（Python）
    │ stdout: JSON 结果（仅 PermissionRequest 需要）
    ▼
Claude Code 读取 hookSpecificOutput
```

### 各事件 stdin 字段速查表

> 字段名验证时间：2026-05-18，claude-sonnet-4-6。字段随 Claude Code 版本可能变化，建议用调试方法确认。

| 事件 | 字段名 | 类型 | 说明 |
|------|--------|------|------|
| `Stop` | `last_assistant_message` | string | AI 本轮最后回复（前 200 字符） |
| `Stop` | `transcript_path` | string | JSONL 会话文件路径 |
| `Stop` | `permission_mode` | string | 当前权限模式（`auto`、`acceptEdits` 等） |
| `Stop` | `cwd` | string | 工作目录 |
| `PermissionRequest` | `tool_name` | string | 工具名（`Bash`、`Edit`、`Write`、`AskUserQuestion` 等） |
| `PermissionRequest` | `tool_input` | object | 工具参数（Bash 含 `command`；AskUserQuestion 含 `questions`） |
| `PermissionRequest` | `cwd` | string | 工作目录 |
| `TaskCompleted` | `task_subject` | string | 任务标题（**不是** `task_name`） |
| `TaskCompleted` | `task_id` | string | 任务 ID（如 `#7`） |
| `TaskCompleted` | `task_description` | string | 任务描述 |
| `TaskCompleted` | `cwd` | string | 工作目录 |
| `PostToolUse` | `tool_name` | string | 已执行的工具名 |
| `PostToolUse` | `tool_input` | object | 工具参数 |
| `PostToolUse` | `tool_result` | any | 工具执行结果 |

### hookSpecificOutput 协议

只有 `PermissionRequest` 需要返回 stdout：

**批准**：
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": { "behavior": "allow" }
  }
}
```

**拒绝**：
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "deny",
      "message": "用户在飞书拒绝了此操作"
    }
  }
}
```

**AskUserQuestion 批准（含选题结果）**：
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow",
      "updatedInput": {
        "questions": [ { "question": "问题全文", "options": [...] } ],
        "answers": { "问题全文": "所选选项 label" }
      }
    }
  }
}
```

---

## 新增 Hook 手把手示例

以「新增 `PreToolUse` 通知」为例（在工具执行前发飞书消息）。

**Step 1**：新建 `hooks/feishu_pre_tool.py`：

```python
#!/usr/bin/env python3
"""PreToolUse hook: notify Feishu before tool execution."""
import json
import sys
import requests

BOT_URL = "http://localhost:13380"

def main():
    raw = sys.stdin.read()
    if not raw.strip():
        return
    data = json.loads(raw)
    tool_name = data.get("tool_name", "unknown")
    tool_input = data.get("tool_input", {})
    command = tool_input.get("command", "")

    # 只通知 Bash 工具
    if tool_name != "Bash":
        return

    try:
        requests.post(f"{BOT_URL}/stop-notify", json={
            "title": "即将执行",
            "content": f"命令：{command[:100]}",
            "template": "blue"
        }, timeout=3)
    except Exception:
        pass  # 通知失败不阻断工具执行

if __name__ == "__main__":
    main()
```

**Step 2**：建立 symlink：

```bash
ln -sf "$REPO/hooks/feishu_pre_tool.py" ~/.claude/hooks/feishu_pre_tool.py
```

**Step 3**：在 `~/.claude/ft-settings.json` 注册：

```json
"PreToolUse": [{
  "matcher": "Bash",
  "hooks": [{
    "type": "command",
    "command": "python3 ~/.claude/hooks/feishu_pre_tool.py",
    "timeout": 5
  }]
}]
```

**Step 4**：重启 Claude Code 后触发任意 Bash 命令，验证飞书收到通知。

---

## Bot HTTP API 文档

所有端点基础地址：`http://localhost:13380`（可通过环境变量 `FEISHU_NOTIFY_BOT_URL` 覆盖）

> **注意**：以下端点和请求体基于 `bot/src/server.js` 实现，如有更新以代码为准。

### `POST /permission-request`

触发方：`feishu_permission_request.py`（Bash/Edit/Write 等）

请求体：
```json
{
  "tool_name": "Bash",
  "command": "git push origin HEAD",
  "project": "my-project"
}
```

### `POST /ask-user-request`

触发方：`feishu_permission_request.py`（AskUserQuestion）

请求体：
```json
{
  "project": "my-project",
  "questions": [
    { "question": "问题全文", "header": "标题", "options": [{"label": "选项A"}, {"label": "选项B"}] }
  ]
}
```

### `POST /decision`

触发方：`feishu_perm_post_tool.py` 或 `feishu-approve`（终端批准后同步卡片）

请求体：
```json
{
  "token": "abc123",
  "decision": "approve",
  "source": "terminal"
}
```

> `source` 常见值：`"terminal"`（feishu-approve CLI）、`"feishu"`（飞书卡片点击）。

### `POST /question-synced`

触发方：`feishu_perm_post_tool.py`（终端选题后同步卡片）

请求体：
```json
{
  "token": "abc123",
  "updatedInput": {
    "questions": [...],
    "answers": { "问题全文": "所选选项 label" }
  },
  "source": "claude_terminal"
}
```

### `POST /stop-notify`

触发方：`feishu_stop.py`

请求体：
```json
{
  "title": "✅ Claude 完成回复",
  "template": "green",
  "content": "**项目**: my-project\n**结果**: ..."
}
```

### `POST /task-completed`

触发方：`feishu_task_completed.py`

请求体：
```json
{
  "task_id": "7",
  "task_subject": "任务标题",
  "task_description": "任务描述",
  "project": "my-project"
}
```

### `POST /stop-failure`

触发方：异常中断场景

请求体：
```json
{
  "reason": "超时",
  "project": "my-project"
}
```

### `GET /health`

响应：
```json
{
  "status": "ok",
  "mode": "ws-long-connection",
  "uptime": 1234.56,
  "ws": { "state": "OPEN", "unhealthySince": null }
}
```

### `GET /admin/api/stats`（需 Authorization）

```bash
curl http://localhost:13380/admin/api/stats \
  -H "Authorization: Bearer <admin_token>"
```

---

## 卡片模板修改

### 修改文案（Python hook 侧）

`hooks/feishu_stop.py` 中控制通知内容的变量（`title`、`content`、`template` 等），修改后无需重启 Claude（symlink 直接读源文件）。

### 修改颜色

`feishu_stop.py` 中 `template` 参数：
- `"green"`：任务完成
- `"orange"`：等待回复
- `"red"`：失败/告警
- `"blue"`：信息提示

### 修改按钮（Bot 侧）

`bot/src/claude/` 目录下的卡片模板控制按钮结构。修改后需重启 bot：`pm2 restart feishu-notify-bot`。

---

## 调试指南

### 打印 stdin 数据

在 hook 脚本 `data = json.loads(raw)` 后临时添加：

```python
with open('/tmp/hook_debug.json', 'w') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
```

触发事件后：`cat /tmp/hook_debug.json`。调试完毕后删除此代码。

### 端到端验证脚本

```bash
bash "$REPO/scripts/validate-permission-flow.sh"
```

脚本分 L0–L4 层验证，无需 Claude Code 即可运行（L5 为手动 E2E 清单）：
- L0：Preflight（环境检查：symlink、feishu-approve PATH、import、ft-settings.json）
- L1：决策总线单元测试（读写 /tmp 文件、first-writer-wins、AskUserQuestion）
- L2：Hook stdout 协议 + feishu-approve 集成（~3s）
- L3：bot 健康检查（可选，bot 未启动时 skip）
- L4：Duplicate guard（防重复批准）

### 手动触发单个 hook

```bash
# Stop hook
echo '{"last_assistant_message":"test","cwd":"'"$PWD"'","permission_mode":"auto","transcript_path":""}' \
  | python3 ~/.claude/hooks/feishu_stop.py

# PermissionRequest hook（需 bot 运行）
echo '{"tool_name":"Bash","tool_input":{"command":"git push"},"cwd":"'"$PWD"'"}' \
  | python3 ~/.claude/hooks/feishu_permission_request.py
```

---

## 移植到其他 IM 平台

替换以下组件即可迁移到 Slack、钉钉、Telegram 等：

| 本仓库组件 | 需替换为 |
|------------|----------|
| 飞书互动卡片发送（bot/src/feishu/） | Slack Block Kit / 钉钉卡片 / Telegram Bot API |
| `card.action.trigger` 回调处理 | 对应平台的回调接收逻辑 |
| `notify_bot_decision()` 中的卡片 patch | 调用新平台的消息更新接口 |

**保持不变的部分**：
- Python hook 框架（stdin/stdout/timeout 协议）
- 决策总线（`/tmp` 文件 + first-writer-wins）
- feishu-approve CLI 的核心逻辑
- hookSpecificOutput 格式

---

## Cursor 适配

```bash
# 一键安装 Cursor hooks（共用 feishu-notify-bot）
bash "$REPO/cursor/install.sh"
```

Cursor 与 Claude Code 事件对照：

| Claude Code 事件 | Cursor 事件 | 当前状态 |
|------------------|-------------|----------|
| `Stop` | `stop` | 已适配（cursor/hooks/feishu_stop_cursor.py） |
| `PermissionRequest` | `beforeShellExecution` | 部分（仅 Shell 命令，cursor/hooks/cursor_shell_gate.py） |
| `PostToolUse` | `postToolUse` | 部分（cursor/hooks/feishu_cursor_post_tool.py，payload 结构不同） |
| `TaskCompleted` | 无 | Cursor 无此事件 |

> Cursor hook 配置路径：项目级 `.cursor/hooks.json`，用户级 `~/.cursor/hooks.json`。
