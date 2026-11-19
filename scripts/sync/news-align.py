#!/usr/bin/env python3
"""news 语义对齐：把「本地有、生产无」的动态按语义键找出来，尾部重排补进生产 — 2026-10-15

背景：news-delta 的软跳过逻辑（派生事件早于上次同步不补）在「补 10-13 历史增量」
场景下漏掉 66 条新用户真实动态（33 注册 + 27 首盘 + 6 发帖）。直接 --include-soft 又会
把 771 条历史老用户的注册动态带进来（违反「老用户不补历史注册动态」铁律）。
故按语义键精确对账，只补本地有、生产无的行。

语义键：
  type=10 入伍      -> user
  type=20 纪录      -> (reference, details.od)
  type=30 首盘上传  -> (user, details.lv)
  type=40 论坛文章  -> reference
  type=50 注册      -> user
  type=51 头像      -> (user, create_time)  # 低频，直接按 user+时间
  type=52 评论      -> (user, reference, create_time)  # 两侧各有测试数据，不对齐
  type=53 晋升      -> (user, details.ti)

排除：本地测试数据（user 999xxx 的行、user=1 且 type=52 的 10-13 测试评论）。

用法：
  PY=/Users/shenjia/.workbuddy/binaries/python/envs/default/bin/python
  $PY scripts/sync/news-align.py            # dry-run
  $PY scripts/sync/news-align.py --apply --allow-nonlocal
连接走 SAOLEI_DB_* 环境变量（本地库固定 root 本地读）。
"""
import json
import os
import sys
from collections import defaultdict
from datetime import datetime

import pymysql

BATCH = 5000
DRY = "--apply" not in sys.argv
NONLOCAL = bool(os.environ.get("SAOLEI_DB_PORT")) and os.environ["SAOLEI_DB_PORT"] != "3306"
if NONLOCAL and "--allow-nonlocal" not in sys.argv and not DRY:
    print("目标库非本地 3306，写入需显式 --allow-nonlocal")
    sys.exit(2)

local = pymysql.connect(host="127.0.0.1", port=3306, user="root",
                        database="saolei", charset="utf8mb4", autocommit=True)
target = pymysql.connect(
    host=os.environ.get("SAOLEI_DB_HOST", "127.0.0.1"),
    port=int(os.environ.get("SAOLEI_DB_PORT", "3306")),
    user=os.environ.get("SAOLEI_DB_USER", "root"),
    password=os.environ.get("SAOLEI_DB_PASSWORD", ""),
    database=os.environ.get("SAOLEI_DB_NAME", "saolei"),
    charset="utf8mb4", autocommit=False)
lc, tc = local.cursor(), target.cursor()


def key_of(ntype, user, ref, dd, ct):
    try:
        d = json.loads(dd or "{}")
    except Exception:
        d = {}
    if ntype == 10:
        return ("10", user)
    if ntype == 20:
        return ("20", ref, d.get("od") or "")
    if ntype == 30:
        return ("30", user, d.get("lv") or "")
    if ntype == 40:
        return ("40", ref)
    if ntype == 50:
        return ("50", user)
    if ntype == 51:
        return ("51", user, ct)
    if ntype == 52:
        return ("52", user, ref, ct)
    if ntype == 53:
        return ("53", user, d.get("ti") or "")
    return (str(ntype), user, ref, ct)


def fetch_all(cur):
    cur.execute("SELECT id, type, user, reference, details_data, create_time, exp_time, ranked FROM news")
    return cur.fetchall()


local_rows = fetch_all(lc)
target_rows = fetch_all(tc)
target_keys = {key_of(t, u, r, dd, ct) for _, t, u, _, r, dd, ct, _e, _k in target_rows}

# 本地有、生产无（排除本地测试：user 999xxx；user=1 的 type=52）
missing = []
for nid, ntype, u, ref, dd, ct, exp, rk in local_rows:
    if 999000 <= u <= 999999:
        continue
    if ntype == 52 and u == 1:
        continue
    k = key_of(ntype, u, ref, dd, ct)
    if k not in target_keys:
        missing.append((ct, nid, ntype, u, ref, dd, exp, rk))

missing.sort(key=lambda e: (e[0], e[1]))
print(f"本地 {len(local_rows)} 行，生产 {len(target_rows)} 行；本地有生产无: {len(missing)} 条")
by_type = defaultdict(int)
for _, _, t, *_ in missing:
    by_type[t] += 1
print("按类型:", dict(sorted(by_type.items())))
for e in missing[:12]:
    print(f"  {datetime.fromtimestamp(e[0]).strftime('%Y-%m-%d %H:%M')} type={e[2]} user={e[3]} ref={e[5]} {e[6][:60]}")

if not missing:
    print("无缺失，退出。")
    sys.exit(0)

if DRY:
    print("\n[dry-run] 未写库。确认后 --apply --allow-nonlocal 执行。")
    sys.exit(0)

# ---------- 尾部合并重排（id 序 = create_time 序铁律） ----------
cut = min(e[0] for e in missing)
tc.execute("SELECT id, type, user, reference, details_data, create_time, exp_time, ranked "
           "FROM news WHERE create_time >= %s ORDER BY id", (cut,))
tail = list(tc.fetchall())
print(f"\ncut={cut}（{datetime.fromtimestamp(cut)}）；尾部原行 {len(tail)} 条")
assert len(tail) < 50000, "尾部行数异常大，中止"

merged = [(ct, None, ntype, u, ref, dd, exp, rk) for ct, nid, ntype, u, ref, dd, exp, rk in missing]
for nid, ntype, u, ref, dd, ct, exp, rk in tail:
    merged.append((ct, nid, ntype, u, ref, dd, exp, rk))
merged.sort(key=lambda e: (e[0], e[1] if e[1] is not None else (1 << 62)))

# 2026-10-17 称号快照制：exp_time/ranked 随行携带（本地缺失行的快照即本地已回填值，
# 尾部生产原行快照原样保留），不再按成绩流水重放。
final_rows = [(ntype, ct, u, exp, rk, ref, dd) for ct, lid, ntype, u, ref, dd, exp, rk in merged]

print(f"重插 {len(final_rows)} 行（原 {len(tail)} + 新 {len(missing)}）")
tc.execute("DELETE FROM news WHERE create_time >= %s", (cut,))
print(f"已删尾部 {tc.rowcount} 行")
ins = 0
for i in range(0, len(final_rows), BATCH):
    batch = final_rows[i:i + BATCH]
    tc.executemany(
        "INSERT INTO news (type, create_time, user, exp_time, ranked, reference, details_data) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s)", batch)
    ins += len(batch)
target.commit()
print(f"[apply] 已重插 {ins} 行")

tc.execute("SELECT COUNT(*) FROM news a JOIN news b ON b.id=a.id+1 WHERE b.create_time < a.create_time")
inv = tc.fetchone()[0]
tc.execute("SELECT COUNT(*) FROM news")
cnt = tc.fetchone()[0]
print(f"校验: 总数 {cnt}；id↔时间逆序行 {inv}（应为 0）")
assert inv == 0
print("DONE")
