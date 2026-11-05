#!/usr/bin/env python3
"""纪录录像被封后的军衔快照统一重放修正（2026-11-05，起因 /user/28321）

背景：纪录录像（曾持有个人纪录、在 video_scores_exp 有流水）被后台屏蔽时，
审核级联已做：成绩回退（user_scores）、纪录动态链重放（syncRecordNewsChain）、
STNB/排名快照刷新——但**行内军衔快照 exp_time 没有统一修正**：
news/comment/bbs_post/bbs_reply/video 行内残留由已封成绩派生的旧值，
渲染端 recordNewsExpTime 的 min(快照, 本盘) 公式救不了（快照本身指向已封成绩），
页面出现「大徽章上士、行内全是上尉」的错位。

口径：与 scripts/backfill-title-snapshot.py 完全同源的重放——
  基底 = video_scores_exp (score_time>0)（屏蔽录像的流水已删，天然排除）
  - news：入伍(10)「含同刻」（f.ct <= ct）；其余类型严格早于（f.ct < ct）
  - comment / bbs_post / bbs_reply / video：严格早于
  - 只修 exp_time != expect 的行（幂等，护栏 IF(exp_time=旧值)）；ranked 一律不动
  - expect=0 且 snap>0 的 C 类也修（首纪录被封 → 回预备役，「视同从未存在」）

用法:
  本地:   python3 scripts/fix-record-ban-snapshots.py --users 28321
  全量:   python3 scripts/fix-record-ban-snapshots.py --all
  落库:   加 --apply（默认 dry-run 只报告）；非本地库需 --allow-nonlocal
备份:     fix-record-ban-snapshots-<ts>.tsv 逐行记录 (表,id,user,旧值,新值,时间)
"""

import os
import sys
import time
from collections import defaultdict

import pymysql

BATCH = 2000
DRY = "--apply" not in sys.argv
ALLOW_NONLOCAL = "--allow-nonlocal" in sys.argv

# ---------- 连接（与项目脚本惯例一致：默认本地，非本地需显式 --allow-nonlocal） ----------

def connect():
    host = os.environ.get("SAOLEI_DB_HOST", "localhost")
    user = os.environ.get("SAOLEI_DB_USER", "root")
    password = os.environ.get("SAOLEI_DB_PASS", "")
    db = os.environ.get("SAOLEI_DB_NAME", "saolei")
    if host not in ("localhost", "127.0.0.1") and not ALLOW_NONLOCAL:
        sys.exit("非本地库需显式 --allow-nonlocal")
    return pymysql.connect(host=host, user=user, password=password, database=db,
                           charset="utf8mb4", autocommit=False)


def parse_users():
    for a in sys.argv[1:]:
        if a.startswith("--users="):
            return {int(x) for x in a.split("=", 1)[1].split(",") if x.strip()}
    if "--users" in sys.argv:
        idx = sys.argv.index("--users")
        return {int(x) for x in sys.argv[idx + 1].split(",") if x.strip()}
    if "--all" in sys.argv:
        return None
    sys.exit("需指定 --users=id1,id2 或 --all")


def load_flows(cur, users):
    """video_scores_exp 流水按用户分组排序；--users 模式只拉目标用户"""
    where = ""
    if users is not None:
        ids = ",".join(str(u) for u in users)
        where = f" AND user IN ({ids})"
    cur.execute(f"SELECT user, score_time, create_time FROM video_scores_exp WHERE score_time > 0{where}")
    by_user = defaultdict(list)
    for uid, st, ct in cur.fetchall():
        by_user[int(uid)].append((int(ct), int(st)))
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


def fix_table(cur, table, users, by_user, has_type, backup):
    """扫描一张表的快照行，收集 exp_time != expect 的行并批量带护栏修正"""
    print(f"\n== {table} ==")
    cols = "id, user, create_time, type, exp_time" if has_type else "id, user, create_time, 0, exp_time"
    where = ""
    if users is not None:
        ids = ",".join(str(u) for u in users)
        where = f" WHERE user IN ({ids})"
    cur.execute(f"SELECT {cols} FROM {table}{where}")
    total = 0
    updates = []  # (id, old, new, uid, ct)
    for rid, uid, ct, ntype, snap in cur.fetchall():
        uid, ct, snap = int(uid), int(ct), int(snap)
        total += 1
        inc = has_type and ntype == 10  # 入伍动态含同刻；晋升(53)已整体下线
        new = replay(by_user, uid, ct, inc)
        if snap != new:
            updates.append((int(rid), snap, new, uid, ct))
    print(f"  扫描 {total} 行，待修 {len(updates)} 行")
    for u in updates[:8]:
        print(f"    id={u[0]} user={u[3]} ct={u[4]} {u[1]} -> {u[2]}")
    if not updates:
        return 0
    with open(backup, "a") as fh:
        for rid, old, new, uid, ct in updates:
            fh.write(f"{table}\t{rid}\t{uid}\t{old}\t{new}\t{ct}\n")
    if not DRY:
        n = 0
        for i in range(0, len(updates), BATCH):
            chunk = updates[i : i + BATCH]
            cases = " ".join(
                f"WHEN {rid} THEN IF(exp_time={old},{new},exp_time)" for rid, old, new, _, _ in chunk
            )
            ids = ",".join(str(rid) for rid, _, _, _, _ in chunk)
            cur.execute(f"UPDATE {table} SET exp_time = CASE id {cases} END WHERE id IN ({ids})")
            n += cur.rowcount
        print(f"  已更新 {n} 行")
    return len(updates)


if __name__ == "__main__":
    users = parse_users()
    conn = connect()
    cur = conn.cursor()
    scope = "全量" if users is None else f"用户 {sorted(users)}"
    print(("[dry-run] " if DRY else "") + f"纪录封禁军衔快照统一重放（{scope}）")

    by_user = load_flows(cur, users)
    print(f"video_scores_exp 基底涉及用户 {len(by_user)} 人")

    ts = time.strftime("%Y%m%d-%H%M%S")
    backup = os.environ.get("SNAPSHOT_BACKUP", f"fix-record-ban-snapshots-{ts}.tsv")
    if not DRY:
        with open(backup, "w") as fh:
            fh.write("table\tid\tuser\told_exp_time\tnew_exp_time\tcreate_time\n")
        print(f"备份: {backup}")

    grand = 0
    grand += fix_table(cur, "news", users, by_user, True, backup)
    grand += fix_table(cur, "comment", users, by_user, False, backup)
    grand += fix_table(cur, "bbs_post", users, by_user, False, backup)
    grand += fix_table(cur, "bbs_reply", users, by_user, False, backup)
    grand += fix_table(cur, "video", users, by_user, False, backup)
    print(f"\n共待修 {grand} 行" + ("" if DRY else "，已落库（幂等护栏 IF(旧值)）"))
    if DRY:
        conn.rollback()
        print("[dry-run] 未落库")
    else:
        conn.commit()
    conn.close()
