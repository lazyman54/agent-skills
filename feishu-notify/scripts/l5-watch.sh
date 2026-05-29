#!/usr/bin/env bash
# Watch for L5 permission requests; print token and optional auto-approve.
set -euo pipefail

MODE="${1:-hint}"   # hint | auto-approve
LOG=/tmp/perm_hook_debug.log
LAST=""

echo "L5 watcher ($MODE). Waiting for PermissionRequest in $LOG ..."
echo "Press Ctrl+C to stop."
echo ""

tail -n 0 -F "$LOG" 2>/dev/null | while read -r line; do
  echo "$line"
  if [[ "$line" != *"started tool="* ]]; then
    continue
  fi
  sleep 0.5
  TOKEN=$(cat /tmp/claude_perm_latest.txt 2>/dev/null || true)
  if [[ -z "$TOKEN" ]] || [[ "$TOKEN" == "$LAST" ]]; then
    continue
  fi
  LAST="$TOKEN"
  echo ""
  echo ">>> New request token=$TOKEN"
  if [[ "$MODE" == "auto-approve" ]]; then
    echo ">>> auto-approve in 1s ..."
    sleep 1
    feishu-approve approve "$TOKEN"
    echo ">>> feishu-approve done (exit $?)"
  else
    echo ">>> Case A: run:  feishu-approve approve $TOKEN"
    echo ">>> Case B: tap Approve on Feishu card"
    echo ">>> Case C: run:  feishu-approve deny $TOKEN"
  fi
  echo ""
done
