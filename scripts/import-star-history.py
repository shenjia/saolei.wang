#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""每日一星历史导入（2026-11-19 张老师定：机器人提供的历史每日一星导入 star 表，供后续历史回顾）

来源：/Users/shenjia/Downloads/每日一星_全量.csv（表头：日期,玩家ID,姓名,阶段）
  - 2020/1/1 ~ 2025/12/16，共 2159 行，阶段列全部为「一阶段(旧站)」（不导入，star 表无此列）
  - 玩家ID = 旧站 Player ID（新站 user.id 同体系，同步镜像）

清洗口径（2026-11-19 张老师定）：
  - 重复日期以 CSV 第一条为准（2024/6/10 有两行，取首行）
  - strip BOM / \r；日期转 ISO（2020/1/1 → 2020-01-01）

写入口径：
  - star(user, date)：speech 空、计数 0、speech_edited false
  - create_time / update_time = 当日 12:00:00 +08:00（历史当选时刻不可考，
    与 backfill-star-news.py 同口径——动态流按天聚合，正午不影响展示序）
  - **不补发 news type=54 当选动态**：2158 条会淹没动态流；历史回顾页直接读 star 表
  - 幂等：已存在同 date 的 star 行跳过（生产 2026-09-25 起的评选行绝不动）
  - 玩家 ID 不存在 / 姓名与 user.chinese_name 不一致的行：dry-run 报告，
    不一致的照插（以 CSV 为准——改名属正常），ID 不存在的跳过并列清单

用法：
  python import-star-history.py            # dry-run
  python import-star-history.py --apply    # 实际写入
  （生产执行：--apply --allow-nonlocal，配合 SAOLEI_DB_HOST 等环境变量）
"""
import os
import sys
import csv
from datetime import datetime, timezone, timedelta

import pymysql

DRY = "--apply" not in sys.argv
CST = timezone(timedelta(hours=8))
CSV_PATH = os.environ.get("STAR_CSV", "/Users/shenjia/Downloads/每日一星_全量.csv")

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

# ---------- 读 CSV + 清洗 ----------
rows = []          # (date_iso, uid, name)
dropped_dup = []   # 重复日期被丢弃的行
bad_lines = []     # 解析失败的行
with open(CSV_PATH, "r", encoding="utf-8-sig", newline="") as f:
    reader = csv.reader(f)
    header = next(reader)
    print(f"表头：{header}")
    seen_dates = set()
    for ln, raw in enumerate(reader, start=2):
        if not raw or not any(cell.strip() for cell in raw):
            continue
        if len(raw) < 3:
            bad_lines.append((ln, raw))
            continue
        ds, uid_s, name = (c.strip() for c in raw[:3])
        try:
            date_iso = datetime.strptime(ds, "%Y/%m/%d").strftime("%Y-%m-%d")
            uid = int(uid_s)
        except ValueError:
            bad_lines.append((ln, raw))
            continue
        if date_iso in seen_dates:
            dropped_dup.append((ln, date_iso, uid, name))
            continue  # 重复日期：第一条为准（张老师 2026-11-19 定）
        seen_dates.add(date_iso)
        rows.append((date_iso, uid, name))

print(f"有效行 {len(rows)}，重复日期丢弃 {len(dropped_dup)}，解析失败 {len(bad_lines)}")
for ln, d, u, n in dropped_dup:
    print(f"  丢弃(重复日期)：行{ln} {d} #{u} {n}")
for ln, raw in bad_lines[:10]:
    print(f"  解析失败：行{ln} {raw}")

# ---------- 数据质量核对 ----------
dates = [d for d, _, _ in rows]
print(f"日期范围：{min(dates)} ~ {max(dates)}")

uid_list = sorted({u for _, u, _ in rows})
placeholders = ",".join(["%s"] * len(uid_list))
cur.execute(f"SELECT id, chinese_name, status FROM user WHERE id IN ({placeholders})", uid_list)
users = {int(r[0]): (r[1] or "", r[2]) for r in cur.fetchall()}

missing = [(d, u, n) for d, u, n in rows if u not in users]
name_mismatch = [(d, u, n, users[u][0]) for d, u, n in rows if u in users and n != users[u][0]]
banned = sum(1 for _, u, _ in rows if u in users and users[u][1] != 0)
print(f"玩家 ID 匹配：{len(uid_list) - len(missing)}/{len(uid_list)} 个唯一 ID 存在")
if missing:
    print(f"⚠️ {len(missing)} 行的玩家 ID 不存在（将跳过）：")
    for d, u, n in missing[:20]:
        print(f"  {d} #{u} {n}")
    if len(missing) > 20:
        print(f"  ……共 {len(missing)} 行")
print(f"姓名与库内 chinese_name 不一致：{len(name_mismatch)} 行（照插，改名属正常）")
for d, u, n, dbn in name_mismatch[:20]:
    print(f"  {d} #{u} CSV「{n}」 vs 库「{dbn}」")
if len(name_mismatch) > 20:
    print(f"  ……共 {len(name_mismatch)} 行")
print(f"其中现封禁用户 {banned} 行（历史记录照插，不影响前台评选——30 天窗口外）")

# ---------- 幂等闸门：已存在的 date 跳过 ----------
cur.execute("SELECT date FROM star")
exists = {r[0] for r in cur.fetchall()}
todo = [(d, u) for d, u, _ in rows if d not in exists]
skip = len(rows) - len(todo)
print(f"star 表已有 {len(exists)} 行；本次待插 {len(todo)} 行，撞日期跳过 {skip} 行")

if DRY:
    print("【dry-run】未写入。加 --apply 实际写入。")
    sys.exit(0)

# ---------- 写入 ----------
now_pair = lambda d: int(datetime.strptime(d, "%Y-%m-%d").replace(
    hour=12, tzinfo=CST).timestamp())
inserted = 0
try:
    for d, u in todo:
        ts = now_pair(d)
        cur.execute(
            "INSERT INTO star (user, date, speech, speech_del, speech_up, speech_down, "
            "speech_edited, create_time, update_time) VALUES (%s, %s, '', 0, 0, 0, 0, %s, %s)",
            (u, d, ts, ts))
        inserted += 1
    my.commit()
    print(f"✅ 已插入 {inserted} 行")
except Exception as e:
    my.rollback()
    print(f"❌ 写入失败已回滚：{e}")
    sys.exit(1)

# ---------- 验证 ----------
cur.execute("SELECT COUNT(*), MIN(date), MAX(date) FROM star")
total, mn, mx = cur.fetchone()
print(f"star 表现有 {total} 行，范围 {mn} ~ {mx}")
