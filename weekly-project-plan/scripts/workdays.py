#!/usr/bin/env python3
"""工作日计算：按国务院调休表算「本周/下周的真实工作日范围」。

为什么不用「周一到周五」硬编码：调休会把周六/周日变成上班日（2026 年有 6 天），
也会把周五变成假日（如 2026-09-25 中秋）。按自然周猜工作日会直接导致漏排或多排任务。

用法:
    workdays.py                      # 今天所在周 + 下周，JSON 输出
    workdays.py --offset 2           # 今天所在周 + 下下周
    workdays.py --date 2026-09-24    # 以指定日期为「今天」
    workdays.py --check-today        # 今天是本周触发日则 exit 0，否则 exit 1

退出码:
    0  正常 / --check-today 判定为触发日
    1  --check-today 判定为非触发日
    3  目标日期超出已知调休表覆盖范围（需先补表，禁止猜）
"""

import argparse
import datetime as dt
import json
import sys

# ── 调休表 ────────────────────────────────────────────────────────────────
# 来源：国务院办公厅《关于2026年部分节假日安排的通知》国办发明电〔2025〕7号（2025-11-04）
# ⚠️ 每年 11 月国务院发布次年安排，跨年使用前必须重新核对并补表。
HOLIDAYS = {
    2026: {
        # 法定放假（含调休连休）
        "holidays": [
            # 元旦
            "2026-01-01", "2026-01-02", "2026-01-03",
            # 春节
            "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18",
            "2026-02-19", "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
            # 清明
            "2026-04-04", "2026-04-05", "2026-04-06",
            # 劳动节
            "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
            # 端午
            "2026-06-19", "2026-06-20", "2026-06-21",
            # 中秋
            "2026-09-25", "2026-09-26", "2026-09-27",
            # 国庆
            "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04",
            "2026-10-05", "2026-10-06", "2026-10-07",
        ],
        # 调休上班日（周末变工作日）
        "makeup": [
            "2026-01-04",  # 周日，补元旦
            "2026-02-14",  # 周六，补春节
            "2026-02-28",  # 周六，补春节
            "2026-05-09",  # 周六，补劳动节
            "2026-09-20",  # 周日，补国庆
            "2026-10-10",  # 周六，补国庆
        ],
    },
}

# 定时任务的运行日集合：周一到周六（周六可能是调休上班日）
RUN_WEEKDAYS = {0, 1, 2, 3, 4, 5}  # Monday=0 ... Saturday=5

CN_WEEKDAY = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]


def covered_years():
    return sorted(HOLIDAYS)


def _tables(d):
    year = d.year
    if year not in HOLIDAYS:
        covered = covered_years()
        sys.stderr.write(
            f"ERROR: {year} 年调休表未收录（已知覆盖: {covered}）。\n"
            f"国务院每年 11 月发布次年安排，请先核对国办发明电并补入 "
            f"{__file__} 的 HOLIDAYS，不要凭猜测继续。\n"
        )
        sys.exit(3)
    return set(HOLIDAYS[year]["holidays"]), set(HOLIDAYS[year]["makeup"])


def is_workday(d):
    holidays, makeup = _tables(d)
    iso = d.isoformat()
    if iso in makeup:
        return True
    if iso in holidays:
        return False
    return d.weekday() < 5


def is_holiday(d):
    holidays, _ = _tables(d)
    return d.isoformat() in holidays


def monday_of(d):
    return d - dt.timedelta(days=d.weekday())


def week_span(monday):
    return [monday + dt.timedelta(days=i) for i in range(7)]


def describe(d):
    return f"{d.isoformat()}({CN_WEEKDAY[d.weekday()]})"


def week_info(monday):
    days = week_span(monday)
    workdays = [d for d in days if is_workday(d)]
    # 触发日只在运行日集合（周一~周六）内取，否则 09/20(周日调休上班) 会被当成触发日
    run_workdays = [d for d in workdays if d.weekday() in RUN_WEEKDAYS]
    holidays = [d for d in days if is_holiday(d)]
    return {
        "monday": monday.isoformat(),
        "sunday": days[-1].isoformat(),
        "workdays": [d.isoformat() for d in workdays],
        "run_workdays": [d.isoformat() for d in run_workdays],
        "last_run_workday": run_workdays[-1].isoformat() if run_workdays else None,
        "holidays_in_week": [d.isoformat() for d in holidays],
    }


def next_week_info(monday):
    """下周单的覆盖范围。

    start = 「下周一之前紧邻的调休上班日」（若有）——2026-09-20(周日) 是调休上班日，
            实际属于「常规事项-20260921」这张单的覆盖范围，不能漏。
    end   = 下周内最后一个真实工作日。
    """
    nxt = monday + dt.timedelta(days=7)
    info = week_info(nxt)
    workdays = [dt.date.fromisoformat(s) for s in info["workdays"]]

    leading = []
    probe = nxt - dt.timedelta(days=1)
    while probe.isoformat() in _tables(probe)[1]:
        leading.insert(0, probe)
        probe -= dt.timedelta(days=1)

    start = leading[0] if leading else (workdays[0] if workdays else None)
    end = workdays[-1] if workdays else None
    calendar_end = nxt + dt.timedelta(days=6)

    return {
        "label": nxt.strftime("%Y%m%d"),
        "monday": nxt.isoformat(),
        "sunday": calendar_end.isoformat(),
        "start": start.isoformat() if start else None,
        "end": end.isoformat() if end else None,
        "workdays": [d.isoformat() for d in workdays],
        "leading_makeup": [d.isoformat() for d in leading],
        "holidays_in_week": info["holidays_in_week"],
        # 读日历用：覆盖整周（含假日），因为假日也可能有已接受的会议
        "calendar_start": (start.isoformat() if start else nxt.isoformat()),
        "calendar_end": calendar_end.isoformat(),
    }


def build(today, offset):
    monday = monday_of(today)
    this_week = week_info(monday)
    result = {
        "today": today.isoformat(),
        "today_cn": describe(today),
        "is_run_day": today.weekday() in RUN_WEEKDAYS,
        "is_last_workday": this_week["last_run_workday"] == today.isoformat(),
        "this_week": this_week,
        "next_week": next_week_info(monday + dt.timedelta(days=7 * (offset - 1))),
    }
    return result


def main():
    ap = argparse.ArgumentParser(description="按调休表计算真实工作日范围")
    ap.add_argument("--date", help="以指定日期为今天（YYYY-MM-DD），默认取系统日期")
    ap.add_argument("--offset", type=int, default=1,
                    help="next_week 的偏移：1=下周(默认)，2=下下周")
    ap.add_argument("--check-today", action="store_true",
                    help="今天是本周触发日则 exit 0，否则 exit 1")
    args = ap.parse_args()

    today = dt.date.fromisoformat(args.date) if args.date else dt.date.today()
    if args.offset < 1:
        ap.error("--offset 必须 >= 1")

    data = build(today, args.offset)

    if args.check_today:
        if not data["is_run_day"]:
            print(f"{data['today_cn']} 不在运行日集合（周一~周六），跳过")
            sys.exit(1)
        if not data["is_last_workday"]:
            print(f"{data['today_cn']} 不是本周触发日"
                  f"（本周触发日 = {data['this_week']['last_run_workday']}），跳过")
            sys.exit(1)
        print(f"{data['today_cn']} 是本周触发日，继续")
        sys.exit(0)

    json.dump(data, sys.stdout, ensure_ascii=False, indent=2)
    print()


if __name__ == "__main__":
    main()
