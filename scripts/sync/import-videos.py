# Phase B 入库：out.jsonl → video_info 回填 + _nf 表修正 + user_sig 补充
# 规则（与张老师确认过的口径）：
# - 只回填空缺字段：signature/software/version/noflag/board（real_time/board_3bv 不动，库值为准）
# - noflag 以文件解析为准：变化且 status=20 的录像同步修正 video_scores_*_nf 归属
# - user_sig：按录像时间序注册新签名（对齐 2013 版 UserSig::register 语义）
# 幂等：可重复跑（已回填的跳过；_nf 修正基于差集；user_sig 查重）
import json, time, sys
import pymysql

OUT = "/tmp/saolei-sync/out.jsonl"
my = pymysql.connect(host="127.0.0.1", user="root", database="saolei", charset="utf8mb4", autocommit=False)
cur = my.cursor()
now = int(time.time())

# ---------- 1. 读取解析结果 ----------
results = {}
errors = []
for line in open(OUT):
    line = line.strip()
    if not line:
        continue
    r = json.loads(line)
    if r.get("ok"):
        results[r["id"]] = r
    else:
        errors.append((r["id"], r.get("err", "")))
print(f"解析成功 {len(results)}，失败 {len(errors)}", flush=True)
from collections import Counter
print("失败原因分布:", Counter(e for _, e in errors).most_common(10), flush=True)

if not results:
    sys.exit(0)

# ---------- 2. 取现状（noflag 对比 + video level/status/user/create_time） ----------
ids = list(results)
cur.execute(
    f"""SELECT i.id, i.noflag, i.signature, v.level, v.status, v.user, v.create_time
        FROM video_info i JOIN video v ON v.id = i.id
        WHERE i.id IN ({','.join(['%s'] * len(ids))})""",
    ids,
)
meta = {}
for vid, nf0, sig0, level, status, user, ct in cur.fetchall():
    meta[vid] = {"nf0": nf0, "sig0": sig0, "level": level, "status": status, "user": user, "ct": ct}
print(f"库内匹配 {len(meta)}", flush=True)

# ---------- 3. 回填 video_info ----------
upd_rows = []
nf_flip_to1, nf_flip_to0 = [], []
for vid, r in results.items():
    m = meta.get(vid)
    if not m:
        continue
    if m["sig0"]:  # 已回填过（幂等跳过）
        continue
    sig = (r.get("sig") or "")[:50]
    sw = (r.get("sw") or "")[:20]
    ver = (r.get("ver") or "")[:20]
    board = r.get("board") or ""
    nf = int(r.get("nf") or 0)
    upd_rows.append((sig, sw, ver, nf, board, now, vid))
    if nf != m["nf0"]:
        (nf_flip_to1 if nf == 1 else nf_flip_to0).append((vid, m["level"], m["status"]))

B = 1000
n_upd = 0
for i in range(0, len(upd_rows), B):
    cur.executemany(
        """UPDATE video_info SET signature=%s, software=%s, version=%s, noflag=%s, board=%s, update_time=%s
           WHERE id=%s""",
        upd_rows[i : i + B],
    )
    my.commit()
    n_upd += len(upd_rows[i : i + B])
    if n_upd % 20000 < B:
        print(f"  video_info 回填 {n_upd}/{len(upd_rows)}", flush=True)
print(f"video_info 回填完成 {n_upd}；noflag 变化: 0→1 {len(nf_flip_to1)}，1→0 {len(nf_flip_to0)}", flush=True)

# ---------- 4. _nf 表归属修正（仅 status=20 才在 scores 表） ----------
n_fix = 0
for vid, level, status in nf_flip_to1:
    if status != 20:
        continue
    cur.execute(
        f"""INSERT IGNORE INTO video_scores_{level}_nf (id,user,score_time,score_3bvs,create_time)
            SELECT id,user,score_time,score_3bvs,create_time FROM video_scores_{level} WHERE id=%s""",
        (vid,),
    )
    n_fix += cur.rowcount
    if n_fix % 500 == 0:
        my.commit()
my.commit()
print(f"_nf 新增 {n_fix}", flush=True)

n_del = 0
for vid, level, status in nf_flip_to0:
    if status != 20:
        continue
    cur.execute(f"DELETE FROM video_scores_{level}_nf WHERE id=%s", (vid,))
    n_del += cur.rowcount
    if n_del % 500 == 0:
        my.commit()
my.commit()
print(f"_nf 删除 {n_del}", flush=True)

# ---------- 5. user_sig 补充（按录像时间序，新签名归上传者） ----------
cur.execute("SELECT signature FROM user_sig")
existing_sig = {r[0] for r in cur.fetchall()}
# 按录像 create_time 升序（对齐 2013 迁移「先到先得」语义）
candidates = []
for vid, r in results.items():
    m = meta.get(vid)
    if not m:
        continue
    sig = (r.get("sig") or "")[:50]
    if sig and sig not in existing_sig:
        candidates.append((m["ct"], vid, m["user"], sig))
candidates.sort()
n_sig = 0
for ct, vid, user, sig in candidates:
    if sig in existing_sig:
        continue
    try:
        cur.execute(
            "INSERT INTO user_sig (user,signature,create_time,update_time) VALUES (%s,%s,%s,%s)",
            (user, sig, ct or now, 0),
        )
        existing_sig.add(sig)
        n_sig += 1
    except pymysql.err.IntegrityError:
        existing_sig.add(sig)  # 并发/大小写撞车，跳过
    if n_sig % 500 == 0:
        my.commit()
my.commit()
print(f"user_sig 新增 {n_sig}", flush=True)

print("ALL DONE", flush=True)
