import json, sys, subprocess, urllib.request, re, time
from datetime import datetime, timezone

WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/6e34528b-97de-47dc-a692-6cdb6f70048e'

raw = sys.stdin.read()
data = json.loads(raw) if raw.strip() else {}

last_msg = data.get('last_assistant_message', '')
cwd = data.get('cwd', '')
permission_mode = data.get('permission_mode', '')
transcript_path = data.get('transcript_path', '')
project = cwd.split('/')[-1] if cwd else ''
now = datetime.now().strftime('%H:%M:%S')


def parse_ts(ts_str):
    if not ts_str:
        return None
    try:
        return datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
    except Exception:
        return None


def read_transcript(path):
    """从 transcript 读取会话名、最后一条用户文本消息、耗时及是否有工具调用"""
    session_name = ''
    last_user_text = ''
    assistant_ts = None
    user_ts = None
    has_tool_use = False
    try:
        with open(path) as f:
            lines = f.readlines()
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get('type') == 'assistant':
                content = d.get('message', {}).get('content', [])
                if isinstance(content, list) and any(c.get('type') == 'tool_use' for c in content):
                    has_tool_use = True
        for line in reversed(lines):
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            dtype = d.get('type')
            if not session_name and dtype == 'custom-title':
                session_name = d.get('customTitle', '')
            if assistant_ts is None and dtype == 'assistant':
                assistant_ts = parse_ts(d.get('timestamp'))
            if not last_user_text and dtype == 'user':
                content = d.get('message', {}).get('content', [])
                if isinstance(content, str):
                    raw_text = content
                elif isinstance(content, list):
                    raw_text = ' '.join(c.get('text', '') for c in content if c.get('type') == 'text')
                else:
                    raw_text = ''
                clean = re.sub(r'\[Image[^\]]*\]', '', raw_text).strip()
                if clean:
                    last_user_text = clean
                    user_ts = parse_ts(d.get('timestamp'))
            if session_name and last_user_text and assistant_ts is not None:
                break
    except Exception:
        pass
    return session_name, last_user_text, user_ts, assistant_ts, has_tool_use


# Stop 触发时 transcript 可能尚未落盘（与 Warp hook 同理）
if transcript_path:
    time.sleep(0.35)
session_name, last_user_text, user_ts, assistant_ts, has_tool_use = read_transcript(transcript_path)

elapsed_secs = 0
elapsed_str = ''
if user_ts and assistant_ts:
    elapsed_secs = int((assistant_ts - user_ts).total_seconds())
    if elapsed_secs >= 60:
        elapsed_str = f'{elapsed_secs // 60}分{elapsed_secs % 60}秒'
    else:
        elapsed_str = f'{elapsed_secs}秒'

# 噪音过滤：无工具、无实质回复、且耗时 < 10 秒才跳过
if not has_tool_use and elapsed_secs < 10 and len(last_msg.strip()) < 30:
    sys.exit(0)

# 摘要用户问题（前100字）
user_summary = re.sub(r'\n+', ' ', last_user_text).strip()[:100]
if len(last_user_text) > 100:
    user_summary += '…'

# 摘要 AI 回复（去代码块，前200字）
ai_summary = re.sub(r'```[^\n]*\n.*?```', '[代码块]', last_msg, flags=re.DOTALL)
ai_summary = re.sub(r'\n+', ' ', ai_summary).strip()[:200]
if len(last_msg) > 200:
    ai_summary += '…'

# 判断是问题还是完成
is_question = last_msg.strip().endswith('?') or last_msg.strip().endswith('？')
if is_question:
    title = '💬 Claude 在等待你的回复'
    template = 'orange'
else:
    title = '✅ Claude 完成回复'
    template = 'green'

notif_text = user_summary[:80] if user_summary else ai_summary[:80]
subprocess.run(
    ['osascript', '-e', f'display notification "{notif_text}" with title "Claude ({project})"'],
    stderr=subprocess.DEVNULL,
)

lines = []
if session_name:
    lines.append(f'**会话**: {session_name}')
if project:
    lines.append(f'**项目**: {project}')
if permission_mode:
    lines.append(f'**权限模式**: {permission_mode}')
lines.append(f'**时间**: {now}')
if elapsed_str:
    lines.append(f'**耗时**: {elapsed_str}')
if user_summary:
    lines.append(f'**任务**: {user_summary}')
if ai_summary:
    lines.append(f'**结果**: {ai_summary}')

content = '\n'.join(lines)

# 优先通过 feishu-notify-bot 发（schema 2.0 正确格式）
try:
    payload = json.dumps({'title': title, 'template': template, 'content': content}).encode()
    req = urllib.request.Request(
        'http://localhost:13380/stop-notify',
        data=payload,
        headers={'Content-Type': 'application/json'},
    )
    urllib.request.urlopen(req, timeout=5)
except Exception:
    # 降级：直接发 Webhook
    try:
        msg = {
            'msg_type': 'interactive',
            'card': {
                'config': {'wide_screen_mode': True},
                'header': {'title': {'content': title, 'tag': 'plain_text'}, 'template': template},
                'elements': [{'tag': 'markdown', 'content': content}],
            },
        }
        req = urllib.request.Request(
            WEBHOOK,
            data=json.dumps(msg).encode(),
            headers={'Content-Type': 'application/json'},
        )
        urllib.request.urlopen(req, timeout=5)
    except Exception:
        pass
