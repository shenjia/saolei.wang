#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
新旧站合并迁移（2026-10-22，方案 v3 定稿执行器）
=================================================
前置条件：
  · 旧站 MSSQL 已冻结（staging 已重抽终态：saolei_mssql 库）
  · 新站维护模式已开启（写入口全挡）
  · 生产已 mysqldump 备份（merge-backup-*.sql.gz）
  · 目标库是本地演练库或 --allow-nonlocal 生产

流程（五段）：
  plan     读 staging 终态 + 目标库现状，产出逐行计划（不写库）
  detach   摘除新站冲突数据（备份成 JSON 落盘再删）
  ingest   旧站增量原位写入（id 直插，复用 transform 同款口径）
  refill   新站数据回填（hash 去重 + id 映射改写引用）
  fold     user 999 段并入旧站序列尾（35,489+ 顺延，全链引用改写）

用法：
  python merge-migration.py plan    [--db ...env 或默认本地]
  python merge-migration.py detach|ingest|refill|fold  [--allow-nonlocal]
  python merge-migration.py verify  （终态对账，只读）

设计要点：
  · 每段幂等可重跑（detach 后 refill 前重跑 detach = no-op）
  · 所有跨段数据经 /tmp/merge-state/ 的 JSON 文件传递（可审计可回滚）
  · ingest 的录像域按 id 分批同事务写（6 表一批，铁律）
  · refill 的 id 映射在 plan 阶段就定死，落盘 merge-map.json
"""
import json
import os
import sys
import time

import pymysql

STATE_DIR = "/tmp/merge-state"
os.makedirs(STATE_DIR, exist_ok=True)

# ---------- 连接（目标库走 env，默认本地 root 免密；非本地必须 --allow-nonlocal） ----------


def target_conn():
    host = os.environ.get("SAOLEI_DB_HOST", "127.0.0.1")
    port = int(os.environ.get("SAOLEI_DB_PORT", "3306"))
    user = os.environ.get("SAOLEI_DB_USER", "root")
    password = os.environ.get("SAOLEI_DB_PASSWORD", "")
    dbname = os.environ.get("SAOLEI_DB_NAME", "saolei")
    return pymysql.connect(host=host, port=port, user=user, password=password,
                           database=dbname, charset="utf8mb4", autocommit=False)


def staging_conn():
    return pymysql.connect(host="127.0.0.1", user="root", database="saolei_mssql",
                           charset="utf8mb4", autocommit=True)


def is_local():
    return os.environ.get("SAOLEI_DB_HOST", "127.0.0.1") == "127.0.0.1" and \
        os.environ.get("SAOLEI_DB_PORT", "3306") == "3306"


def guard_nonlocal(allowed):
    if not is_local() and not allowed:
        sys.exit("目标库非本地：加 --allow-nonlocal 才能写")


# ---------- 工具 ----------

def ux(dt):
    """MSSQL datetime（北京时间）→ Unix 秒"""
    from datetime import datetime, timedelta, timezone
    if not dt:
        return 0
    if isinstance(dt, str):
        dt = datetime.fromisoformat(dt)
    return int((dt - timedelta(hours=8) - datetime(1970, 1, 1)).total_seconds())


def t_ms(score):
    return int((score - 1.0) * 1000 + 0.5)


def dump(name, obj):
    p = os.path.join(STATE_DIR, name)
    with open(p, "w") as f:
        json.dump(obj, f, ensure_ascii=False, default=str)
    print(f"  [state] {name}: {p}", flush=True)


def load(name):
    p = os.path.join(STATE_DIR, name)
    if not os.path.exists(p):
        sys.exit(f"缺少状态文件 {p}，先跑前置段")
    with open(p) as f:
        return json.load(f)


def now_sec():
    return int(time.time())


BATCH = 2000

# ============================================================
# 段 1：plan —— 读两侧差集，产出计划（只读）
# ============================================================


def cmd_plan():
    stg = staging_conn()
    tgt = target_conn()
    sc, tc = stg.cursor(), tgt.cursor()

    plan = {"generated": now_sec()}

    # ---------- 录像域 ----------
    sc.execute("SELECT Video_Id, Video_IsLive FROM Video")
    old_ids = {r[0]: r[1] for r in sc.fetchall()}
    tc.execute("SELECT id, hash FROM video")
    tgt_videos = {r[0]: r[1] for r in tc.fetchall()}

    # 旧站有而目标无 → ingest（原位直插）
    ingest_vids = sorted(i for i in old_ids if i not in tgt_videos)
    # 目标有而旧站无 → 新站上传，detach 后 refill
    new_vids = sorted(i for i in tgt_videos if i not in old_ids)
    # 混合行 = 旧站 10-13 增量窗口内（id>345158）且目标已有行的 id：
    #   这些 id 目标侧行内容是「新站上传」（10-13 同步把它顶掉的/或新站先占位），
    #   旧站终态要原位回归 → 目标行摘除（refill 换新 id），旧站行 ingest。
    #   id<=345158 的重叠行是历史正常同步态（hash 已是旧站真值），不摘。
    mixed_vids = sorted(i for i in old_ids if i in tgt_videos and i > 345158)
    plan["video"] = {"ingest": len(ingest_vids), "detach": len(new_vids), "mixed": len(mixed_vids)}
    dump("plan-video.json", {"ingest": ingest_vids, "detach": new_vids, "mixed": mixed_vids})

    # ---------- 用户域 ----------
    sc.execute("SELECT Player_Id FROM Player")
    old_uids = {r[0] for r in sc.fetchall()}
    tc.execute("SELECT id FROM user")
    tgt_uids = {r[0] for r in tc.fetchall()}
    ingest_uids = sorted(i for i in old_uids if i not in tgt_uids)
    seg999 = sorted(i for i in tgt_uids if i >= 900000)
    plan["user"] = {"ingest": len(ingest_uids), "fold999": len(seg999)}
    dump("plan-user.json", {"ingest": ingest_uids, "fold999": seg999})
    # 折叠目标 id：旧站最大 id 之后顺延
    sc.execute("SELECT MAX(Player_Id) FROM Player")
    max_old = sc.fetchone()[0] or 0
    fold_map = {str(u): max_old + 1 + k for k, u in enumerate(seg999)}
    dump("fold-map.json", fold_map)

    # ---------- 评论 ----------
    sc.execute("SELECT Comment_Id FROM Comment")
    old_cids = {r[0] for r in sc.fetchall()}
    tc.execute("SELECT id FROM comment")
    tgt_cids = {r[0] for r in tc.fetchall()}
    ingest_cids = sorted(i for i in old_cids if i not in tgt_cids)
    new_cids = sorted(i for i in tgt_cids if i not in old_cids)
    # 撞车：id>56259（旧站 10-13 前沿）的双侧重叠行——目标行是新站评论，旧站行要进来
    # （实证：生产 56260-56262 是新站评论、旧站同 id 评论旧站视频——同 id 不同内容）
    collide_cids = sorted(i for i in tgt_cids if i in old_cids and i > 56259)
    plan["comment"] = {"ingest": len(ingest_cids), "detach": len(new_cids),
                       "collide": len(collide_cids)}
    dump("plan-comment.json", {"ingest": ingest_cids, "detach": new_cids,
                               "collide": collide_cids})

    # ---------- BBS（旧站 Title 帖+回帖同序列 → 新站两表） ----------
    sc.execute("SELECT Title_Id, Title_Get_Id FROM Title")
    titles = sc.fetchall()
    old_title_ids = {t[0]: t[1] for t in titles}
    tc.execute("SELECT id FROM bbs_post")
    tgt_pids = {r[0] for r in tc.fetchall()}
    tc.execute("SELECT id FROM bbs_reply")
    tgt_rids = {r[0] for r in tc.fetchall()}
    # ingest：旧站行（帖 or 回帖）任一表缺失的 id
    ingest_titles, ingest_replies = [], []
    for tid, getid in old_title_ids.items():
        if getid and getid > 0:
            if tid not in tgt_rids:
                ingest_replies.append(tid)
        else:
            if tid not in tgt_pids:
                ingest_titles.append(tid)
    # detach：新站帖/回帖中，id 不在旧站 Title 序列里的（= 新站原生）
    detach_posts = sorted(p for p in tgt_pids if p not in old_title_ids)
    detach_replies = sorted(r for r in tgt_rids if r not in old_title_ids)
    # 同 id 双侧同表占用：旧站 Title 有该 id 且目标同表也有行——**仅限 10-13 增量窗口**
    # （Title_Id > 24386）才算真碰撞（旧站新行要进来、新站行占着位）；
    # 窗口内的重叠行是历史同步态，不属于碰撞（ingest 列表已排除目标已有的）
    collide_posts = sorted(p for p in tgt_pids if p in old_title_ids and p > 24386
                           and not old_title_ids[p] and p not in ingest_titles)
    collide_replies = sorted(r for r in tgt_rids if r in old_title_ids and r > 24386
                             and old_title_ids.get(r, 1) and r not in ingest_replies)
    plan["bbs"] = {"ingest_posts": len(ingest_titles), "ingest_replies": len(ingest_replies),
                   "detach_posts": len(detach_posts), "detach_replies": len(detach_replies),
                   "collide_posts": len(collide_posts), "collide_replies": len(collide_replies)}
    dump("plan-bbs.json", {"ingest_titles": sorted(ingest_titles),
                           "ingest_replies": sorted(ingest_replies),
                           "detach_posts": detach_posts, "detach_replies": detach_replies,
                           "collide_posts": collide_posts, "collide_replies": collide_replies})

    # ---------- 私信 ----------
    sc.execute("SELECT Message_Id FROM Message")
    old_mids = {r[0] for r in sc.fetchall()}
    tc.execute("SELECT id FROM message")
    tgt_mids = {r[0] for r in tc.fetchall()}
    ingest_mids = sorted(i for i in old_mids if i not in tgt_mids)
    detach_mids = sorted(i for i in tgt_mids if i not in old_mids)
    # 旧站 10-13 快照前沿 620305 之后的目标行 = 新站原生（619217-620305 是旧站已同步行）
    detach_mids = [m for m in detach_mids if m > 620305]
    plan["message"] = {"ingest": len(ingest_mids), "detach": len(detach_mids)}
    dump("plan-message.json", {"ingest": ingest_mids, "detach": detach_mids})

    # ---------- video id 映射（refill 用：新站旧 id → 目标自增新 id） ----------
    # 原则：refill 在 ingest 之后跑，自增指针已在旧站最大 id 之后；映射按 detach 顺序顺延，
    # 具体值 refill 时逐行 INSERT 后取 LAST_INSERT_ID 回填映射（plan 只定顺序）
    dump("plan.json", plan)
    print(json.dumps(plan, ensure_ascii=False, indent=2, default=str))
    stg.close()
    tgt.close()




# ============================================================
# 段 2：detach —— 摘除新站数据（备份 JSON 落盘 → 删行）
# ============================================================

VIDEO_TABLES = ["video", "video_info", "video_stat",
                "video_scores_beg", "video_scores_int", "video_scores_exp",
                "video_scores_beg_nf", "video_scores_int_nf", "video_scores_exp_nf"]
# ⚠️ 视频域衍生表（不参与行移动，但腾位/换行会让它们变 stale，收尾必须对账）：
#   video_metrics   —— 指标行按 id 对应「某一盘」，行被换成旧站终态后旧指标行描述的就是
#                      「别的盘」（2026-10-22 实证：81 条 mixed 窗失同步，STNB 落盘 34.2
#                      vs 回放现算 135）。detach 删行刻意不含它（--missing-only 只补缺行、
#                      有行就跳过），收尾必须显式对账 + --ids-file 定点重算（见 cmd_ingest 尾注）。
#   video_triage.auto_flag —— detach 不删（-1 未分拣兜底），靠收尾 --only-pending 补判。
# 行移动的表：PK 即 user id 的（user_sig 等 PK 是自身自增 id，只改 user 列、不移动行）
# ⚠️ user_donate 生产不存在（首次备份即因此截断），勿加
USER_MOVE_TABLES = ["user", "user_info", "user_scores", "user_scores_nf", "user_stat", "user_auth"]
USER_TABLES = USER_MOVE_TABLES + ["user_sig", "user_oauth", "user_stnb_best"]


def fetch_rows(tc, table, where_col, ids):
    out = []
    for i in range(0, len(ids), BATCH):
        chunk = ids[i:i + BATCH]
        ph = ",".join(["%s"] * len(chunk))
        tc.execute(f"SELECT * FROM `{table}` WHERE `{where_col}` IN ({ph})", chunk)
        cols = [d[0] for d in tc.description]
        out.extend([dict(zip(cols, r)) for r in tc.fetchall()])
    return out


def cmd_detach():
    tgt = target_conn()
    tc = tgt.cursor()
    pv = load("plan-video.json")
    pc = load("plan-comment.json")
    pb = load("plan-bbs.json")
    pm = load("plan-message.json")

    backup = {}

    # 录像（detach + mixed 的目标侧行全部备份；mixed 的 hash 恢复旧站真值由 ingest 的 upsert 完成）
    vids = pv["detach"] + pv["mixed"]
    for t in VIDEO_TABLES:
        backup[f"video/{t}"] = fetch_rows(tc, t, "id", vids)
    # 关联评论（挂在被摘录像下的）
    detach_cids = pc["detach"] + pc["collide"]
    # 评论引用改写需要的映射先记：评论行备份
    backup["comment"] = fetch_rows(tc, "comment", "id", detach_cids)
    backup["bbs_post"] = fetch_rows(tc, "bbs_post", "id", pb["detach_posts"] + pb["collide_posts"])
    backup["bbs_reply"] = fetch_rows(tc, "bbs_reply", "id", pb["detach_replies"] + pb["collide_replies"])
    backup["message"] = fetch_rows(tc, "message", "id", pm["detach"])
    # news 备份（不删，refill 阶段只改 reference）：
    #   按「reference 指向任一被摘录像（detach+mixed 清单）」筛——不按 id 范围，
    #   因为被摘 id 可能落在任何段（例：345108 旧站终态已删、生产行被 detach）
    detach_vid_set = sorted(set(pv["detach"]) | set(pv["mixed"]))
    if detach_vid_set:
        ph = ",".join(["%s"] * len(detach_vid_set))
        tc.execute(f"""SELECT * FROM news WHERE (type IN (20,30) AND reference IN ({ph}))
                   OR (type = 52 AND details_data LIKE %s AND reference IN ({ph}))""",
                   detach_vid_set + ['%"kind":"video"%'] + detach_vid_set)
        cols = [d[0] for d in tc.description]
        backup["news_ref_videos"] = [dict(zip(cols, r)) for r in tc.fetchall()]
    else:
        backup["news_ref_videos"] = []

    dump("detach-backup.json", backup)

    # 删行（同事务按域提交）
    def delete_ids(table, col, ids):
        n = 0
        for i in range(0, len(ids), BATCH):
            chunk = ids[i:i + BATCH]
            ph = ",".join(["%s"] * len(chunk))
            tc.execute(f"DELETE FROM `{table}` WHERE `{col}` IN ({ph})", chunk)
            n += tc.rowcount
        return n

    try:
        for t in VIDEO_TABLES:
            print(f"  del {t}: {delete_ids(t, 'id', vids)}")
        print(f"  del comment: {delete_ids('comment', 'id', detach_cids)}")
        print(f"  del bbs_post: {delete_ids('bbs_post', 'id', pb['detach_posts'] + pb['collide_posts'])}")
        print(f"  del bbs_reply: {delete_ids('bbs_reply', 'id', pb['detach_replies'] + pb['collide_replies'])}")
        print(f"  del message: {delete_ids('message', 'id', pm['detach'])}")
        tgt.commit()
    except Exception:
        tgt.rollback()
        raise
    print("detach DONE")
    tgt.close()


# ============================================================
# 段 3：ingest —— 旧站增量原位写入（口径复刻 transform.py）
# ============================================================


def cmd_ingest():
    stg = staging_conn()
    tgt = target_conn()
    sc, tc = stg.cursor(), tgt.cursor()
    pv = load("plan-video.json")
    pu = load("plan-user.json")
    pc = load("plan-comment.json")
    pb = load("plan-bbs.json")
    pm = load("plan-message.json")

    # ---------- 用户（user + user_auth，auth 走 INSERT IGNORE 防同名） ----------
    if pu["ingest"]:
        ids_ph = ",".join(["%s"] * len(pu["ingest"]))
        sc.execute(f"SELECT Player_Id, Player_Name, Player_Name_Chinese, Player_Name_English,"
                   f" Player_Sex, Player_Area, Player_Register_Time, Player_Image, Player_IsLive,"
                   f" Player_Login_Time, Player_Password, Player_IsMaster FROM Player WHERE Player_Id IN ({ids_ph})", pu["ingest"])
        rows = sc.fetchall()
        ov = OVERSEAS(0)
        tc.executemany(
            """INSERT INTO user (id,chinese_name,english_name,sex,avatar,area,status,
               create_time,update_time,last_login_time)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,0,%s)
               ON DUPLICATE KEY UPDATE last_login_time=VALUES(last_login_time)""",
            [(r[0], (r[2] or "")[:12], (r[3] or "")[:32], 1 if r[4] else 0,
              "1" if r[7] else "0", "海外" if r[0] in ov else (r[5] or "")[:12],
              0 if r[8] else -1, ux(r[6]), ux(r[9])) for r in rows])
        # user_auth（复刻 transform L191-213 口径：username=Player_Name 登录名、
        # 密码=md5(旧站明文+随机 salt)、role 按 IsMaster；同名不同 id 跳过）
        import hashlib
        import secrets
        tc.execute("SELECT id, username FROM user_auth")
        name_owner = {r[1]: r[0] for r in tc.fetchall()}
        auth_rows = []
        for r in rows:
            owner = name_owner.get((r[1] or "")[:64])
            if owner is not None and owner != r[0]:
                print(f"  [auth-skip] username 冲突 id={r[0]} name={r[1]!r} 已被 id={owner} 占用")
                continue
            salt = hashlib.md5(secrets.token_bytes(16)).hexdigest()
            pw = hashlib.md5(((r[10] or "") + salt).encode("utf-8", "replace")).hexdigest()
            auth_rows.append((r[0], (r[1] or "")[:64], pw, salt, 100 if r[11] else 0, ux(r[6]), 0))
        tc.executemany(
            """INSERT IGNORE INTO user_auth (id,username,password,salt,role,create_time,update_time)
               VALUES (%s,%s,%s,%s,%s,%s,%s)""", auth_rows)
        tgt.commit()
        print(f"user ingest {len(rows)}（auth 写入 {len(auth_rows)}，同名跳过 {len(rows) - len(auth_rows)}）")

    # ---------- 录像（6 表同 id 批次同事务，复刻 transform 口径） ----------
    # mixed id 并入写入清单：plan 时这些 id 目标还有行（不在 ingest 差集里），
    # 但 detach 已腾位——必须写入，否则旧站终态这 81 部永久缺失（时序缺陷修正）
    ingest_vids = sorted(set(pv["ingest"]) | set(pv["mixed"]))
    if ingest_vids:
        # 幂等预过滤：跳过目标库已有行（半截重跑/漂移保护——transform 的 existing_vinfo 同款）
        tc.execute("SELECT id FROM video_info")
        existing_vi = {r[0] for r in tc.fetchall()}
        tc.execute("SELECT id FROM video")
        existing_v = {r[0] for r in tc.fetchall()}
        todo_vids = [i for i in ingest_vids if i not in existing_vi]
        skipped = len(ingest_vids) - len(todo_vids)
        if skipped:
            print(f"  [skip] video_info 已存在 {skipped} 条（幂等过滤）")
        ph = ",".join(["%s"] * len(ingest_vids))
        sc.execute(f"""SELECT Video_Id, Video_Model, Video_Player, Video_Path, Video_IsLive, Video_Check,
                    Video_Time, Video_Score, Video_3BV, Video_3BVS, Video_CheckBy, Video_CheckTime,
                    Video_Click, Video_IsNoFrag FROM Video WHERE Video_Id IN ({ph})""", ingest_vids)
        vmap = {r[0]: r for r in sc.fetchall()}
        # 录像文件路径列（Video_Path）与 noflag 口径见 transform；board_3bv/real_time 校准
        n_txn = 0
        for i in range(0, len(todo_vids), BATCH):
            chunk = todo_vids[i:i + BATCH]
            try:
                for vid in chunk:
                    v = vmap[vid]
                    (_, model, player, path, islive, check, vtime_dt, score, bv, b3bvs,
                     checkby, checktime, click, nf) = v
                    level = (model or "").lower()
                    if level not in ("beg", "int", "exp"):
                        continue
                    status = 0 if not islive else (10 if not check else 20)
                    ct = ux(vtime_dt)
                    rt = ux(checktime)
                    tc.execute(
                        """INSERT INTO video (id,level,user,hash,status,review_user,review_time,
                           create_time,update_time,exp_time)
                           VALUES (%s,%s,%s,'',%s,%s,%s,%s,%s,0)
                           ON DUPLICATE KEY UPDATE status=VALUES(status)""",
                        (vid, level, player, status, checkby if checkby else None,
                         rt if rt else None, ct, ct))
                    tc.execute(
                        """INSERT INTO video_info (id,filepath,signature,software,version,noflag,board,
                           board_3bv,real_time,create_time,update_time)
                           VALUES (%s,%s,'','','',%s,'',%s,%s,%s,0)""",
                        (vid, (path or "")[:100], 1 if nf else 0,
                         int(round(bv)) if bv is not None else 0,
                         t_ms(score) if score is not None else 0, ct))
                    tc.execute(
                        """INSERT INTO video_stat (id,clicks,create_time) VALUES (%s,%s,%s)
                           ON DUPLICATE KEY UPDATE clicks=VALUES(clicks)""",
                        (vid, int(click or 0), ct))
                    if check and score is not None:
                        s3 = int(round((b3bvs or 0) * 1000)) if b3bvs is not None else 0
                        tbl = f"video_scores_{level}"
                        tc.execute(
                            f"""INSERT INTO {tbl} (id,user,score_time,score_3bvs,create_time)
                               VALUES (%s,%s,%s,%s,%s)
                               ON DUPLICATE KEY UPDATE user=VALUES(user)""",
                            (vid, player, t_ms(score), s3, ct))
                        if nf:
                            tc.execute(
                                f"""INSERT INTO {tbl}_nf (id,user,score_time,score_3bvs,create_time)
                                   VALUES (%s,%s,%s,%s,%s)""",
                                (vid, player, t_ms(score), s3, ct))
                tgt.commit()
                n_txn += 1
            except Exception:
                tgt.rollback()
                raise
        print(f"video ingest {len(ingest_vids)} ids / {n_txn} 事务")

    # ---------- 评论 ----------
    if pc["ingest"]:
        tc.execute("SELECT id FROM comment")
        existing_cm = {r[0] for r in tc.fetchall()}
        # collide 并入（detach 已腾位）+ 幂等过滤
        want = sorted(set(pc["ingest"]) | set(pc.get("collide", [])))
        pc_ingest = [i for i in want if i not in existing_cm]
        if not pc_ingest:
            print("comment ingest 0（幂等：全部已存在）")
            pc_ingest = None
        if pc_ingest is not None:
            ph = ",".join(["%s"] * len(pc_ingest))
            sc.execute(f"""SELECT Comment_Id, Comment_Video, Comment_Player, Comment_Text,
                        Comment_Time, Comment_Rank FROM Comment WHERE Comment_Id IN ({ph})""", pc_ingest)
        rows = sc.fetchall() if pc_ingest else []
        tc.executemany(
            """INSERT IGNORE INTO comment (id,video,user,exp_time,ranked,content,status,create_time,update_time)
               VALUES (%s,%s,%s,0,0,%s,0,%s,0)""",
            [(r[0], r[1], r[2], (r[3] or ""), ux(r[4])) for r in rows])
        tgt.commit()
        print(f"comment ingest {len(rows)}")

    # ---------- BBS（Title 分流：Get_Id>0=回帖，否则=帖） ----------
    # collide id 同理并入：detach 已腾位的旧站行要进来（时序缺陷修正，同录像域）
    ti = sorted(set(pb["ingest_titles"]) | set(pb["collide_posts"]))
    ri = sorted(set(pb["ingest_replies"]) | set(pb["collide_replies"]))
    ti = [i for i in ti if i not in {c for c in pb["detach_posts"]}]
    ri = [i for i in ri if i not in {c for c in pb["detach_replies"]}]
    if ti or ri:
        tc.execute("SELECT id FROM bbs_post")
        existing_bp = {r[0] for r in tc.fetchall()}
        tc.execute("SELECT id FROM bbs_reply")
        existing_br = {r[0] for r in tc.fetchall()}
        ti = [i for i in ti if i not in existing_bp]
        ri = [i for i in ri if i not in existing_br]
        if not ti and not ri:
            print("bbs ingest 0（幂等：全部已存在）")
        all_ids = ti + ri
        if all_ids:
            ph = ",".join(["%s"] * len(all_ids))
            sc.execute(f"""SELECT Title_Id, Title_Get_Id, Title_Name, Title_Player, Title_Text,
                        Title_Post_Time, Title_Edit_Time, Title_Reply_Time, Title_Click, Title_Reply,
                        Title_IsHigh, Title_IsNice, Title_IsLock, Title_Model
                        FROM Title WHERE Title_Id IN ({ph})""", all_ids)
        rows = {r[0]: r for r in sc.fetchall()} if all_ids else {}
        board_map = {"Notice": 0, "Skill": 1, "Other": 2, "Ask": 3}
        p_rows, r_rows = [], []
        reply_set = set(ri)
        for tid in sorted(rows):
            (tid2, getid, name, player, text, ptime, etime, rtime, click, reply,
             high, nice, lock, model) = rows[tid]
            ts = ux(ptime)
            if tid in reply_set:
                r_rows.append((tid, getid, player, text or "", 0, ts, ux(etime)))
            else:
                p_rows.append((tid, board_map.get(model or "", 2), player, (name or "")[:100],
                               text or "", int(reply or 0), int(click or 0),
                               1 if high else 0, 1 if nice else 0, 1 if lock else 0, 0,
                               ux(rtime), 0, ts, ux(etime)))
        # 帖先插（回帖 post 外键语义）
        tc.executemany(
            """INSERT INTO bbs_post (id,board,user,title,content,replies,clicks,is_top,is_nice,is_locked,
               status,last_reply_time,last_reply_user,create_time,update_time)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               ON DUPLICATE KEY UPDATE replies=VALUES(replies),clicks=VALUES(clicks)""", p_rows)
        tgt.commit()
        tc.executemany(
            """INSERT INTO bbs_reply (id,post,user,content,status,create_time,update_time)
               VALUES (%s,%s,%s,%s,%s,%s,%s)""", r_rows)
        tgt.commit()
        print(f"bbs ingest posts={len(p_rows)} replies={len(r_rows)}")
        # last_reply_user 修正（按 transform：帖的最后回复人；Title 在 staging 库，
        # 用 IN 跨库读 staging——两个连接都是本地 MySQL）
        sc.execute("""SELECT Title_Get_Id, Title_Player FROM Title WHERE Title_Get_Id > 0
                   ORDER BY Title_Id""")
        last_reply = {}
        for getid, player in sc.fetchall():
            last_reply[getid] = player  # 升序遍历，后者覆盖 = 最新回复人
        for pid, player in last_reply.items():
            tc.execute("UPDATE bbs_post SET last_reply_user=%s WHERE id=%s", (player, pid))
        tgt.commit()

    # ---------- 私信 ----------
    if pm["ingest"]:
        pm_ingest = pm["ingest"] or None
        ph = ",".join(["%s"] * len(pm_ingest or []))
        sc.execute(f"""SELECT Message_Id, Message_Text, Message_From, Message_To, Message_Time,
                    Message_Read FROM Message WHERE Message_Id IN ({ph})""", pm_ingest)
        rows = sc.fetchall() if pm_ingest else []
        tc.executemany(
            """INSERT INTO message (id,from_user,to_user,content,is_read,is_system,create_time,update_time)
               VALUES (%s,%s,%s,%s,%s,0,%s,0)
               ON DUPLICATE KEY UPDATE is_read=VALUES(is_read)""",
            [(r[0], r[2], r[3], (r[1] or "")[:200], 1 if r[5] else 0, ux(r[4])) for r in rows])
        tgt.commit()
        print(f"message ingest {len(rows)}")

    stg.close()
    tgt.close()
    print("ingest DONE")
    # ⚠️ 收尾必做清单（2026-10-22 两项实证漏跑）：
    # ① triage：ingest 的 video 行不走上传 after() 钩子，auto_flag 落默认 -1（未分拣）
    #    → 后台需核定池误膨胀。必须补跑：
    #      cd 项目根 && set -a && . ./.env && set +a && env -u NODE_OPTIONS node \
    #        --experimental-transform-types --import ./scripts/sync/ts-extension-loader.mjs \
    #        scripts/video-triage-backfill.ts --only-pending   # 已通过行另跑一轮 status=20 补判
    # ② video_metrics 失同步对账：mixed 窗腾位后旧指标行描述的是「别的盘」，
    #    --missing-only 只补缺行不重算已有行（幂等补缺语义）。先跑审计 SQL：
    #      SELECT m.id FROM video_metrics m JOIN video_info vi ON vi.id=m.id
    #        JOIN video v ON v.id=m.id
    #        WHERE m.real_time<>vi.real_time OR m.bbbv<>vi.board_3bv
    #           OR m.level<>v.level OR (m.noflag<>0)<>(vi.noflag<>0);
    #    有结果 → 导出到 ids 文件，nice -n 19 ionice -c3 定点重算（含尾部全链路：
    #    分位基准/综合分/组内排名/user_stnb_best，30.8 万盘约 3 分钟）：
    #      env -u NODE_OPTIONS node --experimental-transform-types \
    #        --import ./scripts/sync/ts-extension-loader.mjs \
    #        scripts/video-metrics.ts --ids-file=/tmp/stale-metrics-ids.txt
    print("REMINDER: 收尾必做 ① video-triage-backfill.ts --only-pending ② video_metrics 失同步对账+重算（见上方清单）")


# ============================================================
# 段 4：refill —— 新站数据回填（hash 去重 + id 映射 + 引用改写）
# ============================================================


def cmd_refill():
    tgt = target_conn()
    tc = tgt.cursor()
    backup = load("detach-backup.json")

    vid_map = {}   # 旧 video id → 新 video id
    skipped_dup = []

    # ---------- 录像回填（按备份序，跳过 hash 已存在的） ----------
    vrows = {r["id"]: r for r in backup["video/video"]}
    virows = {r["id"]: r for r in backup["video/video_info"]}
    vstrows = {r["id"]: r for r in backup["video/video_stat"]}
    score_rows = {}
    for lv in ("beg", "int", "exp"):
        for suffix in ("", "_nf"):
            t = f"video/video_scores_{lv}{suffix}"
            if t in backup:
                for r in backup[t]:
                    score_rows.setdefault(r["id"], []).append((t.split("/", 1)[1], r))

    for old_id in sorted(vrows):
        v = vrows[old_id]
        h = v.get("hash") or ""
        if h:
            tc.execute("SELECT id FROM video WHERE hash=%s", (h,))
            row = tc.fetchone()
            if row:
                vid_map[old_id] = row[0]  # 重复录像 → 指向已存在行
                skipped_dup.append(old_id)
                continue
        ts = v.get("update_time") or now_sec()
        # ⚠️ 快照列 ranked 与 exp_time 同为必填（2026-10-22 预备役 bug：本清单漏 ranked，
        #   refill 新行落默认 0 → 82 部录像详情页全显示「预备役」）
        cols_v = ["level", "user", "hash", "status", "review_user", "review_time",
                  "create_time", "update_time", "exp_time", "ranked"]
        vals_v = [v["level"], v["user"], h, v["status"], v.get("review_user"),
                  v.get("review_time"), v["create_time"], ts, v.get("exp_time") or 0,
                  v.get("ranked") or 0]
        for opt in ("auto_flag", "auto_reason"):
            if v.get(opt) is not None:
                cols_v.append(opt)
                vals_v.append(v[opt])
        ph = ",".join(["%s"] * len(vals_v))
        tc.execute(
            f"""INSERT INTO video ({','.join(cols_v)}) VALUES ({ph})""", vals_v)
        new_id = tc.lastrowid
        vid_map[old_id] = new_id
        vi = virows.get(old_id, {})
        tc.execute(
            """INSERT INTO video_info (id,filepath,signature,software,version,noflag,board,
               board_3bv,real_time,create_time,update_time)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (new_id, vi.get("filepath", ""), vi.get("signature", ""), vi.get("software", ""),
             vi.get("version", ""), vi.get("noflag", 0), vi.get("board", ""),
             vi.get("board_3bv", 0), vi.get("real_time", 0), vi.get("create_time", ts), ts))
        vs = vstrows.get(old_id, {})
        tc.execute(
            """INSERT INTO video_stat (id,clicks,downloads,comments,create_time,update_time)
               VALUES (%s,%s,%s,%s,%s,%s)""",
            (new_id, vs.get("clicks", 0), vs.get("downloads", 0), vs.get("comments", 0),
             vs.get("create_time", ts), ts))
        for tbl, sr in score_rows.get(old_id, []):
            tc.execute(
                f"""INSERT INTO `{tbl}` (id,user,score_time,score_3bvs,create_time)
                   VALUES (%s,%s,%s,%s,%s)""",
                (new_id, sr["user"], sr["score_time"], sr["score_3bvs"], sr["create_time"]))
    tgt.commit()
    dump("vid-map.json", {str(k): v for k, v in vid_map.items()})
    print(f"video refill：回填 {len(vid_map) - len(skipped_dup)}，hash 去重跳过 {len(skipped_dup)}")

    # ---------- 评论回填（video 引用改写） ----------
    cmap = {}
    for c in backup.get("comment", []):
        new_vid = vid_map.get(c["video"], c["video"])
        tc.execute(
            """INSERT INTO comment (video,user,exp_time,ranked,content,status,create_time,update_time)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
            (new_vid, c["user"], c.get("exp_time") or 0, c.get("ranked") or 0,
             c["content"], c["status"], c["create_time"], c.get("update_time") or 0))
        cmap[c["id"]] = tc.lastrowid
    tgt.commit()
    dump("comment-map.json", {str(k): v for k, v in cmap.items()})
    print(f"comment refill {len(cmap)}")

    # ---------- BBS 回填（帖先、回帖后；post 引用改写） ----------
    pmap, rmap = {}, {}
    for p in backup.get("bbs_post", []):
        lru = p.get("last_reply_user") or 0
        tc.execute(
            """INSERT INTO bbs_post (board,user,title,content,replies,clicks,is_top,is_nice,
               is_locked,status,last_reply_time,last_reply_user,create_time,update_time)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (p["board"], p["user"], p["title"], p["content"], p["replies"], p["clicks"],
             p["is_top"], p["is_nice"], p["is_locked"], p["status"],
             p["last_reply_time"], lru, p["create_time"], p.get("update_time") or 0))
        pmap[p["id"]] = tc.lastrowid
    tgt.commit()
    for r in backup.get("bbs_reply", []):
        new_post = pmap.get(r["post"], r["post"])
        tc.execute(
            """INSERT INTO bbs_reply (post,user,content,status,create_time,update_time)
               VALUES (%s,%s,%s,%s,%s,%s)""",
            (new_post, r["user"], r["content"], r["status"], r["create_time"],
             r.get("update_time") or 0))
        rmap[r["id"]] = tc.lastrowid
    tgt.commit()
    dump("bbs-map.json", {"post": {str(k): v for k, v in pmap.items()},
                          "reply": {str(k): v for k, v in rmap.items()}})
    print(f"bbs refill posts={len(pmap)} replies={len(rmap)}")

    # ---------- 私信回填 ----------
    mmap = {}
    for m in backup.get("message", []):
        tc.execute(
            """INSERT INTO message (from_user,to_user,content,is_read,is_system,create_time,update_time)
               VALUES (%s,%s,%s,%s,%s,%s,%s)""",
            (m["from_user"], m["to_user"], m["content"], m["is_read"], m["is_system"],
             m["create_time"], m.get("update_time") or 0))
        mmap[m["id"]] = tc.lastrowid
    tgt.commit()
    dump("message-map.json", {str(k): v for k, v in mmap.items()})
    print(f"message refill {len(mmap)}")

    # ---------- news 引用改写（多态 reference，按 type+details.kind 分流） ----------
    # type=20/30 → video id；type=40 → bbs_post id；type=52 → details.kind=video→video id，
    #                                             details.kind=bbs → post id
    # detach 备份的 news_ref_videos 只覆盖 type 20/30；40/52(bbs) 的引用在 BBS 映射后补改
    fixed = 0
    for n in backup.get("news_ref_videos", []):
        new_ref = vid_map.get(n["reference"])
        if new_ref and new_ref != n["reference"]:
            tc.execute("UPDATE news SET reference=%s WHERE id=%s", (new_ref, n["id"]))
            fixed += 1
    tgt.commit()
    print(f"news(20/30) reference 改写 {fixed}")

    # type=40（ARTICLE）与 type=52 bbs 类：reference 指向被摘/被撞帖
    if pmap:
        tc.execute("SELECT id, type, reference, details_data FROM news WHERE type IN (40, 52)")
        cols = [d[0] for d in tc.description]
        rows40 = [dict(zip(cols, r)) for r in tc.fetchall()]
        fixed2 = 0
        for n in rows40:
            if n["reference"] in pmap:
                det = n.get("details_data") or ""
                # type=52 里 kind=video 的 reference 是 video id，不动（上面 20/30 也没它）
                if n["type"] == 52 and '"kind":"video"' in det.replace(" ", ""):
                    continue
                # details.cid 对 40=主题id、52(bbs)=回复id → 一并改写
                new_ref = pmap[n["reference"]]
                new_cid = rmap.get(_extract_cid(det), _extract_cid(det))
                if new_cid != _extract_cid(det):
                    det = det.replace(f'"cid":{_extract_cid(det)}', f'"cid":{new_cid}')
                    tc.execute("UPDATE news SET reference=%s, details_data=%s WHERE id=%s",
                               (new_ref, det, n["id"]))
                else:
                    tc.execute("UPDATE news SET reference=%s WHERE id=%s", (new_ref, n["id"]))
                fixed2 += 1
        tgt.commit()
        print(f"news(40/52-bbs) reference 改写 {fixed2}")

    tgt.close()
    print("refill DONE")


def _extract_cid(details_json):
    import re
    m = re.search(r'"cid"\s*:\s*(\d+)', details_json or "")
    return int(m.group(1)) if m else 0


# ============================================================
# 段 5：fold —— user 999 段并入旧站序列（行移动 + 全链引用改写）
# ============================================================

# 引用改写面（2026-10-22 06:17 定稿，schema 全量核对）
USER_REF_TABLES = [
    ("news", "user"),
    ("comment", "user"),
    ("click", "user"),
    ("star", "user"),
    ("history", "user"),
    ("message", "from_user"),
    ("message", "to_user"),
    ("bbs_post", "user"),
    ("bbs_post", "last_reply_user"),
    ("bbs_reply", "user"),
    ("video", "user"),
    ("video", "review_user"),
    ("video_scores_beg", "user"),
    ("video_scores_int", "user"),
    ("video_scores_exp", "user"),
    ("video_scores_beg_nf", "user"),
    ("video_scores_int_nf", "user"),
    ("video_scores_exp_nf", "user"),
    ("rank_snapshot", "user"),
    ("admin_log", "user"),
    ("avatar_review", "user"),
    ("avatar_review", "reviewer"),
    ("page_view", "user_id"),
    ("practice_log", "user_id"),
    ("user_sig", "user"),
    ("user_oauth", "user_id"),
    ("user_stnb_best", "user"),
]


def cmd_fold():
    tgt = target_conn()
    tc = tgt.cursor()
    fold_map = {int(k): v for k, v in load("fold-map.json").items()}
    if not fold_map:
        print("无 999 段用户，跳过")
        tgt.close()
        return

    try:
        # 1) 行移动（仅 PK=user id 的六表；user_sig 等只改 user 引用列不移动行）
        for t in USER_MOVE_TABLES:
            for old, new in fold_map.items():
                tc.execute(f"UPDATE `{t}` SET id=%s WHERE id=%s", (new, old))
        # 2) 引用改写（28 处；含 user_sig/user_oauth/user_stnb_best/user_donate 的 user 列）
        for t, col in USER_REF_TABLES:
            for old, new in fold_map.items():
                tc.execute(f"UPDATE `{t}` SET `{col}`=%s WHERE `{col}`=%s", (new, old))
        tgt.commit()
    except Exception:
        tgt.rollback()
        raise
    print(f"fold DONE：{len(fold_map)} 用户 → {min(fold_map.values())}+")
    tgt.close()


# ============================================================
# 段 6：verify —— 终态对账（只读）
# ============================================================


def cmd_verify():
    stg = staging_conn()
    tgt = target_conn()
    sc, tc = stg.cursor(), tgt.cursor()
    ok = True

    # 历史悬空基线（迁移前生产即存在——旧站物理删行留下的陈年悬挂，非本次造成）
    BASELINE_DANGLING = {"comment_video": 914, "news_ref": 8, "reply_post": 69}

    def check(name, cond, detail=""):
        nonlocal ok
        print(f"  [{'OK' if cond else 'FAIL'}] {name} {detail}")
        if not cond:
            ok = False

    sc.execute("SELECT COUNT(*) FROM Video")
    old_n = sc.fetchone()[0]
    tc.execute("SELECT COUNT(*) FROM video")
    tgt_n = tc.fetchone()[0]
    check("录像总量 >= 旧站", tgt_n >= old_n, f"目标 {tgt_n} vs 旧站 {old_n}")

    sc.execute("SELECT Video_Id FROM Video")
    old_ids = {r[0] for r in sc.fetchall()}
    tc.execute("SELECT id FROM video")
    tgt_ids = {r[0] for r in tc.fetchall()}
    missing = old_ids - tgt_ids
    check("旧站录像 id 全部在位", not missing, f"缺 {len(missing)}" if missing else "")

    tc.execute("""SELECT COUNT(*) FROM comment c LEFT JOIN video v ON v.id=c.video
               WHERE v.id IS NULL""")
    n = tc.fetchone()[0]
    check("comment 悬空不高于基线", n <= BASELINE_DANGLING["comment_video"], f"实际 {n} / 基线 {BASELINE_DANGLING['comment_video']}")
    tc.execute("""SELECT COUNT(*) FROM news n LEFT JOIN video v ON v.id=n.reference
               WHERE n.type IN (20,30) AND v.id IS NULL""")
    n = tc.fetchone()[0]
    check("news(20/30) 悬空不高于基线", n <= BASELINE_DANGLING["news_ref"], f"实际 {n} / 基线 {BASELINE_DANGLING['news_ref']}")
    tc.execute("""SELECT COUNT(*) FROM bbs_reply r LEFT JOIN bbs_post p ON p.id=r.post
               WHERE p.id IS NULL""")
    n = tc.fetchone()[0]
    check("bbs_reply 悬空不高于基线", n <= BASELINE_DANGLING["reply_post"], f"实际 {n} / 基线 {BASELINE_DANGLING['reply_post']}")
    tc.execute("""SELECT COUNT(*) FROM video v LEFT JOIN user u ON u.id=v.user
               WHERE u.id IS NULL""")
    check("video 无主（user 悬空）", tc.fetchone()[0] == 0)
    tc.execute("""SELECT COUNT(*) FROM comment c LEFT JOIN user u ON u.id=c.user
               WHERE u.id IS NULL""")
    check("comment 无主", tc.fetchone()[0] == 0)
    tc.execute("""SELECT COUNT(*) FROM message m
               LEFT JOIN user uf ON uf.id=m.from_user
               LEFT JOIN user ut ON ut.id=m.to_user
               WHERE (m.from_user>0 AND uf.id IS NULL) OR (m.to_user>0 AND ut.id IS NULL)""")
    check("message 无主", tc.fetchone()[0] == 0)

    tc.execute("SELECT COUNT(*) FROM user WHERE id >= 900000")
    check("999 段已清空", tc.fetchone()[0] == 0)

    # bbs_reply 指向旧站 id 的行数应 = 旧站回帖数（新站回帖已映射新 post id）
    if os.path.exists(os.path.join(STATE_DIR, "detach-backup.json")):
        backup = load("detach-backup.json")
        n_bak = len(backup.get("video/video", []))
        vmap = load("vid-map.json") if os.path.exists(os.path.join(STATE_DIR, "vid-map.json")) else {}
        print(f"  [info] detach 备份录像 {n_bak} 条，映射 {len(vmap)} 条")

    stg.close()
    tgt.close()
    print("VERIFY " + ("PASS" if ok else "FAIL"))
    sys.exit(0 if ok else 1)


def OVERSEAS(uid):
    """海外 13 人名单（与 transform.py OVERSEAS_USER_IDS 同源；transform 是顶层执行脚本
    不能 import，此处内联副本——两边名单变更须同步）"""
    return frozenset({
        4841,   # 卡米尔 Kamil Muranski（旧库「澳门」）
        5045,   # 奥利弗 Oliver
        6234,   # 罗根 Rogen（旧库「澳门」）
        24189,  # 迈克尔 Michal Szoplik（旧库「北京」）
        24743,  # 托马斯 Thomas Kolar（旧库「北京」）
        27167,  # 舒尔茨 Shu Er Ci（旧库「Peking」）
        27631,  # 德米特里 Dmitry Lidyaev（旧库「北京」）
        27924,  # 塔纳托恩 Thanathorn（泰国人，旧库「台湾」）
        30320,  # 敖睿弼 Ruben Ibarra（旧库「Beijing」）
        30986,  # 马尔特 Malte Schulz（旧库「Macau」）
        34212,  # 傑西 Jesse（论坛自述来自美国，旧库「北京」）
        34214,  # 马尔特舒尔茨（Malte Schulz 重复注册，旧库「Beijing」）
        35260,  # 阿扎罗夫 Aleksandr Azarov（旧库「北京」）
    })


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    allowed = "--allow-nonlocal" in sys.argv
    if cmd == "plan":
        cmd_plan()
    elif cmd in ("detach", "ingest", "refill", "fold"):
        guard_nonlocal(allowed)
        {"detach": cmd_detach, "ingest": cmd_ingest,
         "refill": cmd_refill, "fold": cmd_fold}.get(
            cmd, lambda: sys.exit(f"未实现：{cmd}"))()
    elif cmd == "verify":
        cmd_verify()
    else:
        sys.exit(__doc__)
