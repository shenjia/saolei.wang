"use client";

// 世界榜 · 交互式世界地图（2026-10-15 张老师需求，地区榜 AreaMap 同款交互）
// 与 TOP100 表卡并排（.area_top Grid 右列），按「综合排行指数」给各国填色
// （开方归一：越高越黄、越低越灰）；悬停国家高亮 + 气泡（名次 / 排行人数 /
// 综合排行指数 / 领军人物 + 世界排名 + 总成绩）；点击国家在左侧 TOP100 表中
// 滚动定位该国领军人物的行；表行悬停反向高亮地图国家（双向联动）。
// 国界几何是静态数据（src/lib/world-map-geo.ts，由 scripts/build-world-map.py 生成）：
// 无第三方地图服务、无 Key、可离线；中国国界按我国标准口径（含台湾省与南海诸岛九段线），
// chinese-taipei 旗帜选手并入中国统计（lib/worldtop.ts FLAG_ISO）。

import { useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { areaPower } from "@/lib/format";
import type { WorldCountryDatum } from "@/lib/worldtop";
import { GEO_COUNTRIES, GEO_MINI, GEO_NINE, MAP_H, MAP_W } from "@/lib/world-map-geo";

// 综合排行指数配色（与地区榜同款）：开方归一后 #4B4A41（灰）→ #FDC61D（站点金）
const C0 = [0x4b, 0x4a, 0x41];
const C1 = [0xfd, 0xc6, 0x1d];

function ramp(t: number): string {
  const k = Math.max(0, Math.min(1, t));
  const c = C0.map((v, i) => Math.round(v + (C1[i] - v) * k));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

const LEGEND = `linear-gradient(90deg,${Array.from({ length: 7 }, (_, i) => `${ramp(i / 6)} ${Math.round((i / 6) * 100)}%`).join(",")})`;

export function WorldMap({
  data,
  hover,
  onHover,
  onLocate,
}: {
  data: WorldCountryDatum[];
  /** 当前高亮的国家 ISO（地图与表格双向联动共用） */
  hover: string | null;
  onHover: (iso: string | null) => void;
  /** 点击国家：由父组件在 TOP100 表中定位该国领军人物（无 TOP100 选手时不动作） */
  onLocate: (iso: string) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  // 气泡只由地图自身的悬停驱动（表格行悬停只高亮国家，不在鼠标旧位置弹气泡）
  const [tipIso, setTipIso] = useState<string | null>(null);

  const maxPower = data.reduce((m, d) => Math.max(m, d.power), 0) || 1;
  const byIso = new Map(data.map((d) => [d.iso, d]));
  const hot = tipIso ? byIso.get(tipIso) : undefined;

  /** 地图内悬停：同时驱动高亮（外传）与气泡（内部） */
  const enter = (iso: string | null) => () => {
    onHover(iso);
    setTipIso(iso);
  };

  // 气泡跟随鼠标（直接改样式，避免每帧重渲染整张地图）
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
    <div className="area_map">
      <div className="am_head">
        <div className="am_title">地图</div>
        <div className="am_legend">
          <span>弱</span>
          <span className="lg_bar" style={{ background: LEGEND }}></span>
          <span>强</span>
        </div>
      </div>
      <div
        className="am_stage"
        ref={stageRef}
        onMouseMove={move}
        onMouseLeave={() => {
          onHover(null);
          setTipIso(null);
        }}
      >
        <svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} className="am_svg" role="img" aria-label="世界排行分布地图">
          {/* 空白底：鼠标移到无数据区域时收起气泡 */}
          <rect className="am_bg" x="0" y="0" width={MAP_W} height={MAP_H} onMouseEnter={enter(null)} />
          <g>
            {GEO_COUNTRIES.map((c) => {
              const d = byIso.get(c.k);
              return (
                <path
                  key={c.k}
                  className={`ctr${d ? "" : " nodata"}${hover === c.k ? " hovering" : ""}`}
                  d={c.d}
                  fill={d ? ramp(Math.sqrt(d.power / maxPower)) : undefined}
                  onMouseEnter={enter(d ? c.k : null)}
                  onClick={d ? () => onLocate(c.k) : undefined}
                  aria-label={d ? `${d.name}：第 ${d.rank} 位 · ${d.players} 人` : "暂无数据"}
                />
              );
            })}
          </g>
          {/* 南海诸岛九段线（我国标准地图口径，常显） */}
          <path className="wnine" d={GEO_NINE} />
          {/* 小国引线圆点（国土过小或 110m 未收录，保证可悬停可点击） */}
          {GEO_MINI.map((m) => {
            const d = byIso.get(m.k);
            return (
              <g
                key={m.k}
                className={`mini${hover === m.k ? " on" : ""}`}
                onMouseEnter={enter(d ? m.k : null)}
                onClick={d ? () => onLocate(m.k) : undefined}
              >
                <circle
                  cx={m.x}
                  cy={m.y}
                  r="2.2"
                  fill={d ? ramp(Math.sqrt(d.power / maxPower)) : "#302f28"}
                  stroke="rgba(248,248,242,.55)"
                  strokeWidth=".7"
                />
                <line x1={m.x} y1={m.y} x2={m.lx} y2={m.ly} />
                <text className="mlbl" x={m.lx + (m.side > 0 ? 3 : -3)} y={m.ly + 3} textAnchor={m.side > 0 ? "start" : "end"}>
                  {m.n}
                </text>
              </g>
            );
          })}
        </svg>
        <div className={`am_tip${hot ? " show" : ""}`} ref={tipRef}>
          {hot && (
            <>
              <div className="tp_head">
                <b>{hot.name}</b>
                <span>
                  综合排行第&nbsp;<em>{hot.rank}</em>&nbsp;位
                </span>
              </div>
              <div className="tp_row">
                <i>排行人数</i>
                <b>
                  {hot.players} <em className="unit">人</em>
                </b>
              </div>
              <div className="tp_row">
                <i>综合排行指数</i>
                <b className="gold">{areaPower(hot.power)}</b>
              </div>
              <div className="tp_row">
                <i>领军人物</i>
                <b>{hot.bestName}</b>
              </div>
              <div className="tp_row">
                <i>世界排名</i>
                <b>
                  No.<em>{hot.bestRank}</em>
                  <em className="unit">总计 {hot.bestSum}</em>
                </b>
              </div>
              <div className="tp_foot">点击在左侧定位该国领军人物 →</div>
            </>
          )}
        </div>
      </div>
      <div className="am_hint">
        <span className="am_hint_h">鼠标悬停查看国家详情 · </span>点击国家定位该国领军人物
      </div>
    </div>
  );
}
