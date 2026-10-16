#!/usr/bin/env python3
"""生成开发用最小种子库 database/dev-seed.sql.gz（供其他开发者快速起站）

内容口径（刻意保持最小，详见 README.md）：
- 用户只放综合排行 TOP100（sum_time 升序，排除封禁/零成绩）+ 一个测试管理员
  - 管理员：登录名 admin / 密码 admin（role=100 超管），中文名「管理员」，英文名 Guan Li Yun
  - 真实用户密码全部替换为随机 32 位十六进制（任何人无法登录）；
    邮箱/邮箱令牌、登录 IP 一律清空；user_stat.clicker 等隐私字段清空
  - 若 TOP100 中有人占用了 admin 登录名（真实玩家 #15044 郭平），改名 admin_old<id> 让位
- 录像只放 TOP100 用户已通过（status=20）的录像，每人最近 50 部 + 其个人最好成绩指向的录像；
  本地无录像文件时由 /videos 路由按 VIDEO_FALLBACK_ORIGIN 反代主站兜底（见 src/lib/videofile.ts）
- 整表附带 distribution / level_3bv_range / video_metric_dist（军衔阈值等小配置表）
- news/comment/bbs/message 等互动表留空（保持最小体积）

用法：python3 scripts/make-dev-dump.py（读 DATABASE_URL 或默认 mysql://root@localhost:3306/saolei）
输出：database/dev-seed.sql.gz（gzip 压缩；导入：gunzip < database/dev-seed.sql.gz | mysql -uroot <库名>）
"""
import gzip
import hashlib
import os
import re
import subprocess
import sys
import time
from urllib.parse import urlparse

import pymysql

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, "database", "dev-seed.sql.gz")
ADMIN_ID = 999999
ADMIN_SALT = "5f8a3c9d2e7b4a1f6d0c8e3b2a9f7c4d"  # 固定盐，配合 md5('admin'+salt) 生成口令
VIDEOS_PER_USER = 50

# 整表附带的小配置表（体积可忽略）
FULL_TABLES = ["distribution", "level_3bv_range", "video_metric_dist"]
# 按用户 id 复制的表
USER_TABLES = ["user", "user_info", "user_auth", "user_scores", "user_scores_nf", "user_stat", "user_sig"]
# 按录像 id 复制的表
VIDEO_TABLES = ["video", "video_info", "video_stat", "video_metrics"]

# user_scores / user_scores_nf 里指向最好成绩录像的 12 个指针列
BEST_VIDEO_COLS = [
    f"{lv}_{m}_video" for lv in ("beg", "int", "exp") for m in ("time", "3bvs")
]


def parse_dsn():
    url = os.environ.get("DATABASE_URL") or "mysql://root@localhost:3306/saolei"
    m = re.match(r"mysql://([^:@/]+)(?::([^@/]*))?@([^:/]+):(\d+)/(.+)", url)
    if not m:
        sys.exit(f"无法解析 DATABASE_URL: {url}")
    user, pwd, host, port, db = m.groups()
    return dict(user=user, password=pwd or "", host=host, port=int(port), database=db)


def dump_schema(dsn) -> str:
    """mysqldump 全量建表语句（30 张表全部建出，数据由本脚本另行挑选）"""
    cmd = ["mysqldump", f"-h{dsn['host']}", f"-P{dsn['port']}", f"-u{dsn['user']}"]
    if dsn["password"]:
        cmd.append(f"-p{dsn['password']}")
    cmd += ["--no-data", "--compact", "--skip-lock-tables", "--skip-comments", dsn["database"]]
    r = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return r.stdout


def esc(conn, v):
    return "NULL" if v is None else conn.escape(v)


def insert_rows(conn, out, table, rows, transform=None):
    """multi-row INSERT，每 50 行一条；transform 可对行内字段做脱敏改写"""
    if not rows:
        return
    cols = list(rows[0].keys())
    collist = ", ".join(f"`{c}`" for c in cols)
    for i in range(0, len(rows), 50):
        chunk = rows[i : i + 50]
        values = ",\n".join(
            "(" + ", ".join(esc(conn, (transform(dict(r)) if transform else dict(r))[c]) for c in cols) + ")"
            for r in chunk
        )
        out.write(f"INSERT INTO `{table}` ({collist}) VALUES\n{values};\n")


def main():
    now = time.time
    dsn = parse_dsn()
    conn = pymysql.connect(charset="utf8mb4", **dsn)
    cur = conn.cursor(pymysql.cursors.DictCursor)
    conn.begin()

    # --- 选人：综合排行 TOP100（与前台 /ranking sum 榜同口径：sum_time>0 且未封禁） ---
    cur.execute("DROP TEMPORARY TABLE IF EXISTS top100")
    cur.execute(
        "CREATE TEMPORARY TABLE top100 AS "
        "SELECT s.id FROM user_scores s JOIN user u ON u.id=s.id "
        "WHERE s.sum_time > 0 AND u.status = 0 ORDER BY s.sum_time ASC LIMIT 100"
    )
    cur.execute("SELECT COUNT(*) n FROM top100")
    n_users = cur.fetchone()["n"]

    # --- 选录像：TOP100 每人最近 50 部已通过录像 + 个人最好成绩指向的录像 ---
    cur.execute("DROP TEMPORARY TABLE IF EXISTS seed_videos")
    cur.execute(
        "CREATE TEMPORARY TABLE seed_videos (id BIGINT PRIMARY KEY) "
        "AS SELECT id FROM ("
        "  SELECT v.id, ROW_NUMBER() OVER (PARTITION BY v.user ORDER BY v.id DESC) rn"
        "  FROM video v JOIN top100 t ON v.user=t.id WHERE v.status=20"
        ") x WHERE rn <= %s",
        (VIDEOS_PER_USER,),
    )
    for tbl in ("user_scores", "user_scores_nf"):
        for c in BEST_VIDEO_COLS:
            cur.execute(
                f"INSERT IGNORE INTO seed_videos "
                f"SELECT s.{c} FROM {tbl} s JOIN top100 t ON s.id=t.id WHERE s.{c} IS NOT NULL"
            )
    cur.execute("SELECT COUNT(*) n FROM seed_videos")
    n_videos = cur.fetchone()["n"]

    with gzip.open(OUT, "wt", encoding="utf-8") as out:
        out.write(
            "-- saolei.wang 开发用最小种子库（由 scripts/make-dev-dump.py 生成，勿手工编辑）\n"
            f"-- 用户：综合排行 TOP100 + 测试管理员（admin/admin，role=100）；真实用户密码已全部随机化\n"
            f"-- 录像：TOP100 每人最近 {VIDEOS_PER_USER} 部已通过录像 + 最好成绩录像，共 {n_videos} 部；"
            "文件缺失时按 VIDEO_FALLBACK_ORIGIN 反代主站\n"
            "SET FOREIGN_KEY_CHECKS = 0;\n\n"
        )
        out.write(dump_schema(dsn))
        out.write("\n")

        # --- 整表小配置 ---
        for t in FULL_TABLES:
            cur.execute(f"SELECT * FROM `{t}`")
            insert_rows(conn, out, t, cur.fetchall())
            out.write("\n")

        # --- 用户域（含脱敏） ---
        cur.execute("SELECT u.* FROM top100 JOIN user u ON u.id=top100.id")
        users = cur.fetchall()
        users.append(
            dict(
                id=ADMIN_ID, chinese_name="管理员", english_name="Guan Li Yun", sex=1,
                avatar="", area="", status=0, create_time=int(now()), update_time=int(now()),
                last_login_time=0, ban_until=0,
            )
        )

        insert_rows(conn, out, "user", users)
        out.write("\n")

        for t in ("user_info", "user_sig"):
            cur.execute(f"SELECT i.* FROM top100 JOIN {t} i ON i.id=top100.id")
            insert_rows(conn, out, t, cur.fetchall())
        out.write("\n")

        # user_auth：密码随机化 + 清邮箱；占用 admin 登录名的真实玩家改名让位
        cur.execute("SELECT a.* FROM top100 JOIN user_auth a ON a.id=top100.id")
        auths = cur.fetchall()

        def clean_auth(r):
            r["password"] = os.urandom(16).hex()
            if r["username"].lower() == "admin":
                r["username"] = f"admin_old{r['id']}"
            r["email"] = None
            r["email_verified"] = 0
            r["email_token"] = None
            return r

        insert_rows(conn, out, "user_auth", auths, clean_auth)
        admin_pass = hashlib.md5(("admin" + ADMIN_SALT).encode()).hexdigest()
        insert_rows(
            conn,
            out,
            "user_auth",
            [
                dict(
                    id=ADMIN_ID, username="admin", password=admin_pass, salt=ADMIN_SALT,
                    role=100, create_time=int(now()), update_time=int(now()),
                    email=None, email_verified=0, email_token=None,
                )
            ],
        )
        out.write("\n")

        for t in ("user_scores", "user_scores_nf"):
            cur.execute(f"SELECT s.* FROM top100 JOIN {t} s ON s.id=top100.id")
            insert_rows(conn, out, t, cur.fetchall())
        out.write("\n")

        cur.execute("SELECT s.* FROM top100 JOIN user_stat s ON s.id=top100.id")
        stats = cur.fetchall()

        def clean_stat(r):
            r["login_ip"] = None
            r["login_time"] = 0
            r["login_times"] = 0
            return r

        insert_rows(conn, out, "user_stat", stats, clean_stat)
        insert_rows(
            conn,
            out,
            "user_stat",
            [
                dict(
                    id=ADMIN_ID, login_times=0, login_time=0, login_ip=None,
                    points=0, clicks=0, beg_videos=0, int_videos=0, exp_videos=0,
                    create_time=int(now()), update_time=int(now()),
                )
            ],
        )
        out.write("\n")

        # --- 录像域（清 clicker/downloader IP） ---
        for t in VIDEO_TABLES:
            cur.execute(f"SELECT v.* FROM seed_videos JOIN {t} v ON v.id=seed_videos.id")
            rows = cur.fetchall()
            if t == "video_stat":

                def clean_vstat(r):
                    r["clicker"] = None
                    r["downloader"] = None
                    return r

                insert_rows(conn, out, t, rows, clean_vstat)
            else:
                insert_rows(conn, out, t, rows)
            out.write("\n")

        out.write("SET FOREIGN_KEY_CHECKS = 1;\n")

    conn.rollback()  # 只读，防误写
    conn.close()
    size = os.path.getsize(OUT)
    print(f"OK: {OUT}")
    print(f"用户 {n_users} + 管理员 1，录像 {n_videos}，文件 {size / 1024 / 1024:.1f} MB")


if __name__ == "__main__":
    main()
