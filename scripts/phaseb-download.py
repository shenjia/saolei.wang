#!/usr/bin/env python3
"""Phase B：从旧站 HTTP 下载 2013-10-23 之后的录像实体文件。

- 源：http://www.saolei.wang + video_info.filepath（形如 /Video/Mvf/12396/Name_Int_48.42(3bv38).avf）
- 落盘：项目 videos/YYYY/MM/DD/<md5>.<ext>（与 2013 版 hash 路径约定一致；
  YYYY/MM/DD 取 video.create_time 对应 +08:00 日期，与新版上传逻辑相同）
- DB 回填：video.hash=md5、video_info.filepath=<hash 路径>、board/software/version/signature
  （解析回填另由 parse-videos.ts 完成，本脚本先保证文件落地 + md5）
- 幂等：目标文件存在即跳过；DB 已回填 hash 的跳过下载
- 限速：全局并发 3（12 并发实测打挂老 IIS，TimeoutError 成片出现）、单请求 30s 超时；
  失败文件记 /tmp/phaseb-miss.log，重跑脚本即自动重试（hash 未回填的仍在队列里）
"""
import hashlib
import os
import random
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import pymysql

BASE = "http://www.saolei.wang"
ROOT = os.path.expanduser("~/Nutstore Files/我的坚果云/works/github/saolei.wang/videos")
EPOCH_DT = __import__("datetime").datetime(1970, 1, 1)
TZ8 = __import__("datetime").timedelta(hours=8)

my = pymysql.connect(host="127.0.0.1", user="root", database="saolei", charset="utf8mb4", autocommit=True)
cur = my.cursor()

# 待下载清单：2013-10-23 基线之后、旧形态 filepath（/Video/Mvf/...）、hash 为空
cur.execute(
    """SELECT v.id, i.filepath, v.create_time FROM video v
       JOIN video_info i ON i.id = v.id
       WHERE v.create_time > 1382487826
         AND i.filepath LIKE '/Video/Mvf/%'
         AND (v.hash IS NULL OR v.hash = '')"""
)
rows = cur.fetchall()
total = len(rows)
print(f"待下载: {total}", flush=True)

stats = {"ok": 0, "skip": 0, "miss": 0, "err": 0}


def fetch(vid, path, ctime):
    url = BASE + urllib.parse.quote(path)
    ymd = (EPOCH_DT + TZ8 + __import__("datetime").timedelta(seconds=ctime)).strftime("%Y/%m/%d")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 saolei-migration"})
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read()
    except Exception as e:
        code = getattr(e, "code", "")
        with open("/tmp/phaseb-miss.log", "a") as f:
            f.write(f"{vid}\t{code or type(e).__name__}\t{path}\n")
        stats["miss" if code == 404 else "err"] += 1
        return
    md5 = hashlib.md5(data).hexdigest()
    ext = os.path.splitext(path)[1].lower() or ".mvf"
    rel = f"{ymd}/{md5}{ext}"
    dst = os.path.join(ROOT, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if not os.path.exists(dst):
        tmp = dst + ".part"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, dst)
    # 回填 DB（hash + 新 filepath；幂等：hash 非空即不再进队列）
    cur.execute("UPDATE video SET hash=%s WHERE id=%s", (md5, vid))
    cur.execute("UPDATE video_info SET filepath=%s WHERE id=%s", (rel, vid))
    stats["ok"] += 1
    time.sleep(random.uniform(0.05, 0.2))


done = 0
t0 = time.time()
with ThreadPoolExecutor(max_workers=3) as ex:
    futs = [ex.submit(fetch, *r) for r in rows]
    for f in futs:
        f.result()
        done += 1
        if done % 2000 == 0:
            rate = done / (time.time() - t0)
            print(f"进度 {done}/{total} ({rate:.0f}/s) {stats}", flush=True)

print(f"完成: {stats}", flush=True)
