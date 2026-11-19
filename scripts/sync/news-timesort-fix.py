#!/usr/bin/env python3
"""news 时间序修复（2026-10-19 张老师拍板方案 B 配套数据修复）

背景：新站运行时破纪录动态（review.ts publishNews type=20）此前 createTime 取
rv.createTime（录像上传时间）。管理员补审积压旧录像时（上传 vs 过审间隔数日~数周），
动态行 id 追加表尾而 create_time 是旧时间 → 打破「id 序=create_time 序」铁律，
动态流按 id 倒序时时间错乱（2026-10-19 张老师报障）。写入点已改为审核时间
（createTime: rv.reviewTime!，与入伍动态同口径）；本脚本修正存量：
  1. 运行时行（type=20 且 details 的 cr 为数字——PHP 老站 or=0 数字但 cr 恒字符串、
     transform/record-news-backfill 同步行 or/cr 双字符串，数字 cr 唯一新站运行时）
     create_time 早于该录像审核时间 5min 以上 → 修正为 video.review_time
  2. 以 T=2026-09-22 00:00（新站上线切换期，此前数据全部来自 transform 一次性
     同步、天然有序）为界，新时代整段尾部重排：删 create_time >= T 的行，
     按 (create_time, id) 排序重插——回填错位行（news-delta/news-align 补的
     09-22~ 派生行）一并归位，恢复全表铁律
  3. 校验：全表相邻 id↔时间逆序对 = 0、行数不变

前置断言：T 之前的前缀区必须已有序（否则说明老数据也有问题，中止人工排查）。
幂等：修正过的行 create_time=review_time 后不再命中判别器；全表有序后重排为空操作。
生产：SAOLEI_DB_* env（3316 隧道）+ --allow-nonlocal；不建 schema 外备份表，
先服务器侧 mysqldump 备份再执行。

用法: python3 scripts/sync/news-timesort-fix.py [--apply]   默认 dry-run
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

# 新站上线切换期分界：此前全部为 transform 一次性同步数据（天然有序）
T = int(datetime(2026, 9, 22, 0, 0, 0).timestamp())

# ---------- 0. 现状与前置断言 ----------
cur.execute("SELECT COUNT(*) FROM news a JOIN news b ON b.id=a.id+1 "
            "WHERE b.create_time < a.create_time AND a.create_time < %s AND b.create_time < %s", (T, T))
inv_prefix = cur.fetchone()[0]
assert inv_prefix == 0, f"前缀区（<{datetime.fromtimestamp(T)}）存在 {inv_prefix} 对逆序，非本脚本范围，中止"

cur.execute("SELECT COUNT(*) FROM news a JOIN news b ON b.id=a.id+1 WHERE b.create_time < a.create_time")
inv_before = cur.fetchone()[0]
cur.execute("SELECT COUNT(*) FROM news")
cnt_before = cur.fetchone()[0]
print(f"修复前：总行数 {cnt_before}；全表相邻 id↔时间逆序对 {inv_before}")

# ---------- 1. 运行时 type=20 行（cr 数字）需修正者 ----------
cur.execute("""SELECT n.id, n.create_time, v.review_time, n.user, n.reference
            FROM news n JOIN video v ON v.id = n.reference
            WHERE n.type = 20 AND n.details_data REGEXP '"cr":[0-9]'""")
runtime = list(cur.fetchall())
to_fix = [(nid, nct, vrt, u, ref) for nid, nct, vrt, u, ref in runtime
          if vrt and vrt > nct + 300]
print(f"运行时 type=20 行（cr 数字）共 {len(runtime)}；其中 create_time 早于审核 5min+ 待修正 {len(to_fix)}")
for nid, nct, vrt, u, ref in to_fix[:20]:
    print(f"  news={nid} {datetime.fromtimestamp(nct)} -> {datetime.fromtimestamp(vrt)} (user={u} video={ref})")
assert len(to_fix) < 100, "待修正行数异常，中止人工核查"

if inv_before == 0 and not to_fix:
    print("\n全表已有序且无需修正，退出。")
    sys.exit(0)

# ---------- 2. dry-run 汇总 ----------
cur.execute("SELECT COUNT(*) FROM news WHERE create_time >= %s", (T,))
tail_n = cur.fetchone()[0]
print(f"\n重排区间: create_time >= {datetime.fromtimestamp(T)}，共 {tail_n} 行（含修正后行）")
assert tail_n < 50000, "重排区间异常大，中止"

if DRY:
    print(f"\n[dry-run] 将①修正 {len(to_fix)} 行 create_time=审核时间 ②区间 {tail_n} 行按 (create_time, id) 重排重插。")
    print("[dry-run] 未写库。确认后加 --apply 执行。")
    sys.exit(0)

# ---------- 3. 修正 create_time ----------
for nid, nct, vrt, u, ref in to_fix:
    cur.execute("UPDATE news SET create_time = %s WHERE id = %s", (vrt, nid))
print(f"已修正 {len(to_fix)} 行 create_time = 审核时间")

# ---------- 4. 尾部重排（新时代整段） ----------
cur.execute("""SELECT id, type, user, reference, details_data, create_time, exp_time, ranked
            FROM news WHERE create_time >= %s ORDER BY id""", (T,))
tail = list(cur.fetchall())
tail.sort(key=lambda r: (r[5], r[0]))  # (create_time, 原 id)：同刻保持原相对顺序
cur.execute("DELETE FROM news WHERE create_time >= %s", (T,))
print(f"已删区间 {cur.rowcount} 行")
BATCH = 5000
ins = 0
for i in range(0, len(tail), BATCH):
    batch = [(r[1], r[5], r[2], r[6], r[7], r[3], r[4]) for r in tail[i:i + BATCH]]
    cur.executemany(
        "INSERT INTO news (type, create_time, user, exp_time, ranked, reference, details_data) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s)", batch)
    ins += len(batch)
my.commit()
print(f"[apply] 已重插 {ins} 行")

# ---------- 5. 校验 ----------
cur.execute("SELECT COUNT(*) FROM news a JOIN news b ON b.id=a.id+1 WHERE b.create_time < a.create_time")
inv_after = cur.fetchone()[0]
cur.execute("SELECT COUNT(*) FROM news")
cnt_after = cur.fetchone()[0]
print(f"校验: 总数 {cnt_after}（应={cnt_before}）；id↔时间逆序对 {inv_after}（应为 0）")
assert cnt_after == cnt_before, "行数变化异常"
assert inv_after == 0, "修复后仍存在 id 序与时间序不一致"
print("DONE")
my.close()
