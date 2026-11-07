"use client";

// 地区榜 · 交互式中国地图（2026-10-13 张老师需求）
// 位于排行表下方，按当前排序列给各省填色（开方归一：越高越亮、越低越灰暗；
// 战力指数=灰→金，活跃指数=深绿→亮绿，2026-11-02 张老师定）；悬停省份高亮 + 气泡（头部右侧当前榜名次 / 活跃人数 / 排行人数 /
// 本周练习·录像 / 战力·活跃指数 / 领军人物），点击跳转该地区排行。
// 2026-11-02 张老师要求：气泡加「本周练习」「本周录像」两行（初版叫 7 日，同日改本周口径）；头部名次 title 随
// 排序列在「战力排行第x位 / 活跃排行第x位」间切换；填色跟随当前排序列。
// 省界几何是静态数据（src/lib/area-map-geo.ts，由 scripts/build-area-map.py 生成）：
// 无第三方地图服务、无 Key、可离线；含台湾省与南海诸岛九段线（标准地图口径）。

import { useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useRouter } from "next/navigation";
import { buildUrl } from "@/components/Pager";
import { areaDisplay, TITLE_COLORS, type AreaOrder } from "@/lib/config";
import {
  GEO_INSET_ISLAND,
  GEO_INSET_NINE,
  GEO_MINI,
  GEO_PROVINCES,
  MAP_H,
  MAP_INSET,
  MAP_W,
} from "@/lib/area-map-geo";

// 填色配色（随当前排序列切换，开方归一线性插值：越高越亮、越低越灰暗）：
// 战力指数：#4B4A41（灰）→ #FDC61D（站点金）；活跃指数：#2F4A2B（深绿）→ #A6E22E（站点亮绿）
const RAMPS: Record<"power" | "activity", [number[], number[]]> = {
  power: [
    [0x4b, 0x4a, 0x41],
    [0xfd, 0xc6, 0x1d],
  ],
  activity: [
    [0x2f, 0x4a, 0x2b],
    [0xa6, 0xe2, 0x2e],
  ],
};

function ramp(t: number, mode: "power" | "activity"): string {
  const [c0, c1] = RAMPS[mode];
  const k = Math.max(0, Math.min(1, t));
  const c = c0.map((v, i) => Math.round(v + (c1[i] - v) * k));
  return `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function legendFor(mode: "power" | "activity"): string {
  return `linear-gradient(90deg,${Array.from({ length: 7 }, (_, i) => `${ramp(i / 6, mode)} ${Math.round((i / 6) * 100)}%`).join(",")})`;
}

export interface AreaMapDatum {
  /** 数据库原值（链接参数用它，显示走 areaDisplay） */
  area: string;
  /** 当前排序下的名次（与表格「排名」列一致） */
  rank: number;
  players: number;
  active: number;
  power: number;
  /** 活跃指数（area_activity 落盘表，2026-11-02） */
  activity: number;
  /** 近 7 日练习完成盘数（落盘表快照；2026-11-06 张老师定改按完成口径——尝试可刷、完成要努力） */
  wins7d: number;
  /** 近 7 日上传录像数（落盘表快照） */
  videos7d: number;
  bestName: string;
  /** 领军人物的军衔（按高级时间评定，服务端算好传入） */
  title: string;
}

export function AreaMap({
  data,
  order,
  hover,
  onHover,
}: {
  data: AreaMapDatum[];
  /** 当前榜序（气泡 title 切换 + 填色指标跟随排序列） */
  order: AreaOrder;
  hover: string | null;
  onHover: (area: string | null) => void;
}) {
  const router = useRouter();
  const stageRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  // 气泡只由地图自身的悬停驱动（表格行悬停只高亮省份，不在鼠标旧位置弹气泡）
  const [tipArea, setTipArea] = useState<string | null>(null);

  const byActivity = order === "activity";
  // 填色模式：活跃指数榜=深绿→亮绿，其余（战力指数）=灰→站点金
  const fillMode: "power" | "activity" = byActivity ? "activity" : "power";
  const legend = legendFor(fillMode);
  const metric = (d: AreaMapDatum) => (byActivity ? d.activity : d.power);
  const maxMetric = data.reduce((m, d) => Math.max(m, metric(d)), 0) || 1;
  const byName = new Map(data.map((d) => [d.area, d]));
  const hot = tipArea ? byName.get(tipArea) : undefined;

  /** 地图内悬停：同时驱动高亮（外传）与气泡（内部） */
  const enter = (area: string | null) => () => {
    onHover(area);
    setTipArea(area);
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

  const go = (area: string) => () => router.push(buildUrl("/area", { name: area }));

  return (
    <div className="area_map">
      <div className="am_head">
        <div className="am_title">地图</div>
        {/* 图例（2026-10-15 张老师要求）：去掉「综合排行指数」名称，低/高改弱/强 */}
        <div className="am_legend">
          <span>弱</span>
          <span className="lg_bar" style={{ background: legend }}></span>
          <span>强</span>
        </div>
      </div>
      <div
        className="am_stage"
        ref={stageRef}
        onMouseMove={move}
        onMouseLeave={() => {
          onHover(null);
          setTipArea(null);
        }}
      >
        <svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} className="am_svg" role="img" aria-label="中国地区排行地图">
          {/* 空白底：鼠标移到无数据区域时收起气泡 */}
          <rect className="am_bg" x="0" y="0" width={MAP_W} height={MAP_H} onMouseEnter={enter(null)} />
          <g>
            {GEO_PROVINCES.map((p) => {
              const d = byName.get(p.n);
              return (
                <path
                  key={p.n}
                  className={`prov${d ? "" : " nodata"}${hover === p.n ? " hovering" : ""}`}
                  d={p.d}
                  fill={d ? ramp(Math.sqrt(metric(d) / maxMetric), fillMode) : undefined}
                  onMouseEnter={enter(d ? p.n : null)}
                  onClick={d ? go(p.n) : undefined}
                  aria-label={`${areaDisplay(p.n)}${d ? `：第 ${d.rank} 位 · ${d.players} 人` : "：暂无成绩数据"}`}
                />
              );
            })}
          </g>
          {/* 港澳图形过小，补圆点 + 引线保证可发现、可悬停、可点击 */}
          {GEO_MINI.map((m) => {
            const d = byName.get(m.n);
            return (
              <g
                key={m.n}
                className={`mini${hover === m.n ? " on" : ""}`}
                onMouseEnter={enter(d ? m.n : null)}
                onClick={d ? go(m.n) : undefined}
              >
                <circle
                  cx={m.x}
                  cy={m.y}
                  r="2.2"
                  fill={d ? ramp(Math.sqrt(metric(d) / maxMetric), fillMode) : "#302f28"}
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
          {/* 南海诸岛附图（标准地图样式，含九段线） */}
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
                <span>
                  {byActivity ? (
                    <>活跃排行第&nbsp;<em>{hot.rank}</em>&nbsp;位</>
                  ) : (
                    <>战力排行第&nbsp;<em>{hot.rank}</em>&nbsp;位</>
                  )}
                </span>
              </div>
              {/* 2026-11-07 张老师要求：活跃指数提到气泡第一行（活跃人数上面） */}
              <div className="tp_row">
                <i>活跃指数</i>
                <b className="green">
                  {hot.activity} <em className="unit">点</em>
                </b>
              </div>
              <div className="tp_row">
                <i>活跃人数</i>
                <b className="green">
                  {hot.active} <em className="unit">人</em>
                </b>
              </div>
              <div className="tp_row">
                <i>本周练习</i>
                <b>
                  {hot.wins7d} <em className="unit">盘</em>
                </b>
              </div>
              <div className="tp_row">
                <i>本周录像</i>
                <b>
                  {hot.videos7d} <em className="unit">条</em>
                </b>
              </div>
              <div className="tp_row">
                <i>排行人数</i>
                <b>
                  {hot.players} <em className="unit">人</em>
                </b>
              </div>
              <div className="tp_row">
                <i>战力指数</i>
                <b className="gold">
                  {hot.power >= 10000 ? (hot.power / 10000).toFixed(1) : hot.power}
                  {hot.power >= 10000 && <em className="unit">万</em>}
                </b>
              </div>
              <div className="tp_row">
                <i>领军人物</i>
                <b>
                  {hot.bestName}
                  <em style={{ color: TITLE_COLORS[hot.title] ?? "#b1b1a4" }}>{hot.title}</em>
                </b>
              </div>
              <div className="tp_foot">点击查看{areaDisplay(hot.area)}排行 →</div>
            </>
          )}
        </div>
      </div>
      <div className="am_hint">
        <span className="am_hint_h">鼠标悬停查看地区详情 · </span>点击省份查看该地区排行
      </div>
    </div>
  );
}
