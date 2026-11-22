#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""比赛「有成绩无报名」存量补齐（2026-11-22 张老师定口径：有成绩就该有报名记录）

背景：
  上传/后台挂接此前不检查报名状态——玩家开赛后带标识直接上传（或后台批量
  挂接）会产生「有成绩动态（tournament_event type=4）但无报名行
  （tournament_entry）」的口径空洞；窗口赛玩家点开始比赛拿标识后上传同样漏
  报名。代码侧已在三个挂接入口接入 ensureTourEntry（挂接即补报名），本脚本
  一次性补齐存量。

补齐口径（与线上 ensureTourEntry 一致）：
  - 报名行 createTime = 该玩家在本比赛的**最早** type=4 成绩动态时刻
    （窗口赛更精确回溯到窗口 start_time——该时刻 ≥ 点开始比赛时刻，语义正确）
  - 比赛动态 type=2「报名参加了比赛」：createTime=同上；id 在成绩动态之后，
    但 (create_time,id) 排序下报名行排在最早成绩动态**同秒之前位**——先报名、
    再成绩，与线上口径一致
  - 个人动态 news type=58「报名参加了 FFFFF」：createTime 同上；
    exp_time/ranked 快照取当前值（快照制只影响称号渲染，补发无历史值可考）
  - 幂等：先查 tournament_entry 已存在则整组跳过（重跑安全）

用法：
  python backfill-tour-entry.py            # dry-run（只打印）
  python backfill-tour-entry.py --apply    # 实际写入
  （生产执行：--apply --allow-nonlocal，配合 SAOLEI_DB_* 环境变量走隧道）
"""
import os
import sys

import pymysql

DRY = "--apply" not in sys.argv

if not DRY:
    host = os.environ.get("SAOLEI_DB_HOST", "127.0.0.1")
    port = int(os.environ.get("SAOLEI_DB_PORT", "3306"))
    if (host, port) != ("127.0.0.1", 3306) and "--allow-nonlocal" not in sys.argv:
        sys.exit("非本地库写入门禁：需 --allow-nonlocal")

my = pymysql.connect(
    host=os.environ.get("SAOLEI_DB_HOST", "127.0.0.1"),
    port=int(os.environ.get("SAOLEI_DB_PORT", "3306")),
    user=os.environ.get("SAOLEI_DB_USER", "root"),
    password=os.environ.get("SAOLEI_DB_PASSWORD", ""),
    database=os.environ.get("SAOLEI_DB_NAME", "saolei"),
    charset="utf8mb4", autocommit=False)
cur = my.cursor()

# ---------- 1. 找出全部「有成绩动态、无报名行」的 (comp, user) ----------
cur.execute("""
    SELECT te.competition_id, te.user_id, MIN(te.create_time)
    FROM tournament_event te
    LEFT JOIN tournament_entry en
      ON en.competition_id = te.competition_id AND en.user_id = te.user_id
    WHERE te.type = 4 AND te.user_id > 0 AND en.id IS NULL
    GROUP BY te.competition_id, te.user_id""")
missing = cur.fetchall()
print(f"待补 (comp,user)：{len(missing)} 组")

# 窗口赛：存在个人窗口会话的比赛集合（补报名时间回溯到窗口 start_time）
cur.execute("SELECT DISTINCT competition_id FROM tournament_window_session")
window_comps = {r[0] for r in cur.fetchall()}
print(f"窗口赛 competition_id：{sorted(window_comps)}")

# ---------- 2. 逐组补齐 ----------
n_entry = n_tev = n_news = 0
for comp_id, user_id, first_score_ct in missing:
    # 报名时刻：窗口赛优先取该玩家最早的窗口 start_time（早于成绩动态才取，
    # 否则回退成绩动态时刻——防窗口先于成绩的异常数据把报名排在成绩后）
    entry_ct = first_score_ct
    if comp_id in window_comps:
        cur.execute(
            "SELECT MIN(start_time) FROM tournament_window_session"
            " WHERE competition_id=%s AND user_id=%s AND start_time <= %s",
            (comp_id, user_id, first_score_ct))
        row = cur.fetchone()
        if row and row[0]:
            entry_ct = row[0]
    # 幂等复查（dry-run 与 apply 之间库可能变化）
    cur.execute(
        "SELECT id FROM tournament_entry WHERE competition_id=%s AND user_id=%s",
        (comp_id, user_id))
    if cur.fetchone():
        continue
    print(f"  comp={comp_id} user={user_id} entry_ct={entry_ct}"
          f"{' (窗口回溯)' if entry_ct != first_score_ct else ''}")
    if DRY:
        continue
    cur.execute(
        "INSERT INTO tournament_entry (competition_id, user_id, create_time)"
        " VALUES (%s,%s,%s)", (comp_id, user_id, entry_ct))
    n_entry += 1
    # 比赛动态 type=2
    cur.execute(
        "INSERT INTO tournament_event (competition_id, type, user_id, create_time)"
        " VALUES (%s,2,%s,%s)", (comp_id, user_id, entry_ct))
    n_tev += 1
    # 个人动态 type=58（快照取当前值）
    cur.execute("SELECT exp_time FROM user_scores WHERE id=%s", (user_id,))
    row = cur.fetchone()
    exp_time = row[0] if row and row[0] is not None else 0
    cur.execute("SELECT status FROM user WHERE id=%s", (user_id,))
    row = cur.fetchone()
    ranked = 1 if row and row[0] == 0 else 0
    cur.execute(
        "INSERT INTO news (type, user, reference, details_data, exp_time, ranked, create_time)"
        " VALUES (58,%s,%s,'{}',%s,%s,%s)",
        (user_id, comp_id, exp_time, ranked, entry_ct))
    n_news += 1

if DRY:
    my.rollback()
    print(f"[dry-run] 不写入。预计补：entry {len(missing)} / 动态 {len(missing)}×2")
else:
    my.commit()
    print(f"[apply] 完成：entry {n_entry}、比赛动态 type=2 {n_tev}、个人动态 type=58 {n_news}")
    # 收敛断言：重扫应为 0
    cur.execute("""
        SELECT COUNT(*) FROM (
            SELECT DISTINCT te.competition_id, te.user_id
            FROM tournament_event te
            LEFT JOIN tournament_entry en
              ON en.competition_id = te.competition_id AND en.user_id = te.user_id
            WHERE te.type = 4 AND te.user_id > 0 AND en.id IS NULL) t""")
    print(f"收敛断言：残留无报名成绩组 = {cur.fetchone()[0]}（应为 0）")
