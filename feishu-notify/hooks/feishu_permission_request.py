#!/usr/bin/env python3
"""PermissionRequest hook: Feishu card or terminal CLI, first decision wins."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
import urllib.request

from feishu_perm_lib import (
    BOT_URL,
    DING_DELAY,
    POLL_INTERVAL,
    POLL_TIMEOUT,
    clear_pending,
    cli_main,
    consume_decision,
    consume_result,
    hook_output_allow,
    hook_output_deny,
    log,
    new_token,
    notify_bot_decision,
    all_questions_answered,
    notify_bot_question_sync,
    question_hint,
    register_pending,
    result_path,
    terminal_hint,
)

WEBHOOK = os.environ.get(
    'FEISHU_WEBHOOK',
    'https://open.feishu.cn/open-apis/bot/v2/hook/6e34528b-97de-47dc-a692-6cdb6f70048e',
)

# ExitPlanMode 仍仅提醒；AskUserQuestion 走问题卡片
REMINDER_ONLY_TOOLS = frozenset({'ExitPlanMode'})


def _notify_mac(title: str, body: str) -> None:
    safe = body.replace('\\', '\\\\').replace('"', '\\"')[:200]
    subprocess.run(
        ['osascript', '-e', f'display notification "{safe}" with title "{title}"'],
        stderr=subprocess.DEVNULL,
    )


def _request_bot_card(tool_name: str, context: str, project: str) -> dict | None:
    try:
        return json.loads(
            urllib.request.urlopen(
                urllib.request.Request(
                    f'{BOT_URL}/permission-request',
                    data=json.dumps(
                        {
                            'tool_name': tool_name,
                            'command': context,
                            'project': project,
                        }
                    ).encode(),
                    headers={'Content-Type': 'application/json'},
                ),
                timeout=3,
            ).read()
        )
    except Exception as e:
        log(f'bot permission-request failed: {e}')
        return None


def _ding_later(token: str, project: str, context: str) -> None:
    def _run() -> None:
        time.sleep(DING_DELAY)
        if result_path(token).exists():
            return
        try:
            urllib.request.urlopen(
                urllib.request.Request(
                    f'{BOT_URL}/ding',
                    data=json.dumps(
                        {
                            'token': token,
                            'project': project,
                            'command': context[:60],
                        }
                    ).encode(),
                    headers={'Content-Type': 'application/json'},
                ),
                timeout=3,
            )
        except Exception:
            pass

    threading.Thread(target=_run, daemon=True).start()


def _webhook_fallback(tool_name: str, project: str, now: str, context: str, token: str) -> None:
    lines = [
        f'**工具**: {tool_name}',
        f'**项目**: {project}',
        f'**时间**: {now}',
        f'**token**: `{token}`',
        '',
        f'```\n{context[:500]}\n```',
        '',
        f'终端批准: `feishu-approve approve {token}`',
    ]
    msg = {
        'msg_type': 'interactive',
        'card': {
            'config': {'wide_screen_mode': True},
            'header': {
                'title': {'content': '⚠️ 需要你的决定', 'tag': 'plain_text'},
                'template': 'yellow',
            },
            'elements': [{'tag': 'markdown', 'content': '\n'.join(lines)}],
        },
    }
    req = urllib.request.Request(
        WEBHOOK,
        data=json.dumps(msg).encode(),
        headers={'Content-Type': 'application/json'},
    )
    urllib.request.urlopen(req, timeout=5)


def _summarize_ask_user(tool_input: dict) -> str:
    lines = []
    for q in tool_input.get('questions') or []:
        header = q.get('header') or '问题'
        text = q.get('question') or ''
        lines.append(f'**{header}**: {text}')
        for i, opt in enumerate(q.get('options') or [], 1):
            label = opt.get('label') or opt.get('description') or ''
            lines.append(f'  {i}. {label}')
    return '\n'.join(lines) if lines else str(tool_input)[:500]


def _notify_ask_user_terminal_only(tool_name: str, project: str, summary: str) -> None:
    """只提醒到飞书，不阻塞、不发批准/拒绝按钮。"""
    content = '\n'.join(
        [
            f'**工具**: {tool_name}',
            f'**项目**: {project}',
            '',
            summary[:1500],
            '',
            '👉 **请在 Claude Code 终端选择选项**（输入编号或点选）。',
            '此类问题无法通过飞书「批准/拒绝」作答。',
        ]
    )
    try:
        urllib.request.urlopen(
            urllib.request.Request(
                f'{BOT_URL}/ask-user-notify',
                data=json.dumps(
                    {'tool_name': tool_name, 'project': project, 'content': content}
                ).encode(),
                headers={'Content-Type': 'application/json'},
            ),
            timeout=5,
        )
    except Exception:
        msg = {
            'msg_type': 'interactive',
            'card': {
                'config': {'wide_screen_mode': True},
                'header': {
                    'title': {'content': '💬 Claude 等你作答', 'tag': 'plain_text'},
                    'template': 'blue',
                },
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

    _notify_mac('Claude 等你选题', '请到终端选择 AskUserQuestion 选项')
    print(
        '[feishu-notify] AskUserQuestion：请在 Claude Code 终端选择选项（飞书仅提醒，勿点批准）',
        file=sys.stderr,
        flush=True,
    )


def _request_bot_question_card(project: str, questions: list) -> dict | None:
    try:
        return json.loads(
            urllib.request.urlopen(
                urllib.request.Request(
                    f'{BOT_URL}/ask-user-request',
                    data=json.dumps({'project': project, 'questions': questions}).encode(),
                    headers={'Content-Type': 'application/json'},
                ),
                timeout=5,
            ).read()
        )
    except Exception as e:
        log(f'bot ask-user-request failed: {e}')
        return None


def _poll_until_decision(token: str) -> tuple[str, str] | None:
    deadline = time.time() + POLL_TIMEOUT
    while time.time() < deadline:
        parsed = consume_decision(token)
        if parsed:
            return parsed
        time.sleep(POLL_INTERVAL)
    return None


def _poll_until_result(token: str) -> dict | None:
    deadline = time.time() + POLL_TIMEOUT
    while time.time() < deadline:
        data = consume_result(token)
        if data:
            return data
        time.sleep(POLL_INTERVAL)
    return None


def _handle_ask_user_question(
    tool_input: dict,
    project: str,
    cwd: str,
) -> int:
    questions = tool_input.get('questions') or []
    if not questions:
        log('AskUserQuestion missing questions')
        hook_output_deny('AskUserQuestion 缺少 questions')
        return 0

    preview = (questions[0].get('question') or '')[:80]
    bot_resp = _request_bot_question_card(project, questions)
    token = str(bot_resp.get('token')) if bot_resp and bot_resp.get('token') else new_token()
    message_id = str(bot_resp.get('messageId') or '') if bot_resp else ''

    register_pending(
        token,
        tool_name='AskUserQuestion',
        project=project,
        command=preview,
        cwd=cwd,
        message_id=message_id,
        questions=questions,
    )

    print(question_hint(token, preview), file=sys.stderr, flush=True)
    _notify_mac('Claude 等你选题', '请点击飞书卡片选项')

    if not bot_resp:
        _notify_ask_user_terminal_only('AskUserQuestion', project, _summarize_ask_user(tool_input))

    result = _poll_until_result(token)
    if not result:
        clear_pending(token)
        log(f'ask_user timeout token={token}')
        hook_output_deny('选题超时：请在飞书卡片点击选项后重试')
        return 0

    if result.get('decision') == 'answer':
        updated = result.get('updatedInput') or {}
        source = str(result.get('source') or 'unknown')
        qs = updated.get('questions') or questions
        ans = updated.get('answers') or {}
        if not all_questions_answered(qs, ans):
            clear_pending(token)
            log(f'ask_user incomplete token={token} answered={len(ans)}/{len(qs)}')
            hook_output_deny(
                f'选题不完整（{len(ans)}/{len(qs)}）：请在飞书卡片答完所有问题后再继续'
            )
            return 0
        log(f'ask_user answer token={token} source={source}')
        if source != 'feishu':
            notify_bot_question_sync(token, updated, source)
        hook_output_allow(updated)
        return 0

    if result.get('decision') == 'deny':
        hook_output_deny('用户拒绝作答')
        return 0

    clear_pending(token)
    hook_output_deny('未知决策结果')
    return 0


def main() -> int:
    raw = sys.stdin.read()
    data = json.loads(raw) if raw.strip() else {}

    tool_name = data.get('tool_name', 'Unknown')
    tool_input = data.get('tool_input', {})
    cwd = data.get('cwd', '')
    project = cwd.split('/')[-1] if cwd else ''
    now = time.strftime('%H:%M:%S')

    context = (
        tool_input.get('command')
        or tool_input.get('file_path')
        or tool_input.get('url')
        or str(tool_input)
    )

    log(f'started tool={tool_name} cmd={str(tool_input)[:60]}')

    if tool_name == 'AskUserQuestion':
        return _handle_ask_user_question(tool_input, project, cwd)

    if tool_name in REMINDER_ONLY_TOOLS:
        log(f'reminder_only tool={tool_name} notify and exit')
        _notify_ask_user_terminal_only(tool_name, project, context)
        return 0

    bot_resp = _request_bot_card(tool_name, context, project)
    token = str(bot_resp.get('token')) if bot_resp and bot_resp.get('token') else ''
    message_id = str(bot_resp.get('messageId') or '') if bot_resp else ''
    bot_ok = bool(token)
    if not token:
        token = new_token()

    register_pending(
        token,
        tool_name=tool_name,
        project=project,
        command=context,
        cwd=cwd,
        message_id=message_id,
    )

    hint = terminal_hint(token, context)
    print(hint, file=sys.stderr, flush=True)
    _notify_mac(
        f'Claude 待批准 ({tool_name})',
        f'feishu-approve approve {token}',
    )

    if bot_ok:
        _ding_later(token, project, context)
    else:
        try:
            _webhook_fallback(tool_name, project, now, context, token)
        except Exception as e:
            log(f'webhook fallback failed: {e}')

    parsed = _poll_until_decision(token)
    if not parsed:
        clear_pending(token)
        log(f'timeout token={token}')
        hook_output_deny('审批超时：可在飞书点击，或终端执行 feishu-approve approve <token> 后重试')
        return 0

    decision, source = parsed
    log(f'decision={decision} source={source} token={token}')
    if source != 'feishu':
        notify_bot_decision(token, decision, source)

    if decision == 'approve':
        hook_output_allow()
    else:
        hook_output_deny('用户拒绝执行' if source == 'terminal' else '用户在飞书拒绝')
    return 0


if __name__ == '__main__':
    # Allow: python3 feishu_permission_request.py approve [token]
    if len(sys.argv) > 1 and sys.argv[1] in ('approve', 'deny', 'list'):
        raise SystemExit(cli_main(sys.argv[1:]))
    raise SystemExit(main())
