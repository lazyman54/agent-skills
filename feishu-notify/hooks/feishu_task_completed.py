import json, sys, subprocess, urllib.request
from datetime import datetime

WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/6e34528b-97de-47dc-a692-6cdb6f70048e'

raw = sys.stdin.read()
data = json.loads(raw) if raw.strip() else {}

task_id = data.get('task_id', '')
task_name = data.get('task_subject', 'Unknown')
task_desc = data.get('task_description', '')
cwd = data.get('cwd', '')
project = cwd.split('/')[-1] if cwd else ''
now = datetime.now().strftime('%H:%M:%S')

id_label = f'#{task_id} ' if task_id else ''

subprocess.run(
    ['osascript', '-e', f'display notification "{id_label}{task_name}" with title "Claude 任务完成 ({project})"'],
    stderr=subprocess.DEVNULL,
)

lines = [f'**任务**: {id_label}{task_name}']
if task_desc:
    lines.append(f'**描述**: {task_desc[:100]}')
if project:
    lines.append(f'**项目**: {project}')
lines.append(f'**时间**: {now}')

content = '\n'.join(lines)

try:
    msg = {
        'msg_type': 'interactive',
        'card': {
            'config': {'wide_screen_mode': True},
            'header': {'title': {'content': '✅ 任务完成', 'tag': 'plain_text'}, 'template': 'green'},
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
