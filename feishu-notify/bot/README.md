# feishu-notify-bot

Node.js sidecar for interactive Feishu permission cards. Hooks call it on `http://localhost:13380`.

**完整安装、架构、Cursor 适配、自动模式：** 见上级目录 [GUIDE.md](../GUIDE.md)。

## Setup

```bash
cd feishu-notify/bot
cp config.example.json config.json   # fill appId, appSecret, targets, group
npm install
node src/server.js
```

Default port: `13380` (override in `config.json`).

## Key endpoints

| Path | Purpose |
|------|---------|
| `POST /permission-request` | Send approve/deny card (Bash etc.); returns `{ token, messageId }` |
| `POST /ask-user-request` | Send AskUserQuestion option card; returns `{ token, messageId }` |
| `POST /decision` | Update card after terminal / Claude approval |
| `POST /ask-user-notify` | Reminder-only card when bot cannot send question card |
| `POST /stop-notify` | Stop hook notification |
| `GET /health` | Health check |

Card metadata is persisted under `/tmp/claude_perm_cards/` so `/decision` works after bot restart.
