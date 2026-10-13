#!/usr/bin/env python3
"""Phase B 加速压测：keep-alive + 多并发，实测老 IIS 吞吐与成功率。

用法: python3 phaseb-probe.py <并发数> <采样数>
不回填 DB，只落盘（正式脚本对已存在文件自动 skip，压测产出零浪费）。
"""
import hashlib
import os
import sys
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

import pymysql
import requests

BASE = "http://www.saolei.wang"
ROOT = os.path.expanduser("~/Nutstore Files/我的坚果云/works/github/saolei.wang/videos")

workers = int(sys.argv[1]) if len(sys.argv) > 1 else 8
sample = int(sys.argv[2]) if len(sys.argv) > 2 else 64

my = pymysql.connect(host="127.0.0.1", user="root", database="saolei", charset="utf8mb4", autocommit=True)
cur = my.cursor()
cur.execute(
    """SELECT v.id, i.filepath, v.create_time FROM video v
       JOIN video_info i ON i.id = v.id
       WHERE v.create_time > 1382487826
         AND i.filepath LIKE '/Video/Mvf/%%'
         AND (v.hash IS NULL OR v.hash = '')
       ORDER BY RAND()
       LIMIT %s""",
    (sample,),
)
rows = cur.fetchall()

stats = {"ok": 0, "skip": 0, "miss": 0, "err": 0}
lock = threading.Lock()
tl = threading.local()
times = []
sizes = []


def sess() -> requests.Session:
    s = getattr(tl, "s", None)
    if s is None:
        s = requests.Session()
        s.trust_env = False  # 对 HTTP_PROXY 等环境变量免疫
        s.headers.update({"User-Agent": "Mozilla/5.0 saolei-migration"})
        tl.s = s
    return s


def fetch(vid, path, ctime):
    import datetime
    ymd = (datetime.datetime(1970, 1, 1) + datetime.timedelta(hours=8) + datetime.timedelta(seconds=ctime)).strftime("%Y/%m/%d")
    url = BASE + urllib.parse.quote(path)
    rq = time.time()
    try:
        r = sess().get(url, timeout=20, proxies={"http": None, "https": None})
        if r.status_code == 404:
            with lock:
                stats["miss"] += 1
            return
        r.raise_for_status()
        data = r.content
    except Exception as e:
        code = getattr(e.response, "status_code", "") if hasattr(e, "response") else ""
        with lock:
            stats["err"] += 1
        print(f"ERR {vid} {code or type(e).__name__} {path}", flush=True)
        return
    el = time.time() - rq
    with lock:
        times.append(el)
        sizes.append(len(data))
    md5 = hashlib.md5(data).hexdigest()
    ext = os.path.splitext(path)[1].lower() or ".mvf"
    rel = f"{ymd}/{md5}{ext}"
    dst = os.path.join(ROOT, rel)
    if os.path.exists(dst):
        with lock:
            stats["skip"] += 1
        return
    # 纯网络测速：落盘到临时目录，不污染正式 videos 树
    tmp = f"/tmp/phaseb-probe/{md5}{ext}"
    os.makedirs(os.path.dirname(tmp), exist_ok=True)
    with open(tmp, "wb") as f:
        f.write(data)
    with lock:
        stats["ok"] += 1


t0 = time.time()
with ThreadPoolExecutor(max_workers=workers) as ex:
    list(ex.map(fetch, *zip(*rows)))
dt = time.time() - t0
n = len(rows)
if times:
    times.sort()
    p50 = times[len(times) // 2]
    p95 = times[int(len(times) * 0.95)] - 1 if len(times) > 20 else times[-1]
    avg_kb = sum(sizes) / len(sizes) / 1024
else:
    p50 = p95 = avg_kb = 0
print(
    f"并发={workers} 采样={n} 耗时={dt:.1f}s 吞吐={n/dt:.1f}/s "
    f"请求p50={p50:.2f}s p95={p95:.2f}s 平均={avg_kb:.0f}KB {stats}",
    flush=True,
)
