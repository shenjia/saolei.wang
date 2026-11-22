#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""窗口赛「点开赛无报名」存量补齐（2026-11-22，35598 案）

背景：
  /api/tournament/start 此前只创建窗口会话不补报名——玩家点开赛后、上传录像
  前（甚至始终未上传）没有任何报名动态。代码侧已修复（31e5e5c：开赛即
  ensureTourEntry），本脚本一次性补齐存量：凡 tournament_window_session 存在
  而 tournament_entry 缺失的 (comp,user) 组，按窗口 start_time 回溯补：
  · tournament_entry 行（create_time=最早窗口 start_time）
  · 比赛动态 tournament_event type=2「报名参加了比赛」
  · 个人动态 news type=58「报名参加了 XXX」（reference=比赛 id）
  与 ensureTourEntry / backfill-tour-entry.py 同口径；幂等（先查后插），重跑安全。

用法：
  python backfill-start-entry.py            # dry-run（只打印）
  python backfill-start-entry.py --apply    # 实际写入
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

# ---------- 1. 找出全部「点过开赛、无报名行」的 (comp, user) ----------
cur.execute("""
    SELECT ws.competition_id, ws.user_id, MIN(ws.start_time)
    FROM tournament_window_session ws
    LEFT JOIN tournament_entry en
      ON en.competition_id = ws.competition_id AND en.user_id = ws.user_id
    WHERE en.id IS NULL AND ws.user_id > 0
    GROUP BY ws.competition_id, ws.user_id""")
missing = cur.fetchall()
print(f"待补 (comp,user)：{len(missing)} 组")

# ---------- 2. 逐组补齐 ----------
n_entry = n_tev = n_news = 0
for comp_id, user_id, window_start in missing:
    entry_ct = window_start  # 报名时刻=窗口 start_time（点开赛的真实时刻）
    # 幂等复查（dry-run 与 apply 之间库可能变化）
    cur.execute(
        "SELECT id FROM tournament_entry WHERE competition_id=%s AND user_id=%s",
        (comp_id, user_id))
    if cur.fetchone():
        continue
    print(f"  comp={comp_id} user={user_id} entry_ct={entry_ct}")
    if DRY:
        continue
    cur.execute(
        "INSERT INTO tournament_entry (competition_id, user_id, create_time)"
        " VALUES (%s,%s,%s)", (comp_id, user_id, entry_ct))
    n_entry += 1
    # 比赛动态 type=2「报名参加了比赛」
    cur.execute(
        "INSERT INTO tournament_event (competition_id, type, user_id, create_time)"
        " VALUES (%s,2,%s,%s)", (comp_id, user_id, entry_ct))
    n_tev += 1
    # 个人动态 type=58（快照取当前值：补发无历史值可考，与 backfill-tour-entry 同口径）
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
            SELECT DISTINCT ws.competition_id, ws.user_id
            FROM tournament_window_session ws
            LEFT JOIN tournament_entry en
              ON en.competition_id = ws.competition_id AND en.user_id = ws.user_id
            WHERE en.id IS NULL AND ws.user_id > 0) t""")
    print(f"收敛断言：残留开赛无报名组 = {cur.fetchone()[0]}（应为 0）")
