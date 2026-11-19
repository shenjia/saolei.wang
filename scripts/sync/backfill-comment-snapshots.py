#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""评论快照回填（2026-10-22 布衣 bug 修复·续）

与 backfill-bbs-snapshots.py 同根因同修法：comment 表快照缺失 451 行
（transform 历史存量 429 + merge-migration ingest 增量 22）。
按高级成绩流水重放（严格早于评论时刻的 running best），ranked=user.status==0。
用法：SAOLEI_DB_NAME=... python backfill-comment-snapshots.py [--apply] [--allow-nonlocal]
"""
import os
import sys

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

cur.execute("SELECT id, user, create_time FROM comment WHERE exp_time=0 AND ranked=0 ORDER BY id")
rows = cur.fetchall()
print(f"待修行: {len(rows)}")
if not rows:
    print("无需修复")
    sys.exit(0)

need = {r[1] for r in rows if r[1] > 0}
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

cur.execute("SELECT id, status FROM user")
user_status = dict(cur.fetchall())


def snapshot(user, ct):
    best = 0
    for fct, rt in records.get(user, []):
        if fct >= ct:
            break
        if best == 0 or rt < best:
            best = rt
    return best


updates = []
for cid, u, ct in rows:
    if u <= 0:
        continue
    exp = snapshot(u, ct or 0)
    ranked = 1 if user_status.get(u) == 0 else 0
    updates.append((exp, ranked, cid))
    if len(updates) <= 5:
        print(f"  sample comment#{cid} user={u} exp={exp} ranked={ranked}")

print(f"{'[dry-run] 将更新' if DRY else '更新'} {len(updates)} 行")
if DRY:
    sys.exit(0)

try:
    cur.executemany("UPDATE comment SET exp_time=%s, ranked=%s WHERE id=%s", updates)
    my.commit()
except Exception:
    my.rollback()
    raise

cur.execute("SELECT COUNT(*) FROM comment WHERE exp_time=0 AND ranked=0")
print(f"剩余快照缺失 {cur.fetchone()[0]}（应仅剩真·布衣）")
print("BACKFILL DONE")
