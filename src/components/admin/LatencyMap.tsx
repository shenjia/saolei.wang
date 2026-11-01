"use client";

// 排行模式全国延迟地图（2026-10-28 张老师需求）：/admin/practice 顶部。
// 2026-11-01 改版（张老师定）：改展示今日延迟——数据源换成 getRegionToday
// （与右侧「今日地区明细」表同一份），标题「今日延迟情况」；并与明细表
// 双向联动：hover 状态由 PracticeRegionBoard 统一持有，地图悬停省份高亮
// 右表对应行，表格悬停行高亮地图省份（复用 .prov.hovering 高亮样式）。
// 填色绿 ≤30ms → 黄 60ms → 红 ≥90ms 分段线性插值；悬停气泡：人数/盘数/延迟区间。
// 省界几何复用 /area 同一份静态数据（src/lib/area-map-geo.ts，DataV 标准边界，
// 含台湾省与南海诸岛九段线），样式复用 .area_map 族；只看不点（无跳转）。

import { useRef, type MouseEvent as ReactMouseEvent } from "react";
import { areaDisplay } from "@/lib/config";
import { type RegionTodayRow } from "./RegionTodayTable";
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

/* 权威服务实例位置红旗（2026-10-28 张老师需求）：坐标由 build-area-map.py 同一
   LCC 投影（25/47N 双标准纬线、中央经线 105E）算出：北京 116.407,39.904 →
   (747.7,339.3)；香港 114.169,22.319 → (746.9,743.2)。右侧负载清单见
   ServerStatusPanel（同页并排） */
const SERVER_PINS = [
  { n: "北京", x: 747.7, y: 339.3 },
  { n: "香港", x: 746.9, y: 743.2 },
];

export function LatencyMap({
  data,
  hoverArea,
  onHover,
}: {
  data: RegionTodayRow[];
  hoverArea: string | null;
  onHover: (area: string | null) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  const byName = new Map(data.map((d) => [d.area, d]));
  const hot = hoverArea ? byName.get(hoverArea) : undefined;

  const enter = (area: string | null) => () => onHover(area);

  /* 气泡跟随鼠标（与 /area AreaMap 同手法：直接改样式避免整图重渲染） */
  const move = (e: ReactMouseEvent) => {
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
        onMouseLeave={() => onHover(null)}
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
          {/* 权威服务实例红旗（右侧列负载清单，每 3s 刷新） */}
          {SERVER_PINS.map((p) => (
            <g key={p.n} className="srv_pin" style={{ pointerEvents: "none" }}>
              <title>{`${p.n}（排名服务器）`}</title>
              <line x1={p.x} y1={p.y} x2={p.x} y2={p.y - 13} stroke="#e24b4a" strokeWidth="1.6" />
              <path d={`M${p.x},${p.y - 13} L${p.x + 12},${p.y - 9.5} L${p.x},${p.y - 6} Z`} fill="#e24b4a" />
              <circle cx={p.x} cy={p.y} r="2.4" fill="#e24b4a" stroke="rgba(248,248,242,.7)" strokeWidth="0.7" />
            </g>
          ))}
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
        <div className={`am_tip${hot ? " show" : ""}`} ref={tipRef}>
          {hot && (
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
          )}
        </div>
      </div>
      <div className="am_hint">鼠标悬停查看各省人数与延迟 · 灰色＝今日无延迟数据</div>
    </div>
  );
}
