#!/usr/bin/env python3
"""存量补发：给所有已绑定邮箱的用户发「绑定成功」系统通知（2026-10-23 张老师指令）

背景：2026-10-23 邮箱绑定成功后新增自动发系统通知（verify/page.tsx），
此前已绑定完成的存量用户没收到过——本脚本一次性补发同款文案。

口径：
- 只发 email_verified>0（绑定完成）的用户；
- 2026-10-23 已改口径「绑定成功 ⇔ 登录名换成邮箱」，存量若有 username≠email 的
  旧半成功态用户，不按标准文案发（避免「原登录名已失效」是假话），单独列出待人工处理；
- 文案与运行时 sendSystemMessage 完全一致；from_user=0（系统）、is_system=1；
- 幂等：content 前缀匹配（见 MSG_PREFIX）已存在该用户名下则跳过，重跑安全。

用法: python3 scripts/backfill-email-bind-notice.py [--apply]   默认 dry-run
生产: SAOLEI_DB_* env（3316 隧道）+ --allow-nonlocal；执行前服务器侧 mysqldump 备份 message 表。
"""
import os
import sys
import time

import pymysql

DRY = "--apply" not in sys.argv
NONLOCAL = bool(os.environ.get("SAOLEI_DB_PORT")) and os.environ["SAOLEI_DB_PORT"] != "3306"
if NONLOCAL and "--allow-nonlocal" not in sys.argv and not DRY:
    print("目标库非本地 3306，写入需显式 --allow-nonlocal")
    sys.exit(2)

my = pymysql.connect(
    host=os.environ.get("SAOLEI_DB_HOST", "127.0.0.1"),
    port=int(os.environ.get("SAOLEI_DB_PORT", "3306")),
    user=os.environ.get("SAOLEI_DB_USER", "root"),
    password=os.environ.get("SAOLEI_DB_PASSWORD", ""),
    database=os.environ.get("SAOLEI_DB_NAME", "saolei"),
    charset="utf8mb4", autocommit=False)
cur = my.cursor()

MSG_PREFIX = "邮箱（"

# ---------- 1. 目标用户：已绑定且登录名=邮箱 ----------
cur.execute("""SELECT id, email FROM user_auth
            WHERE email_verified > 0 AND username = email""")
targets = list(cur.fetchall())
print(f"已绑定且登录名=邮箱：{len(targets)} 人")

# ---------- 2. 排查旧半成功态（username≠email，只列不发） ----------
cur.execute("""SELECT id, username, email FROM user_auth
            WHERE email_verified > 0 AND username <> email""")
odd = list(cur.fetchall())
if odd:
    print(f"⚠️ 旧半成功态（username≠email）{len(odd)} 人，不按标准文案发，待人工处理：")
    for uid, uname, mail in odd:
        print(f"  user={uid} username={uname} email={mail}")

# ---------- 3. 幂等：已发过的（本脚本或运行时新通知）跳过 ----------
now = int(time.time())
to_send = []
skipped = 0
for uid, mail in targets:
    msg = f"邮箱（{mail}）绑定已成功，今后请使用此邮箱作为用户名进行登录（原登录名已失效）"
    cur.execute(
        "SELECT COUNT(*) FROM message WHERE to_user=%s AND from_user=0 AND is_system=1 AND content=%s",
        (uid, msg))
    (n,) = cur.fetchone()
    if n > 0:
        skipped += 1
        continue
    to_send.append((uid, msg))

print(f"待补发：{len(to_send)} 人（幂等跳过 {skipped} 人）")
assert len(to_send) < 500, "待发人数异常，中止人工核查"

if not to_send:
    print("\n无待发，退出。")
    my.close()
    sys.exit(0)

for uid, msg in to_send[:10]:
    print(f"  user={uid} <- {msg}")

if DRY:
    print(f"\n[dry-run] 将 INSERT {len(to_send)} 行 message（from_user=0, is_system=1, is_read=0）。未写库。")
    my.rollback()
    my.close()
    sys.exit(0)

# ---------- 4. 写入 ----------
rows = [(0, uid, msg, 0, 1, now, now) for uid, msg in to_send]
cur.executemany(
    "INSERT INTO message (from_user, to_user, content, is_read, is_system, create_time, update_time) "
    "VALUES (%s,%s,%s,%s,%s,%s,%s)", rows)
my.commit()
print(f"\n已写入 {cur.rowcount} 行系统通知。")

cur.execute(
    "SELECT COUNT(*) FROM message WHERE from_user=0 AND is_system=1 AND create_time=%s", (now,))
(cnt,) = cur.fetchone()
print(f"校验：create_time={now} 的系统通知 {cnt} 行。")
my.close()
