#!/usr/bin/env python3
"""【已退役 2026-10-17】军衔晋升动态回填脚本——张老师要求晋升动态整体下线：
存量 type=53 行已删除（备份见下），本脚本不再执行、防止误跑复活数据。
保留仅作历史参考。退役前规则：

  - 按 video_scores_exp 流水重放，首次跨过军衔阈值补发 type=53 晋升动态
  - 排序铁律：news.id 序 = create_time 序 → 尾部合并重排
  - exp_time 快照：晋升动态含同刻——取晋升后高级新值

存量备份（17582 行）：本地 .workbuddy/backups/20261017-promo-news-removed/；
生产服务器 ~/backup/userscore-drop-20261017/promo-news-removed.sql.gz。

用法（退役后禁用）: 直接运行将拒绝执行并退出。
"""
import json
import os
import sys

print("[RETIRED] 晋升动态已于 2026-10-17 整体下线，本脚本不再执行。", file=sys.stderr)
sys.exit(3)

# ---------- 以下为退役前实现，仅存档 ----------
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

# 军衔/称号（与 src/lib/config.ts TITLES/TITLE_THRESHOLDS 严格一致；score_time 为毫秒）
# 2026-10-17 人神界改版：论外+神界 7 档顶替 60s 以内军衔（总司令/原大元帅~少校 7 档除名），
# 人界大元帅 ≤61s 起、上校起校段 3 级（大校除名）、上等兵线 150→200s
TIERS = [
    (30000, "外星人"), (35000, "大雷帝"), (40000, "小雷帝"), (45000, "大雷圣"),
    (50000, "小雷圣"), (55000, "大雷神"), (60000, "小雷神"),
    (61000, "大元帅"), (62000, "元帅"), (63000, "大将"),
    (65000, "上将"),
    (67000, "中将"), (70000, "少将"), (73000, "上校"), (76000, "中校"),
    (80000, "少校"), (84000, "上尉"), (90000, "中尉"),
    (100000, "少尉"), (110000, "上士"), (120000, "中士"), (150000, "下士"),
    (200000, "上等兵"), (float("inf"), "列兵"),
]
COND_TEXT = {
    "外星人": "高级记录 < 30秒", "大雷帝": "高级记录 < 35秒", "小雷帝": "高级记录 < 40秒",
    "大雷圣": "高级记录 < 45秒", "小雷圣": "高级记录 < 50秒", "大雷神": "高级记录 < 55秒",
    "小雷神": "高级记录 < 60秒",
    "大元帅": "高级记录 < 61秒", "元帅": "高级记录 < 62秒", "大将": "高级记录 < 63秒",
    "上将": "高级记录 < 65秒", "中将": "高级记录 < 67秒", "少将": "高级记录 < 70秒",
    "上校": "高级记录 < 73秒", "中校": "高级记录 < 76秒", "少校": "高级记录 < 80秒",
    "上尉": "高级记录 < 84秒", "中尉": "高级记录 < 90秒", "少尉": "高级记录 < 100秒",
    "上士": "高级记录 < 110秒", "中士": "高级记录 < 120秒", "下士": "高级记录 < 150秒",
    "上等兵": "高级记录 < 200秒", "列兵": "高级记录 ≥ 200秒",
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
cur.execute("""SELECT id, type, user, reference, details_data, create_time, exp_time, ranked
            FROM news WHERE create_time >= %s ORDER BY id""", (cut,))
tail = list(cur.fetchall())
print(f"尾部原行（create_time >= cut）: {len(tail)} 条")
if len(tail) > 300000 and "--force" not in sys.argv:
    print("[中止] 尾部行数异常大，未写库。检查后加 --force 重跑。")
    sys.exit(2)

merged = []
for ct, u, ti in promo_events:
    dd = json.dumps({"ti": ti, "cond": COND_TEXT[ti]}, separators=(",", ":"))
    merged.append((ct, None, 53, u, 0, dd, None, None))  # exp/rk 占位，重放段填
for nid, ntype, u, ref, dd, ct, exp, rk in tail:
    merged.append((ct, nid, ntype, u, ref, dd, exp, rk))
# 同刻：原行在前，新事件在后
merged.sort(key=lambda e: (e[0], e[1] if e[1] is not None else (1 << 62)))

# ---------- 3. 重放快照 exp_time（新增 type=53 行；含同刻=晋升后高级新值） ----------
need_users = {e[2] for e in merged if e[1] is None}
records = {}
placeholders = ",".join(["%s"] * len(need_users))
cur.execute("SELECT user, score_time, create_time FROM video_scores_exp "
            f"WHERE score_time < %s AND user IN ({placeholders})",
            (SENTINEL, *need_users))
for u, s, ct in cur.fetchall():
    if not s or s <= 0:
        continue
    records.setdefault(u, []).append((ct or 0, s))
for lst in records.values():
    lst.sort()
print(f"重放高级成绩流水用户: {len(records)}")

# ranked：新增行按当前 user.status=0
cur.execute("SELECT id, status FROM user")
user_status = dict(cur.fetchall())

state = {}   # user -> (ptr, best)（含同刻推进：<= ct）
final_rows = []
for row in merged:
    ct, lid, ntype, u, ref, dd = row[:6]
    exp = row[6] if len(row) > 6 else None
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
    if lid is not None:
        final_rows.append((ntype, ct, u, exp, row[7], ref, dd))
    else:
        final_rows.append((ntype, ct, u, st["best"], 1 if user_status.get(u) == 0 else 0, ref, dd))

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
assert inv == 0, "存在 id 序与时间序不一致"
by_type = defaultdict(int)
cur.execute("SELECT type, COUNT(*) FROM news GROUP BY type")
for t, c in cur.fetchall():
    by_type[t] = c
print("类型分布:", dict(sorted(by_type.items())))
print("DONE")
my.close()
