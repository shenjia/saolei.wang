#!/usr/bin/env python3
"""回填 user.last_login_time（旧站 Player_Login_Time -> unix 秒）

背景（2026-10-13 张老师发现「用户详情页没有最近登录」）：
transform.py 的 SELECT 里有 Player_Login_Time，但 INSERT INTO user 时漏了这一列，
导致旧站 3.4 万用户的 last_login_time 全为 0；只有在新站注册/登录过的账号才有值。
transform.py 已修，但全量重跑代价大（约 50 分钟），故用本脚本从本地 MSSQL 镜像库
saolei_mssql.player 直接回填。

口径：
  - 只处理 Player_IsLive=1
  - Player_Login_Time 是北京时间 naive datetime -> unix = t - 8h（与 transform.ux 一致）
  - 写入用 GREATEST(现值, 镜像值)：新站登录写入的时间可能更新，不得被旧站值覆盖

用法：python3 scripts/sync/backfill-last-login.py [--dry-run]
"""
import sys
import time
from datetime import datetime, timedelta

import pymysql

STG = dict(host="127.0.0.1", user="root", database="saolei_mssql", charset="utf8mb4")
MY = dict(host="127.0.0.1", user="root", database="saolei", charset="utf8mb4")

TZ8 = timedelta(hours=8)
EPOCH = datetime(1970, 1, 1)
BATCH = 1000


def ux(dt):
    """naive datetime(北京时间) -> unix 秒"""
    if dt is None:
        return 0
    return int((dt - TZ8 - EPOCH).total_seconds())


def main():
    dry = "--dry-run" in sys.argv
    t0 = time.time()

    stg = pymysql.connect(**STG)
    my = pymysql.connect(**MY)
    try:
        with stg.cursor() as sc:
            sc.execute(
                "SELECT Player_Id, Player_Login_Time FROM player "
                "WHERE Player_IsLive=1 AND Player_Login_Time IS NOT NULL"
            )
            rows = [(int(r[0]), ux(r[1])) for r in sc.fetchall()]
        print(f"镜像库读入 {len(rows)} 条（用时 {time.time() - t0:.0f}s）", flush=True)

        cur = my.cursor()
        cur.execute("SELECT COUNT(*) FROM user WHERE last_login_time > 0")
        before = cur.fetchone()[0]
        print(f"回填前：last_login_time > 0 的用户 {before} 人", flush=True)

        if dry:
            print(f"[dry-run] 样例前 5 条：{rows[:5]}")
            print("[dry-run] 未写库")
            cur.close()
            return

        for i in range(0, len(rows), BATCH):
            chunk = rows[i:i + BATCH]
            cur.executemany(
                "UPDATE `user` SET last_login_time=GREATEST(last_login_time, %s) "
                "WHERE id=%s",
                [(ts, pid) for pid, ts in chunk],
            )
            my.commit()
            print(f"  已写 {min(i + BATCH, len(rows))}/{len(rows)}", flush=True)

        cur.execute("SELECT COUNT(*) FROM user WHERE last_login_time > 0")
        after = cur.fetchone()[0]
        cur.execute(
            "SELECT MAX(last_login_time), FROM_UNIXTIME(MAX(last_login_time)) FROM `user`"
        )
        mx = cur.fetchone()
        print(f"回填后：last_login_time > 0 的用户 {after} 人（+{after - before}）", flush=True)
        print(f"全库最新登录时间：{mx[0]} -> {mx[1]}", flush=True)
        cur.close()
    finally:
        stg.close()
        my.close()
    print(f"完成，用时 {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
