#!/usr/bin/env python3
"""入伍吞纪录动态回填（2026-10-24）：首次入伍与破纪录动态在历史口径（含 2013 老站
VideoScores.php）中为 if/else 互斥——三级成绩首次齐全（sum_time 0→正）那一刻的录像
只发入伍动态（type=10），它同时创造的各级首纪录动态（type=20）从不落库。
1f64f40 已改为「先纪录、后入伍」，本脚本按同一口径补发存量缺失行。

回填口径（与 src/lib/review.ts REVIEWED 分支 / userScoresOnInsert 逐条对齐）：
  - 重放每个用户 status=20 录像（flag 榜语义，NF 录像同样进 flag 榜发动态），
    按 (review_time, id) 升序，规则：时间更小才更新 / 3BV/s 更大且 >0 才更新，
    三级时间齐全才算 sum_time；sum_time 0→正的录像 = 入伍录像。
  - 待补行 = 入伍录像当时新立的 best（beg/int/exp × time/3bvs），
    or=覆盖前旧值（无则 0）、cr=新值、exp_time 快照=覆盖前旧 expTime、
    ranked=当前 user.status==0（同 backfill-title-snapshot.py 惯例）、
    create_time=录像上传时间（2026-10-20 口径）、reference=录像 id、details nf=0。
  - 幂等：news 里已存在同 (user, reference, lv, od) 的 type=20 行（新老两种 JSON
    形态都解析）则跳过——老站自带动态（旧 3BV 限界规则产生）天然不重复。
  - 3BV/s 限界用现行 MIN_3BV_FOR_3BVS（初 10 / 中高 4，2026-10-16 起）。
    老站曾用初 4——老站按旧规则发过的动态已在库里（幂等跳过），仅「老站入伍
    录像本身是初级 3BV 4~9 的 3BV/s 纪录」这一极端边角不再补发。
  - --mode=all 额外补发非入伍路径的缺动态（历史补审/重算等导致的漏发），
    默认只补入伍吞掉的部分（张老师 2026-10-24 需求）。
  - 重放终态与 user_scores 逐用户校验，不一致数写入报告（历史口径漂移所致，
    不影响补发行本身的正确性——每行只依赖该录像设立 best 这一事实）。

用法（本地）: ~/.workbuddy/binaries/python/envs/default/bin/python3 scripts/backfill-enlist-records.py
生产: SAOLEI_DB_HOST=... SAOLEI_DB_USER=... SAOLEI_DB_PASS=... ... --allow-nonlocal --apply
不带 --apply 一律只打印报告，不写库。
"""

import json
import os
import sys

import pymysql

LEVELS = ("beg", "int", "exp")
ORDERS = ("time", "3bvs")
BATCH = 1000
MIN_3BV_FOR_3BVS = {"beg": 10, "int": 4, "exp": 4}


def connect():
    host = os.environ.get("SAOLEI_DB_HOST", "localhost")
    port = int(os.environ.get("SAOLEI_DB_PORT", "3306"))
    user = os.environ.get("SAOLEI_DB_USER", "root")
    password = os.environ.get("SAOLEI_DB_PASSWORD", os.environ.get("SAOLEI_DB_PASS", ""))
    db = os.environ.get("SAOLEI_DB_NAME", "saolei")
    if host not in ("localhost", "127.0.0.1") and "--allow-nonlocal" not in sys.argv:
        sys.exit("非本地库需显式 --allow-nonlocal")
    return pymysql.connect(
        host=host, port=port, user=user, password=password, database=db,
        charset="utf8mb4", autocommit=False,
    )


conn = connect()
cur = conn.cursor()
apply_mode = "--apply" in sys.argv
mode_all = "--mode=all" in sys.argv
debug_user = None
for a in sys.argv:
    if a.startswith("--user="):
        debug_user = int(a.split("=", 1)[1])


def f(level, order, suffix=""):
    return f"{level}{'Time' if order == 'time' else '3bvs'}{suffix}"


# ---------- 1. 用户在榜状态（ranked 按当前 status，惯例同称号快照回填） ----------
cur.execute("SELECT id, status FROM user")
ranked = {int(uid): (int(st) == 0) for uid, st in cur.fetchall()}

# ---------- 2. 全部已通过录像，按用户分组 ----------
print("载入录像…")
cur.execute(
    "SELECT v.id, v.user, v.level, v.review_time, v.create_time, vi.board_3bv, vi.real_time "
    "FROM video v JOIN video_info vi ON vi.id = v.id "
    "WHERE v.status = 20 AND vi.real_time > 0"
)
by_user = {}
for vid, uid, level, rt, ct, bv, real in cur.fetchall():
    if level not in LEVELS:
        continue
    by_user.setdefault(int(uid), []).append((int(rt), int(vid), level, int(ct), int(bv), int(real)))
for lst in by_user.values():
    lst.sort()
print(f"  {sum(len(v) for v in by_user.values())} 条录像，{len(by_user)} 个用户")

# ---------- 3. 存量 type=20 动态索引（幂等）----------
cur.execute("SELECT user, reference, details_data FROM news WHERE type = 20")
existing = set()
no_ref = 0
for uid, ref, det in cur.fetchall():
    try:
        d = json.loads(det)
        lv, od = d.get("lv"), d.get("od")
    except Exception:
        continue
    if lv not in LEVELS or od not in ORDERS:
        continue
    if not ref:
        no_ref += 1
        continue
    existing.add((int(uid), int(ref), lv, od))
print(f"存量 type=20 索引 {len(existing)} 组（reference=0 跳过 {no_ref} 行）")

cur.execute("SELECT DISTINCT user FROM news WHERE type = 10")
newbie_users = {int(r[0]) for r in cur.fetchall()}

# ---------- 4. user_scores 终态（校验用）----------
print("载入 user_scores…")
cur.execute(
    "SELECT id, beg_time, beg_3bvs, int_time, int_3bvs, exp_time, exp_3bvs, sum_time, sum_3bvs, "
    "beg_time_video, beg_3bvs_video, int_time_video, int_3bvs_video, exp_time_video, exp_3bvs_video "
    "FROM user_scores"
)
db_scores = {int(r[0]): r[1:] for r in cur.fetchall()}


def replay(vids):
    """重放单用户 flag 榜。返回 (events, 终态 sum_time)。
    events: [(vid, upload_ct, [(lv, od, old, new)], prev_exp_time, is_transition)]"""
    state = {f(l, o): 0 for l in LEVELS for o in ORDERS}
    state.update({f(l, o, "Video"): 0 for l in LEVELS for o in ORDERS})
    state["sumTime"] = 0
    events = []
    for rt, vid, level, ct, bv, real in vids:
        prev = dict(state)
        s_time = real
        s_3bvs = round(bv * 1000000 / real) if bv >= MIN_3BV_FOR_3BVS[level] else 0
        if s_time > 0 and (state[f(level, "time")] == 0 or s_time < state[f(level, "time")]):
            state[f(level, "time")] = s_time
            state[f(level, "time", "Video")] = vid
        if s_3bvs > 0 and (state[f(level, "3bvs")] == 0 or s_3bvs > state[f(level, "3bvs")]):
            state[f(level, "3bvs")] = s_3bvs
            state[f(level, "3bvs", "Video")] = vid
        times = [state[f(l, "time")] for l in LEVELS]
        state["sumTime"] = sum(times) if all(t > 0 for t in times) else 0
        bvss = [state[f(l, "3bvs")] for l in LEVELS]
        state["sum3bvs"] = sum(bvss) if all(b > 0 for b in bvss) else 0

        ups = [
            (l, o, prev[f(l, o)], state[f(l, o)])
            for l in LEVELS for o in ORDERS
            if state[f(l, o, "Video")] == vid
        ]
        if ups:
            events.append((vid, ct, ups, prev[f("exp", "time")], prev["sumTime"] == 0 and state["sumTime"] > 0))
    return events, state


# ---------- 5. 逐用户重放 ----------
print("重放…")
inserts = []          # (user, reference, details, exp_time, ranked, create_time)
transitions = 0       # sum_time 0→正 转折数
trans_no_newbie = 0   # 转折用户在 news 无 type=10 行（信息项）
mismatch_users = []   # 终态与 user_scores 不一致的用户
stat = {"enlist": 0, "all": 0, "enlist_missing": 0, "all_missing": 0}
by_lv = {}
samples = []

for uid, vids in by_user.items():
    events, state = replay(vids)

    dbrow = db_scores.get(uid)
    if dbrow is not None:
        want = (
            state["begTime"] or None, state["beg3bvs"] or None,
            state["intTime"] or None, state["int3bvs"] or None,
            state["expTime"] or None, state["exp3bvs"] or None,
            state["sumTime"], state["sum3bvs"],  # sum 列无成绩存 0，不归 None
        )
        got = tuple(None if v is None else int(round(v)) for v in dbrow[:8])
        if want != got and len(mismatch_users) < 20:
            mismatch_users.append((uid, want, got))

    trans_list = [e for e in events if e[4]]
    transitions += len(trans_list)
    if trans_list and uid not in newbie_users:
        trans_no_newbie += 1
    if debug_user and uid == debug_user:
        print(f"\n== 调试用户 {uid}：{len(vids)} 盘，{len(trans_list)} 次入伍转折 ==")
        for vid, ct, ups, pexp, istr in events:
            tag = "【入伍】" if istr else ""
            if ups:
                print(f"  video {vid} {tag}exp快照={pexp} " + " ".join(f"{l}/{o}:{o_}->{n}" for l, o, o_, n in ups))
        print(f"  终态 sum_time={state['sumTime']} 库={dbrow[6] if dbrow else None}")

    for vid, ct, ups, prev_exp, istr in events:
        keep = mode_all or istr
        for lv, od, old, new in ups:
            stat["all"] += 1
            if istr:
                stat["enlist"] += 1
            if not keep:
                continue
            if (uid, vid, lv, od) in existing:
                continue
            stat["all_missing"] += 1
            if istr:
                stat["enlist_missing"] += 1
            by_lv[f"{lv}/{od}"] = by_lv.get(f"{lv}/{od}", 0) + 1
            details = json.dumps(
                {"lv": lv, "od": od, "or": int(old), "cr": int(new), "nf": 0},
                separators=(",", ":"),
            )
            inserts.append((uid, vid, details, prev_exp, 1 if ranked.get(uid, False) else 0, ct))
            if len(samples) < 15:
                samples.append((uid, vid, lv, od, old, new, prev_exp, "入伍" if istr else "漏发"))

# ---------- 6. 报告 ----------
print(f"""
================ 报告 ================
重放用户             {len(by_user)}
入伍转折（0→正）     {transitions}（其中 {trans_no_newbie} 个用户在 news 无 type=10 行）
best-设立候选        全部 {stat['all']}（入伍转折上 {stat['enlist']}）
终态校验不一致用户   {len(mismatch_users)}（抽样 {len(mismatch_users)}）

待补行               mode=enlist {stat['enlist_missing']}   mode=all {stat['all_missing']}
待补行分布           {by_lv}
样例（前 15）""")
for s in samples:
    print(f"  user {s[0]} video {s[1]} {s[2]}/{s[3]}: {s[4]} -> {s[5]} (exp快照 {s[6]}) [{s[7]}]")
if mismatch_users:
    print("终态不一致抽样：")
    for uid, want, got in mismatch_users[:10]:
        print(f"  user {uid}\n    重放 {want}\n    库   {got}")

if not inserts:
    print("\n无待补行。")
    sys.exit(0)

if not apply_mode:
    print(f"\n[dry-run] 待补 {len(inserts)} 行，加 --apply 执行写入。")
    sys.exit(0)

# ---------- 7. 写入（分批，事务提交）----------
print(f"\n写入 {len(inserts)} 行…")
sql = (
    "INSERT INTO news (type, user, reference, details_data, exp_time, ranked, create_time) "
    "VALUES (20, %s, %s, %s, %s, %s, %s)"
)
done = 0
for i in range(0, len(inserts), BATCH):
    batch = inserts[i : i + BATCH]
    cur.executemany(sql, [(u, r, d, e, rk, c) for u, r, d, e, rk, c in batch])
    conn.commit()
    done += len(batch)
    print(f"  {done}/{len(inserts)}")
print("完成。")
