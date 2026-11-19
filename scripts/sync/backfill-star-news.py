#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""每日一星历史当选动态回填（2026-10-25 张老师定：恢复每日一星并补发历史动态）

背景：
  旧站（2008 ASP）Star 表仅存当日当选者（每日零点覆盖写），无历史可回溯；
  新站 2026-09-25 上线 ~ 2026-10-13 下线期间，生产 star 表沉淀了 21 行真实
  评选记录（09-23 dev 测试起算，09-25 生产首评 ~ 10-13 功能下线当日）。
  每日一星恢复上线（新口径）后，为这段历史的当选者补发 type=54 当选动态。

写入口径：
  - 每行 star → 一条 news(type=54, user=当选者, create_time=当选日 12:00:00 +08:00)
    （当选时刻不可考——旧评选是「当日首次访问首页」触发，时间随机；取当日正午，
     动态流按天聚合展示，正午不影响展示序，且避免与零点评选的 id 序冲突）
  - exp_time / ranked 快照：按当选日 12:00 严格早于语义重放高级成绩 running best
    （与 backfill-video-news-snapshots.py 同款流水重放；当日新评出的成绩不计入——
     当选时展示的还是评之前一天的军衔，与新站写入路径「严格早于」一致）
  - ranked = 补发时刻 user.status==0（当前状态，非历史状态；封禁者补动态仍记
    当前态——快照制只影响称号渲染，ranked=0 时旧版称号显示「未加入排行」）
  - details_data = '{}'
  - 幂等：已存在 (type=54, user, create_time) 相同元组则跳过（重跑安全）

用法：
  python backfill-star-news.py            # dry-run
  python backfill-star-news.py --apply    # 实际写入
  （生产执行：--apply --allow-nonlocal，配合 SAOLEI_DB_HOST 等环境变量）
"""
import os
import sys
import calendar
from datetime import datetime, timezone, timedelta

import pymysql

DRY = "--apply" not in sys.argv
CST = timezone(timedelta(hours=8))

if not DRY:
    host = os.environ.get("SAOLEI_DB_HOST", "127.0.0.1")
    port = os.environ.get("SAOLEI_DB_PORT", "3306")
    if (host, port) != ("127.0.0.1", "3306") and "--allow-nonlocal" not in sys.argv:
        sys.exit("非本地库写入门禁：需 --allow-nonlocal")

my = pymysql.connect(
    host=os.environ.get("SAOLEI_DB_HOST", "127.0.0.1"),
    port=int(os.environ.get("SAOLEI_DB_PORT", "3306")),
    user=os.environ.get("SAOLEI_DB_USER", "root"),
    password=os.environ.get("SAOLEI_DB_PASSWORD", ""),
    database=os.environ.get("SAOLEI_DB_NAME", "saolei"),
    charset="utf8mb4", autocommit=False)
cur = my.cursor()

# ---------- 收集 star 历史行 ----------
cur.execute("SELECT date, user FROM star ORDER BY date")
stars = [(d, u) for d, u in cur.fetchall() if d and u and u > 0]
print(f"star 历史 {len(stars)} 行：{stars[0][0]} ~ {stars[-1][0]}")

# 已补发的（幂等闸门）
cur.execute("SELECT user, create_time FROM news WHERE type=54")
done = {(u, ct) for u, ct in cur.fetchall()}

# ---------- 高级成绩流水（按人聚合，严格早于重放） ----------
need = {u for _, u in stars}
records = {}
if need:
    ph = ",".join(["%s"] * len(need))
    cur.execute(f"""SELECT v.user, vi.real_time, v.create_time
                 FROM video v JOIN video_info vi ON vi.id = v.id
                 WHERE v.status = 20 AND v.level = 'exp' AND vi.real_time > 0
                   AND v.user IN ({ph}) ORDER BY v.create_time, v.id""", tuple(need))
    for u, rt, ct in cur.fetchall():
        records.setdefault(u, []).append((ct or 0, rt))
for lst in records.values():
    lst.sort()

cur.execute("SELECT id, status FROM user")
user_status = dict(cur.fetchall())


def snapshot_before(user, ct):
    """严格早于 ct 的 running best（与新站写入路径同语义）"""
    best = 0
    for fct, rt in records.get(user, []):
        if fct >= ct:
            break
        if best == 0 or rt < best:
            best = rt
    return best


def noon_ts(date_str):
    d = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=CST)
    return calendar.timegm(d.utctimetuple()) + 12 * 3600


# ---------- 生成补发行 ----------
rows = []
skipped = 0
for date_s, user in stars:
    ct = noon_ts(date_s)
    if (user, ct) in done:
        skipped += 1
        continue
    exp = snapshot_before(user, ct)
    ranked = 1 if user_status.get(user) == 0 else 0
    rows.append((54, user, exp, ranked, ct))

print(f"{'[dry-run] 将补发' if DRY else '补发'} {len(rows)} 条（跳过已存在 {skipped}）")
for r in rows[:5]:
    dt = datetime.fromtimestamp(r[4], CST).strftime("%Y-%m-%d %H:%M")
    print(f"  sample user={r[1]} date={dt} exp={r[2]} ranked={r[3]}")
if DRY:
    sys.exit(0)

try:
    if rows:
        cur.executemany(
            "INSERT INTO news (type, user, reference, details_data, exp_time, ranked, create_time) "
            "VALUES (%s, %s, 0, '{}', %s, %s, %s)", rows)
    my.commit()
except Exception:
    my.rollback()
    raise

cur.execute("SELECT COUNT(*) FROM news WHERE type=54")
print(f"完成：type=54 动态共 {cur.fetchone()[0]} 条")
