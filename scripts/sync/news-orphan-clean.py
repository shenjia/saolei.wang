#!/usr/bin/env python3
"""孤儿动态清理（2026-10-22 张老师要求：帖/评论删除后动态同步消失——存量补齐）

背景：删除联动逻辑 2026-10-22 才上线，此前删除的帖/评论对应的动态仍残留在库里：
  · type=40（发表了文章）：主题已删（bbs_post.status=-1）但动态还在
  · type=52 kind=bbs（评论了文章）：楼层已删（bbs_reply.status=-1）或主题已删，动态还在
  · type=52 kind=video（评论了一盘录像）：评论已删（comment.status=-1/行不存在）或录像已下线
  · type=52 无 cid 行（2026-10-15 前存量，无法精确匹配）：按「同帖同人无 cid 行整组撤」
    口径处理——同一批产生的动态与删除联动（退避口径同 lib/bbs.ts commentNewsWhere）
  · type=52 kind=bbs 自评行（2026-10-22 张老师要求：自评自己的文章不发动态）：
    动态作者=楼主本人的行一并撤（含 2026-10-22 前产生的存量）

幂等：删除条件全部基于「目标内容已不存在/不可见」，清过即不再命中。
注意：不处理 type=20/21/22/30（录像类动态的屏蔽级联在 review.ts 已有，103 条残留在
生产/本地属于另一口径——屏蔽发生在级联上线前的历史录像，需要单独盘点，不在本脚本范围）。

用法: python3 scripts/sync/news-orphan-clean.py [--apply]   默认 dry-run 打印将删的行
生产: SAOLEI_DB_* env（3316 隧道）+ --allow-nonlocal；先服务器侧 mysqldump 备份再执行。
"""
import json
import os
import sys

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


def cid_of(details: str):
    """提取 details JSON 的 cid（无则 None）"""
    try:
        d = json.loads(details) if details else {}
        c = d.get("cid")
        return int(c) if isinstance(c, (int, float, str)) and str(c).isdigit() else None
    except (ValueError, TypeError):
        return None


total_del = 0

# ---------- 1. type=40：主题已删 ----------
cur.execute("""
  SELECT n.id, n.user, n.reference, n.details_data FROM news n
  WHERE n.type = 40
    AND NOT EXISTS (SELECT 1 FROM bbs_post p WHERE p.id = n.reference AND p.status IN (0, 5))
""")
rows = list(cur.fetchall())
print(f"[1] type=40 主题已删的孤儿动态：{len(rows)} 行")
for nid, u, ref, dd in rows[:50]:
    print(f"  news={nid} user={u} post={ref} {str(dd)[:60]}")
if rows:
    if DRY:
        print("  [dry-run] 未删除")
    else:
        cur.execute("DELETE FROM news WHERE id IN (%s)" % ",".join(str(r[0]) for r in rows))
        print(f"  已删除 {cur.rowcount} 行")
        total_del += cur.rowcount

# ---------- 2. type=52 kind=bbs：楼层已删（精确 cid）或无 cid 存量 ----------
cur.execute("""
  SELECT n.id, n.user, n.reference, n.details_data FROM news n
  WHERE n.type = 52 AND n.details_data LIKE '%"kind":"bbs"%'
""")
rows = list(cur.fetchall())
del_ids = []
del_nocid = []
for nid, u, ref, dd in rows:
    cid = cid_of(dd)
    if cid is None:
        # 无 cid 存量行：该 user 在该帖下已无任何可见楼层 → 整组撤
        cur.execute(
            "SELECT COUNT(*) FROM bbs_reply WHERE post=%s AND user=%s AND status IN (0,5)",
            (ref, u))
        if cur.fetchone()[0] == 0:
            del_nocid.append((nid, u, ref))
    else:
        cur.execute(
            "SELECT COUNT(*) FROM bbs_reply WHERE id=%s AND status IN (0,5) AND post=%s",
            (cid, ref))
        if cur.fetchone()[0] == 0:
            del_ids.append((nid, u, ref, cid))

print(f"[2] type=52 kind=bbs 孤儿动态：精确 cid {len(del_ids)} 行 + 无 cid 存量 {len(del_nocid)} 行")
for t in (del_ids + del_nocid)[:50]:
    print(f"  news={t[0]} user={t[1]} post={t[2]}")
if DRY:
    print("  [dry-run] 未删除")
else:
    all_ids = [t[0] for t in del_ids + del_nocid]
    if all_ids:
        cur.execute("DELETE FROM news WHERE id IN (%s)" % ",".join(str(i) for i in all_ids))
        print(f"  已删除 {cur.rowcount} 行")
        total_del += cur.rowcount

# ---------- 3. type=52 kind=video / 无 kind：评论已删或录像下线 ----------
cur.execute("""
  SELECT n.id, n.user, n.reference, n.details_data FROM news n
  WHERE n.type = 52
    AND (n.details_data LIKE '%"kind":"video"%' OR n.details_data NOT LIKE '%"kind":%')
""")
rows = list(cur.fetchall())
del_ids = []
for nid, u, ref, dd in rows:
    cid = cid_of(dd)
    if cid is not None:
        cur.execute(
            "SELECT COUNT(*) FROM comment WHERE id=%s AND status IN (0,5) AND video=%s",
            (cid, ref))
        if cur.fetchone()[0] == 0:
            del_ids.append((nid, u, ref, cid))
    else:
        # 完全无标记的历史行：该 user 对该录像已无可见评论 → 撤
        cur.execute(
            "SELECT COUNT(*) FROM comment WHERE video=%s AND user=%s AND status IN (0,5)",
            (ref, u))
        if cur.fetchone()[0] == 0:
            del_ids.append((nid, u, ref, None))

print(f"[3] type=52 录像评论孤儿动态：{len(del_ids)} 行")
for t in del_ids[:50]:
    print(f"  news={t[0]} user={t[1]} video={t[2]}")
if DRY:
    print("  [dry-run] 未删除")
else:
    all_ids = [t[0] for t in del_ids]
    if all_ids:
        cur.execute("DELETE FROM news WHERE id IN (%s)" % ",".join(str(i) for i in all_ids))
        print(f"  已删除 {cur.rowcount} 行")
        total_del += cur.rowcount

# ---------- 4. type=52 kind=bbs 自评行：动态作者=楼主（自评不发动态，2026-10-22 起）----------
cur.execute("""
  SELECT n.id, n.user, n.reference FROM news n
  JOIN bbs_post p ON p.id = n.reference
  WHERE n.type = 52 AND n.details_data LIKE '%"kind":"bbs"%'
    AND n.user = p.user
""")
rows = list(cur.fetchall())
print(f"[4] type=52 kind=bbs 自评自己文章的动态：{len(rows)} 行")
for nid, u, ref in rows[:50]:
    print(f"  news={nid} user={u} post={ref}")
if DRY:
    print("  [dry-run] 未删除")
else:
    if rows:
        cur.execute("DELETE FROM news WHERE id IN (%s)" % ",".join(str(r[0]) for r in rows))
        print(f"  已删除 {cur.rowcount} 行")
        total_del += cur.rowcount

if DRY:
    print("\n[dry-run] 以上为待删清单，加 --apply 执行。")
    my.rollback()
else:
    my.commit()
    print(f"\n完成：共删除 {total_del} 行孤儿动态。")
my.close()
