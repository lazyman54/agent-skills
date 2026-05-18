import json, sys, subprocess, urllib.request
from datetime import datetime

WEBHOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/6e34528b-97de-47dc-a692-6cdb6f70048e'

raw = sys.stdin.read()
data = json.loads(raw) if raw.strip() else {}

tool_name = data.get('tool_name', 'Unknown')
tool_input = data.get('tool_input', {})
cwd = data.get('cwd', '')
project = cwd.split('/')[-1] if cwd else ''
now = datetime.now().strftime('%H:%M:%S')

# 智能提取操作描述：取最有代表性的字段，长命令只保留前80字
raw_context = (
    tool_input.get('command')
    or tool_input.get('file_path')
    or tool_input.get('url')
    or str(tool_input)
)
if len(raw_context) > 80:
    context = raw_context[:77] + '…'
else:
    context = raw_context

subprocess.run(
    ['osascript', '-e', f'display notification "请回到终端处理权限请求" with title "Claude 需要你的决定 ({tool_name})"'],
    stderr=subprocess.DEVNULL,
)

lines = [
    f'**工具**: {tool_name}',
    f'**操作**: `{context}`',
    f'**项目**: {project}',
    f'**时间**: {now}',
    '',
    '⚡ 请回到终端批准或拒绝',
]

content = '\n'.join(lines)

try:
    msg = {
        'msg_type': 'interactive',
        'card': {
            'config': {'wide_screen_mode': True},
            'header': {'title': {'content': '⚠️ 需要你的决定', 'tag': 'plain_text'}, 'template': 'yellow'},
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
