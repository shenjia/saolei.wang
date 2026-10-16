#!/usr/bin/env python3
"""封禁账号成绩流水一次性回填（2026-10-16 张老师定：封禁只不上榜，历史数据全保留）

背景：旧站封禁（Player_IsLive=0）会连坐把账号全部录像 Video_IsLive=0
（实证：正常用户 0 部 IsLive=0，3038 部 IsLive=0 全属停用账号），
transform.py 原流水条件 status==20 导致这些审核通过（Check=1）的录像
不进 video_scores_* —— 后果：动态军衔重放为空（显示预备役）、
promotion-backfill.py 无源（缺 type=53 晋升动态）、3BV 收集为空。

本脚本把封禁账号（user.status<>0）名下 status=0 且 real_time>0 的录像
补进 video_scores_{beg,int,exp}（noflag=1 的同时补 _nf 表）：
  id = 录像 id（主键幂等，INSERT IGNORE 可重跑）
  score_3bvs = ROUND(board_3bv*1e6/real_time)（2026-10-15 全线定稿口径，禁 floor）

跑完本脚本后需重跑 promotion-backfill.py --apply 补发晋升动态。

用法: python3 scripts/sync/backfill-banned-flows.py [--apply]   默认 dry-run
连接：默认本地 root@127.0.0.1:3306/saolei；
SAOLEI_DB_HOST/PORT/USER/PASSWORD/NAME 环境变量覆盖（写生产走 3316 隧道 + --allow-nonlocal）。
"""
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

LEVELS = ("beg", "int", "exp")

# 候选规模（dry-run 也真实统计）
cur.execute("""SELECT v.level, vi.noflag, COUNT(*)
            FROM video v JOIN video_info vi ON vi.id = v.id
            JOIN `user` u ON u.id = v.user
            WHERE u.status <> 0 AND v.status = 0 AND vi.real_time > 0
            GROUP BY v.level, vi.noflag""")
cands = {(lv, nf): c for lv, nf, c in cur.fetchall()}
print("待回填候选（封禁账号 status=0 录像）：")
total = 0
for lv in LEVELS:
    n = cands.get((lv, 0), 0) + cands.get((lv, 1, ), 0)
    nf = cands.get((lv, 1), 0)
    total += n
    print(f"  {lv}: {n}（其中 NF {nf}）")
print(f"  合计 {total}")

# 已存在行数（幂等确认）
for lv in LEVELS:
    cur.execute(f"""SELECT COUNT(*) FROM video_scores_{lv} s
                 JOIN video v ON v.id = s.id JOIN `user` u ON u.id = v.user
                 WHERE u.status <> 0""")
    print(f"  video_scores_{lv} 已有封禁账号行: {cur.fetchone()[0]}")

if DRY:
    print("\n[dry-run] 未写库。确认后加 --apply 执行。")
    my.close()
    sys.exit(0)

for lv in LEVELS:
    cur.execute(f"""INSERT IGNORE INTO video_scores_{lv} (id, user, score_time, score_3bvs, create_time)
                 SELECT v.id, v.user, vi.real_time,
                        ROUND(vi.board_3bv * 1000000 / vi.real_time), v.create_time
                 FROM video v JOIN video_info vi ON vi.id = v.id
                 JOIN `user` u ON u.id = v.user
                 WHERE u.status <> 0 AND v.status = 0 AND v.level = %s AND vi.real_time > 0""", (lv,))
    print(f"video_scores_{lv}: 写入 {cur.rowcount} 行")
    cur.execute(f"""INSERT IGNORE INTO video_scores_{lv}_nf (id, user, score_time, score_3bvs, create_time)
                 SELECT v.id, v.user, vi.real_time,
                        ROUND(vi.board_3bv * 1000000 / vi.real_time), v.create_time
                 FROM video v JOIN video_info vi ON vi.id = v.id
                 JOIN `user` u ON u.id = v.user
                 WHERE u.status <> 0 AND v.status = 0 AND v.level = %s
                   AND vi.real_time > 0 AND vi.noflag = 1""", (lv,))
    print(f"video_scores_{lv}_nf: 写入 {cur.rowcount} 行")
my.commit()

# 校验：2747（杨萧杨）应有流水
cur.execute("SELECT COUNT(*) FROM video_scores_exp WHERE user = 2747")
print(f"\n校验: video_scores_exp user=2747 -> {cur.fetchone()[0]} 行（应 >0）")
print("DONE — 接下来重跑 promotion-backfill.py --apply 补发晋升动态")
my.close()
