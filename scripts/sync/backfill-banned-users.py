#!/usr/bin/env python3
"""补导旧站「已停用」账号 -> 新站用户域（2026-10-14）

背景
----
transform.py 的用户域筛选条件是 `FROM Player WHERE Player_IsLive=1`（只导存活账号），
而录像域不带上传者过滤——旧站停用(Player_IsLive=0)账号的录像照样进库，于是
`video.user` 指向新站 user 表里不存在的 id：详情页 author=null（无头像/军衔/右栏卡片），
列表页显示 `?`。全站 2844 条录像、123 个悬空 id（本地与生产完全一致）。

张老师 2026-10-14 定调：**封禁 ≠ 删号**（可能只是违规，将来还会解封），这些账号要导过来。
旧站 `Live_Action.asp` 也证实 Player_IsLive 只是「停用/启用」开关，可逆。

做法（幂等，可反复跑）
--------------------
从 staging(saolei_mssql) 取全部 `Player_IsLive=0` 账号，写新站用户域：

  user           status=-1（新站封禁语义＝仅禁止登录，成绩/录像/名字全保留）。
                 **已存在的行只回填 status**，姓名/地区等不动（新站可能已改过）
  user_info      INSERT IGNORE（已存在不动）
  user_stat      INSERT IGNORE（已存在不动）
  user_scores(_nf)  与 transform.py 同口径 upsert（旧站是权威源；这些账号不能登录，
                    新站不会产生新成绩，无覆盖风险）
  user_auth      INSERT IGNORE；username 与其它 id 冲突则跳过；role 一律 0
                 （停用账号不继承管理权限；实测停用账号里 IsMaster=1 为 0 个）

字段口径与 transform.py 完全一致：时间成绩=(秒-1)*1000、3BVS=值*1000、999.99/NULL=无成绩、
MSSQL datetime 视为 +08:00；改口径时两处必须同步改。

用法
----
  PY=/Users/shenjia/.workbuddy/binaries/python/envs/default/bin/python
  $PY scripts/sync/backfill-banned-users.py --dry-run   # 只统计不写库
  $PY scripts/sync/backfill-banned-users.py             # 实际写入
"""
import argparse
import hashlib
import secrets
import time
from datetime import datetime, timedelta

import pymysql

EPOCH = datetime(1970, 1, 1)
TZ8 = timedelta(hours=8)
BATCH = 2000

ap = argparse.ArgumentParser()
ap.add_argument("--dry-run", action="store_true", help="只统计不写库")
args = ap.parse_args()

my = pymysql.connect(host="127.0.0.1", user="root", database="saolei",
                     charset="utf8mb4", autocommit=False)
stg = pymysql.connect(host="127.0.0.1", user="root", database="saolei_mssql",
                      charset="utf8mb4", autocommit=True)
cur = my.cursor()
sc = stg.cursor()


def ux(dt):
    """naive datetime(北京时间) -> unix 秒"""
    if dt is None:
        return 0
    return int((dt - TZ8 - EPOCH).total_seconds())


def t_ms(score):
    """成绩秒 -> 毫秒(减 1 秒规则，与 transform.py 一致)"""
    return int((score - 1.0) * 1000 + 0.5)


def b_x1000(score):
    return int(score * 1000 + 0.5)


def flush(sql, rows, tag):
    if not rows:
        return
    for i in range(0, len(rows), BATCH):
        cur.executemany(sql, rows[i:i + BATCH])
        my.commit()
    print(f"  [{tag}] {len(rows)} rows", flush=True)


t0 = time.time()

# ---------- 列下标（与 SELECT 顺序对应，取自 transform.py） ----------
C = {name: i for i, name in enumerate([
    "id", "name", "pass", "cn", "en", "net", "sex", "area", "reg", "email", "master",
    "sum_t", "sum_t_nf", "sum_b", "sum_b_nf",
    "beg_t", "beg_tv", "beg_b", "beg_bv",
    "int_t", "int_tv", "int_b", "int_bv",
    "exp_t", "exp_tv", "exp_b", "exp_bv",
    "beg_t_nf", "beg_tv_nf", "beg_b_nf", "beg_bv_nf",
    "int_t_nf", "int_tv_nf", "int_b_nf", "int_bv_nf",
    "exp_t_nf", "exp_tv_nf", "exp_b_nf", "exp_bv_nf",
    "click", "qq", "mouse", "pad", "interest", "year", "month", "image", "login"])}

# ---------- 0. staging 读入 ----------
print("loading staging...", flush=True)
sc.execute("SELECT Video_Id, Video_Time FROM video")
vtime = {r[0]: ux(r[1]) for r in sc.fetchall()}

# 每用户每级别录像数（user_stat 用，口径同 transform.py：只数 IsLive 录像）
vcnt = {}
sc.execute("SELECT Video_Player, Video_Model, Video_IsLive FROM video")
for pid, model, islive in sc.fetchall():
    if islive:
        key = (pid, (model or "").lower())
        vcnt[key] = vcnt.get(key, 0) + 1

sc.execute("""SELECT Player_Id, Player_Name, Player_Password, Player_Name_Chinese,
       Player_Name_English, Player_Name_Net, Player_Sex, Player_Area, Player_Register_Time,
       Player_Email, Player_IsMaster,
       Player_Sum_Time_Score, Player_Sum_Time_Score_NF, Player_Sum_3BVS_Score, Player_Sum_3BVS_Score_NF,
       Player_Beg_Time_Score, Player_Beg_Time_Video, Player_Beg_3BVS_Score, Player_Beg_3BVS_Video,
       Player_Int_Time_Score, Player_Int_Time_Video, Player_Int_3BVS_Score, Player_Int_3BVS_Video,
       Player_Exp_Time_Score, Player_Exp_Time_Video, Player_Exp_3BVS_Score, Player_Exp_3BVS_Video,
       Player_Beg_Time_Score_NF, Player_Beg_Time_Video_NF, Player_Beg_3BVS_Score_NF, Player_Beg_3BVS_Video_NF,
       Player_Int_Time_Score_NF, Player_Int_Time_Video_NF, Player_Int_3BVS_Score_NF, Player_Int_3BVS_Video_NF,
       Player_Exp_Time_Score_NF, Player_Exp_Time_Video_NF, Player_Exp_3BVS_Score_NF, Player_Exp_3BVS_Video_NF,
       Player_Click, Player_QQ, Player_Mouse, Player_Pad, Player_Interest,
       Player_Year, Player_Month, Player_Image, Player_Login_Time
       FROM player WHERE Player_IsLive=0""")
players = sc.fetchall()
print(f"  players(停用): {len(players)}", flush=True)


def score_fields(p, lv, nf):
    """返回 (time_ms, b3bvs_x1000, time_video, b3bvs_video, time_date, b3bvs_date)"""
    sfx = "_nf" if nf else ""
    st = p[C[f"{lv}_t{sfx}"]]
    sb = p[C[f"{lv}_b{sfx}"]]
    tm = tb = None
    tv = bv = None
    td = bd = None
    if st is not None and st < 999.99:
        tm = t_ms(st)
        tv = p[C[f"{lv}_tv{sfx}"]]
        td = vtime.get(tv, 0)
    if sb is not None and sb > 0:
        tb = b_x1000(sb)
        bv = p[C[f"{lv}_bv{sfx}"]]
        bd = vtime.get(bv, 0)
    return tm, tb, tv, bv, td, bd


now = int(time.time())
u_rows, ui_rows, ust_rows, us_rows, usn_rows, ua_rows = [], [], [], [], [], []
with_score = []

for p in players:
    pid = p[C["id"]]
    reg = ux(p[C["reg"]])
    u_rows.append((pid, (p[C["cn"]] or "")[:12], (p[C["en"]] or "")[:32],
                   1 if p[C["sex"]] else 0, "1" if p[C["image"]] else "0",
                   (p[C["area"]] or "")[:12], -1, reg, 0, ux(p[C["login"]])))

    y, m = p[C["year"]] or 0, p[C["month"]] or 0
    bday = 0
    if y and m:
        try:
            d = datetime(int(y), int(m), 1)
            bday = ux(d) if 1900 <= d.year <= 2100 else 0
        except (ValueError, OverflowError):
            bday = 0
    ui_rows.append((pid, (p[C["qq"]] or "")[:20], (p[C["net"]] or "")[:32], bday,
                    (p[C["mouse"]] or "")[:60], (p[C["pad"]] or "")[:60], "",
                    (p[C["interest"]] or "")[:150], reg, 0))

    for nf, rows in ((False, us_rows), (True, usn_rows)):
        bt, bb, btv, bbv, btd, bbd = score_fields(p, "beg", nf)
        it, ib, itv, ibv, itd, ibd = score_fields(p, "int", nf)
        et, eb, etv, ebv, etd, ebd = score_fields(p, "exp", nf)
        sum_t = (bt + it + et) if (bt is not None and it is not None and et is not None) else 0
        sum_b = (bb + ib + eb) if (bb is not None and ib is not None and eb is not None) else 0
        rows.append((pid, bt, bb, it, ib, et, eb, sum_t, sum_b,
                     btv, bbv, itv, ibv, etv, ebv, btd, bbd, itd, ibd, etd, ebd, now, 0))
        if not nf and sum_t > 0:
            with_score.append(pid)

    ust_rows.append((pid, int(p[C["click"]] or 0),
                     vcnt.get((pid, "beg"), 0), vcnt.get((pid, "int"), 0),
                     vcnt.get((pid, "exp"), 0), reg))

    # auth：停用账号一律 role=0（不继承管理权限）
    salt = hashlib.md5(secrets.token_bytes(16)).hexdigest()
    plain = p[C["pass"]] or ""
    pw = hashlib.md5((plain + salt).encode("utf-8", "replace")).hexdigest()
    ua_rows.append((pid, (p[C["name"]] or "")[:64], pw, salt, 0, reg, 0))

# ---------- 1. 区分已存在 / 新增 ----------
cur.execute("SELECT id FROM user")
existing_user = {r[0] for r in cur.fetchall()}
cur.execute("SELECT id, username FROM user_auth")
name_owner = {r[1]: r[0] for r in cur.fetchall()}
cur.execute("SELECT id FROM user_scores WHERE sum_time > 0")
existing_ranked = {r[0] for r in cur.fetchall()}

banned_ids = [r[C["id"]] for r in players]
new_ids = [i for i in banned_ids if i not in existing_user]
back_ids = [i for i in banned_ids if i in existing_user]
# 这批账号里「有总成绩、会进排行榜」的
ranked_ids = [i for i in with_score if i not in existing_ranked]

# username 冲突过滤（与其它 id 重名则跳过建 auth 行）
ua_final, conflicts = [], []
for r in ua_rows:
    owner = name_owner.get(r[1])
    if owner is not None and owner != r[0]:
        conflicts.append((r[0], r[1], owner))
        continue
    ua_final.append(r)

print(f"""
统计
  停用账号总数            {len(banned_ids)}
  其中新站已有行(回填status) {len(back_ids)}
  其中需新插入行          {len(new_ids)}
  这批有总成绩的          {len(with_score)}（其中会新进排行榜 {len(ranked_ids)}）
  user_auth 待插入        {len(ua_final)}（username 冲突跳过 {len(conflicts)}）
""", flush=True)
if conflicts:
    for c in conflicts[:20]:
        print(f"  [auth-skip] id={c[0]} name={c[1]!r} 已被 id={c[2]} 占用", flush=True)

if args.dry_run:
    print("dry-run：未写库", flush=True)
    raise SystemExit(0)

# ---------- 2. 写库 ----------
print("writing...", flush=True)

# 已存在行只回填 status；新行写入完整字段
flush("""INSERT INTO user (id,chinese_name,english_name,sex,avatar,area,status,create_time,update_time,last_login_time)
         VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
         ON DUPLICATE KEY UPDATE status=VALUES(status)""", u_rows, "user")

flush("""INSERT IGNORE INTO user_info (id,qq,nickname,birthday,mouse,pad,self_intro,interest,create_time,update_time)
         VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""", ui_rows, "user_info")

flush("""INSERT IGNORE INTO user_stat (id,clicks,beg_videos,int_videos,exp_videos,create_time)
         VALUES (%s,%s,%s,%s,%s,%s)""", ust_rows, "user_stat")

score_cols = ("beg_time,beg_3bvs,int_time,int_3bvs,exp_time,exp_3bvs,sum_time,sum_3bvs,"
              "beg_time_video,beg_3bvs_video,int_time_video,int_3bvs_video,exp_time_video,exp_3bvs_video,"
              "beg_time_date,beg_3bvs_date,int_time_date,int_3bvs_date,exp_time_date,exp_3bvs_date,"
              "create_time,update_time")
score_upd = ",".join(f"{c}=VALUES({c})" for c in score_cols.split(",") if c not in ("create_time", "update_time"))
for table, rows in (("user_scores", us_rows), ("user_scores_nf", usn_rows)):
    flush(f"INSERT INTO {table} (id,{score_cols}) VALUES ({','.join(['%s'] * 23)}) "
          f"ON DUPLICATE KEY UPDATE {score_upd}", rows, table)

flush("""INSERT IGNORE INTO user_auth (id,username,password,salt,role,create_time,update_time)
         VALUES (%s,%s,%s,%s,%s,%s,%s)""", ua_final, "user_auth")

print(f"done {time.time() - t0:.0f}s", flush=True)
