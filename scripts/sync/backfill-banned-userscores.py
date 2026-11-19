#!/usr/bin/env python3
"""封禁账号 user_scores / user_scores_nf 一次性回填（2026-10-16 张老师定：封禁只不上榜，军衔认定保留）

背景：backfill-banned-users.py 补导 878 个停用账号时 user_scores 写空行，
导致封禁账号军衔认定（assessTitle(user_scores.exp_time)）全部掉到「预备役」、
个人主页军衔徽章/动态军衔失真（2747 案：MSSQL 里实为元帅 36.79s）。
本地有 90 个账号因后续审核流程被重算过而有值，生产 878 个全空。

本脚本从 MSSQL staging（saolei_mssql.player）读封禁账号成绩字段，
按 transform.py 的 score_fields 同口径换算后 UPDATE 目标库
user_scores / user_scores_nf 的全部 20 个成绩列（只动 status<>0 的账号，幂等可重跑）。

口径锚点（与 transform.py 完全一致）：
  time 列: 秒 <999.99 才有效，存 (秒-1)*1000 毫秒；3bvs: >0 才有效，存 ×1000；
  *_video 列为 MSSQL 录像 id；*_date 列取该录像 Video_Time 转 unix 秒；
  sum_time = 三级时间齐全才合成；sum_3bvs 允许有初级时间但未达 3BV 限界时按初级 0 合成。

校验基准：2747（杨萧杨）应为 beg 620 / int 9960 / exp 36790 / sum 47370。

用法: python3 scripts/sync/backfill-banned-userscores.py [--apply]   默认 dry-run
连接: staging 读本地 saolei_mssql；目标库默认本地 root@127.0.0.1:3306/saolei，
SAOLEI_DB_HOST/PORT/USER/PASSWORD/NAME 覆盖（写生产走 3316 隧道 + --allow-nonlocal）。
"""
import os
import sys
import time
from datetime import datetime

import pymysql

DRY = "--apply" not in sys.argv
NONLOCAL = bool(os.environ.get("SAOLEI_DB_PORT")) and os.environ["SAOLEI_DB_PORT"] != "3306"
if NONLOCAL and "--allow-nonlocal" not in sys.argv and not DRY:
    print("目标库非本地 3306，写入需显式 --allow-nonlocal")
    sys.exit(2)

# ---------- staging（MSSQL 导出快照，本地） ----------
st = pymysql.connect(host="127.0.0.1", port=3306, user="root", password="",
                     database="saolei_mssql", charset="utf8mb4")
sc = st.cursor()

my = pymysql.connect(
    host=os.environ.get("SAOLEI_DB_HOST", "127.0.0.1"),
    port=int(os.environ.get("SAOLEI_DB_PORT", "3306")),
    user=os.environ.get("SAOLEI_DB_USER", "root"),
    password=os.environ.get("SAOLEI_DB_PASSWORD", ""),
    database=os.environ.get("SAOLEI_DB_NAME", "saolei"),
    charset="utf8mb4", autocommit=False)
cur = my.cursor()

EPOCH = datetime(1970, 1, 1)
TZ8 = __import__("datetime").timedelta(hours=8)


def ux(dt):
    """MSSQL datetime -> unix 秒（+08:00）"""
    if dt is None:
        return 0
    return int((dt - TZ8 - EPOCH).total_seconds())


def t_ms(score):
    return int((score - 1.0) * 1000 + 0.5)


def b_x1000(score):
    return int(score * 1000 + 0.5)


# 录像时间索引（算 *_date 用）：只需封禁账号成绩用到的录像，全量也就 30 万行，一把读
print("loading staging video times...", flush=True)
sc.execute("SELECT Video_Id, Video_Time FROM video")
vtime = {r[0]: ux(r[1]) for r in sc.fetchall()}

sc.execute(
    "SELECT Player_Id,"
    " Player_Beg_Time_Score, Player_Beg_Time_Video, Player_Beg_3BVS_Score, Player_Beg_3BVS_Video,"
    " Player_Int_Time_Score, Player_Int_Time_Video, Player_Int_3BVS_Score, Player_Int_3BVS_Video,"
    " Player_Exp_Time_Score, Player_Exp_Time_Video, Player_Exp_3BVS_Score, Player_Exp_3BVS_Video,"
    " Player_Beg_Time_Score_NF, Player_Beg_Time_Video_NF, Player_Beg_3BVS_Score_NF, Player_Beg_3BVS_Video_NF,"
    " Player_Int_Time_Score_NF, Player_Int_Time_Video_NF, Player_Int_3BVS_Score_NF, Player_Int_3BVS_Video_NF,"
    " Player_Exp_Time_Score_NF, Player_Exp_Time_Video_NF, Player_Exp_3BVS_Score_NF, Player_Exp_3BVS_Video_NF"
    " FROM player WHERE Player_IsLive=0")
players = sc.fetchall()
print(f"staging 封禁账号: {len(players)}", flush=True)

# 目标库封禁账号集合（只动这些，防 staging 与目标漂移）
cur.execute("SELECT id FROM user WHERE status <> 0")
banned = {r[0] for r in cur.fetchall()}
print(f"目标库封禁账号: {len(banned)}", flush=True)

COLS = ("beg_time,beg_3bvs,int_time,int_3bvs,exp_time,exp_3bvs,sum_time,sum_3bvs,"
        "beg_time_video,beg_3bvs_video,int_time_video,int_3bvs_video,exp_time_video,exp_3bvs_video,"
        "beg_time_date,beg_3bvs_date,int_time_date,int_3bvs_date,exp_time_date,exp_3bvs_date")


def score_fields(p, base, nf):
    """base = 该级别（flag/NF）列组在 p 中的起始下标；返回 (tm, tb, tv, bv, td, bd)"""
    st_, tv_, sb_, bv_ = p[base], p[base + 1], p[base + 2], p[base + 3]
    tm = tb = tv = bv = td = bd = None
    if st_ is not None and st_ < 999.99:
        tm = t_ms(st_)
        tv = tv_
        td = vtime.get(tv_, 0)
    if sb_ is not None and sb_ > 0:
        tb = b_x1000(sb_)
        bv = bv_
        bd = vtime.get(bv_, 0)
    return tm, tb, tv, bv, td, bd


def build_rows(nf):
    rows = []
    off = 12 if nf else 0  # NF 列组在 SELECT 里的偏移
    for p in players:
        pid = p[0]
        if pid not in banned:
            continue
        bt, bb, btv, bbv, btd, bbd = score_fields(p, 1 + off, nf)
        it, ib, itv, ibv, itd, ibd = score_fields(p, 5 + off, nf)
        et, eb, etv, ebv, etd, ebd = score_fields(p, 9 + off, nf)
        # 与 transform.py / review.ts 同口径：有初级成绩但未达 3BV 限界记 0
        if bt is not None and bb is None:
            bb = 0
        sum_t = (bt + it + et) if (bt is not None and it is not None and et is not None) else 0
        sum_b = (bb + ib + eb) if (bb is not None and ib is not None and eb is not None) else 0
        rows.append((bt, bb, it, ib, et, eb, sum_t, sum_b,
                     btv, bbv, itv, ibv, etv, ebv, btd, bbd, itd, ibd, etd, ebd,
                     int(time.time()), pid))
    return rows


for nf, table in ((False, "user_scores"), (True, "user_scores_nf")):
    rows = build_rows(nf)
    print(f"[{table}] 待更新 {len(rows)} 行", flush=True)
    if not DRY:
        sql = (f"UPDATE {table} SET {','.join(c + '=%s' for c in COLS.split(','))},update_time=%s "
               "WHERE id=%s")
        cur.executemany(sql, rows)
        my.commit()
        print(f"[{table}] 已更新 {cur.rowcount} 行", flush=True)

# 校验 2747
cur.execute("SELECT beg_time, int_time, exp_time, sum_time FROM user_scores WHERE id=2747")
got = cur.fetchone()
print(f"校验 2747: {got}（dry-run 时为旧值；apply 后应为 (620, 9960, 36790, 47370)）")
if DRY:
    # dry-run 用内存计算值校验
    for p in players:
        if p[0] == 2747:
            bt, bb, *_ = score_fields(p, 1, False)
            it, ib, *_ = score_fields(p, 5, False)
            et, eb, *_ = score_fields(p, 9, False)
            print(f"dry-run 计算值: beg={bt} int={it} exp={et} sum={bt+it+et}")
            assert (bt, it, et, bt + it + et) == (620, 9960, 36790, 47370), "口径与 transform.py 不一致！"
            print("口径校验通过（与本地已知值一致）")

my.close()
st.close()
print("DONE" if not DRY else "[dry-run] 未写库。确认后加 --apply 执行。")
