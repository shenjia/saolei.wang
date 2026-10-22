#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""video + news 快照回填（2026-10-22 布衣 bug 修复·终章）

快照制三张 UGC 表剩余缺口（BBS/评论已修）：
  video：1,042 行（transform 存量 + merge ingest 的 703 行 INSERT 漏快照列）
  news：134 行（type=20 破纪录 123 / type=40 论坛 10 / type=30 首盘 1）
修法统一：高级成绩流水重放。
  - video 行快照 = 按其 create_time 重放（该录像自身的成绩在「严格早于」语义下
    不计入——上传时刻展示的是上一成绩的军衔，与新站写入路径一致）
  - news 行快照 = 按 create_time 重放；type=20 破纪录用「含同刻」——
    动态展示破纪录后的新军衔（news-delta INCLUSIVE 同款：{10,53} 语义中
    破纪录实为严格早于，但旧站惯例与新站 review.ts 均取 original.expTime
    即破之前军衔——遵循新站：严格早于）
用法：SAOLEI_DB_NAME=... python backfill-video-news-snapshots.py [--apply] [--allow-nonlocal]
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

# ---------- 收集待修行 ----------
cur.execute("SELECT id, user, create_time FROM video WHERE exp_time=0 AND ranked=0")
v_rows = cur.fetchall()
cur.execute("SELECT id, user, create_time FROM news WHERE exp_time=0 AND ranked=0 AND type IN (20,30,40)")
n_rows = cur.fetchall()
print(f"video 待修 {len(v_rows)}；news 待修 {len(n_rows)}")

need = {r[1] for r in v_rows} | {r[1] for r in n_rows}
need = {u for u in need if u and u > 0}

# ---------- 高级成绩流水（全量一次取） ----------
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


def snapshot_before(user, ct):
    """严格早于 ct 的 running best（新站写入路径同语义）"""
    best = 0
    for fct, rt in records.get(user, []):
        if fct >= ct:
            break
        if best == 0 or rt < best:
            best = rt
    return best


def ranked_of(user):
    return 1 if user_status.get(user) == 0 else 0


v_updates = []
for vid, u, ct in v_rows:
    if not u or u <= 0:
        continue
    v_updates.append((snapshot_before(u, ct or 0), ranked_of(u), vid))

n_updates = []
for nid, u, ct in n_rows:
    if not u or u <= 0:
        continue
    n_updates.append((snapshot_before(u, ct or 0), ranked_of(u), nid))

print(f"{'[dry-run] 将更新' if DRY else '更新'} video {len(v_updates)} + news {len(n_updates)}")
for t, exp, rk in [("video-sample", *v_updates[0][:2]) if v_updates else ("none", 0, 0)]:
    print(f"  sample {t} exp={exp} ranked={rk}")
if DRY:
    sys.exit(0)

try:
    if v_updates:
        cur.executemany("UPDATE video SET exp_time=%s, ranked=%s WHERE id=%s", v_updates)
    if n_updates:
        cur.executemany("UPDATE news SET exp_time=%s, ranked=%s WHERE id=%s", n_updates)
    my.commit()
except Exception:
    my.rollback()
    raise

cur.execute("SELECT COUNT(*) FROM video WHERE exp_time=0 AND ranked=0")
v_left = cur.fetchone()[0]
cur.execute("SELECT COUNT(*) FROM news WHERE exp_time=0 AND ranked=0 AND type IN (20,30,40)")
n_left = cur.fetchone()[0]
print(f"剩余缺失 video {v_left} / news {n_left}（应仅剩真·布衣/无成绩）")
print("BACKFILL DONE")
