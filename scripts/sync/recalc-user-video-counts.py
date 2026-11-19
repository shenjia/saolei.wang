#!/usr/bin/env python3
"""重算 user_stat.beg/int/exp_videos（2026-10-26，钱1033旭程报障）

背景
----
user_stat 三列的录像计数历史上只有同步管线 transform.py 在写（来源：旧站 MSSQL
`IsLive=1` 实时 COUNT 的快照）。新站自身的审核（lib/review.ts reviewVideo）、上传
（api/video/upload）、自助删除（api/video/self-delete）、后台删除（admin ops video.delete）
从未维护这三列 → 上线后过审的录像全部漏计；10-13 transform 重跑还曾用旧站快照
覆盖过计数（封禁号连坐 IsLive=0 的老数据残留偏多）。生产实测：189 人计数偏少、
106 人偏多、2 人缺 user_stat 行（35489/35497，merge-migration ingest 段漏建）。

口径
----
与前台可见性一致：`status<>0` 即计数（待审 10 + 通过 20），屏蔽 0 不计。
—— 旧站前台即实时 COUNT(IsLive=1)（含未审），同语义；旧站上传初始 IsLive='1'。

做法（幂等，可反复跑）
--------------------
1. 按 video 表 GROUP BY user, level 算实际计数（status<>0）；
2. 缺 user_stat 行的用户（有 video 行却无 stat 行）INSERT 补行（计数值直接写入，
   其余列默认 0——login_times 等并行流程会自己再写）；
3. 既有行三列与实际不符的 UPDATE 修正；
4. 只动 beg/int/exp_videos + update_time，绝不碰 clicks/login_* 等其他列。

用法
----
  PY=/Users/shenjia/.workbuddy/binaries/python/envs/default/bin/python
  $PY scripts/sync/recalc-user-video-counts.py            # 默认 dry-run：只报差异
  $PY scripts/sync/recalc-user-video-counts.py --write    # 实际写库

连接参数（同 backfill-banned-users.py 约定）
-------------------------------------------
  目标库  SAOLEI_DB_HOST/PORT/USER/PASSWORD/NAME（默认 127.0.0.1/3306/root//saolei）
  写生产：SSH 隧道（端口用 3316 防撞，见 topics/sync.md「写生产库」节）+ 环境变量
  + --allow-nonlocal。NONLOCAL 时绝不建备份表（生产建 schema 外表会阻塞全部部署）。
"""
import argparse
import os
import time

import pymysql


def env(name, default=""):
    return os.environ.get(name) or default


TARGET = {
    "host": env("SAOLEI_DB_HOST", "127.0.0.1"),
    "port": int(env("SAOLEI_DB_PORT", "3306")),
    "user": env("SAOLEI_DB_USER", "root"),
    "password": env("SAOLEI_DB_PASSWORD", ""),
    "database": env("SAOLEI_DB_NAME", "saolei"),
}

ap = argparse.ArgumentParser()
ap.add_argument("--write", action="store_true", help="实际写库（默认 dry-run 只报差异）")
ap.add_argument("--allow-nonlocal", action="store_true",
                help="目标库非 127.0.0.1:3306 时写入所需的安全开关")
args = ap.parse_args()

NONLOCAL = not (TARGET["host"] in ("127.0.0.1", "localhost") and TARGET["port"] == 3306)
if NONLOCAL and not args.allow_nonlocal and args.write:
    raise SystemExit(
        f"目标库是 {TARGET['host']}:{TARGET['port']}/{TARGET['database']}（非本地 3306）——"
        "确认无误请加 --allow-nonlocal"
    )

print(f"目标库 {TARGET['host']}:{TARGET['port']}/{TARGET['database']}"
      f"  mode={'WRITE' if args.write else 'dry-run'}", flush=True)

my = pymysql.connect(charset="utf8mb4", autocommit=False, **TARGET)
cur = my.cursor()
t0 = time.time()

# 1) 实际计数（status<>0：待审 10 + 通过 20）
cur.execute(
    """SELECT user,
              SUM(level='beg' AND status<>0) AS beg,
              SUM(level='int' AND status<>0) AS int_c,
              SUM(level='exp' AND status<>0) AS exp
       FROM video GROUP BY user"""
)
real = {r[0]: (int(r[1]), int(r[2]), int(r[3])) for r in cur.fetchall()}
print(f"video GROUP BY user: {len(real)} 用户（{time.time()-t0:.1f}s）", flush=True)

# 2) 现有 user_stat 行
cur.execute("SELECT id, beg_videos, int_videos, exp_videos FROM user_stat")
stat = {r[0]: (r[1], r[2], r[3]) for r in cur.fetchall()}

now = int(time.time())
inserts, updates = [], []
for uid, (beg, int_c, exp) in real.items():
    old = stat.get(uid)
    if old is None:
        # 缺行：补建（其余列走默认；login_* 由并行流程自写）
        inserts.append((uid, beg, int_c, exp, now, now))
    elif old != (beg, int_c, exp):
        updates.append((beg, int_c, exp, now, uid))

# 孤儿 stat 行：有 stat 无 video（real 无键）——计数应为 0 的也一并修正（防「删光录像」残留）
for uid, old in stat.items():
    if uid not in real and (old[0] or old[1] or old[2]):
        updates.append((0, 0, 0, now, uid))

print(f"差异：缺行 {len(inserts)} 个，数值不符 {len(updates)} 个", flush=True)
for uid, beg, int_c, exp, _, _ in inserts[:20]:
    print(f"  [insert] user={uid} beg={beg} int={int_c} exp={exp}")
for beg, int_c, exp, _, uid in updates[:20]:
    old = stat.get(uid, ("-", "-", "-"))
    print(f"  [update] user={uid} {old} -> ({beg}, {int_c}, {exp})")
if len(inserts) > 20 or len(updates) > 20:
    print(f"  …（共 {len(inserts)+len(updates)} 项，仅列前 20）")

if args.write:
    try:
        if inserts:
            cur.executemany(
                """INSERT INTO user_stat (id, beg_videos, int_videos, exp_videos, create_time, update_time)
                   VALUES (%s,%s,%s,%s,%s,%s)""",
                inserts,
            )
        if updates:
            cur.executemany(
                """UPDATE user_stat SET beg_videos=%s, int_videos=%s, exp_videos=%s, update_time=%s
                   WHERE id=%s""",
                updates,
            )
        my.commit()
        print(f"写入完成：INSERT {len(inserts)} 行 / UPDATE {len(updates)} 行"
              f"（{time.time()-t0:.1f}s）", flush=True)
    except Exception:
        my.rollback()
        raise
else:
    print("dry-run：未写库。确认无误后加 --write 执行")

# 3) 复核（写库后再查一遍应零差异）
cur.execute(
    """SELECT COUNT(*) FROM user_stat s
       LEFT JOIN (SELECT user,
                         SUM(level='beg' AND status<>0) AS beg,
                         SUM(level='int' AND status<>0) AS int_c,
                         SUM(level='exp' AND status<>0) AS exp
                  FROM video GROUP BY user) v ON v.user=s.id
       WHERE s.beg_videos<>COALESCE(v.beg,0)
          OR s.int_videos<>COALESCE(v.int_c,0)
          OR s.exp_videos<>COALESCE(v.exp,0)"""
)
mismatch = cur.fetchone()[0]
print(f"复核：剩余不符 {mismatch} 用户（应为 0）", flush=True)

cur.close()
my.close()
