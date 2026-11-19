#!/usr/bin/env python3
"""admin_log 明文凭据脱敏（2026-10-27）

修复后台操作日志两处明文泄漏（本地 + 生产各跑一次）：
1. apikey.create 的 detail 含完整 sk- key 明文（签发弹窗已展示过，日志不应留档）
2. user.resetPassword 的 detail 含重置后的密码明文

处理方式：正则把明文替换为 [已脱敏]，幂等（已脱敏行不再改动）。
admin_log 本身「只增不改」，但这两类行是安全泄漏，经张老师确认后定点清洗。
用法：python3 scrub_admin_log.py [--dry]   # 环境变量 DATABASE_URL 指向目标库
"""
import os
import re
import sys

import pymysql

DRY = "--dry" in sys.argv

# sk- 后跟 base64url 字符集（长度 30~50，覆盖 40 位实际 key）
SK_RE = re.compile(r"sk-[A-Za-z0-9_-]{30,50}")
# 重置密码 detail：`重置 xxx（#N）密码为：明文` → 截到「密码为：」
PWD_RE = re.compile(r"(重置 .+?（#\d+）密码为：).+$")

def main() -> None:
    url = os.environ.get("DATABASE_URL", "")
    # mysql://user[:pass]@host[:port]/db（密码可空，本地 root 直连）
    m = re.match(r"mysql://([^:]+)(?::([^@]*))?@([^:/]+)(?::(\d+))?/([^?]+)", url)
    if not m:
        sys.exit("DATABASE_URL 解析失败")
    user, pwd, host, port, db = m.group(1), m.group(2), m.group(3), int(m.group(4) or 3306), m.group(5)
    conn = pymysql.connect(host=host, port=port, user=user, password=pwd, database=db, charset="utf8mb4")
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, action, detail FROM admin_log WHERE action IN ('apikey.create', 'user.resetPassword')")
            rows = cur.fetchall()
            hits = 0
            for lid, action, detail in rows:
                if not detail:
                    continue
                new = detail
                if action == "apikey.create":
                    new = SK_RE.sub("[已脱敏]", new)
                else:
                    new = PWD_RE.sub(r"\1[已脱敏]", new)
                if new != detail:
                    hits += 1
                    print(f"#{lid} [{action}]")
                    print(f"  旧: {detail}")
                    print(f"  新: {new}")
                    if not DRY:
                        cur.execute("UPDATE admin_log SET detail = %s WHERE id = %s", (new, lid))
            if not DRY and hits:
                conn.commit()
            print(f"\n{'[dry] ' if DRY else ''}共 {hits} 行需脱敏，已{'标记待处理' if DRY else '更新'}")
    finally:
        conn.close()

if __name__ == "__main__":
    main()
