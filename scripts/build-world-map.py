#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 src/lib/world-map-geo.ts —— 世界榜「交互式世界地图」的国界几何数据

数据源（全部为静态几何数据，不使用任何第三方地图服务 / 瓦片 / Key，可离线渲染）：
  1) 基础国界：Natural Earth 110m admin_0_countries（公有领域）
     首次运行抓取并瘦身到 scripts/data/world-geo-full.json，之后离线可复现
  2) 中国国界：复用 scripts/data/china-geo-full.json（阿里 DataV GeoAtlas 全国省级边界，
     含台湾省与南海诸岛九段线，标准地图口径）——用其「省级并集」替换 Natural Earth 的中国，
     并从陆上邻国（印度等）中扣除，保证藏南等争议区按我国标准口径归属，不出现越界画法

投影：Miller 圆柱投影，中央经线 150°E（＝我国标准世界地图的太平洋居中排布：
      欧洲/非洲在左、亚洲居中、太平洋与美洲在右），纬度裁剪 [-56°, 84°]（不画南极）

用法：
  /Users/shenjia/.workbuddy/binaries/python/envs/default/bin/python3 scripts/build-world-map.py
"""
import json
import math
import os
import subprocess
import sys

from shapely.affinity import translate as shp_translate
from shapely.geometry import shape, box, Polygon, MultiPolygon, LineString, MultiLineString
from shapely.ops import unary_union
from shapely.validation import make_valid

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(HERE, "data", "world-geo-full.json")
CHINA_SRC = os.path.join(HERE, "data", "china-geo-full.json")
OUT = os.path.join(ROOT, "src", "lib", "world-map-geo.ts")
URL = ("https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/"
       "geojson/ne_110m_admin_0_countries.geojson")

MAP_W = 1000.0          # viewBox 宽（高按投影比例算）
PADX, PADY = 6.0, 10.0
LON0 = 150.0            # 中央经线
LAT_MIN, LAT_MAX = -56.0, 84.0
EPS = 0.32              # 边界抽稀容差（viewBox 单位，1 单位 ≈ 0.75px，视觉无损）
EPS_LINE = 0.2          # 九段线容差
MIN_RING_AREA = 0.5     # 环面积下限（viewBox 单位²），更小的环视为噪点丢弃
LBL_MIN_AREA = 1300.0   # 常驻名称标签的最小投影外接框面积（按最大环算，海外飞地不计入）
LBL_FORCE = {"FRA", "IDN", "JPN"}   # 面积不够但值得常驻标签的国家
# 标签锚点手工偏移（北欧三国挤在一起，错开摆放）
LBL_OFFSET = {"挪威": (-18, -6), "瑞典": (2, 14), "芬兰": (26, -2), "日本": (16, -2),
              "新西兰": (0, 14), "阿尔及利亚": (18, 14), "摩洛哥": (-14, -10)}
DOT_AREA = 46.0         # 外接框面积小于此值的国家补引线圆点（本比例尺下仅数像素）

# 世界排行用于标记玩家国籍的旗帜 slug → ISO A3（worldtop.ts 抓取到的全量国旗）
FLAG_ISO = {
    "albania": "ALB", "algeria": "DZA", "argentina": "ARG", "armenia": "ARM",
    "australia": "AUS", "austria": "AUT", "bangladesh": "BGD", "belarus": "BLR",
    "belgium": "BEL", "bolivia": "BOL", "bosnia-herzegovina": "BIH", "brazil": "BRA",
    "bulgaria": "BGR", "canada": "CAN", "chile": "CHL", "china": "CHN",
    "chinese-taipei": "CHN", "colombia": "COL", "costa-rica": "CRI", "croatia": "HRV",
    "cuba": "CUB", "cyprus": "CYP", "czech-republic": "CZE", "denmark": "DNK",
    "dominican-republic": "DOM", "ecuador": "ECU", "egypt": "EGY", "estonia": "EST",
    "fiji": "FJI", "finland": "FIN", "france": "FRA", "germany": "DEU",
    "greece": "GRC", "guatemala": "GTM", "hungary": "HUN", "iceland": "ISL",
    "india": "IND", "indonesia": "IDN", "iran": "IRN", "iraq": "IRQ",
    "ireland": "IRL", "israel": "ISR", "italy": "ITA", "japan": "JPN",
    "jordan": "JOR", "kazakhstan": "KAZ", "korea-north": "PRK", "korea-south": "KOR",
    "lebanon": "LBN", "lithuania": "LTU", "luxembourg": "LUX", "macedonia": "MKD",
    "madagascar": "MDG", "malaysia": "MYS", "malta": "MLT", "mauritius": "MUS",
    "mexico": "MEX", "mongolia": "MNG", "montenegro": "MNE", "morocco": "MAR",
    "nepal": "NPL", "netherlands": "NLD", "new-zealand": "NZL", "norway": "NOR",
    "pakistan": "PAK", "palestine": "PSE", "peru": "PER", "philippines": "PHL",
    "poland": "POL", "portugal": "PRT", "romania": "ROU", "russia": "RUS",
    "serbia": "SRB", "singapore": "SGP", "slovakia": "SVK", "slovenia": "SVN",
    "south-africa": "ZAF", "spain": "ESP", "sri-lanka": "LKA", "sweden": "SWE",
    "switzerland": "CHE", "syria": "SYR", "thailand": "THA", "tunisia": "TUN",
    "turkey": "TUR", "ukraine": "UKR", "united-arab-emirates": "ARE",
    "united-kingdom": "GBR", "united-states": "USA", "uruguay": "URY",
    "uzbekistan": "UZB", "venezuela": "VEN", "vietnam": "VNM",
}

# 国家中文名（按我国通用译名；旗帜 slug 的中文名以本表为准）
ZH = {
    "ALB": "阿尔巴尼亚", "DZA": "阿尔及利亚", "ARG": "阿根廷", "ARM": "亚美尼亚",
    "AUS": "澳大利亚", "AUT": "奥地利", "BGD": "孟加拉国", "BLR": "白俄罗斯",
    "BEL": "比利时", "BOL": "玻利维亚", "BIH": "波黑", "BRA": "巴西",
    "BGR": "保加利亚", "CAN": "加拿大", "CHL": "智利", "CHN": "中国",
    "COL": "哥伦比亚", "CRI": "哥斯达黎加", "HRV": "克罗地亚", "CUB": "古巴",
    "CYP": "塞浦路斯", "CZE": "捷克", "DNK": "丹麦", "DOM": "多米尼加",
    "ECU": "厄瓜多尔", "EGY": "埃及", "EST": "爱沙尼亚", "FJI": "斐济",
    "FIN": "芬兰", "FRA": "法国", "DEU": "德国", "GRC": "希腊",
    "GTM": "危地马拉", "HUN": "匈牙利", "ISL": "冰岛", "IND": "印度",
    "IDN": "印度尼西亚", "IRN": "伊朗", "IRQ": "伊拉克", "IRL": "爱尔兰",
    "ISR": "以色列", "ITA": "意大利", "JPN": "日本", "JOR": "约旦",
    "KAZ": "哈萨克斯坦", "PRK": "朝鲜", "KOR": "韩国", "LBN": "黎巴嫩",
    "LTU": "立陶宛", "LUX": "卢森堡", "MKD": "北马其顿", "MDG": "马达加斯加",
    "MYS": "马来西亚", "MLT": "马耳他", "MUS": "毛里求斯", "MEX": "墨西哥",
    "MNG": "蒙古", "MNE": "黑山", "MAR": "摩洛哥", "NPL": "尼泊尔",
    "NLD": "荷兰", "NZL": "新西兰", "NOR": "挪威", "PAK": "巴基斯坦",
    "PSE": "巴勒斯坦", "PER": "秘鲁", "PHL": "菲律宾", "POL": "波兰",
    "PRT": "葡萄牙", "ROU": "罗马尼亚", "RUS": "俄罗斯", "SRB": "塞尔维亚",
    "SGP": "新加坡", "SVK": "斯洛伐克", "SVN": "斯洛文尼亚", "ZAF": "南非",
    "ESP": "西班牙", "LKA": "斯里兰卡", "SWE": "瑞典", "CHE": "瑞士",
    "SYR": "叙利亚", "THA": "泰国", "TUN": "突尼斯", "TUR": "土耳其",
    "UKR": "乌克兰", "ARE": "阿联酋", "GBR": "英国", "USA": "美国",
    "URY": "乌拉圭", "UZB": "乌兹别克斯坦", "VEN": "委内瑞拉", "VNM": "越南",
}

# Natural Earth 里的小国代码别名（NE 用 PSX 表示巴勒斯坦），落库前统一回 ISO 口径
ISO_ALIAS = {"PSE": "PSX"}
NE_ISO = {v: k for k, v in ISO_ALIAS.items()}
FLAG_SET = set(FLAG_ISO.values())

# 基础图里缺号的小国（110m 精度未收录）及其坐标，用于补引线圆点
EXTRA = {"SGP": (103.8, 1.35), "MLT": (14.45, 35.9), "MUS": (57.55, -20.25)}

# 不画的区域（南极；另 TWN 已并入中国）
SKIP = {"ATA", "TWN"}


def round_coords(c, nd):
    if isinstance(c, (int, float)):
        return round(c, nd)
    return [round_coords(x, nd) for x in c]


def load_world():
    """读取瘦身源数据；不存在则抓取并落盘（坐标取 3 位小数 ≈ 110m，够用且体积大减）"""
    if not os.path.exists(SRC):
        os.makedirs(os.path.dirname(SRC), exist_ok=True)
        print("抓取", URL)
        raw = subprocess.run(["curl", "-sSL", "--max-time", "300", URL],
                             capture_output=True, text=True, check=True).stdout
        slim = []
        for f in json.loads(raw)["features"]:
            p, g = f["properties"], f["geometry"]
            if not g:
                continue
            iso = NE_ISO.get(p.get("ADM0_A3"), p.get("ADM0_A3"))
            slim.append({"iso": iso, "name": p.get("NAME"),
                         "type": g["type"],
                         "coordinates": round_coords(g["coordinates"], 3)})
        json.dump({"features": slim}, open(SRC, "w", encoding="utf-8"),
                  ensure_ascii=False, separators=(",", ":"))
        print("源数据已瘦身落盘", SRC, os.path.getsize(SRC), "bytes")
    return json.load(open(SRC, encoding="utf-8"))


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


# ---------------- 投影：Miller 圆柱 ----------------
def miller(lng, lat):
    """lng 为相对中央经线换算后的经度（调用方先减 LON0），返回视图坐标（y 已翻转）"""
    x = math.radians(lng)
    phi = math.radians(lat)
    y = 1.25 * math.log(math.tan(math.pi / 4 + 0.4 * phi))
    return x, -y


def heal_dateline(geom):
    """NE 在反经线两侧把国家拆成两片（各带一条 ±180° 竖直边）——
    把西片平移 +360° 后与东片求并，接缝即被消化，避免在陆地上画出一条假竖线"""
    polys = list(geom.geoms) if isinstance(geom, MultiPolygon) else [geom]
    out, moved = [], False
    for p in polys:
        b = p.bounds
        if b[0] <= -179.99:
            out.append(shp_translate(p, xoff=360.0))
            moved = True
        else:
            out.append(p)
    if not moved:
        return geom
    merged = unary_union(out).buffer(0)
    return merged if not merged.is_empty else geom


def shift_lon(geom, dx):
    return shp_translate(geom, xoff=dx)


def unwrap_ring(ring):
    """把跨 ±180° 的环经度展平成连续值（NE 在反经线两侧各留一条竖直边，直接投影会画出一条假线）"""
    out = [[ring[0][0], ring[0][1]]]
    for p in ring[1:]:
        lon = p[0]
        prev = out[-1][0]
        while lon - prev > 180:
            lon -= 360
        while prev - lon > 180:
            lon += 360
        out.append([lon, p[1]])
    return out


def unwrap_geom(geom):
    polys = list(geom.geoms) if isinstance(geom, MultiPolygon) else [geom]
    out = []
    for p in polys:
        ext = unwrap_ring(list(p.exterior.coords))
        holes = [unwrap_ring(list(i.coords)) for i in p.interiors]
        q = Polygon(ext, holes)
        if not q.is_valid:
            q = q.buffer(0)
        if not q.is_empty:
            out.append(q)
    if not out:
        return geom
    return out[0] if len(out) == 1 else MultiPolygon(out)


def rings_of(geom):
    """shapely 多边形 → [(外环, [内环...]), ...]（经纬度坐标）"""
    polys = geom.geoms if isinstance(geom, MultiPolygon) else [geom]
    out = []
    for p in polys:
        if p.is_empty:
            continue
        out.append((list(p.exterior.coords), [list(i.coords) for i in p.interiors]))
    return out


def build_china():
    """DataV 省级并集＝我国标准口径国界（含台湾省与藏南）；同时取回九段线"""
    data = json.load(open(CHINA_SRC, encoding="utf-8"))
    parts, nine = [], []
    for f in data["features"]:
        if not f.get("type"):
            continue
        g = shape({"type": f["type"], "coordinates": f["coordinates"]})
        if f.get("adcode") == "100000_JD":
            nine.append(g)
        else:
            parts.append(make_valid(g).buffer(0))
    return unary_union(parts).buffer(0), unary_union(nine)


def main():
    world = load_world()
    china, nine = build_china()
    print(f"中国并集：{china.geom_type}，面积 {china.area:.1f} 平方度；九段线 {nine.geom_type}")

    # ---- 逐国几何：中国换标准口径，陆上邻国扣除中国（消掉藏南等越界画法） ----
    geoms, dropped = {}, []
    for f in world["features"]:
        iso = f.get("iso")
        if iso in SKIP or not iso:
            continue
        g = make_valid(shape({"type": f["type"], "coordinates": f["coordinates"]})).buffer(0)
        if iso == "CHN":
            g = china
        else:
            g = g.difference(china)
        g = unwrap_geom(g)
        g = heal_dateline(g)
        if g.is_empty:
            dropped.append(iso)
            continue
        geoms[iso] = g
    print(f"图元 {len(geoms)} 个国家/地区（丢弃空几何 {len(dropped)}：{dropped}）")

    # ---- 投影 + 裁剪（中央经线 150°E，跨 seam 的国家自动拆成两片） ----
    clip = box(-180, LAT_MIN, 180, LAT_MAX)
    proj = {}
    for iso, g in geoms.items():
        pieces = []
        for k in (-360.0, 0.0, 360.0):
            piece = shift_lon(g, k - LON0).intersection(clip)
            if piece.is_empty:
                continue
            for ext, holes in rings_of(piece):
                pieces.append((ext, holes))
        if pieces:
            proj[iso] = pieces

    # ---- 定标（用全部国家的外接范围，保证整幅世界地图比例固定） ----
    pts = [miller(x, y) for iso in proj for ext, _ in proj[iso] for x, y in ext]
    x0, x1 = min(p[0] for p in pts), max(p[0] for p in pts)
    y0, y1 = min(p[1] for p in pts), max(p[1] for p in pts)
    s = MAP_W / (x1 - x0)
    map_h = math.ceil((y1 - y0) * s + 2 * PADY)

    def to_svg(px, py):
        return ((px - x0) * s + PADX, (py - y0) * s + PADY)

    def project(pts_):
        return [to_svg(*miller(x, y)) for x, y in pts_]

    def pj(lng, lat):
        """原始经纬度（未做中央经线平移）→ 主图坐标"""
        return to_svg(*miller(lng - LON0, lat))

    def path_d(pts_, close=True):
        if len(pts_) < 2:
            return ""
        return "M" + "L".join(f"{a:.1f},{b:.1f}" for a, b in pts_) + ("Z" if close else "")

    def bbox_area(q):
        xs = [p[0] for p in q]
        ys = [p[1] for p in q]
        return (max(xs) - min(xs)) * (max(ys) - min(ys))

    def centroid(pts):
        """面积质心（海外领地会把点平均拉跑，故取最大环的质心）"""
        a = cx = cy = 0.0
        for i in range(len(pts) - 1):
            (x1, y1), (x2, y2) = pts[i], pts[i + 1]
            cr = x1 * y2 - x2 * y1
            a += cr
            cx += (x1 + x2) * cr
            cy += (y1 + y2) * cr
        if abs(a) < 1e-9:
            return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
        return (cx / (3 * a), cy / (3 * a))

    countries = []
    stats = {"in": 0, "out": 0}
    for iso, pieces in proj.items():
        d, kept, big = "", False, None
        for ext, holes in pieces:
            stats["in"] += len(ext) + sum(len(h) for h in holes)
            q = rdp(project(ext), EPS)
            if len(q) < 4 or ring_area2(q) < MIN_RING_AREA:
                continue
            kept = True
            stats["out"] += len(q)
            if big is None or ring_area2(q) > ring_area2(big):
                big = q
            d += path_d(q)
            for h in holes:                      # 洞（如里海沿岸的飞地）照画，保证形似
                qh = rdp(project(h), EPS)
                if len(qh) >= 4 and ring_area2(qh) >= MIN_RING_AREA:
                    d += path_d(qh)
        if not kept:
            dropped.append(iso + "(环过小)")
            continue
        area = bbox_area(big)                    # 用最大环外接框（海外飞地不参与标签/圆点判定）
        cx, cy = centroid(big)
        _dx, _dy = LBL_OFFSET.get(ZH.get(iso, ""), (0, 0))
        cx, cy = cx + _dx, cy + _dy
        countries.append({
            "k": iso, "n": ZH.get(iso, "") if iso in FLAG_SET else "", "d": d,
            "x": round(cx, 1), "y": round(cy, 1),
            "a": round(area, 1),
        })

    countries.sort(key=lambda c: c["k"])

    # 常驻名称标签：仅给「有世界排行数据且国土够大」的国家显示（90+ 国全标会糊成一片）；
    # 国土过小者改用引线圆点，保证有数据的国家都能被鼠标点到
    for c in countries:
        c["l"] = c["k"] in FLAG_SET and (c["a"] >= LBL_MIN_AREA or c["k"] in LBL_FORCE)

    # ---- 九段线（DataV 里是 10 段细长面，按其外环描边绘制；原始经纬度需先做中央经线平移）----
    nine_d = ""
    for dash in rings_of(nine):
        q = rdp([pj(x, y) for x, y in dash[0]], EPS_LINE)
        nine_d += path_d(q)

    # ---- 小国引线圆点（国土过小者 + 110m 未收录的新加坡/马耳他/毛里求斯） ----
    by_iso = {c["k"]: c for c in countries}
    minis = []
    for iso, c in by_iso.items():
        if iso not in FLAG_SET or c["l"] or c["a"] >= DOT_AREA:
            continue
        minis.append((iso, c["x"], c["y"]))
    for iso, (lng, lat) in EXTRA.items():
        if iso in by_iso:
            continue
        minis.append((iso, *pj(lng, lat)))
    minis = [{"k": iso, "n": ZH[iso], "x": round(x, 1), "y": round(y, 1),
              "lx": round(x + (22 if x < MAP_W * 0.55 else -22), 1),
              "ly": round(y + (-16 if y > map_h * 0.5 else 20), 1),
              "side": 1 if x < MAP_W * 0.55 else -1}
             for iso, x, y in minis]
    for c in countries:                      # 外接框面积只用于内部判断，不落进产物
        c.pop("a", None)

    def arr(items, indent="  "):
        return "\n".join(indent + json.dumps(o, ensure_ascii=False, separators=(",", ":")) + ","
                         for o in items)

    ts = f"""// 本文件由 scripts/build-world-map.py 生成，请勿手改。
// 数据源：Natural Earth 110m admin_0_countries（公有领域，静态几何，无第三方地图服务/Key）
//         + 阿里 DataV GeoAtlas 全国省级边界（我国标准地图口径，用于替换中国国界并扣除邻国越界部分）
// 投影：Miller 圆柱，中央经线 {LON0:.0f}°E（我国标准世界地图的太平洋居中排布），
//       纬度裁剪 [{LAT_MIN:.0f}°, {LAT_MAX:.0f}°]，边界 Douglas–Peucker 抽稀（容差 {EPS} viewBox 单位）。

export interface GeoCountry {{
  /** ISO A3 代码（国旗 slug → ISO 的映射见 lib/config.ts 的 FLAG_ISO） */
  k: string;
  /** 国家中文名（我国通用译名） */
  n: string;
  /** SVG 路径（viewBox 坐标系） */
  d: string;
  /** 常驻名称标签锚点 */
  x: number;
  y: number;
  /** 是否显示常驻名称标签（国土过小的国家为 false，改用引线圆点） */
  l: boolean;
}}

export interface GeoMini {{
  k: string;
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

export const GEO_COUNTRIES: GeoCountry[] = [
{arr(countries)}
];

/** 南海诸岛九段线（我国标准地图口径，必须绘制） */
export const GEO_NINE = "{nine_d}";

/** 小国引线圆点（国土过小或 110m 精度未收录的国家） */
export const GEO_MINI: GeoMini[] = [
{arr(minis)}
];
"""
    open(OUT, "w", encoding="utf-8").write(ts)
    print(f"国家 {len(countries)} 个 / 引线圆点 {len(minis)} 个；viewBox {MAP_W:.0f}x{map_h}")
    print(f"坐标点：{stats['in']} → {stats['out']}")
    print("written", OUT, os.path.getsize(OUT), "bytes")
    miss = [iso for iso in set(FLAG_ISO.values()) if iso not in by_iso and iso not in EXTRA]
    if miss:
        print("!! 国旗缺少对应国界：", miss, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
