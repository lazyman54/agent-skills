"""Shared permission decision bus: Feishu bot or terminal CLI, first writer wins."""

from __future__ import annotations

import json
import os
import sys
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

POLL_INTERVAL = 0.5
POLL_TIMEOUT = 300
DING_DELAY = 120
LOG_PATH = Path('/tmp/perm_hook_debug.log')
PENDING_DIR = Path('/tmp/claude_perm_pending')
LATEST_TOKEN_PATH = Path('/tmp/claude_perm_latest.txt')
BOT_URL = os.environ.get('FEISHU_NOTIFY_BOT_URL', 'http://localhost:13380')


def log(msg: str) -> None:
    try:
        with LOG_PATH.open('a') as f:
            f.write(f'[{datetime.now().strftime("%H:%M:%S.%f")}] {msg}\n')
    except OSError:
        pass


def result_path(token: str) -> Path:
    return Path(f'/tmp/claude_perm_{token}')


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _norm_cmd(command: str) -> str:
    return ' '.join((command or '').split())


def register_pending(
    token: str,
    *,
    tool_name: str,
    project: str,
    command: str,
    cwd: str = '',
    message_id: str = '',
    questions: list[dict[str, Any]] | None = None,
) -> None:
    PENDING_DIR.mkdir(parents=True, exist_ok=True)
    norm = _norm_cmd(command)
    meta = {
        'token': token,
        'tool_name': tool_name,
        'project': project,
        'command': command[:2000],
        'command_prefix': norm[:240],
        'cwd': cwd,
        'message_id': message_id,
        'questions': questions,
        'created_at': _now_iso(),
    }
    (PENDING_DIR / f'{token}.json').write_text(
        json.dumps(meta, ensure_ascii=False, indent=2),
        encoding='utf-8',
    )
    LATEST_TOKEN_PATH.write_text(token, encoding='utf-8')


def clear_pending(token: str) -> None:
    try:
        (PENDING_DIR / f'{token}.json').unlink(missing_ok=True)
    except OSError:
        pass


def list_pending() -> list[dict[str, Any]]:
    if not PENDING_DIR.is_dir():
        return []
    items: list[dict[str, Any]] = []
    for path in sorted(PENDING_DIR.glob('*.json'), key=lambda p: p.stat().st_mtime):
        try:
            items.append(json.loads(path.read_text(encoding='utf-8')))
        except (OSError, json.JSONDecodeError):
            continue
    return items


def latest_token() -> str | None:
    try:
        token = LATEST_TOKEN_PATH.read_text(encoding='utf-8').strip()
        return token or None
    except OSError:
        return None


def write_question_answer(
    token: str,
    updated_input: dict[str, Any],
    source: str,
) -> bool:
    """Atomically record AskUserQuestion answer. Returns False if already decided."""
    path = result_path(token)
    payload = json.dumps(
        {
            'decision': 'answer',
            'source': source,
            'updatedInput': updated_input,
            'ts': _now_iso(),
        },
        ensure_ascii=False,
    )
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        return False
    try:
        os.write(fd, payload.encode('utf-8'))
    finally:
        os.close(fd)
    log(f'write_question_answer token={token} source={source}')
    return True


def write_decision(token: str, decision: str, source: str) -> bool:
    """Atomically record approve/deny. Returns False if already decided."""
    if decision not in ('approve', 'deny'):
        raise ValueError(f'invalid decision: {decision!r}')
    path = result_path(token)
    payload = json.dumps(
        {'decision': decision, 'source': source, 'ts': _now_iso()},
        ensure_ascii=False,
    )
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        return False
    try:
        os.write(fd, payload.encode('utf-8'))
    finally:
        os.close(fd)
    log(f'write_decision token={token} decision={decision} source={source}')
    return True


def read_result(token: str) -> dict[str, Any] | None:
    """Read permission/answer result payload, or None if not ready."""
    path = result_path(token)
    if not path.is_file():
        return None
    try:
        raw = path.read_text(encoding='utf-8').strip()
    except OSError:
        return None
    if not raw:
        return None
    if raw.startswith('{'):
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return None
    if raw in ('approve', 'deny'):
        return {'decision': raw, 'source': 'feishu'}
    return None


def read_decision(token: str) -> tuple[str, str] | None:
    """Return (decision, source) for approve/deny only."""
    data = read_result(token)
    if not data:
        return None
    decision = data.get('decision', '')
    if decision in ('approve', 'deny'):
        return decision, data.get('source', 'unknown')
    return None


def consume_result(token: str) -> dict[str, Any] | None:
    data = read_result(token)
    if data is None:
        return None
    try:
        result_path(token).unlink(missing_ok=True)
    except OSError:
        pass
    clear_pending(token)
    return data


def consume_decision(token: str) -> tuple[str, str] | None:
    data = consume_result(token)
    if not data:
        return None
    decision = data.get('decision', '')
    if decision in ('approve', 'deny'):
        return decision, data.get('source', 'unknown')
    return None


def hook_output_allow(updated_input: dict[str, Any] | None = None) -> None:
    decision: dict[str, Any] = {'behavior': 'allow'}
    if updated_input is not None:
        decision['updatedInput'] = updated_input
    print(
        json.dumps(
            {
                'hookSpecificOutput': {
                    'hookEventName': 'PermissionRequest',
                    'decision': decision,
                }
            },
            ensure_ascii=False,
        )
    )


def hook_output_deny(message: str) -> None:
    print(
        json.dumps(
            {
                'hookSpecificOutput': {
                    'hookEventName': 'PermissionRequest',
                    'decision': {'behavior': 'deny', 'message': message},
                }
            },
            ensure_ascii=False,
        )
    )


def new_token() -> str:
    return uuid.uuid4().hex


def question_hint(token: str, question_preview: str) -> str:
    preview = question_preview.replace('\n', ' ')[:80]
    return (
        f'[feishu-notify] 待选题 token={token}\n'
        f'  飞书: 点击卡片上的选项按钮\n'
        f'  问题: {preview}'
    )


def terminal_hint(token: str, command_preview: str) -> str:
    preview = command_preview.replace('\n', ' ')[:80]
    return (
        f'[feishu-notify] 待批准 token={token}\n'
        f'  终端: feishu-approve approve {token}\n'
        f'  或:   feishu-approve deny {token}\n'
        f'  命令: {preview}'
    )


def all_questions_answered(
    questions: list[dict[str, Any]],
    answers: dict[str, Any],
) -> bool:
    """True when every question text has a non-empty answer label."""
    if not questions:
        return False
    for q in questions:
        key = q.get('question') or ''
        val = answers.get(key)
        if val is None or str(val).strip() == '':
            return False
    return True


def match_pending_ask_user(
    tool_input: dict[str, Any],
    *,
    cwd: str = '',
) -> str | None:
    """Find pending AskUserQuestion token after terminal answered (PostToolUse)."""
    answers = tool_input.get('answers') or {}
    if not answers:
        return None
    questions = tool_input.get('questions') or []
    first_q = (questions[0].get('question') or '') if questions else ''

    for meta in reversed(list_pending()):
        if meta.get('tool_name') != 'AskUserQuestion':
            continue
        if cwd and meta.get('cwd') and meta.get('cwd') != cwd:
            continue
        meta_qs = meta.get('questions') or []
        if first_q and meta_qs:
            if first_q == (meta_qs[0].get('question') or ''):
                return meta.get('token')
        elif first_q and meta.get('command') == first_q[:80]:
            return meta.get('token')

    token = latest_token()
    if not token:
        return None
    try:
        meta = json.loads((PENDING_DIR / f'{token}.json').read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return None
    if meta.get('tool_name') == 'AskUserQuestion':
        return token
    return None


def notify_bot_question_sync(
    token: str,
    updated_input: dict[str, Any],
    source: str,
) -> None:
    """Patch Feishu question card after terminal / PostToolUse answer."""
    try:
        payload = json.dumps(
            {'token': token, 'updatedInput': updated_input, 'source': source},
            ensure_ascii=False,
        ).encode()
        req = urllib.request.Request(
            f'{BOT_URL}/question-synced',
            data=payload,
            headers={'Content-Type': 'application/json'},
        )
        urllib.request.urlopen(req, timeout=3)
        log(f'notify_bot_question_sync token={token} source={source}')
    except Exception as e:
        log(f'notify_bot_question_sync failed: {e}')


def notify_bot_decision(token: str, decision: str, source: str) -> None:
    """Tell feishu-notify-bot to patch the Feishu card (terminal / hook path)."""
    try:
        payload = json.dumps(
            {'token': token, 'decision': decision, 'source': source},
            ensure_ascii=False,
        ).encode()
        req = urllib.request.Request(
            f'{BOT_URL}/decision',
            data=payload,
            headers={'Content-Type': 'application/json'},
        )
        urllib.request.urlopen(req, timeout=3)
        log(f'notify_bot_decision token={token} decision={decision} source={source}')
    except Exception as e:
        log(f'notify_bot_decision failed: {e}')


def commands_match(pending_cmd: str, pending_prefix: str, actual_cmd: str) -> bool:
    """Match full or truncated pending command against PostToolUse command."""
    actual = _norm_cmd(actual_cmd)
    pending = _norm_cmd(pending_cmd)
    prefix = _norm_cmd(pending_prefix) or pending[:240]
    if not actual:
        return False
    if pending and actual == pending:
        return True
    if prefix and (actual.startswith(prefix) or prefix.startswith(actual[: len(prefix)])):
        return True
    if pending and len(pending) >= 60 and actual.startswith(pending[: min(len(pending), 240)]):
        return True
    return actual[:240] == prefix[:240] if prefix else False


def match_pending_by_command(
    command: str,
    *,
    tool_name: str = '',
    cwd: str = '',
) -> str | None:
    """Find pending token whose command matches (for PostToolUse sync)."""
    if not command or not PENDING_DIR.is_dir():
        return None
    for path in sorted(PENDING_DIR.glob('*.json'), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            meta = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, json.JSONDecodeError):
            continue
        if tool_name and meta.get('tool_name') != tool_name:
            continue
        if cwd and meta.get('cwd') and meta.get('cwd') != cwd:
            continue
        if commands_match(
            meta.get('command') or '',
            meta.get('command_prefix') or '',
            command,
        ):
            return meta.get('token') or path.stem
    return None


def cli_main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    if not args or args[0] in ('-h', '--help'):
        print(
            'Usage:\n'
            '  feishu-approve list\n'
            '  feishu-approve approve [token]\n'
            '  feishu-approve deny [token]\n'
            '\n'
            'Omit token to use the latest pending request.'
        )
        return 0

    cmd = args[0]
    token = args[1] if len(args) > 1 else latest_token()

    if cmd == 'list':
        pending = list_pending()
        if not pending:
            print('No pending permission requests.')
            return 0
        for item in pending:
            print(
                f"{item.get('token')}  [{item.get('project')}] "
                f"{item.get('tool_name')}: {(item.get('command') or '')[:60]}"
            )
        return 0

    if cmd not in ('approve', 'deny'):
        print(f'Unknown command: {cmd}', file=sys.stderr)
        return 1

    if not token:
        print('No token provided and no latest pending request.', file=sys.stderr)
        return 1

    pending_path = PENDING_DIR / f'{token}.json'
    if pending_path.is_file():
        try:
            meta = json.loads(pending_path.read_text(encoding='utf-8'))
            if meta.get('tool_name') == 'AskUserQuestion':
                print(
                    f'Token {token} is AskUserQuestion — use Feishu option buttons, not feishu-approve.',
                    file=sys.stderr,
                )
                return 2
        except (OSError, json.JSONDecodeError):
            pass

    card_meta_path = Path(f'/tmp/claude_perm_cards/{token}.json')
    if card_meta_path.is_file():
        try:
            card_meta = json.loads(card_meta_path.read_text(encoding='utf-8'))
            if card_meta.get('type') == 'ask_user':
                print(
                    f'Token {token} is AskUserQuestion card — use Feishu option buttons, not feishu-approve.',
                    file=sys.stderr,
                )
                return 2
        except (OSError, json.JSONDecodeError):
            pass

    decision = 'approve' if cmd == 'approve' else 'deny'
    if write_decision(token, decision, 'terminal'):
        notify_bot_decision(token, decision, 'terminal')
        print(f'{decision} recorded for {token} (terminal)')
        return 0

    existing = read_decision(token)
    if existing:
        print(f'Already decided: {existing[0]} via {existing[1]}', file=sys.stderr)
        return 2
    print(f'Failed to record decision for {token}', file=sys.stderr)
    return 1
