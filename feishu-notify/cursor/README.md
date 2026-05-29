# Cursor 配置（与 Claude Code auto 模式对齐）

## 安装

```bash
bash feishu-notify/cursor/install.sh
```

然后 **重启 Cursor IDE**。

## 行为（与 `~/.claude/ft-settings.json` 一致）

| 类型 | 示例 | 行为 |
|------|------|------|
| 安全 Shell | `git status`, `ls`, `cat` | 自动批准，无飞书卡 |
| 危险 Shell | `git push`, `rm`, `sudo` | 飞书批准卡 + `feishu-approve` |
| Read / Write / Grep | — | CLI allowlist 自动批准 |

## 文件

| 路径 | 说明 |
|------|------|
| `~/.cursor/hooks.json` | Hook 注册 |
| `~/.cursor/cli-config.json` | Cursor CLI allowlist |
| `~/.cursor/hooks/cursor_shell_gate.py` | 门控 + 飞书轮询 |
| `~/.cursor/hooks/feishu_stop_cursor.py` | 回合结束通知 |
| `~/.cursor/hooks/feishu_cursor_post_tool.py` | 终端批准后同步飞书卡 |

详细说明见 [GUIDE.md](../GUIDE.md)。
