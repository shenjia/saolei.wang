#!/usr/bin/env python3
"""同步结果校验:行数对账 + 抽样字段比对 + 排行一致性"""
import random
import pymysql

my = pymysql.connect(host="127.0.0.1", user="root", database="saolei", charset="utf8mb4")
stg = pymysql.connect(host="127.0.0.1", user="root", database="saolei_mssql", charset="utf8mb4")
c, s = my.cursor(), stg.cursor()

print("===== 行数对账 =====")
checks = [
    ("user", "SELECT COUNT(*) FROM user", "SELECT COUNT(*) FROM Player WHERE Player_IsLive=1"),
    ("user(含本地测试号)", "SELECT COUNT(*) FROM user", None),
    ("video", "SELECT COUNT(*) FROM video", "SELECT COUNT(*) FROM Video"),
    ("video status=20", "SELECT COUNT(*) FROM video WHERE status=20",
     "SELECT COUNT(*) FROM Video WHERE Video_IsLive=1 AND Video_Check=1"),
    ("video status=0", "SELECT COUNT(*) FROM video WHERE status=0", "SELECT COUNT(*) FROM Video WHERE Video_IsLive=0"),
    ("video status=10", "SELECT COUNT(*) FROM video WHERE status=10",
     "SELECT COUNT(*) FROM Video WHERE Video_IsLive=1 AND Video_Check=0"),
    ("video_scores_beg", "SELECT COUNT(*) FROM video_scores_beg",
     "SELECT COUNT(*) FROM Video WHERE Video_Model='Beg' AND Video_IsLive=1 AND Video_Check=1"),
    ("video_scores_int", "SELECT COUNT(*) FROM video_scores_int",
     "SELECT COUNT(*) FROM Video WHERE Video_Model='Int' AND Video_IsLive=1 AND Video_Check=1"),
    ("video_scores_exp", "SELECT COUNT(*) FROM video_scores_exp",
     "SELECT COUNT(*) FROM Video WHERE Video_Model='Exp' AND Video_IsLive=1 AND Video_Check=1"),
    ("video_scores_beg_nf", "SELECT COUNT(*) FROM video_scores_beg_nf",
     "SELECT COUNT(*) FROM Video WHERE Video_Model='Beg' AND Video_IsLive=1 AND Video_Check=1 AND Video_IsNoFrag=1"),
    ("comment", "SELECT COUNT(*) FROM comment", "SELECT COUNT(*) FROM Comment"),
    ("bbs_post", "SELECT COUNT(*) FROM bbs_post", "SELECT COUNT(*) FROM Title WHERE Title_Get_Id=0 OR Title_Get_Id IS NULL"),
    ("bbs_reply", "SELECT COUNT(*) FROM bbs_reply", "SELECT COUNT(*) FROM Title WHERE Title_Get_Id>0"),
    ("history", "SELECT COUNT(*) FROM history", "SELECT COUNT(*) FROM History"),
    ("message", "SELECT COUNT(*) FROM message", "SELECT COUNT(*) FROM Message"),
    ("news", "SELECT COUNT(*) FROM news", None),
]
for name, lq, rq in checks:
    c.execute(lq)
    lv = c.fetchone()[0]
    rv = "-"
    if rq:
        s.execute(rq)
        rv = s.fetchone()[0]
    flag = "✓" if str(lv) == str(rv) else " "
    print(f"  {flag} {name}: 本地={lv} MSSQL={rv}")

print("===== 抽样字段比对(20 用户成绩) =====")
s.execute("SELECT Player_Id FROM Player WHERE Player_IsLive=1 AND Player_Sum_Time_Score<999 ORDER BY RAND() LIMIT 0")
random.seed(42)
s.execute("SELECT Player_Id, Player_Beg_Time_Score, Player_Exp_3BVS_Score, Player_Sum_Time_Score FROM Player WHERE Player_IsLive=1 AND Player_Sum_Time_Score<999")
rows = s.fetchall()
sample = random.sample(rows, 20)
ok = bad = 0
for pid, beg_t, exp_b, sum_t in sample:
    c.execute("SELECT beg_time, exp_3bvs, sum_time FROM user_scores WHERE id=%s", (pid,))
    r = c.fetchone()
    if not r:
        print(f"  ✗ user {pid} 缺失")
        bad += 1
        continue
    exp_beg = int((beg_t - 1) * 1000 + 0.5)
    exp_exp3 = int(exp_b * 1000 + 0.5)
    # sum 由三级别成绩加总,与 MSSQL sum 可能有 ±3ms 内浮点差
    if r[0] == exp_beg and r[1] == exp_exp3 and abs((r[2] or 0) - int((sum_t - 3) * 1000 + 0.5)) <= 3:
        ok += 1
    else:
        print(f"  ✗ user {pid}: 本地={r} 期望≈({exp_beg},{exp_exp3},{int((sum_t-3)*1000+0.5)})")
        bad += 1
print(f"  成绩抽样: {ok} 一致 / {bad} 不一致")

print("===== 抽样录像(10 条新录像) =====")
s.execute("SELECT Video_Id, Video_Score, Video_3BVS, Video_IsLive, Video_Check FROM Video WHERE Video_Id>81493 ORDER BY Video_Id DESC LIMIT 10")
for vid, score, b3, isl, chk in s.fetchall():
    c.execute("SELECT v.status, i.real_time, s.score_3bvs FROM video v JOIN video_info i ON i.id=v.id "
              "LEFT JOIN video_scores_" + "beg" + " s ON s.id=v.id WHERE v.id=%s", (vid,))
    r = c.fetchone()
    want_status = 0 if not isl else (10 if not chk else 20)
    want_rt = int((score - 1) * 1000 + 0.5)
    print(f"  video {vid}: status={r[0]}/{want_status} real_time={r[1]}/{want_rt}")

print("===== 排行 TOP5(sum_time) 对照 =====")
c.execute("""SELECT u.id, u.chinese_name, s.sum_time FROM user_scores s JOIN user u ON u.id=s.id
          WHERE s.sum_time>0 ORDER BY s.sum_time LIMIT 5""")
for r in c.fetchall():
    print(f"  {r[0]} {r[1]} {r[2]/1000:.2f}s")
s.execute("""SELECT TOP 5 Player_Id, Player_Name_Chinese, Player_Sum_Time_Score FROM Player
          WHERE Player_IsLive=1 AND Player_Sum_Time_Score<999 ORDER BY Player_Sum_Time_Score""")
for r in s.fetchall():
    print(f"  MSSQL {r[0]} {r[1]} {r[2]:.2f}s(含+3s规则)")

my.close()
stg.close()
