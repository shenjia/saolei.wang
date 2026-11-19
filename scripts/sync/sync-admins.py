#!/usr/bin/env python3
"""管理员名单同步：旧站（ASP）Team 页 -> 新站 user_auth.role — 2026-10-16

背景：transform.py 的 user_auth 是 INSERT IGNORE，只在首次导入时写 role，
旧站（www.saolei.wang/Team/Index.asp，Player_IsMaster=1）后续的任免永远不会
同步到新站，/team 管理团队页会逐渐失真。本脚本抓旧站团队页做权威对齐。

口径（2026-10-16 张老师确认后首跑）：
  - 旧站团队页名单 = 权威管理员集合
  - 旧站有、新站无 -> role=10（管理员；旧站不分级别，站长 100 由新站自管）
  - 新站 role<>0、旧站已无 -> role=0（含 100，严格对齐）
  - 已在册的 role 级别不动（10 不升 100，100 不降 10）
  - update_time 列是**秒级** Unix 时间戳（勿写毫秒，首跑跑错过一次已修）

用法：
  PY=/Users/shenjia/.workbuddy/binaries/python/envs/default/bin/python
  $PY scripts/sync/sync-admins.py --dry-run          # 只打印 diff（默认姿势）
  $PY scripts/sync/sync-admins.py                    # 写本地库
  $PY scripts/sync/sync-admins.py --allow-nonlocal   # 写生产（先起 3316 隧道，
                                                     #  配 SAOLEI_DB_* env）

注意：外网访问受代理/挂机域名干扰，抓取强制清掉 *_PROXY 走直连；
旧站真址 www.saolei.wang（123.56.177.46），saolei.net 已挂机勿用。
"""
import os
import re
import sys
import time
import urllib.request

import pymysql

TEAM_URL = "http://www.saolei.wang/Team/Index.asp"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " \
     "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"

DRY = "--dry-run" in sys.argv

TARGET = {
    "host": os.environ.get("SAOLEI_DB_HOST") or "127.0.0.1",
    "port": int(os.environ.get("SAOLEI_DB_PORT") or "3306"),
    "user": os.environ.get("SAOLEI_DB_USER") or "root",
    "password": os.environ.get("SAOLEI_DB_PASSWORD") or "",
    "database": os.environ.get("SAOLEI_DB_NAME") or "saolei",
}
NONLOCAL = (TARGET["host"], TARGET["port"]) != ("127.0.0.1", 3306)
if NONLOCAL and "--allow-nonlocal" not in sys.argv and not DRY:
    print("目标库非本地 3306，写入需显式 --allow-nonlocal")
    sys.exit(2)


def fetch_old_masters():
    """抓旧站团队页，返回 [(id, 名字)]（GB2312 页面，Show.asp?Id= 链接即队员）"""
    # 强制直连：WorkBuddy 等环境注入的 *_PROXY 会把请求甩到挂机页
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    req = urllib.request.Request(TEAM_URL, headers={"User-Agent": UA})
    with opener.open(req, timeout=30) as resp:
        html = resp.read().decode("gb18030", errors="replace")
    pairs = re.findall(r"Show\.asp\?Id=(\d+)[^>]*>([^<]+)", html)
    masters = [(int(pid), name.strip()) for pid, name in pairs]
    if not masters:
        raise RuntimeError("旧站团队页解析为空——页面结构变了或被反爬拦了，中止")
    return masters


def main():
    masters = fetch_old_masters()
    master_ids = {pid for pid, _ in masters}
    print(f"旧站管理员 {len(masters)} 人：" + "、".join(f"{n}({i})" for i, n in masters))

    conn = pymysql.connect(**TARGET, charset="utf8mb4")
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT a.id, u.chinese_name, a.role FROM user_auth a "
                "LEFT JOIN `user` u ON u.id=a.id WHERE a.role<>0"
            )
            current = {r[0]: (r[1], r[2]) for r in cur.fetchall()}

        add = sorted(master_ids - set(current))
        revoke = sorted(set(current) - master_ids)
        keep = sorted(master_ids & set(current))
        print(f"新站在册 {len(current)} 人：新增 {len(add)} / 撤销 {len(revoke)} / 保留 {len(keep)}")
        for pid in add:
            print(f"  + {dict(masters).get(pid)}({pid}) -> role=10")
        for pid in revoke:
            name, role = current[pid]
            print(f"  - {name}({pid}) role={role} -> 0")
        if not add and not revoke:
            print("名单已一致，无需变更")
            return
        if DRY:
            print("--dry-run，不写库")
            return

        now = int(time.time())
        with conn.cursor() as cur:
            if add:
                cur.execute(
                    "UPDATE user_auth SET role=10, update_time=%s "
                    f"WHERE id IN ({','.join(['%s'] * len(add))}) AND role=0",
                    [now, *add],
                )
                print(f"新增写入 {cur.rowcount} 行")
            if revoke:
                cur.execute(
                    "UPDATE user_auth SET role=0, update_time=%s "
                    f"WHERE id IN ({','.join(['%s'] * len(revoke))}) AND role<>0",
                    [now, *revoke],
                )
                print(f"撤销写入 {cur.rowcount} 行")
        conn.commit()
        print("已提交")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
