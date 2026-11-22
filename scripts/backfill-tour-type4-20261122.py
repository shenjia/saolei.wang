#!/usr/bin/env python3
"""补「已挂接+有报名行+缺更新成绩动态(type=4)」存量（2026-11-22 张老师批）。

背景：11-20/21 手动批量挂接不写动态，造成部分用户挂接了录像但 type=4 缺失
（例：孟凡熙第17届 640 盘仅 6 条 type=4）。与「无报名行」空洞（已闭合）是两个口径。

补法（与线上手动挂接同形态：每盘一条 type=4，create_time=录像上传时刻，同秒多盘=多条共存）：
  按秒分组对齐——组内差 d = 该秒录像盘数 - 该秒 type=4 条数，d>0 则插 d 条
  （create_time=该秒，不同 id 自然分开）。幂等：重跑时差=0 自然跳过。
范围：全库 22 场比赛；无录像无成绩的组天然不在候选内（张老师：「没有更新成绩就算了」）。
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

        # 录像侧：每 (comp,user,秒) 的盘数（⚠️ 禁用 GROUP_CONCAT，逐行取回内存分组）
        cur.execute(
            """
            SELECT competition_id, user, create_time, COUNT(*) AS cnt
            FROM video
            WHERE competition_id IS NOT NULL AND status<>0
            GROUP BY competition_id, user, create_time
            """
        )
        vid_rows = cur.fetchall()
        vid_sec = {}   # (cid,uid,sec) -> cnt
        pair_vid = {}  # (cid,uid) -> total
        for cid, uid, ct, cnt in vid_rows:
            vid_sec[(cid, uid, int(ct))] = int(cnt)
            pair_vid[(cid, uid)] = pair_vid.get((cid, uid), 0) + int(cnt)

        # 事件侧：每 (comp,user,秒) 的 type=4 条数
        cur.execute(
            """
            SELECT competition_id, user_id, create_time, COUNT(*) AS cnt
            FROM tournament_event
            WHERE type=4 AND user_id>0
            GROUP BY competition_id, user_id, create_time
            """
        )
        ev_sec = {}
        for cid, uid, ct, cnt in cur.fetchall():
            ev_sec[(cid, uid, int(ct))] = int(cnt)

        # 候选 = 有报名行 + 按秒有差的 (comp,user)
        cur.execute(
            "SELECT competition_id, user_id FROM tournament_entry"
        )
        entry_pairs = set(cur.fetchall())

        todo = {}  # (cid,uid) -> [(sec, deficit), ...]
        total_deficit = 0
        for (cid, uid, sec), vc in vid_sec.items():
            if (cid, uid) not in entry_pairs:
                continue
            ec = ev_sec.get((cid, uid, sec), 0)
            d = vc - ec
            if d > 0:
                todo.setdefault((cid, uid), []).append((sec, d))
                total_deficit += d
        print(f"candidates: {len(todo)} (comp,user) pairs, "
              f"deficit type4 = {total_deficit}")
        for (cid, uid) in sorted(todo):
            vt = pair_vid.get((cid, uid), 0)
            dt = sum(d for _, d in todo[(cid, uid)])
            print(f"  comp {cid} user {uid}: videos={vt} deficit={dt} "
                  f"({len(todo[(cid, uid)])} secs)")
        if dry:
            print("DRY RUN only; pass --apply to execute")
            return

        done = 0
        for (cid, uid) in sorted(todo):
            cur.execute("START TRANSACTION")
            for sec, d in todo[(cid, uid)]:
                for _ in range(d):
                    cur.execute(
                        "INSERT INTO tournament_event "
                        "(competition_id, type, user_id, create_time) "
                        "VALUES (%s, 4, %s, %s)",
                        (cid, uid, sec),
                    )
                    done += 1
            cur.execute("COMMIT")
            dt = sum(d for _, d in todo[(cid, uid)])
            print(f"comp {cid} user {uid}: +{dt} type4 events")

        print(f"TOTAL: type4_added={done}")

        # 终态对账：每秒差必须清零
        cur.execute(
            """
            SELECT COUNT(*) FROM (
              SELECT v.competition_id, v.user, v.create_time
              FROM video v
              JOIN tournament_entry te ON te.competition_id=v.competition_id
                AND te.user_id=v.user
              WHERE v.competition_id IS NOT NULL AND v.status<>0
              GROUP BY v.competition_id, v.user, v.create_time
              HAVING COUNT(*) > (
                SELECT COUNT(*) FROM tournament_event e
                WHERE e.competition_id=v.competition_id AND e.user_id=v.user
                  AND e.type=4 AND e.create_time=v.create_time)
            ) x
            """
        )
        left = cur.fetchone()[0]
        print(f"verify: sec_deficit_pairs_left={left} (must be 0)")
        conn.commit()
        conn.close()
    finally:
        cleanup_tunnel()


if __name__ == "__main__":
    main()
