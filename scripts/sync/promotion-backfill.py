#!/usr/bin/env python3
"""军衔晋升动态回填（2026-10-13 SUB 制）：按 video_scores_exp 流水重放，补发首次晋升动态

规则：
  - 对每个玩家按时间重放高级成绩 running best（同刻多盘按流水顺序自然收敛到最终最优）；
  - 每当 running best 首次跨过一个 SUB 阈值（35/40/42/45/48/50/52/55/58/60/63/66/70/80/90/100/150s），
    产生一条 type=53 晋升动态（create_time = 该成绩的流水时间）；
  - 列兵档（>=150s）是首次产生高级成绩即落入，视同首次晋升（首成绩 <150s 的玩家则按实际跨越补）。
  - 幂等：以 (user, ti) 为键跳过已存在的 type=53 行。

排序铁律：news.id 序 = create_time 序 → 走 news-delta 同款「尾部合并重排」：
  cut = 新事件最小时间，删除 create_time >= cut 的尾部行，与新事件一起重排重插。
  同刻时原行在前、新事件在后。

user_score：历史口径为 sum_time 快照；晋升动效按重放 sum（三级 running best 之和）估算，
与 backfill_news_score.py 同算法。

用法: python3 scripts/sync/promotion-backfill.py [--apply]   默认 dry-run

连接（2026-10-15 支持生产重放）：默认本地 root@127.0.0.1:3306/saolei；
SAOLEI_DB_HOST/PORT/USER/PASSWORD 环境变量覆盖（写生产走 3316 隧道 + --allow-nonlocal）。
⚠️ 生产禁建 schema 外表：--apply 时不再建 news_backup_* 表，改为提示——
生产侧备份用 mysqldump 到服务器文件（news-backup-before-promo-20261015.sql.gz）。
"""
import json
import os
import sys
from collections import defaultdict

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

BATCH = 5000
LEVELS = ("beg", "int", "exp")
SENTINEL = 998000

# SUB 制军衔（与 src/lib/config.ts TITLES/TITLE_THRESHOLDS 严格一致；score_time 为毫秒）
# 注意 2026-10-13 17:04 修正：此前士官以下错位一档（80000 曾写成中士，实为上士）；
# 列兵 = 无上限（首成绩 >150s 也发晋升事件）
# 2026-10-16 新增总司令档（SUB30）：现役仅鞠泽恩 1 人（25.10s）
TIERS = [
    (30000, "总司令"), (35000, "大元帅"), (40000, "元帅"), (42000, "大将"),
    (45000, "上将"),
    (48000, "中将"), (50000, "少将"), (52000, "大校"), (55000, "上校"),
    (58000, "中校"), (60000, "少校"), (63000, "上尉"), (66000, "中尉"),
    (70000, "少尉"), (80000, "上士"), (90000, "中士"), (100000, "下士"),
    (150000, "上等兵"), (float("inf"), "列兵"),
]
COND_TEXT = {
    "总司令": "高级记录 < 30秒", "大元帅": "高级记录 < 35秒", "元帅": "高级记录 < 40秒", "大将": "高级记录 < 42秒",
    "上将": "高级记录 < 45秒", "中将": "高级记录 < 48秒", "少将": "高级记录 < 50秒",
    "大校": "高级记录 < 52秒", "上校": "高级记录 < 55秒", "中校": "高级记录 < 58秒",
    "少校": "高级记录 < 60秒", "上尉": "高级记录 < 63秒", "中尉": "高级记录 < 66秒",
    "少尉": "高级记录 < 70秒", "上士": "高级记录 < 80秒", "中士": "高级记录 < 90秒",
    "下士": "高级记录 < 100秒", "上等兵": "高级记录 < 150秒", "列兵": "高级记录 ≥ 150秒",
}


def tiers_for(ms):
    """成绩（毫秒）落入了哪些档（比它差的低档都算已达成——首成绩直接进列兵）"""
    got = []
    for threshold, name in TIERS:
        if ms <= threshold:
            got.append(name)
    return got


# ---------- 0. 本地现状 ----------
cur.execute("SELECT COALESCE(MAX(create_time), 0) FROM news")
local_max_ct = cur.fetchone()[0]
print(f"本地 news 最大 create_time = {local_max_ct}")

cur.execute("SELECT user, details_data FROM news WHERE type=53")
has_promo = set()
for u, dd in cur.fetchall():
    try:
        has_promo.add((u, json.loads(dd or "{}").get("ti")))
    except Exception:
        pass
print(f"已有晋升动态键 (user, ti): {len(has_promo)}")

# ---------- 1. 高级成绩流水重放 ----------
cur.execute("SELECT user, score_time, create_time FROM video_scores_exp "
            "WHERE score_time > 0 AND score_time < %s ORDER BY create_time, id", (SENTINEL,))
rows = cur.fetchall()
print(f"高级成绩流水: {len(rows)} 行")

best = {}          # user -> 当前 running best (ms)
promo_events = []  # (create_time, user, ti)
covered = defaultdict(set)  # user -> 已达成档名（含首成绩直落档）
for u, s, ct in rows:
    if not s or s <= 0:
        continue
    prev = best.get(u)
    if prev is None:
        # 首盘高级成绩：落入的档 = TIERS（严→宽）中第一个 s<=threshold 的档，
        # 所有更宽的档一并视为已达成（不补发低档动态）；只发落入档一条
        best[u] = s
        cur_tier = None
        for threshold, name in TIERS:
            if s <= threshold:
                if cur_tier is None:
                    cur_tier = name  # 第一个满足 = 最严档 = 该成绩的军衔
                covered[u].add(name)  # 宽档全部记为已达成
        if cur_tier and (u, cur_tier) not in has_promo:
            promo_events.append(((ct or 0), u, cur_tier))
    elif s < prev:
        best[u] = s
        # 一次破纪录跨多个档位时「一步晋升到位」：只发最终（最严）档一条动态，
        # 中间档视为已达成不再补发（2026-10-13 17:27 张老师要求：同时多条晋升动态不合理）
        crossed = [name for threshold, name in reversed(TIERS)
                   if s <= threshold and name not in covered[u]]
        for name in crossed:
            covered[u].add(name)
        if crossed and (u, crossed[-1]) not in has_promo:
            promo_events.append(((ct or 0), u, crossed[-1]))
    # else: 未破纪录，跳过

promo_events.sort()
from datetime import datetime
print(f"\n晋升事件: {len(promo_events)} 条")
by_tier = defaultdict(int)
for _, _, ti in promo_events:
    by_tier[ti] += 1
for name in [n for _, n in TIERS]:
    if by_tier.get(name):
        print(f"  {name}: {by_tier[name]}")

if not promo_events:
    print("无晋升事件，退出。")
    sys.exit(0)

# 护栏：远古事件（早于上次同步 30 天以上）默认跳过——大多数晋升是历史事件，
# 但这正是本次任务目标（补历史晋升动态），因此远古不跳过，只提示规模
cut = min(e[0] for e in promo_events)
older = sum(1 for e in promo_events if e[0] < local_max_ct - 30 * 86400)
print(f"\ncut={cut}（{datetime.fromtimestamp(cut)}）；早于最近同步的事件 {older} 条（历史回填，正常）")

# ---------- 2. 尾部原行 + 合并排序 ----------
cur.execute("""SELECT id, type, user, user_score, reference, details_data, create_time
            FROM news WHERE create_time >= %s ORDER BY id""", (cut,))
tail = list(cur.fetchall())
print(f"尾部原行（create_time >= cut）: {len(tail)} 条")
if len(tail) > 300000 and "--force" not in sys.argv:
    print("[中止] 尾部行数异常大，未写库。检查后加 --force 重跑。")
    sys.exit(2)

merged = []
for ct, u, ti in promo_events:
    dd = json.dumps({"ti": ti, "cond": COND_TEXT[ti]}, separators=(",", ":"))
    merged.append((ct, None, 53, u, 0, 0, dd))
for nid, ntype, u, us, ref, dd, ct in tail:
    merged.append((ct, nid, ntype, u, us, ref, dd))
# 同刻：原行在前，新事件在后
merged.sort(key=lambda e: (e[0], e[1] if e[1] is not None else (1 << 62)))

# ---------- 3. 重放 user_score（新增 type=53 行；口径=sum running best） ----------
need_users = {e[3] for e in merged if e[1] is None}
records = {}
for lvl in LEVELS:
    placeholders = ",".join(["%s"] * len(need_users))
    cur.execute(f"SELECT user, score_time, create_time FROM video_scores_{lvl} "
                f"WHERE score_time < %s AND user IN ({placeholders})",
                (SENTINEL, *need_users))
    for u, s, ct in cur.fetchall():
        if not s or s <= 0:
            continue
        records.setdefault(u, {}).setdefault(lvl, []).append((ct or 0, s))
for lvls in records.values():
    for lvl in lvls:
        lvls[lvl].sort()
print(f"重放 sum 成绩流水用户: {len(records)}")

state = {}
final_rows = []
for ct, lid, ntype, u, us, ref, dd in merged:
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
    if lid is not None:
        final_rows.append((ntype, ct, u, us, ref, dd))
    else:
        est = sum(st["best"].values()) if len(st["best"]) == 3 else 0
        final_rows.append((ntype, ct, u, est, ref, dd))

print(f"重插行数: {len(final_rows)}（原 {len(tail)} + 新 {len(promo_events)}）")

if "--apply" not in sys.argv:
    print("\n[sample] 新增晋升动态前 12 条：")
    shown = 0
    for e in merged:
        if e[1] is None and shown < 12:
            print(f"  {datetime.fromtimestamp(e[0]).strftime('%Y-%m-%d %H:%M')} user={e[3]} {e[6][:70]}")
            shown += 1
    print("\n[dry-run] 未写库。确认后加 --apply 执行。")
    sys.exit(0)

# ---------- 4. 尾部替换（生产不建备份表——schema 外表会阻塞全部部署） ----------
if NONLOCAL:
    print("[生产] 不建 schema 外备份表；回滚靠服务器侧 mysqldump 备份文件。")
else:
    backup = "news_backup_promo_" + datetime.now().strftime("%Y%m%d")
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
assert inv == 0, "存在 id 序与时间序不一致"
by_type = defaultdict(int)
cur.execute("SELECT type, COUNT(*) FROM news GROUP BY type")
for t, c in cur.fetchall():
    by_type[t] = c
print("类型分布:", dict(sorted(by_type.items())))
print("DONE")
my.close()
