#!/usr/bin/env python3
"""Cursor postToolUse: sync Feishu card after terminal approved a gated shell command."""

from __future__ import annotations

import json
import sys
from pathlib import Path

_HOOKS_DIR = Path(__file__).resolve().parent.parent.parent / 'hooks'
sys.path.insert(0, str(_HOOKS_DIR))

from feishu_perm_lib import (  # noqa: E402
    log,
    match_pending_by_command,
    notify_bot_decision,
    read_decision,
    write_decision,
)


def main() -> int:
    raw = sys.stdin.read()
    if not raw.strip():
        return 0
    data = json.loads(raw)

    if data.get('tool_name') != 'Shell':
        return 0

    tool_input = data.get('tool_input') or {}
    command = (tool_input.get('command') or '').strip()
    cwd = data.get('cwd') or ''
    if not command:
        return 0

    token = match_pending_by_command(command, tool_name='Bash', cwd=cwd)
    if not token:
        log(f'cursor_post_tool no_match cmd={command[:80]}')
        return 0

    existing = read_decision(token)
    if existing:
        if existing[1] != 'feishu':
            notify_bot_decision(token, existing[0], existing[1])
        return 0

    if not write_decision(token, 'approve', 'cursor_terminal'):
        return 0

    log(f'cursor_post_tool sync token={token}')
    notify_bot_decision(token, 'approve', 'cursor_terminal')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
