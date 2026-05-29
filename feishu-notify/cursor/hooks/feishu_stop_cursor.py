#!/usr/bin/env python3
"""Cursor stop hook: notify Feishu when an agent turn ends (uses transcript if present)."""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.request
from datetime import datetime
from pathlib import Path

# 复用 feishu_stop 的 transcript 解析逻辑
_HOOKS_DIR = Path(__file__).resolve().parent.parent.parent / 'hooks'
sys.path.insert(0, str(_HOOKS_DIR))

WEBHOOK = os.environ.get(
    'FEISHU_WEBHOOK',
    'https://open.feishu.cn/open-apis/bot/v2/hook/6e34528b-97de-47dc-a692-6cdb6f70048e',
)
BOT_URL = os.environ.get('FEISHU_NOTIFY_BOT_URL', 'http://localhost:13380')


def _parse_ts(ts_str: str):
    if not ts_str:
        return None
    try:
        return datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
    except Exception:
        return None


def _read_transcript(path: str) -> tuple[str, str, str, bool]:
    session_name = ''
    last_user_text = ''
    last_assistant = ''
    has_tool_use = False
    try:
        with open(path, encoding='utf-8') as f:
            lines = f.readlines()
    except OSError:
        return session_name, last_user_text, last_assistant, has_tool_use

    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if entry.get('type') == 'custom-title':
            session_name = entry.get('customTitle') or session_name
        if entry.get('type') == 'user':
            msg = entry.get('message') or {}
            content = msg.get('content') if isinstance(msg, dict) else ''
            if isinstance(content, list):
                parts = [
                    p.get('text', '')
                    for p in content
                    if isinstance(p, dict) and p.get('type') == 'text'
                ]
                text = ' '.join(parts)
            else:
                text = str(content or '')
            text = re.sub(r'\[Image[^\]]*\]', '', text).strip()
            if text:
                last_user_text = text
        if entry.get('type') == 'assistant':
            msg = entry.get('message') or {}
            content = msg.get('content') if isinstance(msg, dict) else ''
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get('type') == 'tool_use':
                        has_tool_use = True
                    if isinstance(block, dict) and block.get('type') == 'text':
                        t = block.get('text', '')
                        if t:
                            last_assistant = t
            else:
                last_assistant = str(content or last_assistant)

    return session_name, last_user_text, last_assistant, has_tool_use


def main() -> int:
    raw = sys.stdin.read()
    data = json.loads(raw) if raw.strip() else {}

    status = data.get('status') or 'completed'
    roots = data.get('workspace_roots') or []
    cwd = data.get('cwd') or (roots[0] if roots else '')
    project = cwd.split('/')[-1] if cwd else 'cursor'
    transcript_path = data.get('transcript_path') or ''
    now = datetime.now().strftime('%H:%M:%S')

    session_name, last_user, last_msg, has_tool_use = (
        _read_transcript(transcript_path) if transcript_path else ('', '', '', False)
    )

    if status == 'error':
        title, template = '❌ Cursor Agent 异常', 'red'
    elif status == 'aborted':
        title, template = '⏹️ Cursor Agent 已中止', 'orange'
    else:
        is_question = last_msg.strip().endswith('?') or last_msg.strip().endswith('？')
        if is_question:
            title, template = '💬 Cursor 在等待你的回复', 'orange'
        else:
            title, template = '✅ Cursor 完成回复', 'green'

    user_summary = re.sub(r'\n+', ' ', last_user).strip()[:100]
    ai_summary = re.sub(r'```[^\n]*\n.*?```', '[代码块]', last_msg, flags=re.DOTALL)
    ai_summary = re.sub(r'\n+', ' ', ai_summary).strip()[:200]

    if not has_tool_use and not last_msg and status == 'completed':
        return 0

    lines = []
    if session_name:
        lines.append(f'**会话**: {session_name}')
    lines.append(f'**项目**: {project}')
    lines.append(f'**状态**: {status}')
    lines.append(f'**时间**: {now}')
    if user_summary:
        lines.append(f'**任务**: {user_summary}')
    if ai_summary:
        lines.append(f'**结果**: {ai_summary}')
    content = '\n'.join(lines)

    notif = user_summary[:80] or ai_summary[:80] or status
    subprocess.run(
        ['osascript', '-e', f'display notification "{notif}" with title "Cursor ({project})"'],
        stderr=subprocess.DEVNULL,
    )

    try:
        payload = json.dumps({'title': title, 'template': template, 'content': content}).encode()
        urllib.request.urlopen(
            urllib.request.Request(
                f'{BOT_URL}/stop-notify',
                data=payload,
                headers={'Content-Type': 'application/json'},
            ),
            timeout=5,
        )
        return 0
    except Exception:
        pass

    try:
        msg = {
            'msg_type': 'interactive',
            'card': {
                'config': {'wide_screen_mode': True},
                'header': {'title': {'content': title, 'tag': 'plain_text'}, 'template': template},
                'elements': [{'tag': 'markdown', 'content': content}],
            },
        }
        urllib.request.urlopen(
            urllib.request.Request(
                WEBHOOK,
                data=json.dumps(msg).encode(),
                headers={'Content-Type': 'application/json'},
            ),
            timeout=5,
        )
    except Exception:
        pass
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
