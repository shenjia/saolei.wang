#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""删除 27 条源头缺损录像（2026-10-22 张老师定：有问题录像直接删）

背景：合并迁移视频文件回填时，27 条旧站源头缺损（21 文件截断 + 6 旧站 404）
无法恢复文件，新站保留会呈现「有成绩无回放」。定稿：物理删除。

关联面（已勘察）：
  video/video_info/video_stat 各 27 行
  video_scores_beg/int/exp = 11/4/12 行；*_nf = 3/0/5 行
  comment 5 条（挂在 78048/87064/94174/286299 下）
  news 引用 0；user_scores(_nf) 指向 0（均非用户当前最优）
  user_stat 的 video 计数列不含 per-video 引用，无需改
删除后动作：受影响用户 user_scores 重算由调用方跑 apply-user-scores.sh 全量兜底。

用法：SAOLEI_DB_NAME=... python purge-broken-videos.py [--allow-nonlocal]
"""
import os
import sys
import time

import pymysql

IDS = [14889, 16869, 42815, 42816, 53974, 59881, 67445, 67460, 67466, 67468,
       78048, 86730, 87064, 87282, 87294, 94174, 94396, 227352, 227357, 227358,
       242866, 242887, 242900, 242901, 242902, 286296, 286299]

DRY = "--apply" not in sys.argv

if not DRY:
    host = os.environ.get("SAOLEI_DB_HOST", "127.0.0.1")
    port = os.environ.get("SAOLEI_DB_PORT", "3306")
    if (host, port) != ("127.0.0.1", "3306") and "--allow-nonlocal" not in sys.argv:
        sys.exit("非本地库写入门禁：需 --allow-nonlocal")

my = pymysql.connect(
    host=os.environ.get("SAOLEI_DB_HOST", "127.0.0.1"),
    port=int(os.environ.get("SAOLEI_DB_PORT", "3306")),
    user=os.environ.get("SAOLEI_DB_USER", "root"),
    password=os.environ.get("SAOLEI_DB_PASSWORD", ""),
    database=os.environ.get("SAOLEI_DB_NAME", "saolei"),
    charset="utf8mb4", autocommit=False)
cur = my.cursor()
ph = ",".join(["%s"] * len(IDS))


def count(table, where, params=IDS):
    cur.execute(f"SELECT COUNT(*) FROM `{table}` WHERE {where}", params)
    return cur.fetchone()[0]


print(f"目标 {len(IDS)} 条：{IDS}")
print("删除前：")
print(f"  video={count('video', f'id IN ({ph})')} "
      f"video_info={count('video_info', f'id IN ({ph})')} "
      f"video_stat={count('video_stat', f'id IN ({ph})')}")
for lv in ("beg", "int", "exp"):
    print(f"  scores_{lv}={count(f'video_scores_{lv}', f'id IN ({ph})')} "
          f"scores_{lv}_nf={count(f'video_scores_{lv}_nf', f'id IN ({ph})')}")
print(f"  comment={count('comment', f'video IN ({ph})')}")

if DRY:
    print("[dry-run] 加 --apply 执行")
    sys.exit(0)

ts = int(time.time())
try:
    # 备份待删行到本地 JSON（可回滚兜底，与 mysqldump 双保险）
    import json
    backup = {}
    for t, col in [("video", "id"), ("video_info", "id"), ("video_stat", "id"),
                   ("video_scores_beg", "id"), ("video_scores_int", "id"),
                   ("video_scores_exp", "id"), ("video_scores_beg_nf", "id"),
                   ("video_scores_int_nf", "id"), ("video_scores_exp_nf", "id")]:
        cur.execute(f"SELECT * FROM `{t}` WHERE `{col}` IN ({ph})", IDS)
        cols = [d[0] for d in cur.description]
        backup[t] = [dict(zip(cols, r)) for r in cur.fetchall()]
    cur.execute(f"SELECT * FROM comment WHERE video IN ({ph})", IDS)
    cols = [d[0] for d in cur.description]
    backup["comment"] = [dict(zip(cols, r)) for r in cur.fetchall()]
    with open("/tmp/purge-broken-backup.json", "w") as f:
        json.dump(backup, f, ensure_ascii=False, default=str)
    print(f"  [backup] /tmp/purge-broken-backup.json（{sum(len(v) for v in backup.values())} 行）")

    # 删除（单事务）
    cur.execute(f"DELETE FROM comment WHERE video IN ({ph})", IDS)
    n_c = cur.rowcount
    for t in ("video_scores_beg", "video_scores_int", "video_scores_exp",
              "video_scores_beg_nf", "video_scores_int_nf", "video_scores_exp_nf",
              "video_stat", "video_info", "video"):
        cur.execute(f"DELETE FROM `{t}` WHERE id IN ({ph})", IDS)
        print(f"  del {t}: {cur.rowcount}")
    my.commit()
    print(f"  del comment: {n_c}")
except Exception:
    my.rollback()
    raise

# 终验：无悬空引用
for t, col, ref in [("comment", "video", "video"), ("news", "reference", "video")]:
    cur.execute(f"""SELECT COUNT(*) FROM `{t}` x LEFT JOIN video v ON v.id=x.`{col}`
                 WHERE x.`{col}` IN ({ph})""", IDS)
    print(f"  残留引用 {t}: {cur.fetchone()[0]}")
print("PURGE DONE")
