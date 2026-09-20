#!/usr/bin/env python3
"""把「日历算出来的会议」和「单里已有的子任务」对账，输出该建/该改/该报的动作清单。

为什么需要它：单子一旦建过，日历还会继续变（会议改期、取消、新加）。
刷新分支没有配对规则的话，同名子任务（本单里就有两条「【会议】平台后端晨会-现网系统」）
只能靠时间区分，而其中一条的时间本身可能已经是错的——纯靠模型判断会配错。

配对规则（确定性，不靠猜）：
  1. 按标题分组（子任务名去掉 `【会议】` 前缀后与日程标题比对）
  2. 同标题内按「开始时间最接近」贪心配对
  3. 配不上的日历会议 → create
  4. 配不上的 `【会议】` 子任务 → stale（日历上已无此会议）
  5. 配对成功但排期/估分不符 → update
  6. 非 `【会议】` 且非固定 OnCall 的子任务 → untouched，**一律不碰**

用法:
    reconcile_subtasks.py --start 2026-09-20 --end 2026-09-27 --work-item-id 7117507305
    reconcile_subtasks.py ... --subtasks-json /tmp/subs.json   # 离线复算
"""

import argparse
import datetime as dt
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from next_week_meetings import build, fetch_agenda  # noqa: E402

MEETING_PREFIX = "【会议】"
ONCALL_NAME = "日常oncall+告警排查+团队事项"  # 固定子任务名，见 SKILL.md Step 4a
TZ = dt.timezone(dt.timedelta(hours=8))


def parse_ms(iso):
    if not iso:
        return None
    return int(dt.datetime.fromisoformat(iso).astimezone(TZ).timestamp() * 1000)


def fetch_subtasks(work_item_id, project_key, node_id):
    q = subprocess.run(
        ["meegle", "workflow", "get-node", "--project-key", project_key,
         "--work-item-id", work_item_id, "--node-id-list", json.dumps([node_id]),
         "--need-sub-task", "true", "--select", "list.sub_tasks", "--format", "json"],
        capture_output=True, text=True,
    )
    if q.returncode != 0:
        raise RuntimeError(f"读子任务失败: {q.stderr[:300] or q.stdout[:300]}")
    data = json.loads(q.stdout)
    out = []
    for node in data.get("list", []):
        for st in node.get("sub_tasks", []):
            out.append({
                "sub_task_id": st.get("sub_task_id"),
                "raw_name": st.get("sub_task_name") or "",
                "points": st.get("points"),
                "start_ms": parse_ms(st.get("estimate_start_date")),
                "end_ms": parse_ms(st.get("estimate_end_date")),
            })
    return out


def split_name(raw):
    """子任务名 → (是否会议, 标题)。非会议返回 (False, 原名)。"""
    if raw.startswith(MEETING_PREFIX):
        return True, raw[len(MEETING_PREFIX):]
    return False, raw


def reconcile(meeting_plan, subtasks, range_start_ms, range_end_ms):
    meetings = meeting_plan["included"]

    meeting_subs = []
    others = []
    for st in subtasks:
        is_meeting, title = split_name(st["raw_name"])
        st["title"] = title
        (meeting_subs if is_meeting else others).append(st)

    # 同标题内按开始时间最接近贪心配对
    by_title = {}
    for st in meeting_subs:
        by_title.setdefault(st["title"], []).append(st)

    used = set()
    pairs = []
    for m in sorted(meetings, key=lambda x: x["estimate_start_ms"]):
        cands = [s for s in by_title.get(m["title"], []) if s["sub_task_id"] not in used]
        if not cands:
            pairs.append((m, None))
            continue
        best = min(cands, key=lambda s: abs((s["start_ms"] or 0) - m["estimate_start_ms"]))
        used.add(best["sub_task_id"])
        pairs.append((m, best))

    create, update, keep = [], [], []
    for m, st in pairs:
        if st is None:
            create.append(m)
            continue
        same_time = (st["start_ms"] == m["estimate_start_ms"]
                     and st["end_ms"] == m["estimate_end_ms"])
        same_points = st["points"] == m["points"]
        if same_time and same_points:
            keep.append({"name": m["name"], "sub_task_id": st["sub_task_id"]})
        else:
            update.append({
                "sub_task_id": st["sub_task_id"],
                "name": m["name"],
                "was": {"start_ms": st["start_ms"], "end_ms": st["end_ms"], "points": st["points"]},
                "now": {"estimate_start_ms": m["estimate_start_ms"],
                        "estimate_end_ms": m["estimate_end_ms"], "points": m["points"]},
                "reasons": ([] if same_time else ["排期不符"]) + ([] if same_points else ["估分不符"]),
            })

    stale = [{"sub_task_id": s["sub_task_id"], "name": s["raw_name"],
              "start_ms": s["start_ms"], "points": s["points"]}
             for s in meeting_subs if s["sub_task_id"] not in used]

    # 固定 OnCall：只核排期与估分，不做增删
    oncall = [s for s in others if s["raw_name"] == ONCALL_NAME]
    oncall_ok, oncall_fix = None, None
    if oncall:
        s = oncall[0]
        if s["start_ms"] == range_start_ms and s["end_ms"] == range_end_ms and s["points"] == 1:
            oncall_ok = {"sub_task_id": s["sub_task_id"], "name": s["raw_name"]}
        else:
            oncall_fix = {"sub_task_id": s["sub_task_id"], "name": s["raw_name"],
                          "was": {"start_ms": s["start_ms"], "end_ms": s["end_ms"], "points": s["points"]},
                          "now": {"estimate_start_ms": range_start_ms,
                                  "estimate_end_ms": range_end_ms, "points": 1}}
    else:
        oncall_fix = {"sub_task_id": None, "name": ONCALL_NAME,
                      "now": {"estimate_start_ms": range_start_ms,
                              "estimate_end_ms": range_end_ms, "points": 1}}

    return {
        # 刷新路径已内含 Step 2 的日历过滤，这里把边界项一并带出，
        # 避免调用方为了拿 excluded 再跑一遍 next_week_meetings.py
        "excluded": meeting_plan["excluded"],
        "errors": meeting_plan["errors"],
        "create": create,
        "update": update,
        "keep": keep,
        "stale": stale,
        "oncall": {"ok": oncall_ok, "fix": oncall_fix},
        "untouched": [{"sub_task_id": s["sub_task_id"], "name": s["raw_name"],
                       "points": s["points"]} for s in others if s["raw_name"] != ONCALL_NAME],
        "summary": {
            "meetings_on_calendar": len(meetings),
            "meeting_subs_in_item": len(meeting_subs),
            "create": len(create), "update": len(update),
            "keep": len(keep), "stale": len(stale),
        },
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", required=True)
    ap.add_argument("--end", required=True)
    ap.add_argument("--work-item-id", required=True)
    ap.add_argument("--project-key", default="futu-project")
    ap.add_argument("--node-id", default="state_0")
    ap.add_argument("--range-start", required=True,
                    help="节点/固定 OnCall 的排期起始日 YYYY-MM-DD（来自 workdays.py 的 next_week.start）")
    ap.add_argument("--range-end", required=True,
                    help="节点/固定 OnCall 的排期结束日 YYYY-MM-DD（来自 workdays.py 的 next_week.end）")
    ap.add_argument("--subtasks-json", help="离线复算：直接读已有的 get-node JSON")
    ap.add_argument("--agenda-json", help="离线复算：直接读已有的 agenda JSON")
    args = ap.parse_args()

    if args.agenda_json:
        raw = json.load(open(args.agenda_json))
        items = raw.get("data") or raw.get("items") or raw
        if isinstance(items, dict):
            items = items.get("items") or items.get("events") or []
    else:
        items = fetch_agenda(args.start, args.end)
    plan = build(args.start, args.end, items)

    if args.subtasks_json:
        raw = json.load(open(args.subtasks_json))
        subtasks = []
        for node in raw.get("list", []):
            for st in node.get("sub_tasks", []):
                subtasks.append({
                    "sub_task_id": st.get("sub_task_id"),
                    "raw_name": st.get("sub_task_name") or "",
                    "points": st.get("points"),
                    "start_ms": parse_ms(st.get("estimate_start_date")),
                    "end_ms": parse_ms(st.get("estimate_end_date")),
                })
    else:
        subtasks = fetch_subtasks(args.work_item_id, args.project_key, args.node_id)

    # 节点与固定 OnCall 的排期 = 该周真实工作日，由调用方从 workdays.py 传入
    range_start_ms = int(dt.datetime.fromisoformat(args.range_start + "T00:00:00")
                         .replace(tzinfo=TZ).timestamp() * 1000)
    range_end_ms = int(dt.datetime.fromisoformat(args.range_end + "T23:59:59")
                       .replace(tzinfo=TZ).timestamp() * 1000)

    json.dump(reconcile(plan, subtasks, range_start_ms, range_end_ms),
              sys.stdout, ensure_ascii=False, indent=2)
    print()


if __name__ == "__main__":
    main()
