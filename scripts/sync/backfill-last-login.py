#!/usr/bin/env python3
"""回填 user.last_login_time（旧站 Player_Login_Time -> unix 秒）

背景（2026-10-13 张老师发现「用户详情页没有最近登录」）：
transform.py 的 SELECT 里有 Player_Login_Time，但 INSERT INTO user 时漏了这一列，
导致旧站 3.4 万用户的 last_login_time 全为 0；只有在新站注册/登录过的账号才有值。
transform.py 已修，但全量重跑代价大（约 50 分钟），故用本脚本从本地 MSSQL 镜像库
saolei_mssql.player 直接回填。

口径：
  - 全量（2026-10-21 张老师要求「所有人」：不再按 Player_IsLive 过滤——
    878 个停用账号在旧站同样有登录时间，其主页/卡片同样显示「最近登录」）
  - Player_Login_Time 是北京时间 naive datetime -> unix = t - 8h（与 transform.ux 一致）
  - 写入用 GREATEST(现值, 镜像值)：新站登录写入的时间可能更新，不得被旧站值覆盖

用法：python3 scripts/sync/backfill-last-login.py [--dry-run]

连接参数（默认本地 root 免密；生产/远程用环境变量覆盖，与 backfill-banned-users.py 同款）：
  目标库（新站）  SAOLEI_DB_HOST/PORT/USER/PASSWORD/NAME   （默认 127.0.0.1/3306/root//saolei）
  源库（staging） SAOLEI_STG_HOST/PORT/USER/PASSWORD/NAME  （默认 127.0.0.1/3306/root//saolei_mssql）

  写生产（生产无 staging 快照，故本地读 staging、走 SSH 隧道写生产；3307 被别项目
  长期占用会静默失败，用 3316 + ExitOnForwardFailure）：
    ssh -fN -L 3316:127.0.0.1:3306 -o ExitOnForwardFailure=yes deploy@60.205.137.210
    SAOLEI_DB_PORT=3316 SAOLEI_DB_USER=saolei SAOLEI_DB_PASSWORD='...' \
      python3 scripts/sync/backfill-last-login.py --allow-nonlocal --dry-run
  ⚠️ 目标库非「本地 3306」时，**必须显式加 --allow-nonlocal** 才允许写入（防手滑写错库）。
"""
import os
import sys
import time
from datetime import datetime, timedelta

import pymysql


def env(name, default=""):
    return os.environ.get(name) or default


def is_nonlocal(cfg):
    """目标库是否不是本地 3306（写它必须 --allow-nonlocal）"""
    return not (cfg["host"] in ("127.0.0.1", "localhost") and int(cfg["port"]) == 3306)


STG = {
    "host": env("SAOLEI_STG_HOST", "127.0.0.1"),
    "port": int(env("SAOLEI_STG_PORT", "3306")),
    "user": env("SAOLEI_STG_USER", "root"),
    "password": env("SAOLEI_STG_PASSWORD", ""),
    "database": env("SAOLEI_STG_NAME", "saolei_mssql"),
    "charset": "utf8mb4",
}
MY = {
    "host": env("SAOLEI_DB_HOST", "127.0.0.1"),
    "port": int(env("SAOLEI_DB_PORT", "3306")),
    "user": env("SAOLEI_DB_USER", "root"),
    "password": env("SAOLEI_DB_PASSWORD", ""),
    "database": env("SAOLEI_DB_NAME", "saolei"),
    "charset": "utf8mb4",
}

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
    nonlocal_ok = "--allow-nonlocal" in sys.argv
    if is_nonlocal(MY) and not nonlocal_ok:
        print(
            f"目标库 {MY['host']}:{MY['port']}/{MY['database']} 非本地 3306，"
            "确认写远程请加 --allow-nonlocal"
        )
        sys.exit(1)
    t0 = time.time()

    stg = pymysql.connect(**STG)
    my = pymysql.connect(**MY)
    try:
        with stg.cursor() as sc:
            sc.execute(
                "SELECT Player_Id, Player_Login_Time FROM player "
                "WHERE Player_Login_Time IS NOT NULL"
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
