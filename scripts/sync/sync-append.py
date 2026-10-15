#!/usr/bin/env python3
"""实体表增量同步：本地 -> 生产（按 id 追加，幂等，不碰生产已有行）— 2026-10-15

背景：10-13 本地全量增量同步 + 晋升回填后，一直未把增量推到生产（张老师 10-15 发现
线上没有晋升动态）。两侧 news id 空间已分叉（生产走自己的 id 段、本地被尾部重排拉高
到 90 万段），但实体表 id 仍对齐，故按「生产缺哪个 id 就补哪个 id」追加。

原则（与 backfill-banned-users.py 同姿势）：
  - 只 INSERT IGNORE 生产缺失的 id，绝不动生产已有行（生产有今天的新评论/回复/动态）
  - 排除本地测试数据：user 999003-999006（绑定测试）、bbs_reply 24390/24391/24392
    （user=1 10-13 测试回复）
  - news 不在此脚本处理——news 走语义重放（promotion-backfill + news-delta），不按 id 对齐
  - ⚠️ 生产禁建 schema 外表（会阻塞全部部署），本脚本不建任何表

用法：
  PY=/Users/shenjia/.workbuddy/binaries/python/envs/default/bin/python
  $PY scripts/sync/sync-append.py --dry-run          # 只统计不写库
  $PY scripts/sync/sync-append.py --allow-nonlocal   # 写生产（隧道端口）

连接：本地库默认 root@127.0.0.1:3306/saolei；目标库走 SAOLEI_DB_* 环境变量
（写生产时：ssh -i ~/.ssh/shenjia.pem -N -L 3316:127.0.0.1:3306 deploy@60.205.137.210
后 SAOLEI_DB_PORT=3316 SAOLEI_DB_USER=saolei SAOLEI_DB_PASSWORD=...）
"""
import os
import sys

import pymysql

BATCH = 2000


def env(name, default=""):
    return os.environ.get(name) or default


LOCAL = {
    "host": "127.0.0.1", "port": 3306, "user": "root",
    "password": "", "database": "saolei",
}
TARGET = {
    "host": env("SAOLEI_DB_HOST", "127.0.0.1"),
    "port": int(env("SAOLEI_DB_PORT", "3306")),
    "user": env("SAOLEI_DB_USER", "root"),
    "password": env("SAOLEI_DB_PASSWORD", ""),
    "database": env("SAOLEI_DB_NAME", "saolei"),
}

DRY = "--dry-run" in sys.argv
NONLOCAL = (TARGET["host"], TARGET["port"]) != ("127.0.0.1", 3306)
if NONLOCAL and "--allow-nonlocal" not in sys.argv and not DRY:
    print("目标库非本地 3306，写入需显式 --allow-nonlocal")
    sys.exit(2)

TABLES = [
    "user", "user_auth", "user_info", "user_stat", "user_scores", "user_scores_nf",
    "user_sig",
    "video", "video_info", "video_stat",
    "video_scores_beg", "video_scores_int", "video_scores_exp",
    "video_scores_beg_nf", "video_scores_int_nf", "video_scores_exp_nf",
    "comment", "bbs_post", "bbs_reply", "message", "history",
]

# 本地测试数据硬排除（不进生产）
EXCLUDE = {
    "user": {999003, 999004, 999005, 999006},
    "user_auth": {999003, 999004, 999005, 999006},
    "user_info": {999003, 999004, 999005, 999006},
    "user_stat": {999003, 999004, 999005, 999006},
    "user_scores": {999003, 999004, 999005, 999006},
    "user_scores_nf": {999003, 999004, 999005, 999006},
    "bbs_reply": {24390, 24391, 24392},
}

local = pymysql.connect(**LOCAL, charset="utf8mb4", autocommit=True)
target = pymysql.connect(**TARGET, charset="utf8mb4", autocommit=False)
lc, tc = local.cursor(), target.cursor()

report = []
for table in TABLES:
    lc.execute(f"SELECT id FROM `{table}` ORDER BY id")
    local_ids = [r[0] for r in lc.fetchall()]
    tc.execute(f"SELECT id FROM `{table}`")
    prod_ids = {r[0] for r in tc.fetchall()}
    skip = EXCLUDE.get(table, set())
    missing = [i for i in local_ids if i not in prod_ids and i not in skip]
    if not missing:
        print(f"[skip] {table}: 无缺失 id")
        continue
    lc.execute(f"SHOW COLUMNS FROM `{table}`")
    cols = [r[0] for r in lc.fetchall()]
    col_list = ",".join(f"`{c}`" for c in cols)
    ph = ",".join(["%s"] * len(cols))
    ins = 0
    for i in range(0, len(missing), BATCH):
        batch_ids = missing[i:i + BATCH]
        lc.execute(
            f"SELECT {col_list} FROM `{table}` WHERE id IN ({','.join(['%s'] * len(batch_ids))}) ORDER BY id",
            batch_ids)
        rows = lc.fetchall()
        if not DRY:
            tc.executemany(
                f"INSERT IGNORE INTO `{table}` ({col_list}) VALUES ({ph})", rows)
            target.commit()
        ins += len(rows)
    report.append((table, len(missing), ins))
    status = "dry" if DRY else "inserted"
    print(f"[{status}] {table}: 本地 {len(local_ids)}，补 {len(missing)} 行")

print("\n===== 汇总 =====")
total = 0
for table, miss, done in report:
    print(f"  {table:<20} 补插 {miss} 行")
    total += miss
print(f"  合计 {total} 行" + ("（dry-run）" if DRY else ""))
if DRY:
    print("\n[dry-run] 未写库。确认后去掉 --dry-run 加 --allow-nonlocal 执行。")
