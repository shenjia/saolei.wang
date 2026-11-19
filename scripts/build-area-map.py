#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 src/lib/area-map-geo.ts —— 地区榜「交互式中国地图」的省界几何数据

数据源：阿里 DataV GeoAtlas 全国省级边界（含台湾省与南海诸岛九段线，标准地图口径）
        首次运行抓取并瘦身到 scripts/data/china-geo-full.json，之后离线可复现
投影：正轴等角割圆锥（双标准纬线 25°N / 47°N，中央经线 105°E）＝ 官方标准地图投影
瘦身：投影后用 Douglas–Peucker 抽稀（容差 EPS 个 viewBox 单位）+ 丢弃极小岛屿环
输出：省级主图路径（环心纬度 >= 17.5°N）+ 南海诸岛附图（< 17.5°N 的环 + 九段线）+ 港澳引线点

用法：
  /Users/shenjia/.workbuddy/binaries/python/versions/3.13.12/bin/python3 scripts/build-area-map.py
"""
import json
import math
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(HERE, "data", "china-geo-full.json")
OUT = os.path.join(ROOT, "src", "lib", "area-map-geo.ts")
URL = "https://geo.datav.aliyun.com/areas_v3/bound/100000_full.json"

MAP_W = 1000.0        # 主图 viewBox 宽（高按投影比例算）
PADX, PADY = 6.0, 10.0
INSET_W, INSET_H = 94.0, 148.0   # 南海诸岛附图（右下角）
MIN_MAP_H = 870.0                # viewBox 最小高（留足附图空间）
SPLIT_LAT = 17.5                 # 纬度分界：以南的环进附图
EPS = 0.35                       # 边界抽稀容差（viewBox 单位，1 单位 ≈ 0.75px，视觉无损）
EPS_LINE = 0.2                   # 九段线容差（线细，抽太狠会走样）
MIN_RING_AREA = 0.8              # 环面积下限（viewBox 单位²），更小的岛屿环视为噪点丢弃
LBL_MIN_AREA = 1400.0            # 常驻名称标签的最小投影面积
# 名称标签手工偏移（避开压字/压边界）；直辖市与小省强制出标签
LBL_OFFSET = {"河北": (-30, 40), "天津": (34, 2), "上海": (24, 8)}
LBL_FORCE = {"北京", "天津", "上海"}


def round_coords(c, nd):
    if isinstance(c, (int, float)):
        return round(c, nd)
    return [round_coords(x, nd) for x in c]


def load_source():
    """读取瘦身源数据；不存在则抓取并落盘（坐标取 3 位小数 ≈ 110m，够用且体积减半）"""
    if not os.path.exists(SRC):
        os.makedirs(os.path.dirname(SRC), exist_ok=True)
        print("抓取", URL)
        raw = subprocess.run(["curl", "-sS", "--max-time", "60", URL],
                             capture_output=True, text=True, check=True).stdout
        slim = []
        for f in json.loads(raw)["features"]:
            p, g = f["properties"], f["geometry"]
            slim.append({"adcode": p.get("adcode"), "name": p.get("name"),
                         "type": g["type"] if g else None,
                         "coordinates": round_coords(g["coordinates"], 3) if g else None})
        json.dump({"features": slim}, open(SRC, "w", encoding="utf-8"),
                  ensure_ascii=False, separators=(",", ":"))
        print("源数据已瘦身落盘", SRC, os.path.getsize(SRC), "bytes")
    return json.load(open(SRC, encoding="utf-8"))


def flatten(geom):
    """Polygon / MultiPolygon / LineString / MultiLineString → [('ring'|'line', 点列表), ...]"""
    t, c = geom["type"], geom["coordinates"]
    if t == "Polygon":
        return [("ring", list(r)) for r in c]
    if t == "MultiPolygon":
        return [("ring", list(r)) for poly in c for r in poly]
    if t == "LineString":
        return [("line", list(c))]
    if t == "MultiLineString":
        return [("line", list(l)) for l in c]
    raise ValueError("unsupported geometry: " + t)


def short_name(nm):
    if not nm:
        return None
    for suf in ("特别行政区", "自治区", "省", "市"):
        if nm.endswith(suf):
            nm = nm[:-len(suf)]
            break
    return nm.replace("壮族", "").replace("回族", "").replace("维吾尔", "")


# ---------------- 抽稀：Douglas–Peucker（迭代实现，避免深递归） ----------------
def _seg_dist2(p, a, b):
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return (p[0] - ax) ** 2 + (p[1] - ay) ** 2
    t = ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy)
    t = max(0.0, min(1.0, t))
    return (p[0] - ax - t * dx) ** 2 + (p[1] - ay - t * dy) ** 2


def rdp(pts, eps):
    if len(pts) < 3:
        return pts
    eps2 = eps * eps
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        dmax, idx = -1.0, -1
        for k in range(i + 1, j):
            d = _seg_dist2(pts[k], pts[i], pts[j])
            if d > dmax:
                dmax, idx = d, k
        if dmax > eps2 and idx > 0:
            keep[idx] = True
            stack.append((i, idx))
            stack.append((idx, j))
    return [p for p, k in zip(pts, keep) if k]


def ring_area2(pts):
    a = 0.0
    for i in range(len(pts) - 1):
        a += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1]
    return abs(a) / 2


# ---------------- 投影：正轴等角割圆锥（25°N / 47°N） ----------------
PHI1, PHI2, LAM0 = math.radians(25), math.radians(47), math.radians(105)
N = math.log(math.cos(PHI1) / math.cos(PHI2)) / math.log(
    math.tan(math.pi / 4 + PHI2 / 2) / math.tan(math.pi / 4 + PHI1 / 2))
F = math.cos(PHI1) * math.tan(math.pi / 4 + PHI1 / 2) ** N / N


def lcc(lng, lat):
    phi, lam = math.radians(lat), math.radians(lng)
    rho = F / math.tan(math.pi / 4 + phi / 2) ** N
    d = N * (lam - LAM0)
    return rho * math.sin(d), F - rho * math.cos(d)


def main():
    main_rings, inset_parts = [], []   # (短名, 环) / (短名|None, 'ring'|'line', 点)
    stats = {"in": 0, "out": 0, "dropped": 0}
    for f in load_source()["features"]:
        if not f.get("type"):
            continue
        parts = flatten(f)
        stats["in"] += sum(len(p) for _, p in parts)
        if f.get("adcode") == "100000_JD":
            for kind, pts in parts:
                inset_parts.append((None, kind, pts))
            continue
        nm = short_name(f.get("name"))
        for kind, ring in parts:
            lat = sum(pt[1] for pt in ring) / len(ring)
            if kind == "ring" and lat >= SPLIT_LAT:
                main_rings.append((nm, ring))
            else:
                inset_parts.append((nm, kind, ring))

    # ---- 主图定标 ----
    pts = [lcc(x, y) for _, r in main_rings for x, y in r]
    x0, x1 = min(p[0] for p in pts), max(p[0] for p in pts)
    y0, y1 = min(p[1] for p in pts), max(p[1] for p in pts)
    s = MAP_W / (x1 - x0)
    main_h = (y1 - y0) * s
    map_h = math.ceil(max(main_h + 2 * PADY, MIN_MAP_H))
    inset_y = map_h - 2 * PADY - INSET_H

    def to_svg(px, py):
        return ((px - x0) * s + PADX, (y1 - py) * s + PADY)

    def project(pts_):
        return [to_svg(*lcc(x, y)) for x, y in pts_]

    def path_d(pts_):
        return "M" + "L".join(f"{a:.1f},{b:.1f}" for a, b in pts_) + "Z"

    def bbox_area(q):
        xs = [p[0] for p in q]
        ys = [p[1] for p in q]
        return (max(xs) - min(xs)) * (max(ys) - min(ys))

    def centroid(q):
        """取最大环的面积质心（环绕型省份如河北会偏，故配 LBL_OFFSET 手工微调）"""
        best, ba = None, -1.0
        for r in q:
            a, cx, cy = 0.0, 0.0, 0.0
            for i in range(len(r) - 1):
                (x1p, y1p), (x2p, y2p) = r[i], r[i + 1]
                cross = x1p * y2p - x2p * y1p
                a += cross
                cx += (x1p + x2p) * cross
                cy += (y1p + y2p) * cross
            if abs(a) > ba:
                ba, best = abs(a), (cx / (3 * a), cy / (3 * a))
        return best

    provinces, by_name = [], {}
    for nm, ring in main_rings:
        q = rdp(project(ring), EPS)
        if len(q) < 4 or ring_area2(q) < MIN_RING_AREA:
            stats["dropped"] += 1
            continue
        stats["out"] += len(q)
        by_name.setdefault(nm, []).append(q)
    for nm, qs in by_name.items():
        dx, dy = LBL_OFFSET.get(nm, (0, 0))
        cx, cy = centroid(qs)
        provinces.append({
            "n": nm, "d": "".join(path_d(q) for q in qs),
            "x": round(cx + dx, 1), "y": round(cy + dy, 1),
            "l": (bbox_area([p for q in qs for p in q]) > LBL_MIN_AREA
                  and nm not in ("香港", "澳门")) or nm in LBL_FORCE,
        })
    provinces.sort(key=lambda p: p["n"])

    # ---- 南海诸岛附图 ----
    ipts = [lcc(x, y) for _, _, r in inset_parts for x, y in r]
    ix0, ix1 = min(p[0] for p in ipts), max(p[0] for p in ipts)
    iy0, iy1 = min(p[1] for p in ipts), max(p[1] for p in ipts)
    isc = min(INSET_W / (ix1 - ix0), INSET_H / (iy1 - iy0)) * 0.90
    io_x = (INSET_W - (ix1 - ix0) * isc) / 2
    io_y = (INSET_H - (iy1 - iy0) * isc) / 2

    def ipath(r, eps):
        q = rdp([((lcc(x, y)[0] - ix0) * isc + io_x, (iy1 - lcc(x, y)[1]) * isc + io_y)
                 for x, y in r], eps)
        return path_d(q) if len(q) >= 2 else ""

    island_d = "".join(ipath(r, EPS) for nm, k, r in inset_parts if nm and k == "ring")
    nine_d = "".join(ipath(r, EPS_LINE) for nm, k, r in inset_parts if nm is None)

    # ---- 港澳引线点（本比例尺下图形仅数像素，补圆点 + 引线保证可悬停可点击）----
    def mini(nm, dx, dy, side):
        p = next(x for x in provinces if x["n"] == nm)
        return {"n": nm, "x": p["x"], "y": p["y"],
                "lx": round(p["x"] + dx, 1), "ly": round(p["y"] + dy, 1), "side": side}

    minis = [mini("香港", 18, -20, 1), mini("澳门", -14, 22, -1)]

    def arr(items, indent="  "):
        return "\n".join(indent + json.dumps(o, ensure_ascii=False, separators=(",", ":")) + ","
                         for o in items)

    ts = f"""// 本文件由 scripts/build-area-map.py 生成，请勿手改。
// 数据源：阿里 DataV GeoAtlas 全国省级边界（含台湾省与南海诸岛九段线，标准地图口径），
//         已瘦身存于 scripts/data/china-geo-full.json，要改数据请改脚本后重跑。
// 投影：正轴等角割圆锥（双标准纬线 25°N / 47°N，中央经线 105°E）＝ 官方标准地图投影；
//       边界经 Douglas–Peucker 抽稀（容差 {EPS} viewBox 单位 ≈ 0.26px），视觉无损。
// 省份名已剥去 省/市/自治区/特别行政区 后缀，与 user.area 落库值同口径。

export interface GeoProvince {{
  /** 省份名（与 user.area 同口径，如「内蒙古」「广西」） */
  n: string;
  /** SVG 路径（viewBox 坐标系） */
  d: string;
  /** 常驻名称标签的锚点（已含手工偏移） */
  x: number;
  y: number;
  /** 是否显示常驻名称标签（过小的省 / 港澳为 false） */
  l: boolean;
}}

export interface GeoMini {{
  n: string;
  x: number;
  y: number;
  /** 引线终点（标签锚点） */
  lx: number;
  ly: number;
  /** 标签在引线终点左(-1)/右(1)侧 */
  side: number;
}}

export const MAP_W = {MAP_W:.0f};
export const MAP_H = {map_h};
/** 南海诸岛附图（右下角）在 viewBox 中的位置 */
export const MAP_INSET = {{ x: {MAP_W - PADX - INSET_W:.0f}, y: {round(inset_y, 1)}, w: {INSET_W:.0f}, h: {INSET_H:.0f} }};

export const GEO_PROVINCES: GeoProvince[] = [
{arr(provinces)}
];

/** 南海诸岛（附图内的岛礁面） */
export const GEO_INSET_ISLAND = "{island_d}";

/** 南海诸岛九段线（附图内的线） */
export const GEO_INSET_NINE = "{nine_d}";

export const GEO_MINI: GeoMini[] = [
{arr(minis)}
];
"""
    open(OUT, "w", encoding="utf-8").write(ts)
    print(f"省份 {len(provinces)} 个；主图高 {main_h:.1f}，viewBox {MAP_W:.0f}x{map_h}，附图 y={inset_y:.1f}")
    print(f"坐标点：{stats['in']} → {stats['out']}（丢弃小环 {stats['dropped']} 个）")
    print("written", OUT, os.path.getsize(OUT), "bytes")
    missing = [p for p in ("北京", "天津", "上海", "香港", "澳门", "台湾", "海南",
                           "内蒙古", "广西", "新疆", "西藏", "宁夏")
               if p not in {q["n"] for q in provinces}]
    if missing:
        print("!! 缺省份：", missing, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
