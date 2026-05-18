# feishu-notify — Lark/Feishu Notifications for Claude Code

Get notified on **Lark (Feishu)** whenever Claude Code finishes a response, completes a task, or needs your approval — so you can step away from the terminal without missing anything.

![notification cards showing green completed, orange waiting, and yellow permission request](./preview.png)

---

## What You Get

| Event | Card Color | When it fires |
|---|---|---|
| ✅ Claude completed | Green | Every time Claude finishes a reply |
| 💬 Claude is waiting | Orange | Claude's reply ends with a question |
| ✅ Task completed | Green | A task is marked `completed` via `TaskUpdate` |
| ⚠️ Needs your decision | Yellow | Claude needs permission to run a tool |

Each card shows: session name, project, permission mode, timestamp, your last input (as "task"), and Claude's reply summary.

---

## Prerequisites

- macOS (notifications use `osascript`; Linux users can remove that part)
- Python 3 (pre-installed on macOS)
- A Lark/Feishu group with an **incoming webhook bot** configured
- [Claude Code](https://claude.ai/code) CLI

---

## Setup

### Step 1 — Get your Lark Webhook URL

In Lark/Feishu, open a group → Settings → Bots → Add bot → **Custom Bot** → copy the Webhook URL:
```
https://open.feishu.cn/open-apis/bot/v2/hook/YOUR_TOKEN_HERE
```

### Step 2 — Install the hook scripts

Symlink the scripts to `~/.claude/hooks/` (recommended — edits to the repo take effect immediately):

```bash
mkdir -p ~/.claude/hooks
ln -sf "$(pwd)/hooks/feishu_stop.py" ~/.claude/hooks/feishu_stop.py
ln -sf "$(pwd)/hooks/feishu_task_completed.py" ~/.claude/hooks/feishu_task_completed.py
ln -sf "$(pwd)/hooks/feishu_permission_request.py" ~/.claude/hooks/feishu_permission_request.py
```

Or copy if you prefer an independent local copy:
```bash
cp hooks/feishu_*.py ~/.claude/hooks/
```

Then replace the `WEBHOOK` constant at the top of each script with your URL:

```python
WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/YOUR_TOKEN_HERE'
```

### Step 3 — Register hooks globally

Add the following to `~/.claude/ft-settings.json` (user-level, applies to **all** Claude Code sessions):

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": ".*",
        "hooks": [{"type": "command", "command": "python3 ~/.claude/hooks/feishu_stop.py", "timeout": 10}]
      }
    ],
    "TaskCompleted": [
      {
        "matcher": ".*",
        "hooks": [{"type": "command", "command": "python3 ~/.claude/hooks/feishu_task_completed.py", "timeout": 10}]
      }
    ],
    "PermissionRequest": [
      {
        "matcher": ".*",
        "hooks": [{"type": "command", "command": "python3 ~/.claude/hooks/feishu_permission_request.py", "timeout": 10}]
      }
    ]
  }
}
```

> **Tip:** `~/.claude/ft-settings.json` is user-scoped — one config covers every project. If you only want notifications for specific projects, use `.claude/settings.local.json` in that project directory instead.

### Step 4 — Restart Claude Code

The hook configuration is loaded at startup. Restart Claude Code to activate.

---

## Smoke Test

Run these commands to verify each notification works before relying on them:

```bash
# Test Stop notification
echo '{"last_assistant_message":"Setup complete!","cwd":"/your/project","permission_mode":"acceptEdits","transcript_path":""}' \
  | python3 ~/.claude/hooks/feishu_stop.py

# Test TaskCompleted notification
echo '{"task_id":"1","task_subject":"Test task","task_description":"Verifying hook setup","cwd":"/your/project"}' \
  | python3 ~/.claude/hooks/feishu_task_completed.py

# Test PermissionRequest notification
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /some/path"},"cwd":"/your/project"}' \
  | python3 ~/.claude/hooks/feishu_permission_request.py
```

---

## How It Works

Claude Code fires hook events at specific lifecycle points. Each event pipes a JSON payload to your hook command's **stdin**. The scripts:

1. Read the JSON from stdin
2. Extract relevant fields
3. Build a Lark interactive card message
4. POST it to your webhook URL
5. Also fire a macOS system notification via `osascript`

The `Stop` hook additionally reads the **session transcript** (path provided in the payload) to extract the session name (`/rename` title) and your last text input — stripping image attachment placeholders like `[Image #1]`.

### Key payload fields

**Stop event:**
```json
{
  "last_assistant_message": "Claude's full reply text",
  "cwd": "/path/to/project",
  "permission_mode": "acceptEdits",
  "transcript_path": "/path/to/session.jsonl"
}
```

**TaskCompleted event:**
```json
{
  "task_id": "3",
  "task_subject": "Fix the login bug",
  "task_description": "...",
  "cwd": "/path/to/project"
}
```

**PermissionRequest event:**
```json
{
  "tool_name": "Bash",
  "tool_input": { "command": "npm install" },
  "cwd": "/path/to/project"
}
```

---

## Customization

### Change card colors
Edit the `template` value in the script's `msg` dict. Options: `green`, `orange`, `yellow`, `red`, `purple`, `blue`.

### Add/remove fields
Each script builds a `lines` list — just add or remove entries.

### Use a different notification service
Replace the `urllib.request` block with any HTTP client. The card format uses [Lark's interactive card schema](https://open.feishu.cn/document/common-capabilities/message-card/message-cards-content/card-structure/card-content).

For Slack, replace the message body with Slack's Block Kit format. For Telegram, use the sendMessage API.

### Apply to multiple projects
Register hooks in `~/.claude/ft-settings.json` once — all projects get notifications automatically.

---

## Important: Don't Inline Scripts in settings.json

It's tempting to write the Python inline using a bash heredoc:

```json
"command": "python3 << 'EOF'\nimport json,sys\ndata=json.load(sys.stdin)...\nEOF"
```

**Don't.** When Python runs via heredoc, it consumes stdin to read its own source code — leaving nothing for your hook data. The script will see empty stdin and all fields will be missing.

Always use a separate script file so stdin passes through correctly.

---

## Debugging

To inspect what data a hook actually receives, temporarily add this after `data = ...` in any script:

```python
with open('/tmp/hook_debug.json', 'w') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
```

Trigger the event, then:
```bash
cat /tmp/hook_debug.json
```

Remove the debug line when done.

---

## Confirmed Field Names (as of May 2026)

Claude Code's hook payload fields may change across versions. These were verified against Claude Code running `claude-sonnet-4-6`:

| Event | Field | Notes |
|---|---|---|
| Stop | `last_assistant_message` | Full reply text |
| Stop | `transcript_path` | Path to `.jsonl` session file |
| Stop | `permission_mode` | `acceptEdits` / `dontAsk` / `default` |
| TaskCompleted | `task_subject` | NOT `task_name` or `subject` |
| TaskCompleted | `task_id` | Matches `Task #N` shown in terminal |
| PermissionRequest | `tool_name` | Tool being requested |
| PermissionRequest | `tool_input` | Dict with tool-specific fields |

> For AI reading this: see `CONTEXT.md` for implementation background, current state, and next-step guidance.
