#!/usr/bin/env python3
"""staging (saolei_mssql) -> saolei 转换入库
映射规则(与 2013 版迁移口径逐字段验证一致):
- 用户: Player_IsLive=1;时间成绩 = (秒-1)*1000;3BVS = 值*1000;999.99/NULL=无成绩
- 录像: IsLive=0->status 0;Check=0->10;else 20;时间同为 (秒-1)*1000
- 时间戳: MSSQL datetime 视为 +08:00 转 Unix 秒
- 动态: News_Time > 本地基线 2013-10-23 08:23:46 的插入(type=20);并为新用户补 type=10 入伍动态
"""
import json, math, time, secrets, hashlib
from datetime import datetime, timedelta
import pymysql

EPOCH = datetime(1970, 1, 1)
TZ8 = timedelta(hours=8)
BATCH = 2000
NEWS_BASELINE = 1382487826  # 本地 news 最大 create_time

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
    """成绩秒 -> 毫秒(减 1 秒规则)"""
    return int((score - 1.0) * 1000 + 0.5)


def b_x1000(score):
    return int(score * 1000 + 0.5)


def run(sql, args):
    cur.execute(sql, args)


def flush(sql, rows, tag):
    for i in range(0, len(rows), BATCH):
        cur.executemany(sql, rows[i:i + BATCH])
        my.commit()
    if rows:
        print(f"  [{tag}] {len(rows)} rows", flush=True)


t0 = time.time()

# ---------- 0. 读 staging 全量到内存 ----------
print("loading staging...", flush=True)
sc.execute("SELECT Player_Id, Player_Name, Player_Password, Player_Name_Chinese, Player_Name_English,"
           " Player_Name_Net, Player_Sex, Player_Area, Player_Register_Time, Player_Email, Player_IsMaster,"
           " Player_Sum_Time_Score, Player_Sum_Time_Score_NF, Player_Sum_3BVS_Score, Player_Sum_3BVS_Score_NF,"
           " Player_Beg_Time_Score, Player_Beg_Time_Video, Player_Beg_3BVS_Score, Player_Beg_3BVS_Video,"
           " Player_Int_Time_Score, Player_Int_Time_Video, Player_Int_3BVS_Score, Player_Int_3BVS_Video,"
           " Player_Exp_Time_Score, Player_Exp_Time_Video, Player_Exp_3BVS_Score, Player_Exp_3BVS_Video,"
           " Player_Beg_Time_Score_NF, Player_Beg_Time_Video_NF, Player_Beg_3BVS_Score_NF, Player_Beg_3BVS_Video_NF,"
           " Player_Int_Time_Score_NF, Player_Int_Time_Video_NF, Player_Int_3BVS_Score_NF, Player_Int_3BVS_Video_NF,"
           " Player_Exp_Time_Score_NF, Player_Exp_Time_Video_NF, Player_Exp_3BVS_Score_NF, Player_Exp_3BVS_Video_NF,"
           " Player_Click, Player_QQ, Player_Mouse, Player_Pad, Player_Interest, Player_Year, Player_Month,"
           " Player_Image, Player_Login_Time"
           " FROM Player WHERE Player_IsLive=1")
players = sc.fetchall()
print(f"  players(live): {len(players)}", flush=True)

sc.execute("SELECT Video_Id, Video_Model, Video_Player, Video_Path, Video_IsLive, Video_Check,"
           " Video_Time, Video_Score, Video_3BV, Video_3BVS, Video_CheckBy, Video_CheckTime,"
           " Video_Click, Video_IsNoFrag FROM Video")
videos = {}
for r in sc.fetchall():
    videos[r[0]] = r
print(f"  videos: {len(videos)}", flush=True)

# 录像时间索引(算 score date 用)
vtime = {vid: ux(v[6]) for vid, v in videos.items()}

# 每用户每级别录像数(live)
vcnt = {}
for v in videos.values():
    if v[4]:  # IsLive
        key = (v[2], (v[1] or "").lower())
        vcnt[key] = vcnt.get(key, 0) + 1

# ---------- 1. 用户域 ----------
print("users...", flush=True)
now = int(time.time())
u_rows, ui_rows, us_rows, usn_rows, ust_rows, ua_rows = [], [], [], [], [], []
uid_set = set()

LV = (("Beg", "beg"), ("Int", "int"), ("Exp", "exp"))
# 列下标(与 SELECT 顺序对应)
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


for p in players:
    pid = p[C["id"]]
    uid_set.add(pid)
    reg = ux(p[C["reg"]])
    u_rows.append((pid, (p[C["cn"]] or "")[:12], (p[C["en"]] or "")[:32],
                   1 if p[C["sex"]] else 0, "1" if p[C["image"]] else "0",
                   (p[C["area"]] or "")[:12], 0, reg, 0))
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
    # scores
    for nf, rows in ((False, us_rows), (True, usn_rows)):
        bt, bb, btv, bbv, btd, bbd = score_fields(p, "beg", nf)
        it, ib, itv, ibv, itd, ibd = score_fields(p, "int", nf)
        et, eb, etv, ebv, etd, ebd = score_fields(p, "exp", nf)
        sum_t = (bt + it + et) if (bt is not None and it is not None and et is not None) else 0
        sum_b = (bb + ib + eb) if (bb is not None and ib is not None and eb is not None) else 0
        rows.append((pid, bt, bb, it, ib, et, eb, sum_t, sum_b,
                     btv, bbv, itv, ibv, etv, ebv, btd, bbd, itd, ibd, etd, ebd, now, 0))
    # stat
    ust_rows.append((pid, int(p[C["click"]] or 0),
                     vcnt.get((pid, "beg"), 0), vcnt.get((pid, "int"), 0), vcnt.get((pid, "exp"), 0), reg))
    # auth(仅新用户)
    salt = hashlib.md5(secrets.token_bytes(16)).hexdigest()
    plain = p[C["pass"]] or ""
    pw = hashlib.md5((plain + salt).encode("utf-8", "replace")).hexdigest()
    ua_rows.append((pid, (p[C["name"]] or "")[:64], pw, salt, 100 if p[C["master"]] else 0, reg, 0))

run("SELECT id FROM user_auth", ())
existing_auth = {r[0] for r in cur.fetchall()}
ua_rows = [r for r in ua_rows if r[0] not in existing_auth]
# 防 username 唯一冲突:与现有不同 id 的 username 冲突则跳过并记录
run("SELECT id, username FROM user_auth", ())
name_owner = {r[1]: r[0] for r in cur.fetchall()}
ua_final = []
for r in ua_rows:
    owner = name_owner.get(r[1])
    if owner is not None and owner != r[0]:
        print(f"  [auth-skip] username 冲突 id={r[0]} name={r[1]!r} 已被 id={owner} 占用", flush=True)
        continue
    ua_final.append(r)

flush("""INSERT INTO user (id,chinese_name,english_name,sex,avatar,area,status,create_time,update_time)
       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) ON DUPLICATE KEY UPDATE
       chinese_name=VALUES(chinese_name),english_name=VALUES(english_name),sex=VALUES(sex),
       avatar=VALUES(avatar),area=VALUES(area)""", u_rows, "user")
flush("""INSERT INTO user_info (id,qq,nickname,birthday,mouse,pad,self_intro,interest,create_time,update_time)
       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON DUPLICATE KEY UPDATE
       qq=VALUES(qq),nickname=VALUES(nickname),birthday=VALUES(birthday),mouse=VALUES(mouse),
       pad=VALUES(pad),interest=VALUES(interest)""", ui_rows, "user_info")
score_cols = "beg_time,beg_3bvs,int_time,int_3bvs,exp_time,exp_3bvs,sum_time,sum_3bvs," \
             "beg_time_video,beg_3bvs_video,int_time_video,int_3bvs_video,exp_time_video,exp_3bvs_video," \
             "beg_time_date,beg_3bvs_date,int_time_date,int_3bvs_date,exp_time_date,exp_3bvs_date,create_time,update_time"
score_upd = ",".join(f"{c}=VALUES({c})" for c in score_cols.split(",") if c not in ("create_time", "update_time"))
for table, rows in (("user_scores", us_rows), ("user_scores_nf", usn_rows)):
    flush(f"INSERT INTO {table} (id,{score_cols}) VALUES ({','.join(['%s'] * 23)}) "
          f"ON DUPLICATE KEY UPDATE {score_upd}", rows, table)
flush("""INSERT INTO user_stat (id,clicks,beg_videos,int_videos,exp_videos,create_time)
       VALUES (%s,%s,%s,%s,%s,%s) ON DUPLICATE KEY UPDATE
       clicks=VALUES(clicks),beg_videos=VALUES(beg_videos),int_videos=VALUES(int_videos),exp_videos=VALUES(exp_videos)""",
      ust_rows, "user_stat")
flush("""INSERT IGNORE INTO user_auth (id,username,password,salt,role,create_time,update_time)
       VALUES (%s,%s,%s,%s,%s,%s,%s)""", ua_final, "user_auth")
print(f"users done {time.time()-t0:.0f}s", flush=True)

# ---------- 2. 录像域 ----------
print("videos...", flush=True)
v_rows, vi_rows, vst_rows = [], [], []
vs_rows = {k: [] for k in ("beg", "int", "exp", "beg_nf", "int_nf", "exp_nf")}
run("SELECT id FROM video_info", ())
existing_vinfo = {r[0] for r in cur.fetchall()}

for vid, v in videos.items():
    (_, model, player, path, islive, check, vtime_dt, score, bv, b3bvs, checkby, checktime, click, nf) = v
    level = (model or "").lower()
    if level not in ("beg", "int", "exp"):
        continue
    status = 0 if not islive else (10 if not check else 20)
    ct = ux(vtime_dt)
    rt = ux(checktime)
    v_rows.append((vid, level, player, status,
                   checkby if checkby else None, rt if rt else None, ct, 0))
    real_ms = t_ms(score) if score is not None else 0
    b3bv = int(round(bv)) if bv is not None else 0
    if vid in existing_vinfo:
        vi_rows.append((b3bv, real_ms, vid))  # 仅校准 board_3bv/real_time
    else:
        vi_rows.append((vid, (path or "")[:100], "", "", "", 1 if nf else 0, "", b3bv, real_ms, ct, 0))
    vst_rows.append((vid, int(click or 0), ct))
    if status == 20 and score is not None:
        s3 = b_x1000(b3bvs) if b3bvs is not None else 0
        vs_rows[level].append((vid, player, real_ms, s3, ct))
        if nf:
            vs_rows[level + "_nf"].append((vid, player, real_ms, s3, ct))

flush("""INSERT INTO video (id,level,user,hash,status,review_user,review_time,create_time,update_time)
       VALUES (%s,%s,%s,'',%s,%s,%s,%s,%s) ON DUPLICATE KEY UPDATE
       level=VALUES(level),user=VALUES(user),status=VALUES(status),
       review_user=VALUES(review_user),review_time=VALUES(review_time),create_time=VALUES(create_time)""",
      v_rows, "video")
# video_info: 新行全量插入;已存在行仅校准 board_3bv/real_time
vi_new = [r for r in vi_rows if len(r) == 10]
vi_upd = [r for r in vi_rows if len(r) == 3]
flush("""INSERT INTO video_info (id,filepath,signature,software,version,noflag,board,board_3bv,real_time,create_time,update_time)
       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""", vi_new, "video_info(new)")
flush("UPDATE video_info SET board_3bv=%s, real_time=%s WHERE id=%s", vi_upd, "video_info(upd)")
flush("""INSERT INTO video_stat (id,clicks,create_time) VALUES (%s,%s,%s)
       ON DUPLICATE KEY UPDATE clicks=VALUES(clicks)""", vst_rows, "video_stat")
for key, rows in vs_rows.items():
    flush(f"""INSERT INTO video_scores_{key} (id,user,score_time,score_3bvs,create_time)
           VALUES (%s,%s,%s,%s,%s) ON DUPLICATE KEY UPDATE
           user=VALUES(user),score_time=VALUES(score_time),score_3bvs=VALUES(score_3bvs)""",
          rows, f"video_scores_{key}")
print(f"videos done {time.time()-t0:.0f}s", flush=True)

# ---------- 3. 评论(全量,表原为空) ----------
print("comments...", flush=True)
sc.execute("SELECT Comment_Id, Comment_Video, Comment_Player, Comment_Text, Comment_Time, Comment_Rank FROM Comment")
cm_rows = []
for cid, cv, cp, text, ctime, rank in sc.fetchall():
    ts = ux(ctime)
    cm_rows.append((cid, cv, cp, int((rank or 0) + 0.5), text or "", 0, ts, 0))
flush("""INSERT IGNORE INTO comment (id,video,user,user_score,content,status,create_time,update_time)
       VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""", cm_rows, "comment")
# 评论数回写 video_stat.comments
print("  backfill video_stat.comments", flush=True)
run("""UPDATE video_stat s JOIN (SELECT video, COUNT(*) c FROM comment GROUP BY video) x
     ON s.id=x.video SET s.comments=x.c""", ())
my.commit()
print(f"comments done {time.time()-t0:.0f}s", flush=True)

# ---------- 4. 动态 ----------
print("news...", flush=True)
run("SELECT COUNT(*) FROM news WHERE create_time > %s", (NEWS_BASELINE,))
news_done_already = cur.fetchone()[0] > 0
if news_done_already:
    print("  [skip] news 已有增量数据(非幂等段,避免重复)", flush=True)
else:
    # 现有 type=10 用户集合 + 最大 id
    run("SELECT DISTINCT user FROM news WHERE type=10", ())
    has_newbie = {r[0] for r in cur.fetchall()}
    # 用户当前 sum_time(算 user_score 近似值)
    run("SELECT id, sum_time FROM user_scores", ())
    sum_map = {r[0]: r[1] or 0 for r in cur.fetchall()}

    sc.execute("""SELECT News_Id, News_Time, News_Video, News_Player, News_Model, News_Thing, News_Score, News_Grow
                FROM News WHERE News_IsLive=1 AND News_Time > '2013-10-23 08:23:46' ORDER BY News_Id""")
    seen = set()
    n_rows = []
    lv_map = {"初级": "beg", "中级": "int", "高级": "exp"}
    for nid, ntime, nvideo, nplayer, nmodel, nthing, nscore, ngrow in sc.fetchall():
        lv = lv_map.get(nmodel or "")
        if lv is None or nvideo not in videos:
            continue
        key = (nvideo, nthing)
        if key in seen:
            continue
        seen.add(key)
        if nthing == "时间":
            od = "time"
            cr = t_ms(nscore)
            org = t_ms(nscore + (ngrow or 0)) if ngrow else 0
        else:
            od = "3bvs"
            cr = b_x1000(nscore)
            org = b_x1000(nscore - (ngrow or 0)) if ngrow else 0
            if org < 0:
                org = 0
        details = json.dumps({"lv": lv, "od": od, "or": str(org), "cr": str(cr), "nf": 0}, separators=(",", ":"))
        n_rows.append((ux(ntime), 1, 20, nplayer, sum_map.get(nplayer, 0), nvideo, details))

    # 入伍动态:用户首个凑齐三级别的时刻(按录像时间)
    seen_lv = {}
    for vid, v in sorted(videos.items(), key=lambda kv: (ux(kv[1][6]) or 0, kv[0])):
        (_, model, player, path, islive, check, vtime_dt, *_rest) = v
        level = (model or "").lower()
        if level not in ("beg", "int", "exp") or not islive:
            continue
        if player in has_newbie:
            continue
        s = seen_lv.setdefault(player, set())
        s.add(level)
        if len(s) == 3:
            ct0 = ux(vtime_dt) or now
            n_rows.append((ct0, 0, 10, player, sum_map.get(player, 0), 0, "[]"))
            has_newbie.add(player)
    # 合并后按 (create_time, newbie 优先) 排序插入,保证 id 序=时间序(游标分页依赖)
    n_rows.sort(key=lambda r: (r[0], r[1]))
    ins_rows = [(t, u, us, ref, det, ct) for ct, _o, t, u, us, ref, det in n_rows]
    flush("""INSERT INTO news (type,user,user_score,reference,details_data,create_time)
           VALUES (%s,%s,%s,%s,%s,%s)""", ins_rows, "news(all)")
print(f"news done {time.time()-t0:.0f}s", flush=True)

# ---------- 5. 论坛 ----------
print("bbs...", flush=True)
sc.execute("""SELECT Title_Id, Title_Get_Id, Title_Name, Title_Player, Title_Text,
            Title_Post_Time, Title_Edit_Time, Title_Reply_Time, Title_Click, Title_Reply,
            Title_IsHigh, Title_IsNice, Title_IsLock, Title_Model FROM Title ORDER BY Title_Id""")
titles = sc.fetchall()
board_map = {"Notice": 0, "Skill": 1, "Other": 2, "Ask": 3}
# 每帖最后回复人
last_reply_user = {}
for t in titles:
    getid = t[1] or 0
    if getid > 0:
        last_reply_user[getid] = t[3]  # 按 id 升序,后者覆盖
p_rows, r_rows = [], []
for (tid, getid, name, player, text, ptime, etime, rtime, click, reply, high, nice, lock, model) in titles:
    ts = ux(ptime)
    if (getid or 0) > 0:
        r_rows.append((tid, getid, player, text or "", 0, ts, ux(etime)))
    else:
        board = board_map.get(model or "", 2)
        p_rows.append((tid, board, player, (name or "")[:100], text or "",
                       int(reply or 0), int(click or 0),
                       1 if high else 0, 1 if nice else 0, 1 if lock else 0, 0,
                       ux(rtime), last_reply_user.get(tid, 0), ts, ux(etime)))
flush("""INSERT INTO bbs_post (id,board,user,title,content,replies,clicks,is_top,is_nice,is_locked,status,
       last_reply_time,last_reply_user,create_time,update_time)
       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
       ON DUPLICATE KEY UPDATE replies=VALUES(replies),clicks=VALUES(clicks),is_top=VALUES(is_top),
       is_nice=VALUES(is_nice),is_locked=VALUES(is_locked),last_reply_time=VALUES(last_reply_time),
       last_reply_user=VALUES(last_reply_user)""", p_rows, "bbs_post")
flush("""INSERT INTO bbs_reply (id,post,user,content,status,create_time,update_time)
       VALUES (%s,%s,%s,%s,%s,%s,%s) ON DUPLICATE KEY UPDATE content=VALUES(content)""",
      r_rows, "bbs_reply")
print(f"bbs done {time.time()-t0:.0f}s", flush=True)

# ---------- 6. 历程 / 站内信 ----------
print("history/message...", flush=True)
sc.execute("SELECT History_Id, History_Player, History_Time, History_Text FROM History")
h_rows = []
for hid, hp, htime, htext in sc.fetchall():
    ym = htime.strftime("%Y-%m") if htime else ""
    if not ym:
        continue
    ts = ux(htime)
    h_rows.append((hp, ym, (htext or "")[:500], ts, 0))
flush("""INSERT INTO history (`user`,`year_month`,`content`,`create_time`,`update_time`)
       VALUES (%s,%s,%s,%s,%s) ON DUPLICATE KEY UPDATE content=VALUES(content)""", h_rows, "history")

sc.execute("SELECT Message_Id, Message_Text, Message_From, Message_To, Message_Time, Message_Read FROM Message")
m_rows = []
for mid, mtext, mf, mt, mtime, mread in sc.fetchall():
    ts = ux(mtime)
    m_rows.append((mid, mf, mt, (mtext or "")[:200], 1 if mread else 0, 0, ts, 0))
flush("""INSERT INTO message (id,from_user,to_user,content,is_read,is_system,create_time,update_time)
       VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON DUPLICATE KEY UPDATE is_read=VALUES(is_read)""",
      m_rows, "message")

print(f"ALL DONE {time.time()-t0:.0f}s", flush=True)
my.close()
stg.close()
