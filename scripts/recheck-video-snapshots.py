#!/usr/bin/env python3
"""video.exp_time 存量复核：语义升级为「过审时刻 + 上传序前缀 min」（2026-11-21 张老师定）

背景（/user/35193 判例）：同批上传多盘录像，只有破纪录那盘显新军衔，其余停在
旧军衔——video.exp_time 原语义=「上传时刻」user_scores.exp_time，同审核周期的
联动不存在。新语义（与 src/lib/titlesnapshots.ts recheckVideoSnapshotsAlongUpload
同一口径，两处必须同步改）：

  每盘录像的快照 = 截至本盘「入池时刻」（老站段=create_time；新站段=
  max(create_time, review_time)，即过审时刻）的高级 running best；
  并沿上传序 (create_time, id) 做前缀 min 钳制——新录像军衔绝不允许比
  旧录像还低（乱序审回弹根治）。

  行期望值：
  - 本盘在流水（已过审且 score_time>0）→ 前缀 best（含本盘）；
  - 不在流水（待审/运气盘/屏蔽中/初中级盘）→ 本盘上传时刻严格早于的 running best；
  - 期望=0 → 快照 0（预备役）；ranked 一律不动。

覆盖：处理「有高级流水」∪「video 表有 exp_time≠0 行」的用户全集——
纯初中级玩家 / exp 成绩全被封的用户（无流水但可能有残留快照）同样被复核清零。

幂等：只修 exp_time != expect 的行；UPDATE 带 IF(exp_time=旧值) 护栏（防并发覆盖）。
备份：recheck-video-snapshots-<ts>.tsv 逐行 (id, user, 旧值, 新值, create_time)。

用法:
  本地:     python3 scripts/recheck-video-snapshots.py --users=35193
  全量:     python3 scripts/recheck-video-snapshots.py --all
  落库:     加 --apply（默认 dry-run 只报告）；非本地库需 --allow-nonlocal
"""

import os
import sys
import time
from collections import defaultdict

import pymysql

BATCH = 2000
DRY = "--apply" not in sys.argv
ALLOW_NONLOCAL = "--allow-nonlocal" in sys.argv

NEW_SITE_TS = 1790179200  # 2026-09-24 新站上线时刻（秒）。此前=老站同步段


def connect():
    host = os.environ.get("SAOLEI_DB_HOST", "localhost")
    user = os.environ.get("SAOLEI_DB_USER", "root")
    password = os.environ.get("SAOLEI_DB_PASS", "")
    db = os.environ.get("SAOLEI_DB_NAME", "saolei")
    # SAOLEI_DB_PORT：SSH 隧道连生产用（deploy.md：3307 常被占，用 3316 等不常见端口）
    port = int(os.environ.get("SAOLEI_DB_PORT", "3306"))
    if host not in ("localhost", "127.0.0.1") and not ALLOW_NONLOCAL:
        sys.exit("非本地库需显式 --allow-nonlocal")
    return pymysql.connect(host=host, port=port, user=user, password=password, database=db,
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


def inflow_time(ct, rt):
    """流水行的真实入池时刻。老站段=create_time；新站段=max(create_time, review_time)
    （过审才入池；rt 缺失按 create_time）。与 titlesnapshots.ts inflowTime 同源。"""
    if ct < NEW_SITE_TS:
        return ct
    return max(ct, rt) if rt is not None else ct


def load_flows(cur, users):
    """video_scores_exp 流水按用户分组：(入池时刻, id, score_time)，按 (ct, id) 排序。
    入池时刻口径 2026-11-21 升级：见 inflow_time。--users 模式只拉目标用户。"""
    where = ""
    if users is not None:
        ids = ",".join(str(u) for u in users)
        where = f" AND f.user IN ({ids})"
    cur.execute(
        "SELECT f.user, f.id, f.score_time, f.create_time, v.review_time "
        "FROM video_scores_exp f JOIN video v ON v.id = f.id "
        f"WHERE f.score_time > 0{where}"
    )
    by_user = defaultdict(list)
    for uid, fid, st, ct, rt in cur.fetchall():
        by_user[int(uid)].append((inflow_time(int(ct), rt and int(rt) or None), int(fid), int(st)))
    for lst in by_user.values():
        lst.sort(key=lambda x: (x[0], x[1]))
    return by_user


def load_videos(cur, users):
    """video 行按用户分组：(create_time, id, exp_time)，按上传序 (create_time, id) 排序。
    --users 模式只拉目标用户；--all 模式全量拉（约 31 万行，内存可承受）。"""
    where = ""
    if users is not None:
        ids = ",".join(str(u) for u in users)
        where = f" WHERE user IN ({ids})"
    cur.execute(f"SELECT user, id, create_time, exp_time FROM video{where}")
    by_user = defaultdict(list)
    for uid, vid, ct, snap in cur.fetchall():
        by_user[int(uid)].append((int(ct), int(vid), int(snap)))
    for lst in by_user.values():
        lst.sort(key=lambda x: (x[0], x[1]))
    return by_user


def prefix_best(lst):
    """流水前缀 running best：bestAt[i] = 前缀（含 i）最好成绩"""
    out = []
    best = 0
    for _, _, st in lst:
        if best == 0 or st < best:
            best = st
        out.append(best)
    return out


def replay_strict(lst, ct):
    """上传时刻严格早于（f.ct >= ct 即断）的 running best——待审/运气盘/屏蔽中行用"""
    best = 0
    for fct, _, st in lst:
        if fct >= ct:
            break
        if best == 0 or st < best:
            best = st
    return best


def recheck_user(uid, videos, flows, backup, dry, cur):
    """单用户：video 行按上传序 (create_time, id) 重放+前缀 min 钳制，返回修正行数"""
    bestAt = prefix_best(flows)
    idx_by_id = {fid: i for i, (_, fid, _) in enumerate(flows)}
    floor = 0  # 前缀 min 钳制地板：上传序前面行已写入的最小毫秒值（军衔只升不降）
    updates = []
    for ct, vid, snap in videos:
        i = idx_by_id.get(vid)
        if i is not None:
            expect = bestAt[i]
        else:
            expect = replay_strict(flows, ct)
        # 前缀 min 钳制：新录像军衔不得低于旧录像（floor>0 时 expect=0 防御性兜住）
        if floor > 0 and (expect == 0 or expect > floor):
            expect = floor
        if expect > 0:
            floor = min(floor, expect) if floor > 0 else expect
        if snap != expect:
            updates.append((vid, snap, expect, ct))
    if not updates:
        return 0
    with open(backup, "a") as fh:
        for vid, old, new, ct in updates:
            fh.write(f"{vid}\t{uid}\t{old}\t{new}\t{ct}\n")
    if not dry:
        for i in range(0, len(updates), BATCH):
            chunk = updates[i : i + BATCH]
            cases = " ".join(
                f"WHEN {vid} THEN IF(exp_time={old},{new},exp_time)" for vid, old, new, _ in chunk
            )
            ids = ",".join(str(vid) for vid, _, _, _ in chunk)
            cur.execute(f"UPDATE video SET exp_time = CASE id {cases} END WHERE id IN ({ids})")
    return len(updates)


if __name__ == "__main__":
    users = parse_users()
    conn = connect()
    cur = conn.cursor()
    scope = "全量" if users is None else f"用户 {sorted(users)}"
    print(("[dry-run] " if DRY else "") + f"video.exp_time 过审时刻复核（{scope}）")

    by_flow = load_flows(cur, users)
    by_video = load_videos(cur, users)
    # 处理用户全集 = 有流水 ∪ 有 exp_time≠0 残留（纯初中级玩家也要清残留）
    todo = set(by_flow.keys()) | {
        uid for uid, rows in by_video.items() if any(snap != 0 for _, _, snap in rows)
    }
    if users is not None:
        todo |= users  # 指定用户即使无流水无残留也过一遍（幂等报告）
    print(f"高级流水用户 {len(by_flow)} 人，本次复核 {len(todo)} 人")

    ts = time.strftime("%Y%m%d-%H%M%S")
    backup = os.environ.get("SNAPSHOT_BACKUP", f"recheck-video-snapshots-{ts}.tsv")
    if not DRY:
        with open(backup, "w") as fh:
            fh.write("id\tuser\told_exp_time\tnew_exp_time\tcreate_time\n")
        print(f"备份: {backup}")

    grand = 0
    for uid in sorted(todo):
        grand += recheck_user(uid, by_video.get(uid, []), by_flow.get(uid, []), backup, DRY, cur)
    print(f"\n共修正 {grand} 行" + ("" if DRY else "（幂等护栏 IF(旧值)）"))
    if DRY:
        conn.rollback()
        print("[dry-run] 未落库")
    else:
        conn.commit()
    conn.close()
