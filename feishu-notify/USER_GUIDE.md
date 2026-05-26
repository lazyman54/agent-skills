# USER_GUIDE — 安装与使用指南

> **AI-Notify (for Feishu/Lark)**：本文是面向最终用户的完整指南——从零开始安装、日常使用、以及排查问题。
>
> 架构设计请看 [ARCHITECTURE.md](./ARCHITECTURE.md)，扩展开发请看 [DEVELOPER.md](./DEVELOPER.md)。

---

## 前置条件

| 依赖 | 最低版本 | 用途 |
|------|----------|------|
| macOS 或 Linux | — | Hook 脚本和系统通知 |
| Python | 3.9+ | Hook 脚本运行环境 |
| Node.js | 18+ | feishu-notify-bot |
| pm2 | 任意 | bot 长期运行 |
| Claude Code | 任意 | Hook 挂载点 |
| 飞书企业自建应用 | — | 交互卡片（批准权限必须） |

> 若只需要**通知**（不需要飞书按钮批准），可用飞书**自定义机器人 Webhook**，无需企业自建应用和 bot。

---

## 安装步骤

### 步骤 1：克隆仓库

```bash
git clone https://github.com/<your-org>/feishu-notify.git
cd feishu-notify
REPO=$(pwd)   # 后续步骤用到这个变量
```

### 步骤 2：配置飞书应用

**方式 A：企业自建应用（推荐，支持交互卡片）**

1. 进入 [飞书开放平台](https://open.feishu.cn/) → 创建企业自建应用
2. 开通以下权限：
   - `im:message`
   - `im:message:send_as_bot`
   - `im:message.group_msg:create`（发群消息）
3. 配置事件订阅 → 添加事件 `card.action.trigger`
4. 在「安全设置」里配置 **事件请求地址**：`http://<你的机器IP>:13380/feishu-callback`
   > 本机开发时，飞书回调需要公网可达。可用 frp/ngrok 做内网穿透，或使用飞书「本地调试」模式。
5. 把机器人拉入目标飞书群
6. 记录 `appId`、`appSecret`、群的 `chatId`（在飞书群右键 → 复制链接，ID 在 URL 中）

**方式 B：自定义机器人 Webhook（仅通知，无法点按钮批准）**

在飞书群 → 群设置 → 机器人 → 添加机器人 → 自定义机器人，复制 Webhook 地址。

### 步骤 3：配置并启动 feishu-notify-bot

```bash
cd "$REPO/bot"
cp config.example.json config.json
```

编辑 `config.json`，填入你的值：

```json
{
  "port": 13380,
  "feishu": {
    "appId": "cli_xxxxxxxxxxxxxxxx",
    "appSecret": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  },
  "group": {
    "chatId": "oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "name": "your-group-name"
  },
  "admin": {
    "token": "your-admin-token-here"
  }
}
```

> **安全提醒**：`config.json` 已在 `.gitignore` 中，勿提交凭证。

```bash
npm install
# 测试运行（Ctrl+C 退出后再用 pm2）
node src/server.js

# 确认健康检查通过后，用 pm2 长期运行
pm2 start src/server.js --name feishu-notify-bot
pm2 save
pm2 startup   # 跟随提示设置开机自启
```

验证：

```bash
curl -s http://localhost:13380/health
# 期望输出：{"status":"ok", ...}
```

### 步骤 4：建立 Hook symlink

```bash
mkdir -p ~/.claude/hooks ~/.local/bin

ln -sf "$REPO/hooks/feishu_perm_lib.py"           ~/.claude/hooks/
ln -sf "$REPO/hooks/feishu_permission_request.py" ~/.claude/hooks/
ln -sf "$REPO/hooks/feishu_perm_post_tool.py"     ~/.claude/hooks/
ln -sf "$REPO/hooks/feishu_stop.py"               ~/.claude/hooks/
ln -sf "$REPO/hooks/feishu_task_completed.py"     ~/.claude/hooks/
ln -sf "$REPO/hooks/feishu_notification.py"       ~/.claude/hooks/
ln -sf "$REPO/bin/feishu-approve"                 ~/.local/bin/feishu-approve
chmod +x ~/.local/bin/feishu-approve
```

验证 symlink：

```bash
ls -la ~/.claude/hooks/ | grep feishu
# 应能看到 6 个 -> .../feishu-notify/hooks/ 的链接
```

### 步骤 5：注册全局 Hook（`~/.claude/ft-settings.json`）

编辑（或创建）`~/.claude/ft-settings.json`，加入以下 `hooks` 配置（与现有内容合并）：

```json
{
  "skipAutoPermissionPrompt": true,
  "permissions": {
    "allow": [
      "Read", "Glob", "Grep", "Edit", "Write", "MultiEdit", "NotebookEdit",
      "Bash(git status)", "Bash(git diff *)", "Bash(git log *)",
      "Bash(ls *)", "Bash(cat *)", "Bash(echo *)"
    ],
    "ask": [
      "Bash(git push *)",
      "Bash(rm *)",
      "Bash(sudo *)"
    ],
    "deny": [],
    "defaultMode": "auto"
  },
  "hooks": {
    "Stop": [{
      "matcher": ".*",
      "hooks": [{
        "type": "command",
        "command": "python3 ~/.claude/hooks/feishu_stop.py",
        "timeout": 10
      }]
    }],
    "TaskCompleted": [{
      "matcher": ".*",
      "hooks": [{
        "type": "command",
        "command": "python3 ~/.claude/hooks/feishu_task_completed.py",
        "timeout": 10
      }]
    }],
    "PermissionRequest": [{
      "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit|AskUserQuestion",
      "hooks": [{
        "type": "command",
        "command": "python3 ~/.claude/hooks/feishu_permission_request.py",
        "timeout": 310,
        "statusMessage": "等待飞书批准..."
      }]
    }],
    "PostToolUse": [{
      "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit|AskUserQuestion",
      "hooks": [{
        "type": "command",
        "command": "python3 ~/.claude/hooks/feishu_perm_post_tool.py",
        "timeout": 5
      }]
    }],
    "Notification": [{
      "matcher": ".*",
      "hooks": [{
        "type": "command",
        "command": "python3 ~/.claude/hooks/feishu_notification.py",
        "timeout": 10
      }]
    }]
  }
}
```

**关键说明**：
- `skipAutoPermissionPrompt: true`：需要批准时，终端不再弹第二套 Allow/Deny 框，避免与飞书卡片重复。只需在飞书点按钮 **或** 终端运行 `feishu-approve approve`，二选一即可。
- `PermissionRequest` 的 `timeout: 310`：给飞书卡片批准留足 5 分钟等待时间。
- `defaultMode: "auto"`：未命中 allow/deny 时倾向自动执行；只有 `ask` 列表中的命令才触发飞书卡片。

### 步骤 6：端到端验证

```bash
bash "$REPO/scripts/validate-permission-flow.sh"
```

全部 L0–L5 通过后，重启 Claude Code，在会话里触发一个 `ask` 列表中的命令（如 `git push`），确认飞书群里出现批准卡片。

---

## 日常使用

### 通知卡片说明

| 卡片类型 | 触发时机 | 颜色 | 可操作 |
|----------|----------|------|--------|
| **Stop（绿）** | 每轮 AI 回复结束 | 绿色 | 否 |
| **Stop（橙）** | AI 回复末尾是问句 | 橙色「等待回复」 | 否 |
| **TaskCompleted** | Task 标记 completed | 绿色 | 否 |
| **PermissionRequest** | Bash/Edit/Write 等需批准 | 黄色「审批」 | ✅ 批准 / 拒绝 |
| **AskUserQuestion** | Claude 向你提问 | 黄色「选题」 | ✅ 选项按钮 |

### 在飞书批准/拒绝权限

1. 飞书群里收到黄色审批卡片
2. 点击 **批准** 或 **拒绝** 按钮
3. Claude 立即收到决策，卡片自动更新为绿色/红色

> **卡片在群里，不是私聊**：批准卡默认发到 `config.json` 的 `group.chatId` 配置的群，如果你只在私聊里找，会以为没有通知。

### 在飞书回答 AskUserQuestion

1. 收到选题卡片后，点击对应选项按钮
2. Claude 接收答案并继续执行
3. 卡片更新为「已作答」状态

### feishu-approve CLI（终端备用）

当飞书不方便操作时，也可在终端完成批准：

```bash
# 查看待处理的权限请求
feishu-approve list

# 批准最新的请求
feishu-approve approve

# 批准指定 token
feishu-approve approve <token>

# 拒绝指定 token
feishu-approve deny <token>
```

### 静音某次任务

在 Claude Code 会话里对 Claude 说「这次不用发飞书通知」，或在 hook 中检查环境变量 `FEISHU_NOTIFY_SKIP=1`（需自行扩展，见 DEVELOPER.md）。

---

## Cursor IDE 支持（可选）

一键安装（与 Claude Code 共用同一个 feishu-notify-bot）：

```bash
bash "$REPO/cursor/install.sh"
```

安装后重启 Cursor IDE。

**当前 Cursor 能力对照**：

| 能力 | 状态 |
|------|------|
| 回合结束通知（stop） | ✅ 已支持 |
| 任务完成（TaskCompleted） | ❌ Cursor 无此事件 |
| Bash 权限飞书批准 | ⚠️ 部分支持（`beforeShellExecution`） |
| AskUserQuestion | ❌ Cursor 无此工具 |

详细 Cursor 适配说明见 [DEVELOPER.md](./DEVELOPER.md)。

---

## 自动模式配置

如果你想让 AI 尽可能自动执行，只对危险操作触发飞书审批：

1. 把安全操作加入 `permissions.allow`（Read/Edit/git status 等）
2. 把危险操作放入 `permissions.ask`（git push/rm/sudo 等）
3. 保持 `skipAutoPermissionPrompt: true`，终端不重复弹框

**不推荐**：把 `Bash(*)` 放进 `ask`——每个命令都触发飞书卡片会非常吵。精准配置 `ask` 列表才是正确用法。

---

## 排障手册

### 快速诊断命令

```bash
# 1. bot 是否存活
curl -s http://localhost:13380/health

# 2. hook symlink 是否正确
ls -la ~/.claude/hooks/ | grep feishu

# 3. 端到端验证（需 bot 运行）
bash ~/Projects/github/agent-skills/feishu-notify/scripts/validate-permission-flow.sh

# 4. 查看 bot 日志
pm2 logs feishu-notify-bot --lines 50

# 5. 手动触发 Stop hook（无需 Claude）
echo '{"last_assistant_message":"测试","cwd":"'"$PWD"'","permission_mode":"auto","transcript_path":""}' \
  | python3 ~/.claude/hooks/feishu_stop.py
```

### 常见问题

| 现象 | 原因 | 解决 |
|------|------|------|
| 完全没通知 | Hook 未注册，或 Claude Code 未重启 | 检查 `ft-settings.json`，重启 Claude Code |
| 有通知无按钮 | bot 未启动，或 `config.json` 未配 chatId | `curl http://localhost:13380/health`；检查 `config.json` |
| 飞书批了 Claude 不动 | `/tmp/claude_perm_<token>` 未写入 | `tail -f /tmp/perm_hook_debug.log`；检查 bot 回调地址是否公网可达 |
| 终端批了飞书不更新 | PostToolUse hook 未注册，或 bot 无 `/decision` 端点 | 检查 ft-settings.json 的 `PostToolUse` 配置 |
| 卡片找不到 | 在私聊找，实际发到群里 | 确认 `config.json` 的 `group.chatId` 配置，去群里找卡片 |
| bot 与 hook 行为不一致 | pm2 跑的是旧代码 | `pm2 restart feishu-notify-bot`，确认 cwd 指向正确的 bot 目录 |

---

## 已知坑与注意事项

1. **禁止在 settings.json 里用 heredoc 内联 Python**
   `python3 << 'EOF'` 会让 Python 读自己的源码消耗 stdin，Hook 数据全部丢失。必须用独立 `.py` 文件。

2. **字段名以实测为准**
   - `TaskCompleted` 用 `task_subject`，不是 `task_name`
   - `Stop` 用 `last_assistant_message`，不是 `message`
   - `PermissionRequest` 用 `tool_input`（dict），不是 `command`

3. **用户消息里可能有图片占位符**
   `[Image #1]`、`[Image: source: /path/file.png]` 等形式，Stop hook 已自动过滤。

4. **卡片回调需公网可达**
   本地开发时飞书服务器需要能回调你的 bot（`:13380`）。内网环境需配置内网穿透。

5. **pm2 工作目录必须指向正确路径**
   pm2 的 `exec cwd` 必须是 `feishu-notify/bot/`，不能是 `/tmp` 临时目录。验证：`pm2 info feishu-notify-bot | grep cwd`。
