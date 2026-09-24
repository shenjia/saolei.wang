#!/usr/bin/env python3
"""一次性事故恢复：重建 news「原表行」集（2026-09-24 rebuild_news.py 首次 apply 中断引发）

事故链（详见 rebuild_news.py 头注释）：
1. 首次 --apply INSERT 列序错位，报错发生在 TRUNCATE 之后 → news 空
2. 二次 --apply 把空 news 当原表 0 条 → 备份表被覆盖为空 → 新事件落库
3. 三次 --apply 把新事件行当原表 → 备份表被覆盖为新事件行
→ 真原表 150,483 行（含 2019 转储基线 55,657 + staging 增量 + 新站产生）在库内丢失

恢复路径（与 scripts/sync/transform.py news 段口径一致）：
A. 2019 转储 saolei_2019-5-18.sql 的 news 段（55,657 行，id 1..55657）——基线前真实历史
B. staging 库 saolei_mssql.News（News_Time > 2013-10-23 08:23:46）→ 按 transform 同款逻辑
   转 type=20 纪录动态（(nvideo, nthing) 去重）+ 补 type=10 入伍动态（transform 后半段逻辑）
C. 新站自己产生的行（备份表里的 50/51/52/40 及 2026-09-22 后的 10/20——其实 B 已覆盖，
   转储+staging 之外的新站行从 news_backup_20260924 现存内容里按时间补）
D. 合并后按 (create_time, 转储id序, newbie优先) 排序写入 news_restore_check 供比对，
   确认后换入 news，再跑 rebuild_news.py 完成三类新事件回填

用法: python3 restore_news.py   （写 news_restore_check 表，不碰 news）
"""
import json
import re
import sys
from datetime import datetime, timedelta

import pymysql

EPOCH = datetime(1970, 1, 1)
TZ8 = timedelta(hours=8)
NEWS_BASELINE = 1382487826  # 2013-10-23 08:23:46
DUMP = "../saolei.net/database/saolei_2019-5-18.sql"

my = pymysql.connect(host="127.0.0.1", user="root", database="saolei",
                     charset="utf8mb4", autocommit=False)
stg = pymysql.connect(host="127.0.0.1", user="root", database="saolei_mssql",
                      charset="utf8mb4", autocommit=True)
cur = my.cursor()
sc = stg.cursor()


def ux(dt):
    if dt is None:
        return 0
    return int((dt - TZ8 - EPOCH).total_seconds())


def t_ms(score):
    return int((score - 1.0) * 1000 + 0.5)


def b_x1000(score):
    return int(score * 1000 + 0.5)


# ---------- A. 2019 转储基线（真实历史值，user_score 勿动） ----------
print("A. 解析 2019 转储 news 段...", flush=True)
rows_a = []
pat = re.compile(r"\((\d+),(\d+),(\d+),(-?\d+),(\d+),'((?:[^'\\]|\\.)*)',(\d+)\)(?=,|;|$)")
with open(DUMP, encoding="utf-8") as f:
    buf = []
    in_news = False
    for line in f:
        if line.startswith("INSERT INTO `news` VALUES"):
            in_news = True
            buf.append(line.split("VALUES", 1)[1])
            if line.rstrip().endswith(";"):
                in_news = False
        elif in_news:
            buf.append(line)
            if line.rstrip().endswith(";"):
                in_news = False
        if buf and not in_news:
            text = "".join(buf)
            for m in pat.finditer(text):
                nid, ntype, u, us, ref, dd, ct = m.groups()
                rows_a.append((int(nid), int(ntype), int(u), int(us), int(ref), dd, int(ct)))
            buf = []
rows_a.sort(key=lambda r: r[0])
print(f"  转储基线 {len(rows_a)} 行（id {rows_a[0][0]}..{rows_a[-1][0]}）")

# ---------- B. staging 增量（transform.py news 段同款逻辑） ----------
print("B. staging News 增量...", flush=True)
sc.execute("SELECT Video_Id, Video_Model, Video_Player, Video_IsLive, Video_Time FROM Video")
videos = {r[0]: r for r in sc.fetchall()}

sc.execute("""SELECT News_Id, News_Time, News_Video, News_Player, News_Model, News_Thing, News_Score, News_Grow
              FROM News WHERE News_IsLive=1 AND News_Time > '2013-10-23 08:23:46' ORDER BY News_Id""")
lv_map = {"初级": "beg", "中级": "int", "高级": "exp"}
has_newbie = {r[2] for r in rows_a if r[1] == 10}  # r=(nid,type,user,...) → 取 user
seen = set()
rows_b = []  # (ct, order, type, user, user_score, reference, details)
for nid, ntime, nvideo, nplayer, nmodel, nthing, nscore, ngrow in sc.fetchall():
    lv = lv_map.get(nmodel or "")
    if lv is None or nvideo not in videos:
        continue
    key = (nvideo, nthing)
    if key in seen:
        continue
    seen.add(key)
    if nthing == "时间":
        od, cr = "time", t_ms(nscore)
        org = t_ms(nscore + (ngrow or 0)) if ngrow else 0
    else:
        od = "3bvs"
        cr = b_x1000(nscore)
        org = b_x1000(nscore - (ngrow or 0)) if ngrow else 0
        if org < 0:
            org = 0
    details = json.dumps({"lv": lv, "od": od, "or": str(org), "cr": str(cr), "nf": 0}, separators=(",", ":"))
    rows_b.append((ux(ntime), 1, 20, nplayer, 0, nvideo, details))

# user_score：transform 用「用户当前 sum_time」近似；恢复时直接 0，之后跑 backfill_news_score.py 重放
# （丢掉的是 backfill 后的值，重放算法一致，结果应基本一致）

# 入伍动态补齐（transform 后半段）
seen_lv = {}
now = int(datetime.now().timestamp())
for vid, v in sorted(videos.items(), key=lambda kv: (ux(kv[1][4]) or 0, kv[0])):
    _, model, player, _, vtime_dt = v
    level = (model or "").lower()
    if level not in ("beg", "int", "exp") or not v[3]:
        continue
    if player in has_newbie:
        continue
    s = seen_lv.setdefault(player, set())
    s.add(level)
    if len(s) == 3:
        rows_b.append((ux(vtime_dt) or now, 0, 10, player, 0, 0, "[]"))
        has_newbie.add(player)
n20 = len([r for r in rows_b if r[2] == 20])
n10 = len([r for r in rows_b if r[2] == 10])
print(f"  staging 增量 20类 {n20} + 补入伍 {n10} = {len(rows_b)} 行")

# ---------- C. 新站自发行（仅 type 51/52 与 2026-09-22 之后的 10/20/40——
#     第二轮事故落库的 50 类行【不收】（那是 rebuild 的新事件，等最终 rebuild 再生成）） ----------
print("C. 新站自发行...", flush=True)
cur.execute("SELECT type, user, user_score, reference, details_data, create_time FROM news_backup_20260924")
rows_c = []
SITE_EPOCH = 1790006400  # 2026-09-22 00:00 +08 新站开始产生动态（数据基线止于 2026-09-22 21:31）
for ntype, u, us, ref, dd, ct in cur.fetchall():
    if ntype in (51, 52) or (ct >= SITE_EPOCH and ntype in (10, 20, 40)):
        rows_c.append((ct, 2, ntype, u, us, ref, dd))
print(f"  新站自发行 {len(rows_c)} 行")

# ---------- 合并写入校验表 ----------
all_rows = (
    [(ct, 3, ntype, u, us, ref, dd) for nid, ntype, u, us, ref, dd, ct in rows_a]
    + rows_b
    + rows_c
)
all_rows.sort(key=lambda r: (r[0], r[1], r[2]))
print(f"\n合计 {len(all_rows)} 行（丢失前 150,483 = 转储 {len(rows_a)} + staging {len([r for r in rows_b if r[2]==20])} "
      f"+ 入伍 {len([r for r in rows_b if r[2]==10])} + 新站 {len(rows_c)}）")

cur.execute("DROP TABLE IF EXISTS news_restore_check")
cur.execute("""CREATE TABLE news_restore_check AS
               SELECT %s type, %s user, %s user_score, %s reference, %s details_data, %s create_time""",
            (all_rows[0][2], all_rows[0][3], all_rows[0][4], all_rows[0][5], all_rows[0][6], all_rows[0][0]))
# 上面 CREATE AS 只插了第一行，删掉重建用批量插
cur.execute("DROP TABLE IF EXISTS news_restore_check")
cur.execute("""CREATE TABLE news_restore_check (
  type smallint NOT NULL, user bigint NOT NULL, user_score int NOT NULL,
  reference bigint NOT NULL DEFAULT 0, details_data varchar(200) NOT NULL,
  create_time bigint NOT NULL DEFAULT 0)""")
BATCH = 5000
payload = [(t, u, us, ref, dd, ct) for ct, _o, t, u, us, ref, dd in all_rows]
for i in range(0, len(payload), BATCH):
    cur.executemany(
        "INSERT INTO news_restore_check (type, user, user_score, reference, details_data, create_time) VALUES (%s,%s,%s,%s,%s,%s)",
        payload[i:i + BATCH],
    )
my.commit()
print(f"已写 news_restore_check {len(payload)} 行（未动 news）。核对后执行换入。")
