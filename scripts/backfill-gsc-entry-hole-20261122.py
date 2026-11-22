#!/usr/bin/env python3
"""补「已挂接但无报名行」空洞（2026-11-22 张老师批「要补的」）。

背景：第17届金羊杯 2 人 + 第18届 5 人，录像已挂接（11-20/21 手动挂接，当时不写事件），
但既无报名行也无任何动态——两判据（8193 条 Arbiter 回填补未挂接 / 622 组 backfill-tour-entry
补「有 type=4 无报名」）的交集空洞。

口径（与 backfill-gsc-arbiter-20261122.py / ensureTourEntry 同构）：
  1. tournament_entry 补报名（createTime=该玩家首盘上传时刻）
  2. tournament_event type=2 报名动态（createTime=同上）
  3. news type=58 个人动态（exp_time/ranked 快照军衔，与 ensureTourEntry 同构）
  4. tournament_event type=4 成绩动态（每盘一条，createTime=上传时刻）

幂等：报名唯一索引 + type=4 防重键 (comp,user,create_time) + type=2/58 先查后插。
判据锁死：只补「挂接用户 NOT IN 报名用户」，不碰其他任何行。
"""
import os
import subprocess
import sys
import time

import pymysql

TUNNEL_PORT = 3316
TUNNEL_MARKER = "backfill-gsc-tunnel"


def ensure_tunnel():
    # 只按本脚本专属 marker 清理/建立，绝不动别的隧道
    subprocess.run(["pkill", "-f", TUNNEL_MARKER], capture_output=True)
    time.sleep(1)
    cmd = (
        f'ssh -i ~/.ssh/shenjia.pem -o ExitOnForwardFailure=yes '
        f'-L {TUNNEL_PORT}:127.0.0.1:3306 deploy@60.205.137.210 -fN '
        f'-S /tmp/{TUNNEL_MARKER}.ctl -M'
    )
    subprocess.run(cmd, shell=True, check=True)
    for _ in range(10):
        try:
            import socket
            s = socket.create_connection(("127.0.0.1", TUNNEL_PORT), timeout=2)
            s.close()
            return
        except OSError:
            time.sleep(0.5)
    raise RuntimeError("tunnel not ready")


def cleanup_tunnel():
    subprocess.run(
        ["ssh", "-S", f"/tmp/{TUNNEL_MARKER}.ctl", "-O", "exit",
         "deploy@60.205.137.210"],
        capture_output=True,
    )


def get_pw():
    out = subprocess.run(
        ["ssh", "-i", os.path.expanduser("~/.ssh/shenjia.pem"),
         "deploy@60.205.137.210",
         r'''sed -n 's/^DATABASE_URL="mysql:\/\/saolei:\([^@]*\)@localhost.*/\1/p' /home/deploy/saolei.wang/.env'''],
        capture_output=True, text=True, check=True,
    )
    return out.stdout.strip()


def main():
    dry = "--apply" not in sys.argv
    pw = get_pw()
    ensure_tunnel()
    try:
        conn = pymysql.connect(
            host="127.0.0.1", port=TUNNEL_PORT, user="saolei",
            password=pw, database="saolei",
            charset="utf8mb4", autocommit=False,
        )
        cur = conn.cursor()

        # 候选 = 挂接了录像但报名表无行的 (比赛, 用户) 对
        # ⚠️ GROUP_CONCAT 默认 1024 字节截断（本次实证：680 盘被裁成 94），禁用；
        # 改逐盘 SELECT + 内存分组，session 级调大上限做双保险
        cur.execute("SET SESSION group_concat_max_len = 1000000")
        cur.execute(
            """
            SELECT v.competition_id, v.user, v.create_time
            FROM video v
            WHERE v.competition_id IS NOT NULL AND v.status<>0
              AND v.user NOT IN (
                SELECT user_id FROM tournament_entry te
                WHERE te.competition_id = v.competition_id)
            ORDER BY v.competition_id, v.user, v.create_time
            """
        )
        rows = cur.fetchall()
        pairs = {}
        for cid, uid, ct in rows:
            pairs.setdefault((cid, uid), []).append(int(ct))
        print(f"candidates: {len(pairs)} (comp,user) pairs, {len(rows)} videos")
        for (cid, uid), cts in pairs.items():
            print(f"  comp {cid} user {uid}: {len(cts)} videos, "
                  f"first={cts[0]} ({time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(cts[0]))})")
        if dry:
            print("DRY RUN only; pass --apply to execute")
            return

        grand_e = grand_ev2 = grand_ev4 = grand_n = 0
        for (cid, uid), cts in pairs.items():
            first_ct = cts[0]
            cur.execute("START TRANSACTION")
            # 1) 补报名（先查后插幂等）
            cur.execute(
                "SELECT 1 FROM tournament_entry "
                "WHERE competition_id=%s AND user_id=%s LIMIT 1",
                (cid, uid),
            )
            if cur.fetchone():
                # 理论不可达（候选判据已排除），防御跳过
                cur.execute("ROLLBACK")
                continue
            cur.execute(
                "INSERT INTO tournament_entry (competition_id, user_id, create_time) "
                "VALUES (%s, %s, %s)",
                (cid, uid, first_ct),
            )
            # 2) 报名动态 type=2（同先查后插，防历史脏数据撞）
            cur.execute(
                "SELECT 1 FROM tournament_event "
                "WHERE competition_id=%s AND type=2 AND user_id=%s LIMIT 1",
                (cid, uid),
            )
            if not cur.fetchone():
                cur.execute(
                    "INSERT INTO tournament_event (competition_id, type, user_id, create_time) "
                    "VALUES (%s, 2, %s, %s)",
                    (cid, uid, first_ct),
                )
                grand_ev2 += 1
            # 3) 个人动态 news type=58（军衔快照与 ensureTourEntry 同构）
            cur.execute(
                "SELECT 1 FROM news WHERE type=58 AND user=%s AND reference=%s LIMIT 1",
                (uid, cid),
            )
            if not cur.fetchone():
                cur.execute(
                    "SELECT s.exp_time, u.status FROM user_scores s "
                    "LEFT JOIN user u ON u.id=s.id WHERE s.id=%s LIMIT 1",
                    (uid,),
                )
                r = cur.fetchone()
                exp_time = int(r[0]) if r and r[0] is not None else 0
                ranked = 1 if (r and r[1] == 0) else 0
                cur.execute(
                    "INSERT INTO news (type, user, reference, details_data, exp_time, ranked, create_time) "
                    "VALUES (58, %s, %s, '{}', %s, %s, %s)",
                    (uid, cid, exp_time, ranked, first_ct),
                )
                grand_n += 1
            # 4) 成绩动态 type=4（每盘一条，防重键 comp+user+create_time）
            for ct in cts:
                cur.execute(
                    "SELECT 1 FROM tournament_event "
                    "WHERE competition_id=%s AND type=4 AND user_id=%s AND create_time=%s LIMIT 1",
                    (cid, uid, ct),
                )
                if not cur.fetchone():
                    cur.execute(
                        "INSERT INTO tournament_event (competition_id, type, user_id, create_time) "
                        "VALUES (%s, 4, %s, %s)",
                        (cid, uid, ct),
                    )
                    grand_ev4 += 1
            cur.execute("COMMIT")
            grand_e += 1
            print(f"comp {cid} user {uid}: entry(ct={first_ct}) +type2 +news58 "
                  f"+{len(cts)} type4 events")
        print(f"TOTAL: entries={grand_e} type2={grand_ev2} news58={grand_n} "
              f"type4={grand_ev4}")

        # 终态对账：空洞必须清零
        cur.execute(
            """
            SELECT COUNT(*) FROM (
              SELECT DISTINCT v.competition_id, v.user
              FROM video v
              WHERE v.competition_id IS NOT NULL AND v.status<>0
                AND v.user NOT IN (
                  SELECT user_id FROM tournament_entry te
                  WHERE te.competition_id = v.competition_id)
            ) x
            """
        )
        left = cur.fetchone()[0]
        print(f"verify: hole_left={left} (must be 0)")
        conn.commit()
        conn.close()
    finally:
        cleanup_tunnel()


if __name__ == "__main__":
    main()
