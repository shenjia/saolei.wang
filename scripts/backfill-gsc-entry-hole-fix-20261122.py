#!/usr/bin/env python3
"""修复 backfill-gsc-entry-hole 首轮 GROUP_CONCAT 截断脏数据（2026-11-22）。

首轮事故（已实证）：
  1. GROUP_CONCAT 默认 1024 字节截断 → 6 组 (comp,user) 的 create_time 列表被裁，
     首盘时刻恰好被裁掉 → entry/type2/type58 的 create_time 落成 1（1970-01-01）；
  2. type=4 成绩动态只写了截断后的 94/32/85 条（真实 680/146/156 盘）。

本脚本三步（幂等可重跑）：
  A. UPDATE 修正 6 条 entry 的 create_time=该用户该比赛真实首盘时刻；
  B. 同步修正对应 type=2 报名动态与 news type=58 个人动态的 create_time；
  C. 按库内真实挂接录像逐盘补齐缺失的 type=4 成绩动态（防重键兜底）。
"""
import os
import subprocess
import sys
import time

import pymysql

TUNNEL_PORT = 3316
TUNNEL_MARKER = "backfill-gsc-tunnel"


def ensure_tunnel():
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

        # 受损 6 组：首轮 create_time=1 的报名（第 7 组 16753 时刻正确无需动）
        cur.execute(
            """
            SELECT te.competition_id, te.user_id, te.id
            FROM tournament_entry te
            WHERE te.create_time = 1
            """
        )
        bad = cur.fetchall()
        print(f"bad entries (create_time=1): {len(bad)}")
        if dry:
            for cid, uid, eid in bad:
                print(f"  comp {cid} user {uid} entry_id={eid}")
            print("DRY RUN only; pass --apply to execute")
            return

        fix_e = fix_ev2 = fix_n = fix_ev4 = 0
        for cid, uid, _eid in bad:
            # 该用户该比赛真实首盘时刻（库内挂接录像 MIN，权威值）
            cur.execute(
                "SELECT MIN(create_time) FROM video "
                "WHERE competition_id=%s AND user=%s AND status<>0",
                (cid, uid),
            )
            real_first = cur.fetchone()[0]
            if not real_first:
                print(f"  !! comp {cid} user {uid}: no videos?? skip")
                continue
            cur.execute("START TRANSACTION")
            # A) entry 时刻修正
            cur.execute(
                "UPDATE tournament_entry SET create_time=%s "
                "WHERE competition_id=%s AND user_id=%s AND create_time=1",
                (real_first, cid, uid),
            )
            fix_e += cur.rowcount
            # B) type=2 报名动态 + news type=58 同步修正
            cur.execute(
                "UPDATE tournament_event SET create_time=%s "
                "WHERE competition_id=%s AND type=2 AND user_id=%s AND create_time=1",
                (real_first, cid, uid),
            )
            fix_ev2 += cur.rowcount
            cur.execute(
                "UPDATE news SET create_time=%s "
                "WHERE type=58 AND user=%s AND reference=%s AND create_time=1",
                (real_first, uid, cid),
            )
            fix_n += cur.rowcount
            # C) 逐盘补齐缺失的 type=4（防重键 comp+user+create_time 兜底）
            cur.execute(
                "SELECT create_time FROM video "
                "WHERE competition_id=%s AND user=%s AND status<>0 "
                "ORDER BY create_time",
                (cid, uid),
            )
            for (ct,) in cur.fetchall():
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
                    fix_ev4 += 1
            cur.execute("COMMIT")
            print(f"  comp {cid} user {uid}: fixed ct={real_first} "
                  f"({time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(real_first))}) "
                  f"+{fix_ev4} cumulative type4")

        print(f"TOTAL: entry_fixed={fix_e} type2_fixed={fix_ev2} "
              f"news58_fixed={fix_n} type4_added={fix_ev4}")

        # 终态断言 1：无 create_time=1 的残留
        cur.execute(
            "SELECT COUNT(*) FROM tournament_entry WHERE create_time=1"
        )
        left1 = cur.fetchone()[0]
        # 终态断言 2：7 组每人 type=4 条数 = 实际挂接录像数
        cur.execute(
            """
            SELECT v.competition_id, v.user, COUNT(DISTINCT v.create_time) AS vc
            FROM video v
            WHERE v.status<>0 AND v.competition_id IN (19,20)
              AND v.user IN (14464,16753,21557,22706,28234,34212)
            GROUP BY v.competition_id, v.user
            """
        )
        mismatch = 0
        for cid, uid, vc in cur.fetchall():
            cur.execute(
                "SELECT COUNT(*) FROM tournament_event "
                "WHERE competition_id=%s AND user_id=%s AND type=4",
                (cid, uid),
            )
            ec = cur.fetchone()[0]
            status = "OK" if ec >= vc else "MISMATCH"
            if ec < vc:
                mismatch += 1
            print(f"  verify comp {cid} user {uid}: videos={vc} type4={ec} {status}")
        print(f"verify: entry_ct1_left={left1} mismatch={mismatch} (both must be 0)")
        conn.commit()
        conn.close()
    finally:
        cleanup_tunnel()


if __name__ == "__main__":
    main()
