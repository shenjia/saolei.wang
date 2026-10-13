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
  3. user_score：新增行按成绩流水重放估算（与 rebuild_news.py / backfill_news_score.py 同算法）；
     尾部原行的 user_score 原样保留

用法: python3 scripts/sync/news-delta.py [--apply]   默认 dry-run
"""
import json
import sys
from collections import defaultdict

import pymysql

SENTINEL = 998000  # 999.99s 无成绩哨兵(t_ms=998990)
NEWS_BASELINE = "2013-10-23 08:23:46"
LEVELS = ("beg", "int", "exp")
BATCH = 5000

my = pymysql.connect(host="127.0.0.1", user="root", database="saolei",
                     charset="utf8mb4", autocommit=False)
stg = pymysql.connect(host="127.0.0.1", user="root", database="saolei_mssql",
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
events = []  # (create_time, legacy, type, user, user_score, reference, details_data)
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
    events.append((ux(ntime), None, 20, nplayer, 0, nvideo, dd))
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
    events.append((third, None, 10, player, 0, 0, "[]"))
    new_newbie += 1
print(f"新增入伍动态: {new_newbie}")

# 1c. 加入扫雷网（本地 user 中无 type=50 的）
cur.execute("SELECT id, create_time FROM user")
new_join = 0
for uid, ct in cur.fetchall():
    if uid in has_join or not ct:
        continue
    events.append((ct, None, 50, uid, 0, 0, "{}"))
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
    events.append((ct, None, 30, u, 0, vid, dd))
    new_first += 1
print(f"新增首盘上传动态: {new_first}")

# 1e. 论坛文章
cur.execute("SELECT id, user, create_time, title FROM bbs_post WHERE status=0")
new_post = 0
for pid, u, ct, title in cur.fetchall():
    if pid in has_post:
        continue
    t = (title or "")[:50].replace("\\", "\\\\\\\\").replace('"', '\\\\"')
    events.append((ct or 0, None, 40, u, 0, pid, '{"t":"%s"}' % t))
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
    print(f"\n[跳过] {len(soft)} 条派生事件时间早于上次同步（不补插，避免整表重编号）：")
    for e in sorted(soft, key=lambda x: x[0])[:15]:
        print(f"  {datetime.fromtimestamp(e[0]).strftime('%Y-%m-%d %H:%M')} type={e[2]} user={e[3]} ref={e[5]} {e[6][:50]}")
    drop = {id(e) for e in soft}
    events = [e for e in events if id(e) not in drop]
if ancient:
    print(f"\n[跳过·远古] {len(ancient)} 条事件早于上次同步 {ANCIENT_DAYS} 天以上（仅报告；--force 可强制并入）：")
    for e in sorted(ancient, key=lambda x: x[0])[:20]:
        print(f"  {datetime.fromtimestamp(e[0]).strftime('%Y-%m-%d %H:%M')} type={e[2]} user={e[3]} ref={e[5]} {e[6][:60]}")
    if "--force" not in sys.argv:
        drop = {id(e) for e in ancient}
        events = [e for e in events if id(e) not in drop]
if hard:
    print(f"\n[补插] {len(hard)} 条旧站事件时间略早于上次同步（并入尾部重排）：")
    for e in sorted(hard, key=lambda x: x[0])[:10]:
        print(f"  {datetime.fromtimestamp(e[0]).strftime('%Y-%m-%d %H:%M')} type={e[2]} user={e[3]} ref={e[5]} {e[6][:60]}")

if not events:
    print("\n无新增事件，无需处理。")
    sys.exit(0)

cut = min(e[0] for e in events)
print(f"\n实际并入事件 {len(events)} 条，cut={cut}")

# ---------- 2. 尾部原行 + 合并排序 ----------
cur.execute("""SELECT id, type, user, user_score, reference, details_data, create_time
            FROM news WHERE create_time >= %s ORDER BY id""", (cut,))
tail = list(cur.fetchall())
print(f"尾部原行（create_time >= cut）: {len(tail)} 条")
if len(tail) > 50000 and "--force" not in sys.argv:
    print("[中止] 尾部行数异常大，未写库。检查后加 --force 重跑。")
    sys.exit(2)

merged = []
for ct, lid, ntype, u, us, ref, dd in events:
    merged.append((ct, None, ntype, u, us, ref, dd))
for nid, ntype, u, us, ref, dd, ct in tail:
    merged.append((ct, nid, ntype, u, us, ref, dd))
# 同刻：原行在前（保持原相对顺序），新事件在后
merged.sort(key=lambda e: (e[0], e[1] if e[1] is not None else (1 << 62)))

# ---------- 3. 重放 user_score（仅新增行） ----------
need_users = {e[3] for e in merged if e[1] is None}
records = {}
for lvl in LEVELS:
    cur.execute(f"SELECT user, score_time, create_time FROM video_scores_{lvl} "
                f"WHERE score_time < %s AND user IN ({','.join(['%s'] * len(need_users))})",
                (SENTINEL, *need_users))
    for u, s, ct in cur.fetchall():
        if not s or s <= 0:
            continue
        records.setdefault(u, {}).setdefault(lvl, []).append((ct or 0, s))
for lvls in records.values():
    for lvl in lvls:
        lvls[lvl].sort()
print(f"重放成绩流水用户: {len(records)}")

state = {}
final_rows = []
for ct, lid, ntype, u, us, ref, dd in merged:
    if lid is not None:
        final_rows.append((ntype, ct, u, us, ref, dd))
        # 尾部原行也要推进重放状态，保证后续新增行估算准确
    st = state.setdefault(u, {"best": {}, "ptr": {k: 0 for k in LEVELS}})
    user_recs = records.get(u, {})
    for lvl in LEVELS:
        lst = user_recs.get(lvl)
        if not lst:
            continue
        i = st["ptr"][lvl]
        while i < len(lst) and lst[i][0] <= ct:
            ms = lst[i][1]
            if lvl not in st["best"] or ms < st["best"][lvl]:
                st["best"][lvl] = ms
            i += 1
        st["ptr"][lvl] = i
    if lid is None:
        est = sum(st["best"].values()) if len(st["best"]) == 3 else 0
        final_rows.append((ntype, ct, u, est, ref, dd))

print(f"重插行数: {len(final_rows)}（原 {len(tail)} + 新 {len(events)}）")

if "--apply" not in sys.argv:
    from datetime import datetime
    print("\n[sample] 新增行前 10 条：")
    shown = 0
    for e in merged:
        if e[1] is None and shown < 10:
            print(f"  {datetime.fromtimestamp(e[0]).strftime('%Y-%m-%d %H:%M')} type={e[2]} user={e[3]} ref={e[5]} {e[6][:60]}")
            shown += 1
    print("\n[dry-run] 未写库。确认后加 --apply 执行。")
    sys.exit(0)

# ---------- 4. 备份 + 尾部替换 ----------
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
        "INSERT INTO news (type, create_time, user, user_score, reference, details_data) VALUES (%s,%s,%s,%s,%s,%s)",
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
