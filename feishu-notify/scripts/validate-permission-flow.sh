#!/usr/bin/env bash
# Layered validation for feishu-notify permission flow (no Claude Code required for L0–L5).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOKS="$REPO_ROOT/hooks"
LOG=/tmp/perm_hook_debug.log
PASS=0
FAIL=0
SKIP=0

ok()   { echo "  ✓ $*"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $*"; FAIL=$((FAIL + 1)); }
skip() { echo "  ○ $* (skipped)"; SKIP=$((SKIP + 1)); }
section() { echo ""; echo "== $* =="; }

# --- L0: Preflight ---
section "L0 Preflight"

for link in \
  "$HOME/.claude/hooks/feishu_perm_lib.py" \
  "$HOME/.claude/hooks/feishu_permission_request.py"; do
  if [[ -L "$link" ]] && [[ -e "$link" ]]; then
    ok "symlink $link"
  else
    fail "missing symlink $link (run install symlinks)"
  fi
done

if command -v feishu-approve >/dev/null 2>&1; then
  ok "feishu-approve on PATH"
else
  fail "feishu-approve not on PATH (~/.local/bin?)"
fi

if python3 -c "import sys; sys.path.insert(0, '$HOOKS'); import feishu_perm_lib" 2>/dev/null; then
  ok "feishu_perm_lib imports"
else
  fail "feishu_perm_lib import failed"
fi

SETTINGS="$HOME/.claude/ft-settings.json"
if [[ -f "$SETTINGS" ]]; then
  if grep -q '"skipAutoPermissionPrompt": true' "$SETTINGS"; then
    ok "skipAutoPermissionPrompt is true"
  else
    fail "skipAutoPermissionPrompt should be true for Feishu/CLI-only flow"
  fi
  if grep -q '"timeout": 310' "$SETTINGS" || grep -q '"timeout": 3[0-9][0-9]' "$SETTINGS"; then
    ok "PermissionRequest hook timeout >= 300s"
  else
    fail "PermissionRequest hook timeout too low (need ~310s)"
  fi
  if grep -q 'AskUserQuestion' "$SETTINGS" && grep -q 'feishu_perm_post_tool' "$SETTINGS"; then
    ok "PostToolUse includes AskUserQuestion sync hook"
  else
    fail "PostToolUse matcher must include AskUserQuestion for terminal→Feishu sync"
  fi
else
  skip "no $SETTINGS (manual Claude hook config)"
fi

# --- L1: Decision bus unit tests ---
section "L1 Decision bus (Python)"

python3 <<PY
import sys
sys.path.insert(0, "$HOOKS")
from pathlib import Path
from feishu_perm_lib import (
    new_token, register_pending, write_decision, write_question_answer,
    read_decision, read_result, consume_decision, result_path, list_pending,
    clear_pending, match_pending_ask_user,
)

errors = []

def check(cond, msg):
    if not cond:
        errors.append(msg)

t = new_token()
register_pending(t, tool_name="Bash", project="validate", command="echo l1")
check(list_pending(), "list_pending non-empty after register")

check(write_decision(t, "approve", "terminal"), "first write_decision")
check(not write_decision(t, "deny", "terminal"), "second write must fail (no duplicate)")
check(consume_decision(t) == ("approve", "terminal"), "consume approve/terminal")
check(consume_decision(t) is None, "consume twice is None")

t2 = new_token()
result_path(t2).write_text("approve", encoding="utf-8")
check(read_decision(t2) == ("approve", "feishu"), "legacy plain approve")
result_path(t2).unlink(missing_ok=True)
clear_pending(t2)

tq = new_token()
qtext = "L1 validate question?"
register_pending(
    tq,
    tool_name="AskUserQuestion",
    project="validate",
    command=qtext[:80],
    cwd="/tmp/validate-feishu",
    questions=[{"question": qtext, "header": "Test", "options": [{"label": "A"}]}],
)
updated = {
    "questions": [{"question": qtext, "header": "Test", "options": [{"label": "A"}]}],
    "answers": {qtext: "A"},
}
check(write_question_answer(tq, updated, "claude_terminal"), "write_question_answer")
check(read_result(tq).get("decision") == "answer", "read_result answer")
check(
    match_pending_ask_user(updated, cwd="/tmp/validate-feishu") == tq,
    "match_pending_ask_user",
)
result_path(tq).unlink(missing_ok=True)
clear_pending(tq)

if errors:
    for e in errors:
        print(f"FAIL: {e}")
    sys.exit(1)
print("ALL_L1_OK")
PY
if [[ $? -eq 0 ]]; then ok "L1 unit tests"; else fail "L1 unit tests"; fi

# --- L2: Hook + terminal approve (integration, ~3s) ---
section "L2 Hook stdout + feishu-approve (integration)"

: > "$LOG"
HOOK_OUT=$(mktemp)
HOOK_ERR=$(mktemp)
export HOOKS HOOK_OUT HOOK_ERR

python3 <<'PY'
import json, os, subprocess, threading, time, sys

hooks = os.environ["HOOKS"]
out_path = os.environ["HOOK_OUT"]
err_path = os.environ["HOOK_ERR"]
sys.path.insert(0, hooks)
from feishu_perm_lib import latest_token, write_decision

payload = json.dumps({
    "tool_name": "Bash",
    "tool_input": {"command": "echo validate-l2"},
    "cwd": "/tmp/validate-feishu",
})
proc = subprocess.Popen(
    [sys.executable, os.path.join(hooks, "feishu_permission_request.py")],
    stdin=subprocess.PIPE,
    stdout=open(out_path, "w"),
    stderr=open(err_path, "w"),
    text=True,
)

def approve():
    time.sleep(0.8)
    token = latest_token()
    if token:
        write_decision(token, "approve", "terminal")

threading.Thread(target=approve, daemon=True).start()
proc.stdin.write(payload)
proc.stdin.close()
raise SystemExit(proc.wait())
PY
L2_EXIT=$?

if [[ "$L2_EXIT" -eq 0 ]]; then ok "hook exited 0"; else fail "hook exited $L2_EXIT"; fi

if grep -q '"behavior": "allow"' "$HOOK_OUT"; then
  ok 'hook stdout contains hookSpecificOutput allow'
else
  fail "hook stdout missing allow decision"
  echo "    stdout: $(head -c 200 "$HOOK_OUT" 2>/dev/null || echo empty)"
fi

if grep -q "feishu-approve approve" "$HOOK_ERR"; then
  ok "hook stderr prints terminal hint"
else
  fail "hook stderr missing feishu-approve hint"
  echo "    stderr: $(head -c 200 "$HOOK_ERR" 2>/dev/null || echo empty)"
fi

TOKEN=$(cat /tmp/claude_perm_latest.txt 2>/dev/null || true)
if [[ -n "$TOKEN" ]] && [[ -f "/tmp/claude_perm_$TOKEN" ]]; then
  fail "decision file still present (not consumed)"
else
  ok "decision file consumed or cleared"
fi

rm -f "$HOOK_OUT" "$HOOK_ERR"

# --- L3: feishu-notify-bot (optional) ---
section "L3 feishu-notify-bot (optional)"

BOT_URL="${FEISHU_NOTIFY_BOT_URL:-http://localhost:13380}"
if curl -sf --max-time 2 "$BOT_URL/health" >/dev/null 2>&1; then
  ok "bot health $BOT_URL/health"
  RESP=$(curl -sf --max-time 3 -X POST "$BOT_URL/permission-request" \
    -H 'Content-Type: application/json' \
    -d '{"tool_name":"Bash","command":"echo bot-test","project":"validate"}' || true)
  BOT_TOKEN=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token') or '')" 2>/dev/null || true)
  if [[ -n "$BOT_TOKEN" ]]; then
    ok "bot returns token on permission-request"
    # simulate Feishu click
    echo -n approve > "/tmp/claude_perm_$BOT_TOKEN"
    if python3 -c "
import sys; sys.path.insert(0, '$HOOKS')
from feishu_perm_lib import read_decision
print(read_decision('$BOT_TOKEN'))
" | grep -q approve; then
      ok "bot-style plain approve readable by lib"
      rm -f "/tmp/claude_perm_$BOT_TOKEN"
    else
      fail "bot-style approve not readable"
    fi
  else
    fail "bot permission-request did not return token: $RESP"
  fi
else
  skip "bot not running at $BOT_URL (start feishu-notify-bot for L3)"
fi

# --- L4: Race (first writer wins) ---
section "L4 Duplicate decision guard"

python3 <<PY
import sys
sys.path.insert(0, "$HOOKS")
from feishu_perm_lib import new_token, write_decision, read_decision, result_path

t = new_token()
assert write_decision(t, "approve", "terminal")
assert not write_decision(t, "deny", "feishu")
# simulate bot late write without O_EXCL (overwrite) — document risk
result_path(t).write_text("deny")
# lib read returns last content; hook should have consumed before this in prod
print("L4_OK")
PY
ok "second atomic write rejected"
skip "overwrite without O_EXCL is bot-side risk (see README)"

# --- Summary ---
section "Summary"
echo "  Passed: $PASS  Failed: $FAIL  Skipped: $SKIP"
echo ""
if [[ $FAIL -gt 0 ]]; then
  echo "Fix failures above before Claude E2E (L5)."
  exit 1
fi

echo "L0–L4 OK. Run manual L5 (Claude E2E) checklist:"
echo "  1. Restart Claude Code"
echo "  2. In a session, run: git push origin HEAD  (or any command in permissions.ask)"
echo "  3. Case A: feishu-approve approve     → tool runs, no second prompt"
echo "  4. Case B: tap Approve on Feishu card → same"
echo "  5. Case C: feishu-approve deny          → Claude gets deny, tool not run"
echo "  6. Inspect: tail -20 $LOG"
exit 0
