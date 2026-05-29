#!/usr/bin/env python3
"""PostToolUse: sync Feishu card when terminal approves Bash or answers AskUserQuestion."""

from __future__ import annotations

import json
import sys
from typing import Any

from feishu_perm_lib import (
    all_questions_answered,
    log,
    match_pending_ask_user,
    match_pending_by_command,
    notify_bot_decision,
    notify_bot_question_sync,
    read_decision,
    read_result,
    write_decision,
    write_question_answer,
)

SYNC_TOOLS = frozenset({'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'})


def _extract_command(tool_name: str, tool_input: dict) -> str:
    if tool_name == 'Bash':
        return (tool_input.get('command') or '').strip()
    if tool_name in ('Edit', 'Write', 'MultiEdit'):
        return (tool_input.get('file_path') or '').strip()
    if tool_name == 'NotebookEdit':
        return (tool_input.get('notebook_path') or tool_input.get('file_path') or '').strip()
    return ''


def _sync_ask_user(data: dict[str, Any]) -> int:
    tool_input = data.get('tool_input') or {}
    answers = tool_input.get('answers') or {}
    if not answers:
        return 0

    cwd = data.get('cwd', '')
    token = match_pending_ask_user(tool_input, cwd=cwd)
    if not token:
        log(f'post_tool ask_user no_match answers={list(answers.keys())[:2]}')
        return 0

    questions = tool_input.get('questions') or []
    if not all_questions_answered(questions, answers):
        log(
            f'post_tool ask_user partial token={token} '
            f'answered={len(answers)}/{len(questions)} — skip until complete'
        )
        return 0

    updated_input: dict[str, Any] = {'questions': questions, 'answers': answers}

    existing = read_result(token)
    if existing and existing.get('decision') == 'answer':
        log(f'post_tool ask_user already_answered token={token} via {existing.get("source")}')
        if existing.get('source') != 'feishu':
            notify_bot_question_sync(
                token,
                existing.get('updatedInput') or updated_input,
                str(existing.get('source') or 'claude_terminal'),
            )
        return 0

    if write_question_answer(token, updated_input, 'claude_terminal'):
        log(f'post_tool ask_user sync token={token}')
        notify_bot_question_sync(token, updated_input, 'claude_terminal')
    return 0


def main() -> int:
    raw = sys.stdin.read()
    if not raw.strip():
        return 0
    data = json.loads(raw)

    tool_name = data.get('tool_name', '')
    if tool_name == 'AskUserQuestion':
        return _sync_ask_user(data)

    if tool_name not in SYNC_TOOLS:
        return 0

    command = _extract_command(tool_name, data.get('tool_input') or {})
    cwd = data.get('cwd', '')
    if not command:
        return 0

    token = match_pending_by_command(command, tool_name=tool_name, cwd=cwd)
    if not token:
        log(f'post_tool no_match tool={tool_name} cmd={command[:80]}')
        return 0

    existing = read_decision(token)
    if existing:
        log(f'post_tool already_decided token={token} via {existing[1]}')
        if existing[1] != 'feishu':
            notify_bot_decision(token, existing[0], existing[1])
        return 0

    if not write_decision(token, 'approve', 'claude_terminal'):
        return 0

    log(f'post_tool sync token={token} tool={tool_name}')
    notify_bot_decision(token, 'approve', 'claude_terminal')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
