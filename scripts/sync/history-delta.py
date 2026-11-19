#!/usr/bin/env python3
"""history（扫雷历程/纪事）增量同步：旧站 staging -> 新站（本地/生产）

背景（2026-10-22 张老师发现 user/25669 十月纪事缺失）：transform.py 的 history
段是首导一次性段（无守卫但从不重跑），news 有 news-delta.py 而 history 一直没有
增量通道——旧站新写/修改的纪事在新站永远缺失。

同步语义（按 (user, year_month) 语义键对账，id 不对齐——新站 id 自增与
History_Id 无关，同 news「永不按 id 搬」原则）：
  1. 缺行：staging 有键、目标库无键 → INSERT（create_time=月初时间戳，
     update_time=0，同首导口径；内容截 500）
  2. 内容差异：staging 内容 ≠ 目标库内容 且目标库 update_time=0（非新站侧
     编辑）→ UPDATE content（旧站追加场景）
  3. 铁律：目标库 update_time>0 的行 = 新站侧用户编辑过，绝不覆盖

用法: python3 scripts/sync/history-delta.py [--apply]   默认 dry-run
连接（同 news-delta）：源 staging 走 SAOLEI_STG_*；目标库走 SAOLEI_DB_*
（写生产：3316 隧道 + --allow-nonlocal）。
⚠️ 生产禁建 schema 外表：--apply 不建备份表，生产侧备份用 mysqldump 到服务器文件。
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
stg = pymysql.connect(
    host=os.environ.get("SAOLEI_STG_HOST", "127.0.0.1"),
    port=int(os.environ.get("SAOLEI_STG_PORT", "3306")),
    user=os.environ.get("SAOLEI_STG_USER", "root"),
    password=os.environ.get("SAOLEI_STG_PASSWORD", ""),
    database=os.environ.get("SAOLEI_STG_NAME", "saolei_mssql"),
    charset="utf8mb4", autocommit=True)
cur, sc = my.cursor(), stg.cursor()

TZ_OFFSET = 8 * 3600


def ux(dt):
    """MSSQL datetime(北京时间) -> unix 秒（口径：naive datetime 视为 +08:00）"""
    if dt is None:
        return 0
    return int((dt - datetime(1970, 1, 1)).total_seconds() - TZ_OFFSET)


# ---------- 1. 两侧全量读取（小表：5 千行级） ----------
sc.execute("SELECT History_Player, History_Time, History_Text FROM History")
src = {}
for hp, htime, htext in sc.fetchall():
    ym = htime.strftime("%Y-%m") if htime else ""
    if not ym:
        continue
    src[(hp, ym)] = (ux(htime), (htext or "")[:500])
print(f"staging History 键: {len(src)}")

cur.execute("SELECT `user`, `year_month`, content, update_time FROM history")
dst = {}
dst_edited = set()  # 新站侧编辑过的键，绝不覆盖
for u, ym, content, upd in cur.fetchall():
    dst[(u, ym)] = content
    if upd and upd > 0:
        dst_edited.add((u, ym))
print(f"目标库 history 键: {len(dst)}（其中新站侧编辑过 {len(dst_edited)}，不覆盖）")

# ---------- 2. 对账 ----------
inserts, updates, skipped_edited = [], [], []
for key, (ts, text) in sorted(src.items()):
    if key not in dst:
        inserts.append((key, ts, text))
    elif dst[key] != text:
        if key in dst_edited:
            skipped_edited.append(key)
        else:
            updates.append((key, text))

if inserts:
    print(f"\n[缺行] {len(inserts)} 条：")
    for (u, ym), ts, text in inserts[:20]:
        print(f"  user={u} {ym}  {text[:50].replace(chr(10), ' ')}")
if updates:
    print(f"\n[内容更新] {len(updates)} 条（目标库非新站侧编辑）：")
    for (u, ym), text in updates[:20]:
        print(f"  user={u} {ym}  {text[:50].replace(chr(10), ' ')}")
if skipped_edited:
    print(f"\n[跳过·新站侧已编辑] {len(skipped_edited)} 条：")
    for u, ym in skipped_edited[:20]:
        print(f"  user={u} {ym}")

if not inserts and not updates:
    print("\n无差异，无需处理。")
    sys.exit(0)

if DRY:
    print(f"\n[dry-run] 未写库（将插 {len(inserts)} 行、更新 {len(updates)} 行）。确认后加 --apply 执行。")
    sys.exit(0)

# ---------- 3. 写库 ----------
if NONLOCAL:
    print("[生产] 不建 schema 外备份表；回滚靠服务器侧 mysqldump 备份文件。")

ins = cur.executemany(
    "INSERT INTO history (`user`,`year_month`,`content`,`create_time`,`update_time`) "
    "VALUES (%s,%s,%s,%s,0)",
    [(u, ym, text, ts) for (u, ym), ts, text in inserts])
print(f"已插入 {ins} 行")
upd = cur.executemany(
    "UPDATE history SET content=%s WHERE `user`=%s AND `year_month`=%s",
    [(text, u, ym) for (u, ym), text in updates])
print(f"已更新 {upd} 行")
my.commit()

# ---------- 4. 校验 ----------
cur.execute("SELECT COUNT(*) FROM history")
print(f"校验: history 总数 {cur.fetchone()[0]}")
for (u, ym), _, _ in inserts[:5]:
    cur.execute("SELECT LEFT(content,40) FROM history WHERE `user`=%s AND `year_month`=%s", (u, ym))
    r = cur.fetchone()
    print(f"  抽查 user={u} {ym}: {r[0] if r else '!!缺失!!'}")
print("DONE")
my.close()
stg.close()
