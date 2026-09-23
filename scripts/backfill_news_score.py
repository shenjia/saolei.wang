#!/usr/bin/env python3
"""回填 news.user_score：按录像成绩流水模拟估算动态发生时刻的 sum_time

背景: 2026-09-23 同步时 transform.py 用用户「当前」sum_time 近似填充
news.user_score,导致进步历程里每条动态的军衔恒定不变。
本脚本按 video_scores_{beg,int,exp} 的成绩流水重放用户历史最佳成绩,
估算每条动态时刻的 sum_time,再按 distribution 最新军衔阈值评定。

规则:
- 仅回填同步补入的行(create_time > NEWS_BASELINE 2013-10-23):这段 user_score 被
  transform.py 填成了用户「当前」sum_time;基线之前的动态来自 2019 转储,是真实历史值,不动
- 2013-10-23 之后新站自发产生的动态(暂无)同样会被重算,估算值应与实际一致
- 无成绩哨兵 999.99s(=998990ms)及以上的录像不计入
- 三个级别成绩不齐时视为未入伍 -> 0（预备役），不做部分和评定
- 阈值用当前 distribution——历史阈值无法回溯,此为估算的主要误差源

用法: python3 backfill_news_score.py [--apply]   默认 dry-run 只打印统计
"""
import sys
from collections import defaultdict

import pymysql

NEWS_BASELINE = 1382487826  # 同步基线 2013-10-23:之前是真实历史值,之后是被污染的近似值
SENTINEL = 998000     # 999.99s -> t_ms = 998990,无成绩哨兵
LEVEL_TABLES = (("beg", "video_scores_beg"), ("int", "video_scores_int"), ("exp", "video_scores_exp"))
TITLES = [
    "大元帅", "元帅", "大将", "上将", "中将", "少将",
    "大校", "上校", "中校", "少校",
    "上尉", "中尉", "少尉",
    "上士", "中士", "下士",
    "上等兵", "列兵",
]

my = pymysql.connect(host="127.0.0.1", user="root", database="saolei",
                     charset="utf8mb4", autocommit=False)
cur = my.cursor()

# ---------- 1) 军衔阈值（Assess::title 口径：sum_time 升序定位） ----------
cur.execute("SELECT title FROM distribution ORDER BY id DESC LIMIT 1")
thresholds = [int(x) for x in cur.fetchone()[0].split(",")]
assert len(thresholds) == len(TITLES), f"阈值数 {len(thresholds)} 与军衔数 {len(TITLES)} 不符"


def est_title(score: int) -> str:
    if not score:
        return "预备役"
    for i, t in enumerate(thresholds):
        if score <= t:
            return TITLES[i]
    return TITLES[-1]


# ---------- 2) 成绩流水：user -> level -> [(create_time, score_time)] ----------
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

# ---------- 3) 按用户重放动态 ----------
cur.execute(
    "SELECT id, user, create_time, user_score FROM news WHERE create_time > %s ORDER BY user, create_time",
    (NEWS_BASELINE,),
)
rows = cur.fetchall()
print(f"待回填动态：{len(rows)} 条（create_time > 2013-10-23 同步基线）")

updates = []  # (est, id)
changed = 0
before_titles: dict[str, int] = defaultdict(int)
after_titles: dict[str, int] = defaultdict(int)
samples = []  # 军衔有变化的用户样本

by_user: dict[int, list] = defaultdict(list)
for nid, u, ct, old in rows:
    by_user[u].append((nid, ct, old))

for u, items in by_user.items():
    best: dict[str, int] = {}       # 各级别当前最佳
    ptr: dict[str, int] = {k: 0 for k in ("beg", "int", "exp")}
    user_recs = records.get(u, {})
    rank_path = []
    for nid, ct, old in items:
        # 把 create_time <= 动态时刻的成绩流入最佳值（动态本身对应的录像也随之计入）
        for lvl in ("beg", "int", "exp"):
            lst = user_recs.get(lvl)
            if not lst:
                continue
            i = ptr[lvl]
            while i < len(lst) and lst[i][0] <= ct:
                ms = lst[i][1]
                if lvl not in best or ms < best[lvl]:
                    best[lvl] = ms
                i += 1
            ptr[lvl] = i
        # 三级不齐 = 尚未入伍，评预备役；不齐时的部分和会严重高估军衔
        est = sum(best.values()) if len(best) == 3 else 0
        updates.append((est, nid))
        tb, ta = est_title(old), est_title(est)
        before_titles[tb] += 1
        after_titles[ta] += 1
        if tb != ta:
            changed += 1
            rank_path.append((nid, ct, old, est, tb, ta))
    if rank_path and len(samples) < 5:
        samples.append((u, rank_path[:6], len(rank_path)))

print(f"\n军衔发生变化：{changed}/{len(rows)} 条")
print("\n回填前分布：")
for t in TITLES + ["预备役"]:
    if before_titles.get(t):
        print(f"  {t}: {before_titles[t]}")
print("回填后分布：")
for t in TITLES + ["预备役"]:
    if after_titles.get(t):
        print(f"  {t}: {after_titles[t]}")

print("\n样本（估算军衔演进，前 5 个有变化的用户）：")
for u, path, total in samples:
    print(f"  用户 {u}（{total} 条变化）:")
    from datetime import datetime, timedelta, timezone
    for nid, ct, old, est, tb, ta in path:
        dt = datetime.fromtimestamp(ct, timezone(timedelta(hours=8))).strftime("%Y-%m-%d")
        print(f"    {dt}  {old} -> {est}  {tb} -> {ta}")

if "--apply" not in sys.argv:
    print("\n[dry-run] 未写库。确认后加 --apply 执行。")
    sys.exit(0)

BATCH = 2000
for i in range(0, len(updates), BATCH):
    cur.executemany("UPDATE news SET user_score=%s WHERE id=%s", updates[i:i + BATCH])
my.commit()
print(f"\n[apply] 已回填 {len(updates)} 条 news.user_score")
