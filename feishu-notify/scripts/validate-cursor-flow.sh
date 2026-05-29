#!/usr/bin/env bash
# Quick validation for Cursor hooks + shared feishu-notify-bot.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0

ok()   { echo "  ✓ $*"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }

echo "== Cursor + shared bot validation =="

# --- Config ---
[[ -f "$HOME/.cursor/hooks.json" ]] && ok "hooks.json exists" || fail "missing ~/.cursor/hooks.json"
[[ -f "$HOME/.cursor/cli-config.json" ]] && ok "cli-config.json exists" || fail "missing cli-config.json"
grep -q 'cursor_shell_gate' "$HOME/.cursor/hooks.json" && ok "beforeShellExecution registered" || fail "shell gate not in hooks.json"
grep -q 'allowlist' "$HOME/.cursor/cli-config.json" && ok "CLI approvalMode allowlist" || fail "allowlist not set"

for f in cursor_shell_gate.py feishu_stop_cursor.py feishu_cursor_post_tool.py; do
  [[ -L "$HOME/.cursor/hooks/$f" && -e "$HOME/.cursor/hooks/$f" ]] && ok "symlink $f" || fail "symlink $f"
done

# --- Bot ---
BOT="${FEISHU_NOTIFY_BOT_URL:-http://localhost:13380}"
if curl -sf --max-time 2 "$BOT/health" >/dev/null; then
  ok "bot health"
else
  fail "bot not running at $BOT"
fi

# --- cursor_shell_gate: safe allow ---
OUT=$(echo '{"command":"git status","cwd":"/tmp/validate","workspace_roots":["/tmp/validate"]}' \
  | python3 "$HOME/.cursor/hooks/cursor_shell_gate.py")
echo "$OUT" | grep -q '"permission": "allow"' && ok "safe command -> allow" || fail "safe command: $OUT"

# --- cursor_shell_gate: risky blocks until approve ---
TOKEN=''
(
  echo '{"command":"echo cursor-validate-risky","cwd":"/tmp/validate","workspace_roots":["/tmp/validate"]}' \
    | python3 "$HOME/.cursor/hooks/cursor_shell_gate.py" &
  HPID=$!
  sleep 1.2
  TOKEN=$(cat /tmp/claude_perm_latest.txt 2>/dev/null || true)
  if [[ -n "$TOKEN" ]]; then
    feishu-approve approve "$TOKEN" >/dev/null 2>&1 || true
  fi
  wait "$HPID" 2>/dev/null || true
) 2>/dev/null
# Use actual risky pattern for ask path
OUT=$( (
  echo '{"command":"git push origin HEAD","cwd":"/tmp/validate","workspace_roots":["/tmp/validate"]}' \
    | python3 "$HOME/.cursor/hooks/cursor_shell_gate.py" &
  GPID=$!
  sleep 1.5
  T=$(cat /tmp/claude_perm_latest.txt 2>/dev/null || true)
  [[ -n "$T" ]] && feishu-approve approve "$T" >/dev/null
  wait "$GPID"
) 2>/dev/null | tail -1)
if echo "$OUT" | grep -q '"permission": "allow"'; then
  ok "risky command + feishu-approve -> allow"
else
  fail "risky flow: $OUT"
fi

# --- feishu_stop_cursor ---
echo '{"status":"completed","workspace_roots":["/tmp/validate"],"transcript_path":""}' \
  | python3 "$HOME/.cursor/hooks/feishu_stop_cursor.py" >/dev/null 2>&1 \
  && ok "stop hook runs" || fail "stop hook error"

# --- question-synced endpoint ---
QS=$(curl -s -X POST "$BOT/question-synced" \
  -H 'Content-Type: application/json' \
  -d '{"token":"nonexistent","updatedInput":{"answers":{}}}' 2>/dev/null || echo '{}')
echo "$QS" | grep -q 'unknown_token' && ok "question-synced endpoint" || fail "question-synced: $QS"

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[[ $FAIL -eq 0 ]]
