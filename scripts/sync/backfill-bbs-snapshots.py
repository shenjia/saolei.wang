#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""BBS 快照回填（2026-10-22 布衣 bug 修复）

背景：称号快照制（2026-10-17）要求 UGC 行内嵌 exp_time/ranked 快照。
两批行漏写：
  1. merge-migration.py ingest 段写旧站增量 BBS 行时 INSERT 列表漏了快照列
  2. 历史同步（transform）时代的更早存量行同样为 0（快照制改造漏网）
合计 17 帖 + 46 回帖 = 63 行，页面全部显示「布衣/预备役」。

修复：按「高级成绩流水重放」重建快照（与 news-delta.py 第 3 段同款）：
  - 取该用户全部 status=20 高级录像的 (create_time, real_time)
  - 快照 = 发帖时刻（严格早于，不含同刻）的 running best
  - ranked = user.status == 0（当前态快照，与 news-delta 同口径）

用法：SAOLEI_DB_NAME=... python backfill-bbs-snapshots.py [--apply] [--allow-nonlocal]
"""
import os
import sys
import time

import pymysql

DRY = "--apply" not in sys.argv

if not DRY:
    host = os.environ.get("SAOLEI_DB_HOST", "127.0.0.1")
    port = os.environ.get("SAOLEI_DB_PORT", "3306")
    if (host, port) != ("127.0.0.1", "3306") and "--allow-nonlocal" not in sys.argv:
        sys.exit("非本地库写入门禁：需 --allow-nonlocal")

my = pymysql.connect(
    host=os.environ.get("SAOLEI_DB_HOST", "127.0.0.1"),
    port=int(os.environ.get("SAOLEI_DB_PORT", "3306")),
    user=os.environ.get("SAOLEI_DB_USER", "root"),
    password=os.environ.get("SAOLEI_DB_PASSWORD", ""),
    database=os.environ.get("SAOLEI_DB_NAME", "saolei"),
    charset="utf8mb4", autocommit=False)
cur = my.cursor()

# ---------- 1. 待修行 ----------
rows = []  # (table, id, user, create_time)
for table in ("bbs_post", "bbs_reply"):
    cur.execute(f"""SELECT id, user, create_time FROM `{table}`
                 WHERE exp_time = 0 AND ranked = 0 ORDER BY id""")
    for vid, u, ct in cur.fetchall():
        rows.append((table, vid, u, ct or 0))
print(f"待修行: {len(rows)}（post {sum(1 for r in rows if r[0]=='bbs_post')} / "
      f"reply {sum(1 for r in rows if r[0]=='bbs_reply')}）")
if not rows:
    print("无需修复")
    sys.exit(0)

# ---------- 2. 成绩流水 ----------
need = {r[2] for r in rows if r[2] > 0}
records = {}
if need:
    ph = ",".join(["%s"] * len(need))
    cur.execute(f"""SELECT v.user, vi.real_time, v.create_time
                 FROM video v JOIN video_info vi ON vi.id = v.id
                 WHERE v.status = 20 AND v.level = 'exp' AND vi.real_time > 0
                   AND v.user IN ({ph}) ORDER BY v.create_time, v.id""", tuple(need))
    for u, rt, ct in cur.fetchall():
        records.setdefault(u, []).append((ct or 0, rt))
for lst in records.values():
    lst.sort()

# ranked 快照：当前 user.status（news-delta 同口径）
cur.execute("SELECT id, status FROM user")
user_status = dict(cur.fetchall())


def snapshot(user, ct):
    """严格早于 ct 的 running best（同刻不含——BBS 行本身不是成绩事件）"""
    best = 0
    for fct, rt in records.get(user, []):
        if fct >= ct:
            break
        if best == 0 or rt < best:
            best = rt
    return best


# ---------- 3. 生成更新 ----------
updates = []
for table, vid, u, ct in rows:
    if u <= 0:
        continue
    exp = snapshot(u, ct)
    ranked = 1 if user_status.get(u) == 0 else 0
    updates.append((table, vid, exp, ranked))
    if len(updates) <= 5:
        print(f"  sample {table}#{vid} user={u} exp={exp} ranked={ranked}")

if DRY:
    print(f"[dry-run] 将更新 {len(updates)} 行；加 --apply 执行")
    sys.exit(0)

ts = int(time.time())
try:
    for table, vid, exp, ranked in updates:
        if table == "bbs_post":
            cur.execute("UPDATE bbs_post SET exp_time=%s, ranked=%s, update_time=update_time WHERE id=%s",
                        (exp, ranked, vid))
        else:
            cur.execute("UPDATE bbs_reply SET exp_time=%s, ranked=%s, update_time=update_time WHERE id=%s",
                        (exp, ranked, vid))
    my.commit()
except Exception:
    my.rollback()
    raise

# 终验
n_left = 0
for table in ("bbs_post", "bbs_reply"):
    cur.execute(f"SELECT COUNT(*) FROM `{table}` WHERE exp_time=0 AND ranked=0")
    n_left += cur.fetchone()[0]
print(f"更新 {len(updates)} 行；剩余快照缺失 {n_left}（应仅剩布衣语义的正确行，如 user<=0 或确无成绩者）")
print("BACKFILL DONE")
