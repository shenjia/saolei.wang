#!/usr/bin/env python3
"""重建 news 表：原 15 万条动态按原顺序保留 + 回填 3 类历史动态，全表按时间重灌

背景（2026-09-24 张老师拍板）:
- 动态体系扩充后（92547af），三类历史事件也应有动态:加入扫雷网(50)、
  每用户每级别第一盘上传录像(30)、论坛文章(40)
- news 铁律「id 序 = create_time 序」→ 不能尾部追加,必须整表按时间重灌
- 现在是唯一窗口期:网站未上线,id 重编号无外部引用

原表处理:
- 原 15 万条动态(入伍/纪录,来自 2019 转储+新站产生)原样保留:
  type/user/reference/details_data 不变,user_score 不变(基线前是真实历史值,
  基线后是 backfill_news_score.py 的重放估算值,均不动)
- 评论(52)/换头像(51)不回填:评论类太密会淹没纪录动态;头像无更换时间记录

新增三类的事件时间:
- 加入扫雷网: user.create_time
- 上传录像: video.create_time(video.status=20 已通过,同用户同级别取最早一盘)
- 论坛文章: bbs_post.create_time(status=0 正常帖)

user_score 口径(动态时刻的 sum_time):
- 按成绩流水重放(复用 backfill_news_score.py 的算法):三个级别都取该时刻前
  的历史最佳时间,三级不齐=预备役(0);999.99 哨兵不计
- 原 15 万条的用户查到什么就填什么,不重算

用法: python3 rebuild_news.py [--apply]   默认 dry-run 只打印统计
"""
import sys
from collections import defaultdict

import pymysql

SENTINEL = 998000  # 999.99s 无成绩哨兵(t_ms=998990)
LEVEL_TABLES = (("beg", "video_scores_beg"), ("int", "video_scores_int"), ("exp", "video_scores_exp"))
BATCH = 5000

my = pymysql.connect(host="127.0.0.1", user="root", database="saolei",
                     charset="utf8mb4", autocommit=False)
cur = my.cursor()

# ---------- 1) 成绩流水（重放算法，与 backfill_news_score.py 一致） ----------
records: dict[int, dict[str, list[tuple[int, int]]]] = defaultdict(dict)
for lvl, table in LEVEL_TABLES:
    cur.execute(f"SELECT user, score_time, create_time FROM {table} WHERE score_time < %s", (SENTINEL,))
    for u, s, ct in cur.fetchall():
        if not s or s <= 0:
            continue
        records[u].setdefault(lvl, []).append((ct or 0, s))
for lvls in records.values():
    for lvl in lvls:
        lvls[lvl].sort()
print(f"成绩流水：{len(records)} 个用户")

# ---------- 2) 收集全部事件，统一按时间排序 ----------
events = []  # (create_time, type, user, reference, details_json, legacy_id)
# legacy_id: 原表动态行;新事件 None。同刻排序时原表行优先(保序)
# (用负 id 让「原表行 id 更小=更早」与时间序一致,见排序键)

# 2a. 原 news 全量（2026-09-24 已用 restore_news.py 从 2019 转储 + staging 完整恢复，
#     user_score 已跑 backfill_news_score.py 重放回填；此表即「原表行」，直接读）
cur.execute("SELECT id, type, user, user_score, reference, details_data, create_time FROM news ORDER BY id")
legacy = list(cur.fetchall())
print(f"原动态：{len(legacy)} 条")
for nid, ntype, u, us, ref, dd, ct in legacy:
    events.append((ct or 0, nid, ntype, u, us, ref, dd))

# 2b. 加入扫雷网（全部用户）
cur.execute("SELECT id, create_time FROM user")
users = cur.fetchall()
for uid, ct in users:
    if not ct:
        continue
    events.append((ct or 0, None, 50, uid, None, 0, "{}"))
print(f"用户(加入扫雷网)：{len(users)} 条")

# 2c. 每用户每级别第一盘已通过录像
cur.execute("""
    SELECT v.user, v.level, v.id, v.create_time, i.real_time, i.board_3bv
    FROM video v JOIN video_info i ON i.id = v.id
    WHERE v.status = 20 AND v.create_time > 0
    ORDER BY v.create_time
""")
first_video: dict[tuple[int, str], tuple] = {}
for u, lvl, vid, ct, rt, bv in cur.fetchall():
    key = (u, lvl)
    if key not in first_video:
        first_video[key] = (ct, vid, rt, bv)
for (u, lvl), (ct, vid, rt, bv) in first_video.items():
    tm = rt if rt and rt > 0 else 0
    bv_score = (bv * 1000000 // rt) if rt and rt > 0 else 0
    dd = '{"lv":"%s","tm":%d,"bv":%d}' % (lvl, tm, max(bv_score, 0))
    events.append((ct, None, 30, u, None, vid, dd))
print(f"首盘录像(上传动态)：{len(first_video)} 条")

# 2d. 论坛文章
cur.execute("SELECT id, user, create_time, title FROM bbs_post WHERE status = 0")
posts = cur.fetchall()
for pid, u, ct, title in posts:
    t = (title or "")[:50].replace("\\", "\\\\\\\\").replace('"', '\\\\"')
    dd = '{"t":"%s"}' % t
    events.append((ct or 0, None, 40, u, None, pid, dd))
print(f"论坛文章：{len(posts)} 条")

# 全序：时间升序；同刻时原表行按原 id、新事件排在其后（原表行间相对顺序不变）
events.sort(key=lambda e: (e[0], e[1] or (1 << 62)))
print(f"\n事件总数：{len(events)}（原 {len(legacy)} + 新增 {len(events) - len(legacy)}）")

# 去重：新站已按新逻辑发过动态的事件（如 999004 注册的 JOIN），
# 原表行已存在，不能再生成一条新事件——同 type+user+同秒 视为同一事件，跳过新行
legacy_keys = {(ct, ntype, u) for ct, nid, ntype, u, us, ref, dd in events if nid is not None}
before = len(events)
events = [
    e for e in events
    if e[1] is not None or (e[0], e[2], e[3]) not in legacy_keys
]
dropped = before - len(events)
print(f"去重：剔除与原表行重复的新事件 {dropped} 条")

# ---------- 3) 全局时间序重放 user_score（新事件估算；原表行保留原值） ----------
final_rows = []  # (type, create_time, user, user_score, reference, details_data)
state: dict[int, dict] = {}
for ct, lid, ntype, u, us, ref, dd in events:
    st = state.setdefault(u, {"best": {}, "ptr": {k: 0 for k in ("beg", "int", "exp")}})
    user_recs = records.get(u, {})
    for lvl in ("beg", "int", "exp"):
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
    else:
        final_rows.append((ntype, ct, u, us, ref, dd))

print(f"最终行数：{len(final_rows)}（原表 {len(legacy)} + 新增 {len(final_rows) - len(legacy)}）")
by_type = defaultdict(int)
for row in final_rows:
    by_type[row[0]] += 1
print("类型分布：", dict(sorted(by_type.items())))

if "--apply" not in sys.argv:
    print("\n[sample] 前 10 行：")
    from datetime import datetime, timedelta, timezone
    for ntype, ct, u, us, ref, dd in final_rows[:10]:
        dt = datetime.fromtimestamp(ct, timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M")
        print(f"  {dt} type={ntype} user={u} score={us} ref={ref} {dd[:50]}")
    print("[sample] 最后 5 行：")
    for ntype, ct, u, us, ref, dd in final_rows[-5:]:
        dt = datetime.fromtimestamp(ct, timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M")
        print(f"  {dt} type={ntype} user={u} score={us} ref={ref} {dd[:50]}")
    print("\n[dry-run] 未写库。确认后加 --apply 执行。")
    sys.exit(0)

# ---------- 4) 备份 + 重灌 ----------
cur.execute("DROP TABLE IF EXISTS news_backup_20260924")
cur.execute("CREATE TABLE news_backup_20260924 AS SELECT * FROM news")
print("已备份 news -> news_backup_20260924")

cur.execute("TRUNCATE TABLE news")
inserted = 0
for i in range(0, len(final_rows), BATCH):
    batch = final_rows[i:i + BATCH]
    cur.executemany(
        "INSERT INTO news (type, create_time, user, user_score, reference, details_data) VALUES (%s,%s,%s,%s,%s,%s)",
        batch,
    )
    inserted += len(batch)
my.commit()
print(f"[apply] 已重灌 {inserted} 条")


# ---------- 5) 校验 ----------
cur.execute("SELECT COUNT(*) FROM news")
cnt = cur.fetchone()[0]
assert cnt == inserted, f"行数不符 {cnt} != {inserted}"

# id 序 = create_time 序（全局单调不减）
cur.execute("SELECT COUNT(*) FROM news a JOIN news b ON b.id = a.id + 1 WHERE b.create_time < a.create_time")
inv = cur.fetchone()[0]
print(f"校验:总数 {cnt}；id↔时间逆序行 {inv}（应为 0）")
assert inv == 0, "存在 id 序与时间序不一致"

# 原表行内容与相对顺序保持（backup id 序 vs 新表中同类型行序）
cur.execute("SELECT type, user, reference, details_data, user_score, create_time FROM news_backup_20260924 ORDER BY id")
backup_seq = cur.fetchall()
cur.execute("SELECT type, user, reference, details_data, user_score, create_time FROM news")
new_all = cur.fetchall()
new_legacy_seq = [r for r in new_all if r[0] in (0, 10, 20, 21, 22)]
assert len(new_legacy_seq) == len(backup_seq), f"原表行数不符 {len(new_legacy_seq)} != {len(backup_seq)}"
mismatch = sum(1 for a, b in zip(backup_seq, new_legacy_seq) if a != b)
print(f"校验:原表 {len(backup_seq)} 行相对顺序 {'保持 ✅' if mismatch == 0 else f'错乱 {mismatch} 行 ❌'}")
if mismatch:
    for a, b in zip(backup_seq, new_legacy_seq):
        if a != b:
            print(f"  首个不一致: {a} vs {b}")
            break
    sys.exit(1)
print("完成。原表备份在 news_backup_20260924,确认无问题后可 DROP")
