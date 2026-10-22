#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""合并迁移视频文件回填（2026-10-22）
来源：out-merge.jsonl（1467 条解析成功行）+ 本地镜像文件 /Users/shenjia/saolei-videos
回填：video.hash / video_info(filepath,signature,software,version,noflag,board,board_3bv)
      + user_sig 注册（对齐 2013 UserSig::register 语义）
      + video_scores_*_nf 归属修正（noflag 变化且 status=20）
口径与 Phase B import-videos.py 一致：只回填空缺字段，real_time 以库值为准。
用法：SAOLEI_DB_NAME=... python backfill-merge-videos.py [--allow-nonlocal]
     （hash 计算按文件内容 md5；filepath 改写为新站形态 /YYYY/M/D/<hash>.avf|mvf）
"""
import hashlib
import json
import os
import sys

import pymysql

OK_FILE = "/Users/shenjia/saolei-videos-sync/out-merge.jsonl"
VIDEO_ROOT = "/Users/shenjia/saolei-videos"
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

# ---------- 1. 读解析结果 ----------
results = {}
for line in open(OK_FILE, encoding="utf-8"):
    line = line.strip()
    if not line:
        continue
    r = json.loads(line)
    if r.get("ok"):
        results[r["id"]] = r
print(f"解析成功行: {len(results)}")

# ---------- 2. 目标库现状 ----------
ids = list(results)
ph = ",".join(["%s"] * len(ids))
cur.execute(f"""SELECT v.id, v.hash, v.status, v.level, v.user, v.create_time,
            vi.signature, vi.software, vi.version, vi.noflag, vi.board, vi.board_3bv, vi.real_time, vi.filepath
            FROM video v JOIN video_info vi ON vi.id=v.id
            WHERE v.id IN ({ph})""", ids)
rows = {r[0]: r for r in cur.fetchall()}
print(f"目标库在位: {len(rows)}")

import time
now = int(time.time())
fp_todo = []       # (id, hash, newpath, sig, sw, ver, nf, board, b3bv)
sig_register = {}   # user -> [(sig, ct)] 按时间序
nf_fix = []         # (id, level, nf) noflag 与解析不一致且 status=20

for vid, p in sorted(results.items()):
    row = rows.get(vid)
    if not row:
        continue
    (_, hash_v, status, level, user, ct, sig, sw, ver, nf, board, b3bv, rt, old_fp) = row
    # 本地镜像文件（旧站形态 /Video/Mvf/... → VIDEO_ROOT 下同名路径）
    local = VIDEO_ROOT + old_fp
    if not os.path.exists(local):
        continue
    with open(local, "rb") as f:
        data = f.read()
    h = hashlib.md5(data).hexdigest()
    ext = os.path.splitext(old_fp)[1].lower() or ".mvf"
    # 新站路径形态：/YYYY/M/D/<hash>.<ext>（按录像上传时间）
    import datetime
    dt = datetime.datetime.fromtimestamp(ct or now)
    newpath = f"/{dt.year}/{dt.month}/{dt.day}/{h}{ext}"

    p_sig = (p.get("sig") or "").strip()
    p_nf = 1 if p.get("nf") else 0
    p_board = p.get("board") or ""
    p_b3bv = p.get("b3bv") or 0

    fp_todo.append((vid, h, newpath,
                    sig or p_sig, sw or (p.get("sw") or ""), ver or (p.get("ver") or ""),
                    (nf if nf is not None and nf != "" else 0),  # noflag 已有值不覆盖（Phase B 同款）
                    board if board else p_board,
                    b3bv if b3bv else int(p_b3bv)))
    # noflag 变化修正（DB 空/0 但解析为 NF，或反之）——仅 status=20
    db_nf = int(nf or 0)
    if status == 20 and db_nf != p_nf:
        nf_fix.append((vid, level, p_nf))
    # user_sig 注册
    if p_sig and user:
        sig_register.setdefault(user, []).append((p_sig, ct or now))

print(f"待回填: {len(fp_todo)}；noflag 待修正: {len(nf_fix)}；user_sig 候选: {len(sig_register)}")

if DRY:
    print("[dry-run] 加 --apply 执行")
    sys.exit(0)

# ---------- 3. 回填 video + video_info ----------
for vid, h, newpath, sig, sw, ver, nf, board, b3bv in fp_todo:
    cur.execute("UPDATE video SET hash=%s, update_time=%s WHERE id=%s AND hash=''", (h, now, vid))
    cur.execute("""UPDATE video_info SET filepath=%s, signature=%s, software=%s, version=%s,
                board=%s, board_3bv=%s, update_time=%s
                WHERE id=%s AND (filepath LIKE '/Video/%%' OR signature='')""",
                (newpath, sig, sw, ver, board, b3bv, now, vid))
my.commit()
print(f"video/video_info 回填 {len(fp_todo)}")

# ---------- 4. noflag 修正 + _nf 表归属 ----------
for vid, level, p_nf in nf_fix:
    tbl = f"video_scores_{level}"
    if p_nf == 1:
        # 补进 _nf
        cur.execute(f"SELECT user, score_time, score_3bvs, create_time FROM `{tbl}` WHERE id=%s", (vid,))
        r = cur.fetchone()
        if r:
            cur.execute(f"""INSERT IGNORE INTO `{tbl}_nf` (id,user,score_time,score_3bvs,create_time)
                        VALUES (%s,%s,%s,%s,%s)""", (vid, r[0], r[1], r[2], r[3]))
        cur.execute("UPDATE video_info SET noflag=1 WHERE id=%s", (vid,))
    else:
        cur.execute(f"DELETE FROM `{tbl}_nf` WHERE id=%s", (vid,))
        cur.execute("UPDATE video_info SET noflag=0 WHERE id=%s", (vid,))
my.commit()
print(f"noflag 修正 {len(nf_fix)}")

# ---------- 5. user_sig 注册（对齐 2013 语义：按时间序查重注册） ----------
cur.execute("SELECT user, signature FROM user_sig")
existing = {(r[0], r[1]) for r in cur.fetchall()}
n_sig = 0
for user, items in sig_register.items():
    for sig, ct in sorted(items, key=lambda x: x[1]):
        if (user, sig) in existing:
            continue
        cur.execute("INSERT IGNORE INTO user_sig (user, signature, create_time, update_time) VALUES (%s,%s,%s,%s)",
                    (user, sig, ct, now))
        existing.add((user, sig))
        n_sig += 1
my.commit()
print(f"user_sig 注册 {n_sig}")
print("BACKFILL DONE")
