#!/usr/bin/env python3
"""称号快照制回填（2026-10-17）：为 news / comment / bbs_post / bbs_reply / video 的
exp_time / ranked 快照列回填存量值，作为一次性迁移数据。

口径与 src/lib/queries.ts expTimeAtBatch（现渲染重放逻辑）保持一致：
  - exp_time = 该用户在快照时刻的高级时间 running best（毫秒，0=无成绩）
    * news：入伍(10)/晋升(53)「含同刻」（f.ct <= ct），破纪录(20)与其余类型「严格早于」（f.ct < ct）
    * comment / bbs_post / bbs_reply：严格早于（快照=发布当时已有成绩）
    * video：严格早于 create_time（与现渲染口径 expTimeAtBatch 一致）
  - ranked = 发布时用户是否在榜。历史封禁时刻无完整流水，统一按「当前 user.status=0」回填
    （历史上被封时发布的行未来由自选体系按 ranked=0 处理；运行时快照由写入路径实时取）。

数据源：video_scores_exp（主键=录像 id，含 user/score_time/create_time）——
与 expTimeAtBatch 同源，23 万动态/30 万录像全量重放，内存分组扫描，分批 UPDATE。

用法（本地）: python3 scripts/backfill-title-snapshot.py [--dry-run]
生产: SAOLEI_DB_HOST=... SAOLEI_DB_USER=... SAOLEI_DB_PASS=... python3 scripts/backfill-title-snapshot.py --allow-nonlocal
"""

import os
import sys

import pymysql

BATCH = 2000

# ---------- 连接（与项目脚本惯例一致：默认本地，非本地需显式 --allow-nonlocal）----------

def connect():
    host = os.environ.get("SAOLEI_DB_HOST", "localhost")
    user = os.environ.get("SAOLEI_DB_USER", "root")
    password = os.environ.get("SAOLEI_DB_PASS", "")
    db = os.environ.get("SAOLEI_DB_NAME", "saolei")
    nonlocal_ok = "--allow-nonlocal" in sys.argv
    if host not in ("localhost", "127.0.0.1") and not nonlocal_ok:
        sys.exit("非本地库需显式 --allow-nonlocal")
    return pymysql.connect(host=host, user=user, password=password, database=db, charset="utf8mb4")


cur = None


def fetch_flows():
    """全量拉 video_scores_exp 流水，按用户分组排序（内存重放基底）"""
    cur.execute("SELECT user, score_time, create_time FROM video_scores_exp WHERE score_time > 0")
    by_user = {}
    for uid, st, ct in cur.fetchall():
        by_user.setdefault(int(uid), []).append((int(ct), int(st)))
    for lst in by_user.values():
        lst.sort()
    return by_user


def replay(by_user, uid, ct, inclusive):
    """重放 uid 在 ct 时刻的 running best；inclusive=含同刻"""
    lst = by_user.get(uid)
    if not lst:
        return 0
    best = 0
    for fct, s in lst:
        if fct > ct if inclusive else fct >= ct:
            break
        if best == 0 or s < best:
            best = s
    return best


def backfill_table(table, time_col, extra_where="", inclusive_types=None, has_type=False):
    """回填一张表。inclusive_types: 该表内「含同刻」的 type 集合（news 用）"""
    print(f"\n== {table} ==")
    where = f"WHERE {extra_where}" if extra_where else ""
    cols = f"id, user, {time_col}, type" if has_type else f"id, user, {time_col}, 0"
    cur.execute(f"SELECT {cols} FROM {table} {where}")
    rows = cur.fetchall()
    total = len(rows)
    print(f"  待回填 {total} 行")
    updates = []
    for rid, uid, ct, ntype in rows:
        inc = bool(inclusive_types and int(ntype) in inclusive_types)
        exp = replay(by_user, int(uid), int(ct), inc)
        updates.append((exp, ranked_now.get(int(uid), 0), int(rid)))
    # 分批 CASE WHEN UPDATE
    done = 0
    for i in range(0, len(updates), BATCH):
        chunk = updates[i : i + BATCH]
        cases_e = " ".join(f"WHEN {r} THEN {e}" for e, _, r in chunk)
        cases_r = " ".join(f"WHEN {r} THEN {k}" for _, k, r in chunk)
        ids = ",".join(str(r) for _, _, r in chunk)
        sql = (
            f"UPDATE {table} SET exp_time = CASE id {cases_e} END, "
            f"ranked = CASE id {cases_r} END WHERE id IN ({ids})"
        )
        if DRY_RUN:
            continue
        cur.execute(sql)
        done += len(chunk)
        if done % 40000 < BATCH:
            print(f"  已回填 {done}/{total}")
    if not DRY_RUN:
        print(f"  完成 {done}/{total}")
    # 对账：抽样验证
    cur.execute(f"SELECT COUNT(*) FROM {table} WHERE exp_time > 0")
    print(f"  exp_time>0 行数: {cur.fetchone()[0]}")


if __name__ == "__main__":
    DRY_RUN = "--dry-run" in sys.argv
    conn = connect()
    cur = conn.cursor()
    print(("[dry-run] " if DRY_RUN else "") + "称号快照回填启动")

    # ranked 基底：当前 user.status=0 → 1
    cur.execute("SELECT id FROM user WHERE status = 0")
    ranked_now = {int(r[0]): 1 for r in cur.fetchall()}
    print(f"当前在榜用户 {len(ranked_now)} 人")

    by_user = fetch_flows()
    print(f"video_scores_exp 涉及用户 {len(by_user)} 人")

    # news：入伍(10)/晋升(53)含同刻；其余严格早于
    backfill_table("news", "create_time", inclusive_types={10, 53}, has_type=True)
    # comment / bbs_post / bbs_reply / video：严格早于
    backfill_table("comment", "create_time")
    backfill_table("bbs_post", "create_time")
    backfill_table("bbs_reply", "create_time")
    backfill_table("video", "create_time")

    if not DRY_RUN:
        conn.commit()
    conn.close()
    print("\n全部完成")
