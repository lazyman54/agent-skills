# CONTEXT — For AI Agents

> Read this file when you need to understand the background, current implementation state, and what to do next. For user-facing documentation, see README.md.

---

## What This Is

A Claude Code hook setup that sends Lark/Feishu notifications when Claude finishes a response, completes a task, or needs a permission decision. Built and debugged by ericmao on 2026-05-18.

The motivation: when Claude runs long tasks autonomously, the user wants to know what happened without staring at the terminal — especially on mobile.

---

## Current Implementation State

### Files
```
hooks/
├── feishu_perm_lib.py           # Shared decision bus + notify_bot_decision
├── feishu_permission_request.py # PermissionRequest event
├── feishu_perm_post_tool.py     # PostToolUse — sync Feishu card after terminal approve
├── feishu_stop.py               # Stop event
└── feishu_task_completed.py     # TaskCompleted event
bot/                            # feishu-notify-bot (Node, :13380)
bin/feishu-approve              # Terminal approval CLI
scripts/validate-permission-flow.sh

README.md     # Quick start (English)
GUIDE.md      # Full guide: install, DIY, Cursor, auto mode (中文)
CONTEXT.md    # This file — AI context
```

The hook scripts live at `~/.claude/hooks/` but are **symlinked** to this repo:
```bash
ln -sf ~/Projects/github/agent-skills/feishu-notify/hooks/feishu_stop.py ~/.claude/hooks/feishu_stop.py
ln -sf ~/Projects/github/agent-skills/feishu-notify/hooks/feishu_task_completed.py ~/.claude/hooks/feishu_task_completed.py
ln -sf ~/Projects/github/agent-skills/feishu-notify/hooks/feishu_perm_lib.py ~/.claude/hooks/feishu_perm_lib.py
ln -sf ~/Projects/github/agent-skills/feishu-notify/hooks/feishu_permission_request.py ~/.claude/hooks/feishu_permission_request.py
ln -sf ~/Projects/github/agent-skills/feishu-notify/bin/feishu-approve ~/.local/bin/feishu-approve
```
Edit files in `hooks/` → Claude Code picks up changes immediately. Commit → version controlled.

### What each script does

**feishu_stop.py**
- Reads `last_assistant_message` for AI reply summary (first 200 chars, code blocks → `[代码块]`)
- Reads `transcript_path` JSONL to extract: session name (from `custom-title` entries) and user's last text input (from `user` entries, filtering `[Image...]` placeholders)
- Reply ends with `?`/`？` → orange card "waiting for reply"; otherwise green "completed"
- Also fires macOS system notification via `osascript`

**feishu_task_completed.py**
- Fields: `task_subject` (NOT `task_name`), `task_id`, `task_description`, `cwd`
- Displays `#task_id subject` — matches `Task #N` shown in terminal

**feishu_permission_request.py**
- **Bash/Edit/…**: approve/deny card + `feishu-approve` CLI; `hookSpecificOutput.decision.behavior` allow/deny
- **AskUserQuestion**: `POST /ask-user-request` → option buttons on Feishu; answer written as JSON with `updatedInput.questions` + `updatedInput.answers`
- Shared bus: `/tmp/claude_perm_<token>`; card meta: `/tmp/claude_perm_cards/<token>.json`
- Bot: `permission-question-card.js` handles `permKind: answer` card callbacks

### Hook registration (global)
Add to `~/.claude/ft-settings.json` — applies to all Claude Code sessions:
```json
{
  "hooks": {
    "Stop":              [{"matcher":".*","hooks":[{"type":"command","command":"python3 ~/.claude/hooks/feishu_stop.py","timeout":10}]}],
    "TaskCompleted":     [{"matcher":".*","hooks":[{"type":"command","command":"python3 ~/.claude/hooks/feishu_task_completed.py","timeout":10}]}],
    "PermissionRequest": [{"matcher":".*","hooks":[{"type":"command","command":"python3 ~/.claude/hooks/feishu_permission_request.py","timeout":10}]}]
  }
}
```

---

## Critical Gotchas

### 1. Never use heredoc for inline Python in settings.json
`python3 << 'EOF'` causes Python to consume stdin reading its own source code. Hook data (piped on stdin) is lost. Always use a separate script file.

### 2. Field names to use (verified May 2026, claude-sonnet-4-6)
- `TaskCompleted` → `task_subject` (not `task_name`, not `subject`)
- `Stop` → `last_assistant_message`, `transcript_path`, `permission_mode`, `cwd`
- `PermissionRequest` → `tool_name`, `tool_input` (dict), `cwd`

### 3. User messages in transcript may contain image placeholders
Filter with: `re.sub(r'\[Image[^\]]*\]', '', text)`
Patterns seen: `[Image #1]`, `[Image: source: /path/to/file.png]`

### 4. Session name location in transcript JSONL
Look for `{"type": "custom-title", "customTitle": "SESSION_NAME"}` — written each time `/rename` is called. Read from bottom up and take the last one.

---

## How to Debug Any Hook

Add after `data = json.loads(raw) if raw.strip() else {}`:
```python
with open('/tmp/hook_debug.json', 'w') as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
```
Trigger the event, run `cat /tmp/hook_debug.json`. Remove when done.

---

## Next Steps (priority order)

> Full TODO list: `feishu-notify/TODO.md` (gitignored, local only)

| Task | Where to edit | Notes |
|---|---|---|
| Add turn duration to Stop card | `feishu_stop.py` | Read timestamps from transcript: last `user` entry → last `assistant` entry |
| Add git branch to cards | `feishu_stop.py`, `feishu_task_completed.py` | `subprocess.run(['git','-C',cwd,'branch','--show-current'])` |
| Distinguish chat vs task execution | `feishu_stop.py` | Check if transcript has `tool_use` type in last assistant message |
| Per-project webhook URL | All three scripts | Read from env var `FEISHU_WEBHOOK` with fallback to hardcoded default |
| Linux system notification | All three scripts | Replace `osascript` block with `notify-send` behind `platform.system()` check |
