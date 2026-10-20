#!/usr/bin/env python3
"""news 破纪录动态时间改回录像上传时间（2026-10-20 张老师拍板）

背景：2026-10-19 方案 B（b83e20e）把运行时破纪录动态（review.ts publishNews type=20）
的 createTime 从 rv.createTime（录像上传时间）改成 rv.reviewTime（审核时间），动机是保
「id 序=create_time 序」铁律；张老师 10-20 再定：一批补审的动态时间全挤在过审时刻不可
接受，改回上传时间，动态流排序改 (create_time,id) 倒序（不再依赖 id 序）。

写入点已改回 rv.createTime；本脚本修正存量：10-19 news-timesort-fix.py 改过 create_time
的行（判别器同款：type=20 且 details 的 cr 为数字=新站运行时行）以及 10-19~10-20 期间
新产生的 type=20 行，create_time 一律改回 video.create_time（录像上传时间）。

注意：本脚本不改 id、不重排——10-20 起排序按 (create_time,id)，id 序与时间序解耦。
幂等：create_time=video.create_time 后不再命中（判别条件 create_time<>video.create_time）。

用法: python3 scripts/sync/news-uploadtime-restore.py [--apply]   默认 dry-run
生产: SAOLEI_DB_* env（3316 隧道）+ --allow-nonlocal；先服务器侧 mysqldump 备份再执行。
"""
import os
import sys
from datetime import datetime

import pymysql

DRY = "--apply" not in sys.argv
NONLOCAL = bool(os.environ.get("SAOLEI_DB_PORT")) and os.environ["SAOLEI_DB_PORT"] != "3306"
if NONLOCAL and "--allow-nonlocal" not in sys.argv and not DRY:
    print("目标库非本地 3306，写入需显式 --allow-nonlocal")
    sys.exit(2)

my = pymysql.connect(
    host=os.environ.get("SAOLEI_DB_HOST", "127.0.0.1"),
    port=int(os.environ.get("SAOLEI_DB_PORT", "3306")),
    user=os.environ.get("SAOLEI_DB_USER", "root"),
    password=os.environ.get("SAOLEI_DB_PASSWORD", ""),
    database=os.environ.get("SAOLEI_DB_NAME", "saolei"),
    charset="utf8mb4", autocommit=False)
cur = my.cursor()

# ---------- 1. 找出需修正的行：新站运行时 type=20 且 create_time ≠ 录像上传时间 ----------
cur.execute("""SELECT n.id, n.create_time, v.create_time AS upload_time, v.review_time, n.user, n.reference
            FROM news n JOIN video v ON v.id = n.reference
            WHERE n.type = 20 AND n.details_data REGEXP '"cr":[0-9]'
              AND n.create_time <> v.create_time""")
rows = list(cur.fetchall())
print(f"新站运行时 type=20 行（cr 数字）中 create_time≠录像上传时间：{len(rows)} 行")
for nid, nct, vct, vrt, u, ref in rows[:30]:
    mark = "审→传" if nct == vrt else "?"
    print(f"  news={nid} {datetime.fromtimestamp(nct)} -> {datetime.fromtimestamp(vct)} "
          f"({mark}, user={u} video={ref})")
assert len(rows) < 200, "待修正行数异常，中止人工核查"

if not rows:
    print("\n无待修正行，退出。")
    sys.exit(0)

if DRY:
    print(f"\n[dry-run] 将 UPDATE {len(rows)} 行 create_time = video.create_time（上传时间）。未写库。")
    sys.exit(0)

# ---------- 2. 修正 ----------
for nid, nct, vct, vrt, u, ref in rows:
    cur.execute("UPDATE news SET create_time = %s WHERE id = %s", (vct, nid))
my.commit()
print(f"[apply] 已修正 {len(rows)} 行 create_time = 录像上传时间")

# ---------- 3. 校验：无残留 ----------
cur.execute("""SELECT COUNT(*) FROM news n JOIN video v ON v.id = n.reference
            WHERE n.type = 20 AND n.details_data REGEXP '"cr":[0-9]'
              AND n.create_time <> v.create_time""")
left = cur.fetchone()[0]
assert left == 0, f"仍有 {left} 行未修正"
print(f"校验: 新站 type=20 行 create_time 全部等于录像上传时间 ✓")
print("DONE")
my.close()
