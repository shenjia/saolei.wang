"use client";

// 排行模式全国延迟地图（2026-10-28 张老师需求）：/admin/practice 顶部。
// 2026-11-01 改版（张老师定）：改展示今日延迟——数据源换成 getRegionToday
// （与右侧「今日地区明细」表同一份），标题「今日延迟情况」；并与明细表
// 双向联动：hover 状态由 PracticeRegionBoard 统一持有，地图悬停省份高亮
// 右表对应行，表格悬停行高亮地图省份（复用 .prov.hovering 高亮样式）。
// 填色绿 ≤30ms → 黄 60ms → 红 ≥90ms 分段线性插值；悬停气泡：人数/盘数/延迟区间。
// 省界几何复用 /area 同一份静态数据（src/lib/area-map-geo.ts，DataV 标准边界，
// 含台湾省与南海诸岛九段线），样式复用 .area_map 族；只看不点（无跳转）。
// 2026-11-02 改版（张老师需求）：静态红旗撤下，改「每服务器一颗 18×18 服务器
// 机架图标」（public/images/server.png，HTML overlay 百分比锚定城市坐标，尺寸
// 不随地图缩放；无坐标/无图标的节点自动跳过）；与负载面板双向联动：hover
// 服务器名 → 图标高亮放大，hover 图标 → 气泡显示该服务器数据（在线/对局 x/y、
// 平均延迟三色、样本数）。坐标与省界同一 LCC 投影
// （25/47N 双标准纬线、中央经线 105E）：北京 (747.7,339.3) 杭州 (846.4,546.2)
// 成都 (531.2,562.6) 广州 (725.9,726.2)——加节点跑 build-area-map.py 的
// lcc+to_svg 公式补坐标即可。

import { useEffect, useRef, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { areaDisplay } from "@/lib/config";
import { type RegionTodayRow } from "./RegionTodayTable";
import { type ServerRow } from "./ServerStatusPanel";
import { rttColor, RTT_LEGEND } from "./rttColor";
import {
  GEO_INSET_ISLAND,
  GEO_INSET_NINE,
  GEO_MINI,
  GEO_PROVINCES,
  MAP_H,
  MAP_INSET,
  MAP_W,
} from "@/lib/area-map-geo";

/* 绿黄红分段色标（张老师定：按平均延迟分级，中间差值渐变） */
const STOPS: { at: number; c: [number, number, number] }[] = [
  { at: 30, c: [0xa6, 0xe2, 0x2e] }, // 绿（同前台/后台绿）
  { at: 60, c: [0xfd, 0xc6, 0x1d] }, // 黄（站点金）
  { at: 90, c: [0xe2, 0x4b, 0x4a] }, // 红
];

function hex(c: [number, number, number]): string {
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function ramp(avg: number): string {
  if (avg <= STOPS[0].at) return hex(STOPS[0].c);
  for (let i = 0; i < STOPS.length - 1; i++) {
    const a = STOPS[i];
    const b = STOPS[i + 1];
    if (avg <= b.at) {
      const k = (avg - a.at) / (b.at - a.at);
      return hex([0, 1, 2].map((j) => Math.round(a.c[j] + (b.c[j] - a.c[j]) * k)) as [number, number, number]);
    }
  }
  return hex(STOPS[STOPS.length - 1].c);
}

const LEGEND = `linear-gradient(90deg,${Array.from({ length: 13 }, (_, i) => {
  const ms = 15 + i * 7.5; // 15→105ms 均匀取样
  return `${ramp(ms)} ${Math.round((i / 12) * 100)}%`;
}).join(",")})`;

/* 服务器图标坐标（键 = authority-status targets() 的 name）：dx 为像素级
   水平偏移（HTML overlay 层用 calc 拼进 left），北京双实例同城左右错开。
   城市坐标与省界同一 LCC 投影。香港已下线不设。 */
const SERVER_GEO: Record<string, { x: number; y: number; dx?: number }> = {
  北京1: { x: 747.7, y: 339.3, dx: -9 },
  北京2: { x: 747.7, y: 339.3, dx: 9 },
  杭州: { x: 846.4, y: 546.2 },
  成都: { x: 531.2, y: 562.6 },
  广州: { x: 725.9, y: 726.2 },
};

/** 图标层定位：SVG 坐标 → stage 百分比（am_svg 宽 100% 高自动，盒比例恒 1000:870，
    百分比定位与渲染宽度无关） */
function pos(g: { x: number; y: number; dx?: number }): CSSProperties {
  return {
    left: `calc(${(g.x / MAP_W) * 100}% + ${g.dx ?? 0}px)`,
    top: `${(g.y / MAP_H) * 100}%`,
  };
}

/** 钉状态色（与负载面板状态点同口径）：正常绿 / 排空橙 / 不可用红 */
function pinColor(s: ServerRow): string {
  return s.ok ? (s.draining ? "#f79646" : "#a6e22e") : "#e24b4a";
}

export function LatencyMap({
  data,
  hoverArea,
  onHover,
  servers,
  hoverServer,
  onHoverServer,
  srvTip,
  onSrvTip,
}: {
  data: RegionTodayRow[];
  hoverArea: string | null;
  onHover: (area: string | null) => void;
  servers: ServerRow[];
  hoverServer: string | null;
  onHoverServer: (name: string | null) => void;
  /** 钉气泡目标（仅钉自身 hover 时非空）：hover 负载行只放大钉、不出气泡 */
  srvTip: string | null;
  onSrvTip: (name: string | null) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  /* 各图形元素（省份 path + 港澳圆点 + 服务器钉）：联动时按其 bbox 锚定气泡 */
  const shapeRefs = useRef<Map<string, Element>>(new Map());
  /* 区分 hover 来源：地图本体 hover 时 move 跟鼠标即可，跳过锚定（防闪跳） */
  const localHover = useRef(false);

  const byName = new Map(data.map((d) => [d.area, d]));
  const hot = hoverArea ? byName.get(hoverArea) : undefined;
  /* 钉气泡目标：只取有坐标的实例（无坐标节点画不了钉自然不联动） */
  const hotSrv = srvTip
    ? servers.find((s) => s.name === srvTip && SERVER_GEO[s.name])
    : undefined;

  const enter = (area: string | null) => () => {
    localHover.current = area !== null;
    onHover(area);
    onHoverServer(null); // 省/港澳与服务器钉互斥
    onSrvTip(null);
  };
  const enterSrv = (name: string | null) => () => {
    onHoverServer(name);
    onSrvTip(name); // 气泡只跟钉自身 hover（负载行 hover 只放大钉）
    if (name) onHover(null); // 钉与省份互斥（钉在上层，进钉时清省）
  };

  /* 表格行 / 负载行联动（hover 状态变化且非地图本体触发）：气泡锚定到对应
     图形旁（省在 bbox 下方、钉在 bbox 上方，放不下翻面）。
     钉气泡仅 srvTip（钉自身 hover）触发；负载行 hover 只放大钉不出气泡 */
  useEffect(() => {
    if (srvTip) {
      const stage = stageRef.current;
      const tip = tipRef.current;
      const el = shapeRefs.current.get(srvTip);
      if (!stage || !tip || !el) return;
      const r = stage.getBoundingClientRect();
      const pr = el.getBoundingClientRect();
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      let x = pr.left - r.left + pr.width / 2 - tw / 2;
      x = Math.max(4, Math.min(x, r.width - tw - 4));
      let y = pr.top - r.top - th - 6; // 钉：气泡在钉头上方
      if (y < 4) y = pr.bottom - r.top + 8;
      tip.style.left = `${x}px`;
      tip.style.top = `${y}px`;
      return;
    }
    if (!hoverArea) return;
    if (localHover.current) {
      localHover.current = false;
      return;
    }
    const stage = stageRef.current;
    const tip = tipRef.current;
    const el = shapeRefs.current.get(hoverArea);
    if (!stage || !tip || !el) return;
    const r = stage.getBoundingClientRect();
    const pr = el.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let x = pr.left - r.left + pr.width / 2 - tw / 2;
    x = Math.max(4, Math.min(x, r.width - tw - 4));
    let y = pr.bottom - r.top + 8; // 省：气泡在 bbox 下方
    if (y + th > r.height - 4) y = pr.top - r.top - th - 8;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }, [hoverArea, srvTip, servers]);

  /* 气泡跟随鼠标（与 /area AreaMap 同手法：直接改样式避免整图重渲染）。
     钉气泡锚定在钉上方（effect 已定位），不被鼠标拽走 */
  const move = (e: ReactMouseEvent) => {
    if (srvTip) return;
    const stage = stageRef.current;
    const tip = tipRef.current;
    if (!stage || !tip) return;
    const r = stage.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let x = e.clientX - r.left + 16;
    if (x + tw > r.width - 8) x = e.clientX - r.left - tw - 16;
    const y = Math.max(4, Math.min(e.clientY - r.top - 10, r.height - th - 4));
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  };

  return (
    <div className="area_map" style={{ maxWidth: 620, margin: "0 auto" }}>
      <div className="am_head">
        <div className="am_title">今日延迟情况</div>
        <div className="am_legend">
          <span>30ms</span>
          <span className="lg_bar" style={{ background: LEGEND }}></span>
          <span>90ms</span>
        </div>
      </div>
      <div
        className="am_stage"
        ref={stageRef}
        onMouseMove={move}
        onMouseLeave={() => {
          onHover(null);
          onHoverServer(null);
          onSrvTip(null);
        }}
      >
        <svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} className="am_svg" role="img" aria-label="全国今日延迟地图">
          <rect className="am_bg" x="0" y="0" width={MAP_W} height={MAP_H} onMouseEnter={enter(null)} />
          <g>
            {GEO_PROVINCES.map((p) => {
              const d = byName.get(p.n);
              const avg = d?.avgRtt ?? null;
              return (
                <path
                  key={p.n}
                  ref={(el) => {
                    if (el) shapeRefs.current.set(p.n, el);
                    else shapeRefs.current.delete(p.n);
                  }}
                  className={`prov${avg !== null ? "" : " nodata"}${hoverArea === p.n ? " hovering" : ""}`}
                  style={{ cursor: d ? "help" : "default" }}
                  d={p.d}
                  fill={avg !== null ? ramp(avg) : undefined}
                  onMouseEnter={enter(d ? p.n : null)}
                  aria-label={`${areaDisplay(p.n)}：平均 ${d?.avgRtt ?? "--"}ms`}
                />
              );
            })}
          </g>
          {/* 港澳图形过小，补圆点 + 引线保证可发现、可悬停；联动高亮＝圆点放大 */}
          {GEO_MINI.map((m) => {
            const d = byName.get(m.n);
            const avg = d?.avgRtt ?? null;
            const hotMini = hoverArea === m.n;
            return (
              <g key={m.n} className="mini" onMouseEnter={enter(d ? m.n : null)}>
                <circle
                  ref={(el) => {
                    if (el) shapeRefs.current.set(m.n, el);
                    else shapeRefs.current.delete(m.n);
                  }}
                  cx={m.x}
                  cy={m.y}
                  r={hotMini ? 3.6 : 2.2}
                  fill={avg !== null ? ramp(avg) : "#302f28"}
                  stroke={hotMini ? "#f8f8f2" : "rgba(248,248,242,.55)"}
                  strokeWidth={hotMini ? 1.2 : 0.7}
                />
                <line x1={m.x} y1={m.y} x2={m.lx} y2={m.ly} />
                <text className="mlbl" x={m.lx + (m.side > 0 ? 3 : -3)} y={m.ly + 3} textAnchor={m.side > 0 ? "start" : "end"}>
                  {m.n}
                </text>
              </g>
            );
          })}
          {/* 南海诸岛附图（标准地图样式，含九段线）——合规必留 */}
          <svg x={MAP_INSET.x} y={MAP_INSET.y} width={MAP_INSET.w} height={MAP_INSET.h} viewBox={`0 0 ${MAP_INSET.w} ${MAP_INSET.h}`}>
            <rect className="inset-box" x="0.5" y="0.5" width={MAP_INSET.w - 1} height={MAP_INSET.h - 1} rx="3" />
            <text className="inset-lbl" x="6" y="13">
              南海诸岛
            </text>
            <g className="nine">
              <path d={GEO_INSET_NINE} />
            </g>
            <path className="island" d={GEO_INSET_ISLAND} />
          </svg>
        </svg>
        {/* 服务器图标层（2026-11-02 张老师：SVG 钉太小看不见，换 32×32 服务器图标。
            HTML overlay 百分比锚定城市坐标，尺寸不随地图缩放；hover 联动/气泡同前） */}
        <div className="srv_icons">
          {servers
            .filter((s) => SERVER_GEO[s.name])
            .map((s) => {
              const g = SERVER_GEO[s.name];
              const hl = hoverServer === s.name;
              return (
                <img
                  key={s.name}
                  ref={(el) => {
                    if (el) shapeRefs.current.set(s.name, el);
                    else shapeRefs.current.delete(s.name);
                  }}
                  src="/images/server.png"
                  alt={s.name}
                  draggable={false}
                  className={`srv_icon${hl ? " hl" : ""}`}
                  style={pos(g)}
                  onMouseEnter={enterSrv(s.name)}
                  onMouseLeave={() => {
                    onHoverServer(null);
                    onSrvTip(null);
                  }}
                />
              );
            })}
        </div>
        <div className={`am_tip${hot || hotSrv ? " show" : ""}`} ref={tipRef}>
          {hotSrv ? (
            <>
              <div className="tp_head">
                <b>{hotSrv.name}</b>
                <em
                  style={{
                    color: pinColor(hotSrv),
                    fontStyle: "normal",
                    fontWeight: 500,
                  }}
                >
                  {hotSrv.ok ? (hotSrv.draining ? "排空中" : "正常") : "不可用"}
                </em>
              </div>
              <div className="tp_row">
                <i>在线</i>
                <b className="green">
                  {hotSrv.connections} <em className="unit">/ {hotSrv.connsUsers.toLocaleString("zh-CN")} 人</em>
                </b>
              </div>
              <div className="tp_row">
                <i>对局</i>
                <b>
                  {hotSrv.active} <em className="unit">/ {hotSrv.gamesServed.toLocaleString("zh-CN")} 局</em>
                </b>
              </div>
              <div className="tp_row">
                <i>平均延迟</i>
                <b style={hotSrv.rttAvg !== null ? { color: rttColor(hotSrv.rttAvg) } : undefined}>
                  {hotSrv.rttAvg !== null ? `${hotSrv.rttAvg}ms` : "--"}
                </b>
              </div>
              <div className="tp_row">
                <i>样本数</i>
                <b>{hotSrv.rttN.toLocaleString("zh-CN")}</b>
              </div>
              <div className="tp_foot">在线/对局＝当前 / 累计 · 延迟＝近 7 天 · {RTT_LEGEND}</div>
            </>
          ) : hot ? (
            <>
              <div className="tp_head">
                <b>{areaDisplay(hot.area)}</b>
                <em
                  style={{
                    color: hot.avgRtt !== null ? ramp(hot.avgRtt) : "#75715e",
                    fontStyle: "normal",
                    fontWeight: 500,
                  }}
                >
                  {hot.avgRtt !== null ? `${hot.avgRtt}ms` : "--"}
                </em>
              </div>
              <div className="tp_row">
                <i>人数</i>
                <b className="green">
                  {hot.players} <em className="unit">人</em>
                </b>
              </div>
              <div className="tp_row">
                <i>盘数</i>
                <b>
                  {hot.plays.toLocaleString("zh-CN")} <em className="unit">盘</em>
                </b>
              </div>
              <div className="tp_row">
                <i>延迟区间</i>
                <b>
                  {hot.minRtt !== null ? `${hot.minRtt} – ${hot.maxRtt}` : "--"}
                  {hot.minRtt !== null && (
                    <em className="unit">
                      {" "}
                      ms
                    </em>
                  )}
                </b>
              </div>
              <div className="tp_foot">今日数据 · 分级 绿≤30 黄60 红≥90</div>
            </>
          ) : null}
        </div>
      </div>
      <div className="am_hint">鼠标悬停查看各省人数与延迟 · 钉＝排名服务器 · 灰色＝今日无延迟数据</div>
    </div>
  );
}
