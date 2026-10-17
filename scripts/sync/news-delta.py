#!/usr/bin/env python3
"""news 增量同步：旧站新产生的动态 + 新数据派生的历史动态，尾部合并重排

背景：transform.py 的 news 段是非幂等一次性段（插过就跳过），本次为「上线后增量」，
不能整表重灌（新站已产生 40/50/52 等动态，且 id 已被本地引用），故只对尾部做合并：

  1. 采集新增事件
     - type 20 纪录：staging News（>2013-10-23 基线）中本地不存在的 (reference, od) 键
     - type 10 入伍：新用户在 staging 录像中凑齐三级别的时刻（本地已有 type=10 的用户跳过）
     - type 50 加入扫雷网：本地 user 中尚无 type=50 动态的用户（event = user.create_time）
     - type 30 首盘上传：每个 (user, level) 的首盘已通过录像，本地 type=30 中不存在的 pair
     - type 40 论坛文章：bbs_post(status=0) 中本地 type=40 引用里不存在的帖
  2. tail 合并：cut = min(新事件时间)，删除 news 中 create_time >= cut 的尾部行，
     与新增事件一起按 (create_time, 原行优先) 重排后重插
     → 保「id 序 = create_time 序」铁律（前端游标分页依赖）
  3. 快照（2026-10-17 称号快照制）：新增行 exp_time 按高级成绩流水重放
     （入伍/晋升含同刻、其余严格早于，与 backfill-title-snapshot.py 同口径）；
     尾部原行的 exp_time/ranked 原样保留

用法: python3 scripts/sync/news-delta.py [--apply]   默认 dry-run

连接（2026-10-15 支持生产）：源库 staging 走 SAOLEI_STG_*；目标库（新站）走
SAOLEI_DB_*（写生产走 3316 隧道 + --allow-nonlocal）。
⚠️ 生产禁建 schema 外表：--apply 时不再建 news_backup_* 表——生产侧备份用
mysqldump 到服务器文件。--include-soft：旧站派生事件（30/40/50）早于上次同步的
也并入（本次生产补 10-13 增量时需要：295 条事件全部早于生产 max create_time）。
"""
import json
import os
import sys
from collections import defaultdict

import pymysql

SENTINEL = 998000  # 999.99s 无成绩哨兵(t_ms=998990)
NEWS_BASELINE = "2013-10-23 08:23:46"
LEVELS = ("beg", "int", "exp")
BATCH = 5000

DRY = "--apply" not in sys.argv
NONLOCAL = bool(os.environ.get("SAOLEI_DB_PORT")) and os.environ["SAOLEI_DB_PORT"] != "3306"
if NONLOCAL and "--allow-nonlocal" not in sys.argv and not DRY:
    print("目标库非本地 3306，写入需显式 --allow-nonlocal")
    sys.exit(2)
INCLUDE_SOFT = "--include-soft" in sys.argv

my = pymysql.connect(
    host=os.environ.get("SAOLEI_DB_HOST", "127.0.0.1"),
    port=int(os.environ.get("SAOLEI_DB_PORT", "3306")),
    user=os.environ.get("SAOLEI_DB_USER", "root"),
    password=os.environ.get("SAOLEI_DB_PASSWORD", ""),
    database=os.environ.get("SAOLEI_DB_NAME", "saolei"),
    charset="utf8mb4", autocommit=False)
stg = pymysql.connect(
    host=os.environ.get("SAOLEI_STG_HOST", "127.0.0.1"),
    port=int(os.environ.get("SAOLEI_STG_PORT", "3306")),
    user=os.environ.get("SAOLEI_STG_USER", "root"),
    password=os.environ.get("SAOLEI_STG_PASSWORD", ""),
    database=os.environ.get("SAOLEI_STG_NAME", "saolei_mssql"),
    charset="utf8mb4", autocommit=True)
cur, sc = my.cursor(), stg.cursor()

TZ_OFFSET = 8 * 3600
_EPOCH_SHIFT = 8 * 3600


def ux(dt):
    """MSSQL datetime(北京时间) -> unix 秒（口径：naive datetime 视为 +08:00）"""
    if dt is None:
        return 0
    from datetime import datetime
    return int((dt - datetime(1970, 1, 1)).total_seconds() - _EPOCH_SHIFT)


# ---------- 0. 本地现状 ----------
cur.execute("SELECT COALESCE(MAX(create_time), 0) FROM news")
local_max_ct = cur.fetchone()[0]
print(f"本地 news 最大 create_time = {local_max_ct}（{__import__('datetime').datetime.fromtimestamp(local_max_ct)}）")

cur.execute("SELECT reference, details_data FROM news WHERE type=20")
seen_rec = set()
for ref, dd in cur.fetchall():
    try:
        od = json.loads(dd or "{}").get("od") or ""
    except Exception:
        od = ""
    seen_rec.add((ref, od))
print(f"本地已有纪录动态键: {len(seen_rec)}")

cur.execute("SELECT DISTINCT user FROM news WHERE type=10")
has_newbie = {r[0] for r in cur.fetchall()}
cur.execute("SELECT DISTINCT user FROM news WHERE type=50")
has_join = {r[0] for r in cur.fetchall()}
cur.execute("SELECT user, details_data FROM news WHERE type=30")
has_first = set()
for u, dd in cur.fetchall():
    try:
        has_first.add((u, json.loads(dd or "{}").get("lv")))
    except Exception:
        pass
cur.execute("SELECT reference FROM news WHERE type=40")
has_post = {r[0] for r in cur.fetchall()}
print(f"本地已有动态: 入伍={len(has_newbie)} 注册={len(has_join)} 首盘={len(has_first)} 论坛={len(has_post)}")

# ---------- 1. 采集新增事件 ----------
events = []  # (create_time, legacy, type, user, reference, details_data)
# legacy=None 表示新增行；否则为尾部原行的 (id, 内容) 元组

# 1a. 旧站纪录动态（注意：News 结果必须先物化，否则会被同一游标的下一条查询顶掉）
sc.execute("""SELECT News_Id, News_Time, News_Video, News_Player, News_Model, News_Thing,
            News_Score, News_Grow FROM News
            WHERE News_IsLive=1 AND News_Time > %s ORDER BY News_Id""", (NEWS_BASELINE,))
news_rows = sc.fetchall()
print(f"staging News 候选行: {len(news_rows)}")
lv_map = {"初级": "beg", "中级": "int", "高级": "exp"}


def t_ms(score):
    return int((score - 1.0) * 1000 + 0.5)


def b_x1000(score):
    return int(score * 1000 + 0.5)


sc.execute("SELECT Video_Id FROM Video")
stage_vids = {r[0] for r in sc.fetchall()}
new_rec = 0
seen_new = set()
for nid, ntime, nvideo, nplayer, nmodel, nthing, nscore, ngrow in news_rows:
    lv = lv_map.get(nmodel or "")
    if lv is None or nvideo not in stage_vids:
        continue
    od = "time" if nthing == "时间" else "3bvs"
    if (nvideo, od) in seen_rec or (nvideo, od) in seen_new:
        continue
    seen_new.add((nvideo, od))
    if od == "time":
        cr = t_ms(nscore)
        org = t_ms(nscore + (ngrow or 0)) if ngrow else 0
    else:
        cr = b_x1000(nscore)
        org = b_x1000(nscore - (ngrow or 0)) if ngrow else 0
        if org < 0:
            org = 0
    dd = json.dumps({"lv": lv, "od": od, "or": str(org), "cr": str(cr), "nf": 0}, separators=(",", ":"))
    events.append((ux(ntime), None, 20, nplayer, nvideo, dd))
    new_rec += 1
print(f"新增纪录动态: {new_rec}")

# 1b. 入伍动态（新用户凑齐三级别）
sc.execute("SELECT Video_Id, Video_Model, Video_Player, Video_Time, Video_IsLive FROM Video")
by_user = defaultdict(list)
for vid, model, player, vtime, islive in sc.fetchall():
    lv = (model or "").lower()
    if lv in LEVELS and islive:
        by_user[player].append((ux(vtime) or 0, vid, lv))
new_newbie = 0
for player, vs in by_user.items():
    if player in has_newbie:
        continue
    lvset = set(lv for _, _, lv in vs)
    if len(lvset) != 3:
        continue
    third = max(min(t for t, _, lv in vs if lv == L) for L in LEVELS)
    events.append((third, None, 10, player, 0, "[]"))
    new_newbie += 1
print(f"新增入伍动态: {new_newbie}")

# 1c. 加入扫雷网（本地 user 中无 type=50 的）
cur.execute("SELECT id, create_time FROM user")
new_join = 0
for uid, ct in cur.fetchall():
    if uid in has_join or not ct:
        continue
    events.append((ct, None, 50, uid, 0, "{}"))
    new_join += 1
print(f"新增注册动态: {new_join}")

# 1d. 首盘上传（每 user 每 level 首盘 status=20）
cur.execute("""SELECT v.user, v.level, v.id, v.create_time, i.real_time, i.board_3bv
            FROM video v JOIN video_info i ON i.id=v.id
            WHERE v.status=20 AND v.create_time>0 ORDER BY v.create_time""")
first_video = {}
for u, lvl, vid, ct, rt, bv in cur.fetchall():
    key = (u, lvl)
    if key not in first_video and key not in has_first:
        first_video[key] = (ct, vid, rt, bv)
new_first = 0
for (u, lvl), (ct, vid, rt, bv) in first_video.items():
    tm = rt if rt and rt > 0 else 0
    bv_score = (bv * 1000000 // rt) if rt and rt > 0 else 0
    dd = '{"lv":"%s","tm":%d,"bv":%d}' % (lvl, tm, max(bv_score, 0))
    events.append((ct, None, 30, u, vid, dd))
    new_first += 1
print(f"新增首盘上传动态: {new_first}")

# 1e. 论坛文章
cur.execute("SELECT id, user, create_time, title FROM bbs_post WHERE status=0")
new_post = 0
for pid, u, ct, title in cur.fetchall():
    if pid in has_post:
        continue
    t = (title or "")[:50].replace("\\", "\\\\\\\\").replace('"', '\\\\"')
    events.append((ct or 0, None, 40, u, pid, '{"t":"%s"}' % t))
    new_post += 1
print(f"新增论坛动态: {new_post}")

if not events:
    print("\n无新增事件，无需处理。")
    sys.exit(0)

cut = min(e[0] for e in events)
print(f"\n新事件 {len(events)} 条，最小时间 {cut}（cut）")

# 护栏：区分三类「早于上次同步」的事件
# - 硬缺口（type 10/20，旧站真实事件）且距今 < ANCIENT_DAYS：并入尾部重排（补上真数据）
# - 远古缺口（距今 >= ANCIENT_DAYS）：只报告不补插——为个别历史行把整表重编号不划算，
#   需要时用 --force 强制并入
# - 派生事件（type 30/40/50）早于上次同步：跳过并报告（补插收益极低）
from datetime import datetime
ANCIENT_DAYS = 30
ancient_cut = local_max_ct - ANCIENT_DAYS * 86400
hard = [e for e in events if e[0] < local_max_ct and e[2] in (10, 20) and e[0] >= ancient_cut]
ancient = [e for e in events if e[0] < ancient_cut and e[2] in (10, 20)]
soft = [e for e in events if e[0] < local_max_ct and e[2] in (30, 40, 50)]
if soft:
    if INCLUDE_SOFT:
        print(f"\n[并入] {len(soft)} 条派生事件时间早于上次同步（--include-soft 强制并入）：")
    else:
        print(f"\n[跳过] {len(soft)} 条派生事件时间早于上次同步（不补插，避免整表重编号）：")
        for e in sorted(soft, key=lambda x: x[0])[:15]:
            print(f"  {datetime.fromtimestamp(e[0]).strftime('%Y-%m-%d %H:%M')} type={e[2]} user={e[3]} ref={e[4]} {e[5][:50]}")
        drop = {id(e) for e in soft}
        events = [e for e in events if id(e) not in drop]
if ancient:
    print(f"\n[跳过·远古] {len(ancient)} 条事件早于上次同步 {ANCIENT_DAYS} 天以上（仅报告；--force 可强制并入）：")
    for e in sorted(ancient, key=lambda x: x[0])[:20]:
        print(f"  {datetime.fromtimestamp(e[0]).strftime('%Y-%m-%d %H:%M')} type={e[2]} user={e[3]} ref={e[4]} {e[5][:60]}")
    if "--force" not in sys.argv:
        drop = {id(e) for e in ancient}
        events = [e for e in events if id(e) not in drop]
if hard:
    print(f"\n[补插] {len(hard)} 条旧站事件时间略早于上次同步（并入尾部重排）：")
    for e in sorted(hard, key=lambda x: x[0])[:10]:
        print(f"  {datetime.fromtimestamp(e[0]).strftime('%Y-%m-%d %H:%M')} type={e[2]} user={e[3]} ref={e[4]} {e[5][:60]}")

if not events:
    print("\n无新增事件，无需处理。")
    sys.exit(0)

cut = min(e[0] for e in events)
print(f"\n实际并入事件 {len(events)} 条，cut={cut}")

# ---------- 2. 尾部原行 + 合并排序 ----------
# 2026-10-17 称号快照制：user_score 已删，行内快照 exp_time/ranked 随行保留重插
cur.execute("""SELECT id, type, user, reference, details_data, create_time, exp_time, ranked
            FROM news WHERE create_time >= %s ORDER BY id""", (cut,))
tail = list(cur.fetchall())
print(f"尾部原行（create_time >= cut）: {len(tail)} 条")
if len(tail) > 50000 and "--force" not in sys.argv:
    print("[中止] 尾部行数异常大，未写库。检查后加 --force 重跑。")
    sys.exit(2)

merged = []
for ct, lid, ntype, u, ref, dd in events:
    merged.append((ct, None, ntype, u, ref, dd))
for nid, ntype, u, ref, dd, ct, exp, rk in tail:
    merged.append((ct, nid, ntype, u, ref, dd, exp, rk))
# 同刻：原行在前（保持原相对顺序），新事件在后
merged.sort(key=lambda e: (e[0], e[1] if e[1] is not None else (1 << 62)))

# ---------- 3. 重放快照 exp_time（仅新增行；2026-10-17 快照制，原 sum_time 重放退役） ----------
# ranked：新增行统一按当前 user.status=0 快照（旧站增量期内无历史封禁流水）
cur.execute("SELECT id, status FROM user")
user_status = dict(cur.fetchall())
INCLUSIVE = {10, 53}  # 入伍/晋升含同刻（晋升后军衔）；破纪录等严格早于（旧军衔）

need_users = {e[3] for e in merged if e[1] is None}
records = {}
cur.execute(f"SELECT user, score_time, create_time FROM video_scores_exp "
            f"WHERE score_time < %s AND user IN ({','.join(['%s'] * len(need_users))})",
            (SENTINEL, *need_users)) if need_users else None
if need_users:
    for u, s, ct in cur.fetchall():
        if not s or s <= 0:
            continue
        records.setdefault(u, []).append((ct or 0, s))
for lst in records.values():
    lst.sort()
print(f"重放高级成绩流水用户: {len(records)}")

state = {}
final_rows = []
for row in merged:
    if len(row) == 8:
        ct, lid, ntype, u, ref, dd, exp, rk = row
    else:
        ct, lid, ntype, u, ref, dd = row
        exp = rk = None
    if lid is not None:
        # 尾部原行：快照随行保留
        final_rows.append((ntype, ct, u, exp, rk, ref, dd))
    st = state.setdefault(u, {"best": 0, "ptr": 0})
    lst = records.get(u)
    if lst:
        i = st["ptr"]
        while i < len(lst) and lst[i][0] <= ct:
            ms = lst[i][1]
            if st["best"] == 0 or ms < st["best"]:
                st["best"] = ms
            i += 1
        st["ptr"] = i
    if lid is None:
        inc = ntype in INCLUSIVE
        best = st["best"]
        if not inc:
            # 严格早于：回退「同刻推入」的成绩——本行快照取 ct 之前（不含）的 running best
            best_before = 0
            for fct, s in lst or []:
                if fct >= ct:
                    break
                if best_before == 0 or s < best_before:
                    best_before = s
            best = best_before
        final_rows.append((ntype, ct, u, best, 1 if user_status.get(u) == 0 else 0, ref, dd))

print(f"重插行数: {len(final_rows)}（原 {len(tail)} + 新 {len(events)}）")

if "--apply" not in sys.argv:
    from datetime import datetime
    print("\n[sample] 新增行前 10 条：")
    shown = 0
    for e in merged:
        if e[1] is None and shown < 10:
            print(f"  {datetime.fromtimestamp(e[0]).strftime('%Y-%m-%d %H:%M')} type={e[2]} user={e[3]} ref={e[4]} {e[5][:60]}")
            shown += 1
    print("\n[dry-run] 未写库。确认后加 --apply 执行。")
    sys.exit(0)

# ---------- 4. 尾部替换（生产不建备份表——schema 外表会阻塞全部部署） ----------
if NONLOCAL:
    print("[生产] 不建 schema 外备份表；回滚靠服务器侧 mysqldump 备份文件。")
else:
    backup = "news_backup_" + __import__("datetime").datetime.now().strftime("%Y%m%d")
    cur.execute(f"DROP TABLE IF EXISTS {backup}")
    cur.execute(f"CREATE TABLE {backup} AS SELECT * FROM news")
    print(f"已备份 news -> {backup}")

cur.execute("DELETE FROM news WHERE create_time >= %s", (cut,))
print(f"已删尾部 {cur.rowcount} 行")

ins = 0
for i in range(0, len(final_rows), BATCH):
    batch = final_rows[i:i + BATCH]
    cur.executemany(
        "INSERT INTO news (type, create_time, user, exp_time, ranked, reference, details_data) VALUES (%s,%s,%s,%s,%s,%s,%s)",
        batch)
    ins += len(batch)
my.commit()
print(f"[apply] 已重插 {ins} 行")

# ---------- 5. 校验 ----------
cur.execute("SELECT COUNT(*) FROM news")
cnt = cur.fetchone()[0]
cur.execute("SELECT COUNT(*) FROM news a JOIN news b ON b.id=a.id+1 WHERE b.create_time < a.create_time")
inv = cur.fetchone()[0]
print(f"校验: 总数 {cnt}；id↔时间逆序行 {inv}（应为 0）")
cur.execute("SELECT COUNT(*) FROM news")
assert inv == 0, "存在 id 序与时间序不一致"
by_type = defaultdict(int)
cur.execute("SELECT type, COUNT(*) FROM news GROUP BY type")
for t, c in cur.fetchall():
    by_type[t] = c
print("类型分布:", dict(sorted(by_type.items())))
print("DONE")
my.close()
stg.close()
