#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
论坛外链图本地化（2026-10-22 张老师需求）：
把 bbs_post.content / bbs_reply.content 里 [img]外链图床URL[/img] 的图片下载、
转 WebP 存到 public/bbs-img/，再把库里 URL 替换为本地路径，防图床挂掉帖子失读。

用法：
  python bbs-img-localize.py scan                 # 扫描并生成清单 /tmp/bbs-img-urls.json + /tmp/bbs-img-plan.tsv
  python bbs-img-localize.py download [--workers N]  # 下载+转 WebP（幂等，已存在跳过；Wayback 兜底）
  python bbs-img-localize.py apply [--apply]      # 预览/执行库替换（默认 dry-run；--apply 才写库）
                                                   写库前自动备份受影响行到 .workbuddy/backups/

规则：
- 只处理 http(s) 外链；自家 saolei.net/wang 的 /models/images/ 渲染层已重写，不动
- 本地路径形如 /bbs-img/<sha1前12位>.webp，同图多帖引用共享一个文件
- 下载失败（图床死+Wayback 无存档）的 URL 不替换，保留原链（宁留死链不丢内容）
- 动图 GIF 转有损 webp（gif2webp）；静态图走 cwebp -q 82；小于阈值不转
- PNG 透明通道保留（cwebp -exact）
"""
import hashlib
import html
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse

import requests

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PUBLIC = os.path.join(REPO, "public", "bbs-img")
BACKUP_DIR = os.path.join(REPO, ".workbuddy", "backups", "bbs-img-20261022")
URLS_JSON = "/tmp/bbs-img-urls.json"
PLAN_TSV = "/tmp/bbs-img-plan.tsv"
DL_DIR = "/tmp/bbs-img-raw"

IMG_RE = re.compile(r"\[img\]([^\[\]]+?)\[/img\]", re.I)
# 渲染层（src/lib/bbs.ts ubb()）会重写的自家路径，无需本地化
OWN_RE = re.compile(
    r"^https?://(?:www\.)?saolei\.(?:net|wang)(/models/images/)", re.I
)

DB = dict(host="localhost", user="root", database="saolei", charset="utf8mb4")

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"


def db():
    import pymysql
    return pymysql.connect(**DB)


def decode_url(u: str) -> str:
    """库里的 URL 可能含 HTML 实体（&amp;）或尾部 &nbsp;，先归一化。"""
    u = html.unescape(u)
    u = u.replace("\u00a0", "").strip()
    return u


def is_target(u: str) -> bool:
    if not u.lower().startswith(("http://", "https://")):
        return False
    if OWN_RE.match(u):
        return False
    return True


def local_path(u: str) -> tuple:
    key = hashlib.sha1(u.encode("utf-8")).hexdigest()[:12]
    return key, f"/bbs-img/{key}.webp"


def cmd_scan():
    conn = db()
    rows = []
    with conn.cursor() as cur:
        cur.execute("SELECT id, content FROM bbs_post WHERE content LIKE '%[img]http%'")
        for rid, content in cur.fetchall():
            rows.append(("post", int(rid), content))
        cur.execute("SELECT id, content FROM bbs_reply WHERE content LIKE '%[img]http%'")
        for rid, content in cur.fetchall():
            rows.append(("reply", int(rid), content))
    conn.close()

    url_rows = []  # (src, id, raw_url, decoded, key, local)
    seen = {}
    for src, rid, content in rows:
        for m in IMG_RE.finditer(content):
            raw = m.group(1)
            u = decode_url(raw)
            if not is_target(u):
                continue
            key, lp = local_path(u)
            url_rows.append([src, rid, raw, u, key, lp])
            seen[u] = seen.get(u, 0) + 1

    with open(URLS_JSON, "w", encoding="utf-8") as f:
        json.dump(url_rows, f, ensure_ascii=False, indent=0)
    # 计划表：key 唯一行
    keys = {}
    for src, rid, raw, u, key, lp in url_rows:
        if key not in keys:
            keys[key] = [u, 0]
        keys[key][1] += 1
    with open(PlanTSV := PLAN_TSV, "w", encoding="utf-8") as f:
        for key, (u, cnt) in sorted(keys.items()):
            f.write(f"{key}\t{cnt}\t{u}\n")

    from collections import Counter
    doms = Counter(urllib.parse.urlparse(u).netloc.lower() for _, _, _, u, _, _ in url_rows)
    print(f"引用行 {len(url_rows)} 处，唯一 URL {len(keys)} 个")
    print(f"TOP 域名: {doms.most_common(15)}")
    print(f"清单: {URLS_JSON}")
    print(f"计划: {PLAN_TSV}")


def fetch(session, url, timeout=20, headers=None):
    h = {"User-Agent": UA, "Referer": "https://" + urllib.parse.urlparse(url).netloc + "/"}
    if headers:
        h.update(headers)
    r = session.get(url, timeout=timeout, headers=h, allow_redirects=True)
    r.raise_for_status()
    ct = (r.headers.get("Content-Type") or "").lower()
    if "text/html" in ct and not url.lower().endswith((".html", ".htm")):
        raise ValueError(f"HTML not image: {ct}")
    data = r.content
    if len(data) < 64:
        raise ValueError(f"too small {len(data)}B")
    if len(data) > 25 * 1024 * 1024:
        raise ValueError(f"too big {len(data)}B")
    return data, ct


def wayback(session, url):
    """CDX API 查最近存档，取 id_ 原始字节；429/5xx 指数退避。"""
    import random
    cdx = (
        "https://web.archive.org/cdx/search/cdx?url="
        + urllib.parse.quote(url, safe="")
        + "&output=json&filter=statuscode:200&limit=-1&fastLatest=true"
    )
    for attempt in range(4):
        r = session.get(cdx, timeout=30, headers={"User-Agent": UA})
        if r.status_code == 200:
            break
        time.sleep((2 ** attempt) + random.random())  # 429/5xx 退避
    else:
        return None
    try:
        rows = r.json()
    except ValueError:
        return None
    if not rows or len(rows) < 2:
        return None
    ts = rows[-1][1]  # 最近一条 200 存档
    wb = f"https://web.archive.org/web/{ts}id_/{url}"
    r2 = session.get(wb, timeout=60, headers={"User-Agent": UA})
    if r2.status_code != 200:
        return None
    ct = (r2.headers.get("Content-Type") or "").lower()
    if "text/html" in ct and not url.lower().endswith((".html", ".htm")):
        return None
    return r2.content, ct


MAGIC = [
    (b"GIF8", "gif"),
    (b"\x89PNG\r\n\x1a\n", "png"),
    (b"\xff\xd8\xff", "jpg"),
    (b"BM", "bmp"),
    (b"RIFF", "webp"),  # 需再查 WEBP
]


def sniff(data: bytes):
    for magic, name in MAGIC:
        if data[: len(magic)] == magic:
            if name == "webp" and data[8:12] != b"WEBP":
                return None
            if name == "bmp" and len(data) < 16:
                return None
            return name
    return None


def convert(data: bytes, key: str):
    """转 webp；返回 (ok, webp_path_or_None, note)。"""
    src = os.path.join(DL_DIR, key)
    dst = os.path.join(PUBLIC, key + ".webp")
    kind = sniff(data)
    if kind is None:
        # 有些图床返回的 content-type 不可靠，用文件扩展名猜不出就算失败
        return False, None, "unknown-format"
    with open(src + "." + kind, "wb") as f:
        f.write(data)
    rawfile = src + "." + kind
    tmp = dst + ".tmp"
    if kind == "gif":
        # 动图：gif2webp；若失败（如损坏 gif）退回取第一帧 cwebp
        p = subprocess.run(
            ["gif2webp", "-q", "75", "-mixed", "-min_size", rawfile, "-o", tmp],
            capture_output=True,
        )
        if p.returncode != 0:
            p2 = subprocess.run(
                ["cwebp", "-q", "82", rawfile, "-o", tmp], capture_output=True
            )
            if p2.returncode != 0:
                return False, None, "gif-convert-fail"
    else:
        # BMP/大 PNG 先经 sips 归一为 png 再 cwebp；jpg/png 直转
        if kind == "bmp":
            p = subprocess.run(
                ["sips", "-s", "format", "png", rawfile, "--out", src + ".png"],
                capture_output=True,
            )
            if p.returncode != 0:
                return False, None, "bmp-sips-fail"
            rawfile = src + ".png"
        args = ["cwebp", "-q", "82"]
        if kind == "png":
            args.append("-exact")  # 保透明
        if len(data) <= 4096:
            args.append("-lossless")
        p = subprocess.run(args + [rawfile, "-o", tmp], capture_output=True)
        if p.returncode != 0:
            return False, None, "convert-fail"
    if not os.path.exists(tmp) or os.path.getsize(tmp) == 0:
        return False, None, "empty-output"
    os.replace(tmp, dst)
    return True, dst, kind


def cmd_download(workers=8, proxy=None, retry_failed=False):
    os.makedirs(PUBLIC, exist_ok=True)
    os.makedirs(DL_DIR, exist_ok=True)
    url_rows = json.load(open(URLS_JSON, encoding="utf-8"))
    keys = {}
    for src, rid, raw, u, key, lp in url_rows:
        keys.setdefault(key, [u, 0])
        keys[key][1] += 1
    # 过滤已存在的（幂等重跑）
    missing = {k: v for k, v in keys.items() if not os.path.exists(os.path.join(PUBLIC, k + ".webp"))}
    print(f"唯一 {len(keys)}，已落盘 {len(keys)-len(missing)}，缺 {len(missing)}")
    todo = missing
    if retry_failed:
        # 重试模式=全部缺失的（状态文件可能被上一轮覆盖丢失历史，以文件存在性为准）
        pass
    print(f"本轮待下 {len(todo)}")
    from concurrent.futures import ThreadPoolExecutor, as_completed
    import threading

    wb_lock = threading.Lock()  # Wayback 全局串行 + 节流（archive.org 限流≈1req/s）
    WB_INTERVAL = 1.2

    session_pool = {}

    def get_session():
        import threading
        t = threading.current_thread().ident
        if t not in session_pool:
            s = requests.Session()
            s.trust_env = False  # 沙箱注入的 HTTP_PROXY 不可靠，一律不用 env 代理
            if proxy:
                s.proxies = {"http": proxy, "https": proxy}
            session_pool[t] = s
        return session_pool[t]

    results = {}
    status_file = "/tmp/bbs-img-dl-status.json"

    def do(item):
        key, (u, cnt) = item
        s = get_session()
        note = ""
        data = None
        # ① 直连（http 死站多半超时，先短超时快速失败）
        try:
            data, ct = fetch(s, u, timeout=12)
            note = "direct"
        except Exception as e:
            time.sleep(0.5)
            # ② Wayback 兜底（archive.org 必须走代理；限流≈1req/s，全局节流）
            wb_lock.acquire()
            try:
                time.sleep(WB_INTERVAL)
                wb = wayback(s, u)
            finally:
                wb_lock.release()
            if wb:
                data, ct = wb
                note = "wayback"
            else:
                note = f"dead:{type(e).__name__}"
        if data is not None:
            ok, _, conv_note = convert(data, key)
            if not ok:
                note = f"convert-fail({conv_note})"
                data = None
        return key, u, note

    done = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(do, item) for item in todo.items()]
        for fut in as_completed(futs):
            try:
                key, u, note = fut.result()
            except Exception as e:
                key, u, note = "?", "?", f"worker-error:{e}"
            results[key] = [u, note]
            done += 1
            if done % 25 == 0 or done == len(todo):
                okc = sum(1 for v in results.values() if not v[1].startswith(("dead", "convert-fail", "worker-error")))
                print(f"[{done}/{len(todo)}] ok={okc} fail={len(results)-okc} elapsed={time.time()-t0:.0f}s", flush=True)
                json.dump(results, open(status_file, "w"), ensure_ascii=False)

    json.dump(results, open(status_file, "w"), ensure_ascii=False)
    from collections import Counter
    st = Counter(v[1].split("(")[0] for v in results.values())
    print("状态分布:", dict(st))
    print(f"明细: {status_file}")


def cmd_apply(really=False):
    url_rows = json.load(open(URLS_JSON, encoding="utf-8"))
    # 只替换已成功本地化的
    have = {
        f[: -len(".webp")]
        for f in os.listdir(PUBLIC)
        if f.endswith(".webp")
    }
    repl = {}  # raw_url(库中原样) -> local
    for src, rid, raw, u, key, lp in url_rows:
        if key in have and raw not in repl:
            repl[raw] = lp
    # 同一 raw 可能因空白差异对应不同 decoded？不会——decode 是确定的；但同 raw 多行只需记录一次
    print(f"可替换引用 {sum(1 for r in url_rows if r[4] in have)} 处 / {len(repl)} 个唯一 URL")

    conn = db()
    changed_posts, changed_replies = [], []
    with conn.cursor() as cur:
        cur.execute("SELECT id, content FROM bbs_post WHERE content LIKE '%[img]http%'")
        for rid, content in cur.fetchall():
            new = content
            for raw, lp in repl.items():
                new = new.replace(f"[img]{raw}[/img]", f"[img]{lp}[/img]")
            if new != content:
                changed_posts.append((int(rid), content, new))
        cur.execute("SELECT id, content FROM bbs_reply WHERE content LIKE '%[img]http%'")
        for rid, content in cur.fetchall():
            new = content
            for raw, lp in repl.items():
                new = new.replace(f"[img]{raw}[/img]", f"[img]{lp}[/img]")
            if new != content:
                changed_replies.append((int(rid), content, new))

    print(f"待更新: post {len(changed_posts)} 行 / reply {len(changed_replies)} 行")
    if not really:
        print("dry-run 结束（--apply 才写库）")
        conn.close()
        return

    os.makedirs(BACKUP_DIR, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    with open(os.path.join(BACKUP_DIR, f"bbs-content-backup-{ts}.jsonl"), "w", encoding="utf-8") as f:
        for src, rows in (("post", changed_posts), ("reply", changed_replies)):
            for rid, old, new in rows:
                f.write(json.dumps({"src": src, "id": rid, "old": old, "new": new}, ensure_ascii=False) + "\n")
    print(f"备份: {BACKUP_DIR}/bbs-content-backup-{ts}.jsonl")

    n = 0
    try:
        with conn.cursor() as cur:
            for rid, old, new in changed_posts:
                cur.execute("UPDATE bbs_post SET content=%s WHERE id=%s", (new, rid))
                n += 1
            for rid, old, new in changed_replies:
                cur.execute("UPDATE bbs_reply SET content=%s WHERE id=%s", (new, rid))
                n += 1
        conn.commit()
    finally:
        conn.close()
    print(f"已更新 {n} 行")


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)
    cmd = args[0]
    if cmd == "scan":
        cmd_scan()
    elif cmd == "download":
        w = 8
        if "--workers" in args:
            w = int(args[args.index("--workers") + 1])
        proxy = None
        if "--proxy" in args:
            proxy = args[args.index("--proxy") + 1]
        cmd_download(w, proxy=proxy, retry_failed="--retry-failed" in args)
    elif cmd == "apply":
        cmd_apply(really="--apply" in args)
    else:
        print(__doc__)
        sys.exit(1)
