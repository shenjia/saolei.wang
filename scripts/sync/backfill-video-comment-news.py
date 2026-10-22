#!/usr/bin/env python3
"""录像评论动态回填录像信息快照（2026-10-22 张老师要求：存量动态也要渲染「评论了yyy的高级40.44NF录像」）

背景：2026-10-22 d9980fd 起 addComment 写入点把 lv（级别）/tm（成绩）/nf（NF）/vn（楼主名）
快照进 details；此前的存量行只有 {"kind":"video","cid":N}，渲染退回「评论了一盘录像」。
本脚本为存量行补齐快照——数据取当前 video/video_info/user 行（录像信息不可变，回填即当年值）。

规则：
  · 只补 details 无 "lv" 键的行（幂等：补过后不再命中）
  · 键序固定 kind,lv,tm,nf,vn,cid——cid 必须尾置（AI 复审/删除联动按 "cid":<id>} 尾缀精确匹配）
  · 录像已不存在/评论已删的行跳过（属孤儿动态，归 news-orphan-clean.py 管）

用法: python3 scripts/sync/backfill-video-comment-news.py [--apply]   默认 dry-run
生产: SAOLEI_DB_* env（3316 隧道）+ --allow-nonlocal；先服务器侧 mysqldump 备份再执行。
"""
import json
import os
import sys

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

cur.execute("""
  SELECT n.id, n.user, n.reference, n.details_data FROM news n
  WHERE n.type = 52
    AND (n.details_data LIKE '%"kind":"video"%' OR n.details_data NOT LIKE '%"kind":%')
    AND n.details_data NOT LIKE '%"lv"%'
""")
rows = list(cur.fetchall())
print(f"待回填（kind=video 且无 lv 快照）：{len(rows)} 行")

updated = 0
skipped = []
for nid, user, ref, dd in rows:
    try:
        d = json.loads(dd) if dd else {}
    except ValueError:
        skipped.append((nid, "details 非法 JSON"))
        continue
    cur.execute(
        "SELECT v.level, v.user, vi.noflag, vi.real_time FROM video v "
        "JOIN video_info vi ON vi.id = v.id WHERE v.id = %s", (ref,))
    v = cur.fetchone()
    if not v:
        skipped.append((nid, f"录像 {ref} 不存在（孤儿动态，归 orphan-clean 管）"))
        continue
    level, owner, noflag, real_time = v
    cur.execute("SELECT chinese_name FROM user WHERE id = %s", (owner,))
    u = cur.fetchone()
    owner_name = (u[0] if u else "")[:20]
    new_dd = json.dumps(
        {"kind": "video", "lv": level or "", "tm": int(real_time or 0),
         "nf": 1 if noflag else 0, "vn": owner_name, "vid": int(owner),
         "cid": int(d.get("cid", 0))},
        ensure_ascii=False, separators=(",", ":"))
    print(f"  news={nid} user={user} video={ref} lv={level} tm={real_time} nf={noflag} vn={owner_name}")
    if not DRY:
        cur.execute("UPDATE news SET details_data = %s WHERE id = %s", (new_dd, nid))
        updated += cur.rowcount

if skipped:
    print("跳过：")
    for nid, why in skipped[:20]:
        print(f"  news={nid} {why}")

if DRY:
    print(f"\n[dry-run] 将回填 {len(rows) - len(skipped)} 行。未写库。")
    my.rollback()
else:
    my.commit()
    print(f"\n完成：回填 {updated} 行。")
my.close()
