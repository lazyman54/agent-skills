#!/usr/bin/env python3
"""把下周日历里的会议转成 Meego 子任务草案（估分 + 吸附后排期）。

口径来自 2026-09-18 对「常规事项-20260921」已建子任务的反推验证，
见 SKILL.md「Step 2 / Step 4b」。之所以做成脚本：无人值守跑的时候，
12 场会议的 rsvp 判断、时长换算、小时吸附不能靠模型口算。

用法:
    next_week_meetings.py --start 2026-09-20 --end 2026-09-27
    next_week_meetings.py --start 2026-09-20 --end 2026-09-27 --agenda-json /tmp/agenda.json  # 离线复算

输出: JSON 到 stdout
    {"included": [...], "excluded": [...], "errors": [...]}
每条 included: name / title / start / end / points / estimate_start_ms / estimate_end_ms / reason
"""

import argparse
import datetime as dt
import json
import re
import subprocess
import sys

# 我自己的 open_id（日历参会人里的 user_id；与 bot 推送目标一致）
MY_OPEN_ID = "ou_a735e005fa3ddb9a8b59c745805db36e"

# 1 人天 = 7 小时；最小单位 0.1 人天（用户 2026-09-17 定的口径）
HOURS_PER_DAY = 7.0
MIN_POINTS = 0.1
POINTS_STEP = 0.1

TZ = dt.timezone(dt.timedelta(hours=8))  # Asia/Shanghai


def parse_dt(s):
    return dt.datetime.fromisoformat(s).astimezone(TZ)


def to_ms(d):
    return int(d.timestamp() * 1000)


def base_event_id(event_id):
    """重复性日程的参会人接口要用 <base>_0，直接用实例 ID 会报 event not found。"""
    m = re.match(r"^(.*)_(\d+)$", event_id)
    return f"{m.group(1)}_0" if m else event_id


def calc_points(hours):
    """时长 → 人天：h ÷ 7，四舍五入到 0.1，下限 0.1。

    下限会让 0.5h 和 1h 落到同一个估分，这是口径的必然结果，调用方要在推送里说明。
    """
    raw = hours / HOURS_PER_DAY
    steps = round(raw / POINTS_STEP)
    return max(MIN_POINTS, round(steps * POINTS_STEP, 1))


def snap_schedule(start, end):
    """子任务排期只有小时粒度：start 向下取整到整点，
    end 吸附到 (end − 1 秒) 所在小时的 59:59。

    传 09:45→10:00 会落库成 09:00→10:59:59，所以必须先减一秒再取整点。
    """
    s = start.replace(minute=0, second=0, microsecond=0)
    e_probe = end - dt.timedelta(seconds=1)
    e = e_probe.replace(minute=59, second=59, microsecond=0)
    return s, e


def fetch_agenda(start, end):
    q = subprocess.run(
        ["lark-cli", "calendar", "+agenda",
         "--start", start, "--end", end, "--as", "user", "--format", "json"],
        capture_output=True, text=True,
    )
    if q.returncode != 0:
        raise RuntimeError(f"lark-cli agenda 失败: {q.stderr[:300] or q.stdout[:300]}")
    data = json.loads(q.stdout)
    items = data.get("data") or data.get("items") or data
    if isinstance(items, dict):
        items = items.get("items") or items.get("events") or []
    return items


def fetch_attendees(event_id):
    q = subprocess.run(
        ["lark-cli", "calendar", "event.attendees", "list",
         "--calendar-id", "primary", "--event-id", base_event_id(event_id),
         "--as", "user", "--format", "json"],
        capture_output=True, text=True,
    )
    if q.returncode != 0:
        raise RuntimeError(q.stderr[:200] or q.stdout[:200])
    data = json.loads(q.stdout)
    return (data.get("data") or {}).get("items") or []


def classify(item):
    """返回 (是否纳入, 原因, 其他参会人数)。

    纳入 = self_rsvp_status == "accept" 且 除我之外至少 1 个参会人。
    「除我之外」把 user / resource(会议室) / chat(群) 都算——验证过：
      - 旧奖品下线周例会：我 accept，没有其他 user，但有 1 会议室 + 1 群 → 纳入
      - Self（个人时间块）：我 accept，0 参会人 → 排除
    """
    rsvp = item.get("self_rsvp_status")
    if rsvp != "accept":
        return False, f"self_rsvp_status={rsvp}", None

    try:
        attendees = fetch_attendees(item["event_id"])
    except Exception as exc:  # 查不到参会人时不猜，标出来让人工看
        return None, f"参会人查询失败: {exc}", None

    others = [a for a in attendees
              if not (a.get("type") == "user" and a.get("user_id") == MY_OPEN_ID)]
    if not others:
        return False, "除我之外无参会人（个人时间块）", 0
    return True, "", len(others)


def build(start, end, items):
    included, excluded, errors = [], [], []
    for item in items:
        title = item.get("summary") or "(无标题)"
        verdict, reason, n_others = classify(item)
        if verdict is None:
            errors.append({"title": title, "event_id": item["event_id"], "reason": reason})
            continue

        s, e = parse_dt(item["start_time"]["datetime"]), parse_dt(item["end_time"]["datetime"])
        hours = (e - s).total_seconds() / 3600
        snapped_s, snapped_e = snap_schedule(s, e)

        row = {
            "name": f"【会议】{title}",
            "title": title,
            "event_id": item["event_id"],
            "meeting_start": s.isoformat(),
            "meeting_end": e.isoformat(),
            "hours": round(hours, 4),
            "points": calc_points(hours),
            "estimate_start_ms": to_ms(snapped_s),
            "estimate_end_ms": to_ms(snapped_e),
            "estimate_start": snapped_s.isoformat(),
            "estimate_end": snapped_e.isoformat(),
        }
        if verdict:
            row["other_attendees"] = n_others
            included.append(row)
        else:
            row["reason"] = reason
            excluded.append(row)

    included.sort(key=lambda r: r["estimate_start_ms"])
    excluded.sort(key=lambda r: r["meeting_start"])
    return {
        "range": {"start": start, "end": end},
        "included": included,
        "excluded": excluded,
        "errors": errors,
        "total_points": round(sum(r["points"] for r in included), 1),
        "count": len(included),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", required=True, help="读日历起始日 YYYY-MM-DD")
    ap.add_argument("--end", required=True, help="读日历结束日 YYYY-MM-DD")
    ap.add_argument("--agenda-json", help="离线复算：直接读已有的 agenda JSON，不调 lark-cli")
    args = ap.parse_args()

    if args.agenda_json:
        raw = json.load(open(args.agenda_json))
        items = raw.get("data") or raw.get("items") or raw
        if isinstance(items, dict):
            items = items.get("items") or items.get("events") or []
    else:
        items = fetch_agenda(args.start, args.end)

    json.dump(build(args.start, args.end, items), sys.stdout, ensure_ascii=False, indent=2)
    print()


if __name__ == "__main__":
    main()
