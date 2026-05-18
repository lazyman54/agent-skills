import json, sys, subprocess, urllib.request, re
from datetime import datetime

WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/6e34528b-97de-47dc-a692-6cdb6f70048e'

raw = sys.stdin.read()
data = json.loads(raw) if raw.strip() else {}

last_msg = data.get('last_assistant_message', '')
cwd = data.get('cwd', '')
permission_mode = data.get('permission_mode', '')
transcript_path = data.get('transcript_path', '')
project = cwd.split('/')[-1] if cwd else ''
now = datetime.now().strftime('%H:%M:%S')


def read_transcript(path):
    """从 transcript 读取会话名和最后一条用户文本消息"""
    session_name = ''
    last_user_text = ''
    try:
        with open(path) as f:
            lines = f.readlines()
        for line in reversed(lines):
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            # 会话名
            if not session_name and d.get('type') == 'custom-title':
                session_name = d.get('customTitle', '')
            # 最后一条真实用户文本（排除 tool_result 和纯图片消息）
            if not last_user_text and d.get('type') == 'user':
                content = d.get('message', {}).get('content', [])
                if isinstance(content, list):
                    texts = [c.get('text', '') for c in content if c.get('type') == 'text']
                    # 去掉图片引用占位符（[Image: source: ...] 和 [Image #N]）
                    clean = re.sub(r'\[Image[^\]]*\]', '', ' '.join(texts)).strip()
                    if clean:
                        last_user_text = clean
            if session_name and last_user_text:
                break
    except Exception:
        pass
    return session_name, last_user_text


session_name, last_user_text = read_transcript(transcript_path)

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
if user_summary:
    lines.append(f'**任务**: {user_summary}')
if ai_summary:
    lines.append(f'**结果**: {ai_summary}')

content = '\n'.join(lines)

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
