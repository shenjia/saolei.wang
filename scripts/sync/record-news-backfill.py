#!/usr/bin/env python3
"""破纪录动态回填（2026-10-16 张老师指令）：为解禁的原封禁用户补齐缺失的 type=20 个人纪录动态

背景：封禁用户在旧站封禁期间上传的录像不生成动态，同步后其名下 type=20 空缺
（如 13688 钟言只有回填的晋升动态）；解禁后记录/军衔已恢复，破纪录历史动态需补齐。
部分用户（366/2747）封禁前的旧站动态已随同步带入，属完整覆盖——本脚本幂等跳过。

规则（与 src/lib/review.ts 新站口径严格一致）：
  - 按用户重放 video_scores_{beg,int,exp} 流水（仅 status=20 录像，(create_time, video id) 序）；
  - time 维：score_time>0 且优于当前最优 → 事件 {lv, od:'time', or=旧最优(无则0), cr=新值}；
  - 3bvs 维：score_3bvs>0 且优于当前最优 → 事件 {lv, od:'3bvs', ...}；
  - user_score = 该盘更新后三级最优时间之和（三级不全则 0，与 user_scores.sum_time 口径一致）；
  - reference = 录像 id；nf 恒 0（NF 榜不发动态）；
  - 不补入伍动态（「老用户不补历史注册动态」铁律）；
  - 幂等：按 (user, create_time, lv, od) 跳过已存在的 type=20 行（旧站同步来的历史行原样不动）。

排序铁律：news.id 序 = create_time 序 → 尾部合并重排（同 promotion-backfill：
cut=新事件最小时间，删 create_time>=cut 尾部行，与新事件合并按时间重排重插；同刻原行在前）。

用法: python3 scripts/sync/record-news-backfill.py [--apply]   默认 dry-run
连接：默认本地 root@127.0.0.1:3306/saolei；SAOLEI_DB_HOST/PORT/USER/PASSWORD 覆盖
（写生产走 3316 隧道 + --allow-nonlocal；生产不建 schema 外备份表，回滚靠 mysqldump 文件）。
"""
import json
import os
import sys
from collections import defaultdict
from datetime import datetime

import pymysql

DRY = "--apply" not in sys.argv
NONLOCAL = bool(os.environ.get("SAOLEI_DB_PORT")) and os.environ["SAOLEI_DB_PORT"] != "3306"
if NONLOCAL and "--allow-nonlocal" not in sys.argv and not DRY:
    print("目标库非本地 3306，写入需显式 --allow-nonlocal")
    sys.exit(2)

# 目标用户：解禁的 18 人去掉窦何 12203（2026-10-16 查实为周科小号，录像已重新封禁）
USERS = [2687, 2747, 366, 5775, 7135, 9599, 9689, 10552, 12710, 13324,
         13606, 14398, 16013, 15568, 13688, 31152, 34017]
LEVELS = ("beg", "int", "exp")
BATCH = 5000

my = pymysql.connect(
    host=os.environ.get("SAOLEI_DB_HOST", "127.0.0.1"),
    port=int(os.environ.get("SAOLEI_DB_PORT", "3306")),
    user=os.environ.get("SAOLEI_DB_USER", "root"),
    password=os.environ.get("SAOLEI_DB_PASSWORD", ""),
    database=os.environ.get("SAOLEI_DB_NAME", "saolei"),
    charset="utf8mb4", autocommit=False)
cur = my.cursor()

PH = ",".join(["%s"] * len(USERS))

# ---------- 0. 已有 type=20 行（幂等键） ----------
cur.execute(f"SELECT user, create_time, details_data FROM news WHERE type=20 AND user IN ({PH})",
            USERS)
existing = set()
for u, ct, dd in cur.fetchall():
    try:
        d = json.loads(dd or "{}")
        existing.add((int(u), int(ct), str(d.get("lv")), str(d.get("od"))))
    except Exception:
        pass
print(f"目标用户已有 type=20 行（幂等键）: {len(existing)}")

# ---------- 1. 流水重放（仅 status=20 录像） ----------
flows = []  # (ct, user, vid, lv, score_time, score_3bvs)
for lvl in LEVELS:
    cur.execute(f"""SELECT f.id, f.user, f.score_time, f.score_3bvs, f.create_time
                 FROM video_scores_{lvl} f JOIN video v ON v.id = f.id AND v.status = 20
                 WHERE f.user IN ({PH})""", USERS)
    rows = cur.fetchall()
    print(f"video_scores_{lvl} 流水（status=20）: {len(rows)} 行")
    for vid, u, st, sb, ct in rows:
        flows.append(((ct or 0), int(u), int(vid), lvl, st or 0, sb or 0))
flows.sort()  # (ct, user, vid) —— 同用户同刻按录像 id

best_time = {}   # (user, lv) -> 最优时间 ms
best_3bvs = {}   # (user, lv) -> 最优 3bvs
replay = []      # (ct, user, vid, lv, od, orv, crv, user_score)
pending = []     # 同一盘录像的多个事件，结算时统一附 user_score
last_key = None
for ct, u, vid, lvl, st, sb in flows:
    if last_key is not None and (u, ct, vid) != last_key:
        times = [best_time.get((last_key[0], l), 0) for l in LEVELS]
        us = sum(times) if all(times) else 0
        replay.extend(e + (us,) for e in pending)
        pending = []
    last_key = (u, ct, vid)
    if st > 0 and ((u, lvl) not in best_time or st < best_time[(u, lvl)]):
        orv = best_time.get((u, lvl), 0)
        best_time[(u, lvl)] = st
        pending.append((ct, u, vid, lvl, "time", orv, st))
    if sb > 0 and ((u, lvl) not in best_3bvs or sb > best_3bvs[(u, lvl)]):
        orv = best_3bvs.get((u, lvl), 0)
        best_3bvs[(u, lvl)] = sb
        pending.append((ct, u, vid, lvl, "3bvs", orv, sb))
if pending:
    times = [best_time.get((last_key[0], l), 0) for l in LEVELS]
    us = sum(times) if all(times) else 0
    replay.extend(e + (us,) for e in pending)

final_events = [e for e in replay if (e[1], e[0], e[3], e[4]) not in existing]
skipped = len(replay) - len(final_events)
print(f"重放破纪录事件: {len(replay)}；已有跳过: {skipped}；待补: {len(final_events)}")
by_user = defaultdict(int)
for e in final_events:
    by_user[e[1]] += 1
for u in USERS:
    if by_user.get(u):
        print(f"  user={u}: {by_user[u]} 条")
if not final_events:
    print("无待补事件，退出。")
    sys.exit(0)

cut = min(e[0] for e in final_events)
print(f"cut={cut}（{datetime.fromtimestamp(cut)}）")

# ---------- 2. 尾部合并重排 ----------
cur.execute("""SELECT id, type, user, user_score, reference, details_data, create_time
            FROM news WHERE create_time >= %s ORDER BY id""", (cut,))
tail = list(cur.fetchall())
print(f"尾部原行（create_time >= cut）: {len(tail)} 条")
if len(tail) > 300000 and "--force" not in sys.argv:
    print("[中止] 尾部行数异常大，未写库。检查后加 --force 重跑。")
    sys.exit(2)

merged = []
for ct, u, vid, lv, od, orv, crv, us in final_events:
    dd = json.dumps({"lv": lv, "od": od, "or": str(orv), "cr": str(crv), "nf": 0},
                    separators=(",", ":"))
    merged.append((ct, None, 20, u, us, vid, dd))
for nid, ntype, u, us, ref, dd, ct in tail:
    merged.append((ct, nid, ntype, u, us, ref, dd))
# 同刻：原行在前，新事件在后
merged.sort(key=lambda e: (e[0], e[1] if e[1] is not None else (1 << 62)))

if DRY:
    print("\n[sample] 待补动态前 12 条：")
    shown = 0
    for e in merged:
        if e[1] is None and shown < 12:
            print(f"  {datetime.fromtimestamp(e[0]).strftime('%Y-%m-%d %H:%M')} user={e[3]} ref={e[5]} {e[6][:70]}")
            shown += 1
    print("\n[dry-run] 未写库。确认后加 --apply 执行。")
    sys.exit(0)

# ---------- 3. 尾部替换 ----------
if NONLOCAL:
    print("[生产] 不建 schema 外备份表；回滚靠服务器侧 mysqldump 备份文件。")
else:
    backup = "news_backup_record_" + datetime.now().strftime("%Y%m%d")
    cur.execute(f"DROP TABLE IF EXISTS {backup}")
    cur.execute(f"CREATE TABLE {backup} AS SELECT * FROM news")
    print(f"已备份 news -> {backup}")

cur.execute("DELETE FROM news WHERE create_time >= %s", (cut,))
print(f"已删尾部 {cur.rowcount} 行")

ins = 0
for i in range(0, len(merged), BATCH):
    batch = [(ntype, ct, u, us, ref, dd) for ct, lid, ntype, u, us, ref, dd in merged[i:i + BATCH]]
    cur.executemany(
        "INSERT INTO news (type, create_time, user, user_score, reference, details_data) VALUES (%s,%s,%s,%s,%s,%s)",
        batch)
    ins += len(batch)
my.commit()
print(f"[apply] 已重插 {ins} 行")

# ---------- 4. 校验 ----------
cur.execute("SELECT COUNT(*) FROM news")
cnt = cur.fetchone()[0]
cur.execute("SELECT COUNT(*) FROM news a JOIN news b ON b.id=a.id+1 WHERE b.create_time < a.create_time")
inv = cur.fetchone()[0]
print(f"校验: 总数 {cnt}；id↔时间逆序行 {inv}（应为 0）")
assert inv == 0, "存在 id 序与时间序不一致"
print("DONE")
my.close()
