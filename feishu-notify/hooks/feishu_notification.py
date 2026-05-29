#!/usr/bin/env python3
"""Claude Code Notification hook: permission_prompt / idle_prompt → 飞书群提醒."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.request

BOT_URL = os.environ.get('FEISHU_NOTIFY_BOT_URL', 'http://localhost:13380')
WEBHOOK = os.environ.get(
    'FEISHU_WEBHOOK',
    'https://open.feishu.cn/open-apis/bot/v2/hook/6e34528b-97de-47dc-a692-6cdb6f70048e',
)


def _notify_mac(title: str, body: str) -> None:
    safe = body.replace('\\', '\\\\').replace('"', '\\"')[:200]
    subprocess.run(
        ['osascript', '-e', f'display notification "{safe}" with title "{title}"'],
        stderr=subprocess.DEVNULL,
    )


def _send_group_card(title: str, template: str, content: str) -> None:
    try:
        urllib.request.urlopen(
            urllib.request.Request(
                f'{BOT_URL}/notify-card',
                data=json.dumps({'title': title, 'template': template, 'content': content}).encode(),
                headers={'Content-Type': 'application/json'},
            ),
            timeout=5,
        )
        return
    except Exception:
        pass
    msg = {
        'msg_type': 'interactive',
        'card': {
            'config': {'wide_screen_mode': True},
            'header': {'title': {'content': title, 'tag': 'plain_text'}, 'template': template},
            'elements': [{'tag': 'markdown', 'content': content}],
        },
    }
    try:
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


def main() -> int:
    raw = sys.stdin.read()
    data = json.loads(raw) if raw.strip() else {}

    notif_type = data.get('notification_type') or ''
    message = (data.get('message') or '').strip()
    title = (data.get('title') or '').strip()
    cwd = data.get('cwd') or ''
    project = cwd.split('/')[-1] if cwd else ''

    if notif_type == 'permission_prompt':
        lines = [
            f'**项目**: {project or "-"}',
            f'**说明**: {message or "Claude 需要你批准工具执行"}',
            '',
            '👉 若已配置飞书批准卡，请到**群消息或私聊**点按钮；或在终端执行 `feishu-approve list`。',
        ]
        _notify_mac(f'Claude 待批准 ({project})', message[:80] or '需要批准')
        _send_group_card('⚠️ Claude 等待批准', 'yellow', '\n'.join(lines))
        return 0

    if notif_type == 'idle_prompt':
        lines = [
            f'**项目**: {project or "-"}',
            f'**说明**: {message or "Claude 已完成，等待你的下一条指令"}',
        ]
        _notify_mac(f'Claude 等你输入 ({project})', message[:80] or '等待输入')
        _send_group_card('💬 Claude 等待输入', 'orange', '\n'.join(lines))
        return 0

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
