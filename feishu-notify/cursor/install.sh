#!/usr/bin/env bash
# Install Cursor hooks + CLI allowlist (mirrors Claude Code ft-settings permissions).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CURSOR_DIR="$HOME/.cursor"
HOOKS_DST="$CURSOR_DIR/hooks"

echo "== feishu-notify Cursor install =="
echo "Repo: $REPO_ROOT"

mkdir -p "$HOOKS_DST"

for f in cursor_shell_gate.py feishu_stop_cursor.py feishu_cursor_post_tool.py; do
  ln -sf "$REPO_ROOT/cursor/hooks/$f" "$HOOKS_DST/$f"
  echo "  linked $f"
done

# hooks.json
if [[ -f "$CURSOR_DIR/hooks.json" ]]; then
  backup="$CURSOR_DIR/hooks.json.bak.$(date +%Y%m%d%H%M%S)"
  cp "$CURSOR_DIR/hooks.json" "$backup"
  echo "  backed up existing hooks.json -> $backup"
fi
cp "$REPO_ROOT/cursor/hooks.json" "$CURSOR_DIR/hooks.json"
echo "  installed ~/.cursor/hooks.json"

# CLI config
if [[ -f "$CURSOR_DIR/cli-config.json" ]]; then
  backup="$CURSOR_DIR/cli-config.json.bak.$(date +%Y%m%d%H%M%S)"
  cp "$CURSOR_DIR/cli-config.json" "$backup"
  echo "  backed up cli-config.json -> $backup"
fi
cp "$REPO_ROOT/cursor/cli-config.example.json" "$CURSOR_DIR/cli-config.json"
echo "  installed ~/.cursor/cli-config.json (approvalMode=allowlist)"

chmod +x "$REPO_ROOT/cursor/hooks/"*.py 2>/dev/null || true

echo ""
echo "Done. Restart Cursor IDE (and Cursor CLI sessions if any)."
echo "Risky shell (git push, rm, sudo, ...) -> Feishu card + feishu-approve, same as Claude Code."
echo "Safe shell / Read / Write -> auto-approved via allowlist + cursor_shell_gate.py"
