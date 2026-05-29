#!/usr/bin/env python3
"""Cursor beforeShellExecution: auto-allow safe commands; risky → Feishu/CLI (like Claude ask)."""

from __future__ import annotations

import json
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

_HOOKS_DIR = Path(__file__).resolve().parent.parent.parent / 'hooks'
sys.path.insert(0, str(_HOOKS_DIR))

from feishu_perm_lib import (  # noqa: E402
    BOT_URL,
    POLL_INTERVAL,
    POLL_TIMEOUT,
    clear_pending,
    consume_decision,
    log,
    new_token,
    register_pending,
    result_path,
    terminal_hint,
)

# 与 ~/.claude/ft-settings.json permissions.ask 对齐
ASK_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r'git\s+push\b'),
    re.compile(r'\brm\b'),
    re.compile(r'rm\s+-rf\b'),
    re.compile(r'git\s+reset\s+--hard\b'),
    re.compile(r'git\s+clean\b'),
    re.compile(r'\bchmod\b'),
    re.compile(r'\bchown\b'),
    re.compile(r'\bsudo\b'),
    re.compile(r'\bmv\s+/\S+\s+/\s'),  # 与 Claude Bash(mv /*) 对齐：mv 到根路径
    re.compile(r'\bcp\s+/(?:etc|usr|var|bin|sbin)\b'),
    re.compile(r'\bcp\s+\S+\s+/(?:etc|usr|var|bin|sbin)\b'),
]

# 与 permissions.allow 中的 Bash(*) 对齐
SAFE_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r'^ls\b'),
    re.compile(r'^cat\b'),
    re.compile(r'^head\b'),
    re.compile(r'^tail\b'),
    re.compile(r'^find\b'),
    re.compile(r'^echo\b'),
    re.compile(r'^pwd$'),
    re.compile(r'^which\b'),
    re.compile(r'^env$'),
    re.compile(r'^git\s+status\b'),
    re.compile(r'^git\s+log\b'),
    re.compile(r'^git\s+diff\b'),
    re.compile(r'^git\s+show\b'),
    re.compile(r'^git\s+branch\b'),
    re.compile(r'^cd\s+/tmp/feishu-notify-bot'),
]


def _norm(command: str) -> str:
    return ' '.join((command or '').split())


def _matches(patterns: list[re.Pattern[str]], command: str) -> bool:
    norm = _norm(command)
    return any(p.search(norm) for p in patterns)


def _out(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def _notify_mac(title: str, body: str) -> None:
    safe = body.replace('\\', '\\\\').replace('"', '\\"')[:200]
    subprocess.run(
        ['osascript', '-e', f'display notification "{safe}" with title "{title}"'],
        stderr=subprocess.DEVNULL,
    )


def _request_bot_card(command: str, project: str) -> dict | None:
    try:
        return json.loads(
            urllib.request.urlopen(
                urllib.request.Request(
                    f'{BOT_URL}/permission-request',
                    data=json.dumps(
                        {
                            'tool_name': 'Bash',
                            'command': command,
                            'project': project,
                        }
                    ).encode(),
                    headers={'Content-Type': 'application/json'},
                ),
                timeout=5,
            ).read()
        )
    except Exception as e:
        log(f'cursor_shell_gate bot failed: {e}')
        return None


def _poll_approve(token: str) -> tuple[str, str] | None:
    deadline = time.time() + POLL_TIMEOUT
    while time.time() < deadline:
        parsed = consume_decision(token)
        if parsed:
            return parsed
        time.sleep(POLL_INTERVAL)
    return None


def main() -> int:
    raw = sys.stdin.read()
    data = json.loads(raw) if raw.strip() else {}
    command = (data.get('command') or '').strip()
    cwd = data.get('cwd') or ''
    roots = data.get('workspace_roots') or []
    project = (cwd.split('/')[-1] if cwd else '') or (
        roots[0].split('/')[-1] if roots else 'cursor'
    )

    if not command:
        _out({'permission': 'allow'})
        return 0

    if _matches(SAFE_PATTERNS, command):
        log(f'cursor_shell allow-safe cmd={command[:80]}')
        _out({'permission': 'allow'})
        return 0

    if not _matches(ASK_PATTERNS, command):
        log(f'cursor_shell allow-default cmd={command[:80]}')
        _out({'permission': 'allow'})
        return 0

    log(f'cursor_shell ask-feishu cmd={command[:80]}')
    bot_resp = _request_bot_card(command, project)
    token = str(bot_resp.get('token')) if bot_resp and bot_resp.get('token') else new_token()
    register_pending(
        token,
        tool_name='Bash',
        project=project,
        command=command[:2000],
        cwd=cwd,
        message_id=str(bot_resp.get('messageId') or '') if bot_resp else '',
    )

    hint = terminal_hint(token, command[:80])
    print(hint, file=sys.stderr, flush=True)
    _notify_mac('Cursor 待批准', command[:80])

    decision = _poll_approve(token)
    if not decision:
        clear_pending(token)
        _out(
            {
                'permission': 'deny',
                'user_message': '命令批准超时：请在飞书卡片或 feishu-approve 批准后重试',
                'agent_message': 'Shell command was not approved within the timeout window.',
            }
        )
        return 0

    dec, source = decision
    log(f'cursor_shell decided token={token} decision={dec} source={source}')
    if dec == 'approve':
        _out({'permission': 'allow'})
        return 0

    _out(
        {
            'permission': 'deny',
            'user_message': f'已在 {source} 拒绝该命令',
            'agent_message': 'The user denied this shell command.',
        }
    )
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
