"use client";

// 比赛纪录图表（2026-11-19 凌晨张老师定：严格复刻纪录页 RecordsCurves）——
// · 背景同 rec_card #1e1f1c（外层 .comp_chart 容器改色，本组件透明）
// · 金色 #fdc61a 折线 + 下方 13% 面积阴影；成绩标尺右侧（无标尺名）；
//   数据点不加白点（纯折线；hover 由透明竖条命中区承载，命中点显示金点高亮）
// · hover 气泡（rec_tip 同款 DOM/样式）：排名：第 N 位 / 成绩：xxx.xxx / 创造者（人名+性别+军衔）
// x 轴=排名（最右为 1），y 轴=成绩秒（越小越靠上）

import { useState } from "react";
import { AvatarCell, TitleBadge } from "@/components/Cells";

const W = 760;
const H = 210;
const PAD_L = 14;
const PAD_R = 56; // 右侧留标尺数字位
const PAD_T = 16;
const PAD_B = 30;

export interface CompChartPoint {
  rank: number; // 1 = 第一名
  score: number; // 成绩（秒，越小越好）
  name?: string;
  /** hover 气泡用（2026-11-19 凌晨定）：创造者展示信息 */
  uid?: number;
  englishName?: string;
  sex?: number;
  title?: string;
  classic?: { name: string; color: string } | null;
}

export function TourChart({ points }: { points: CompChartPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length === 0) return null;

  const maxRank = Math.max(...points.map((p) => p.rank), 2);
  const scores = points.map((p) => p.score);
  const sMin = Math.min(...scores);
  const sMax = Math.max(...scores);
  const sPad = Math.max((sMax - sMin) * 0.1, 1);
  const lo = sMin - sPad;
  const hi = sMax + sPad;

  const x = (rank: number) => PAD_L + ((maxRank - rank) / Math.max(maxRank - 1, 1)) * (W - PAD_L - PAD_R);
  const y = (score: number) => PAD_T + ((score - lo) / Math.max(hi - lo, 1e-9)) * (H - PAD_T - PAD_B);

  // y 标尺刻度：4 条均分（数字右侧，无轴名）
  const ticks = Array.from({ length: 4 }, (_, i) => lo + ((hi - lo) * i) / 3);
  // x 刻度：排名整档（最多 6 档）
  const rankTicks: number[] = [];
  const step = Math.max(1, Math.ceil(maxRank / 5));
  for (let r = maxRank; r >= 1; r -= step) rankTicks.push(r);
  if (rankTicks[rankTicks.length - 1] !== 1) rankTicks.push(1);

  const line = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.rank).toFixed(1)},${y(p.score).toFixed(1)}`)
    .join(" ");

  // 每点透明命中竖条（RecordsCurves 十三轮同款：命中交给浏览器 hit-test，零坐标换算）
  const bandW = (W - PAD_L - PAD_R) / Math.max(points.length - 1, 1);
  const hp = hover !== null ? points[hover] : null;
  // 气泡跟随 hover 点（rec_tip 是 position:absolute，需要本容器 relative 作定位基准；
  // left 按 SVG viewBox 坐标折算容器百分比，随点移动；右半区自动翻转到点左侧防溢出）
  const tipLeftPct = hp ? (x(hp.rank) / W) * 100 : 0;
  const flip = hp ? x(hp.rank) > W * 0.6 : false;

  return (
    <div className="comp_chart_plot" style={{ position: "relative" }}>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="comp_chart_svg" role="img" aria-label="比赛纪录图表">
        {ticks.map((t, i) => (
          <line key={`t${i}`} x1={PAD_L} y1={y(t)} x2={W - PAD_R} y2={y(t)} stroke="#49483e" strokeWidth="1" />
        ))}
        {/* 金色面积阴影 + 金色折线（数据点不加白点，纯折线） */}
        <path
          d={`${line} L${x(points[points.length - 1].rank)},${H - PAD_B} L${x(points[0].rank)},${H - PAD_B} Z`}
          fill="#fdc61a"
          fillOpacity="0.13"
        />
        <path d={line} fill="none" stroke="#fdc61a" strokeWidth="2" strokeLinejoin="round" />
        {/* 成绩标尺（右侧数字） */}
        {ticks.map((t, i) => (
          <text key={`r${i}`} x={W - PAD_R + 8} y={y(t) + 3} fontSize="10" fill="#75715e" textAnchor="start">
            {t.toFixed(0)}
          </text>
        ))}
        {rankTicks.map((r) => (
          <text key={`rk${r}`} x={x(r)} y={H - PAD_B + 14} fontSize="10" fill="#75715e" textAnchor="middle">
            {r}
          </text>
        ))}
        {/* hover 点高亮（金色实心，仅 hover 时出现） */}
        {hp && (
          <circle cx={x(hp.rank)} cy={y(hp.score)} r="4" fill="#fdc61a" stroke="#1e1f1c" strokeWidth="1.5" />
        )}
        {/* 透明命中竖条（鼠标交互） */}
        {points.map((p, i) => (
          <rect
            key={`h${i}`}
            x={x(p.rank) - bandW / 2}
            y={PAD_T}
            width={Math.max(bandW, 12)}
            height={H - PAD_T - PAD_B}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </svg>
      {/* hover 气泡（rec_tip 同款 DOM/样式：排名/成绩/创造者三行）——
          跟随 hover 点：left 按点在 viewBox 的百分比折算，右半区翻转到点左侧 */}
      {hp && (
        <div
          className="rec_tip"
          style={flip ? { right: `${100 - tipLeftPct + 2}%` } : { left: `${tipLeftPct + 2}%` }}
        >
          <div className="row">
            <span>排名</span>
            {/* 2026-11-19 凌晨张老师定：只有名次数字元帅金，「第/位」亮灰小字（rec_tip b 16px 过大） */}
            <b className="comp_tip_val">
              <span className="comp_tip_unit">第 </span>
              <span className="comp_tip_num">{hp.rank}</span>
              <span className="comp_tip_unit"> 位</span>
            </b>
          </div>
          <div className="row">
            <span>成绩</span>
            <b className="comp_tip_val">{hp.score.toFixed(3)}</b>
          </div>
          <div className="row">
            <span>创造者</span>
            <span className="who">
              {hp.uid ? (
                <>
                  <AvatarCell id={hp.uid} name={hp.name ?? ""} englishName={hp.englishName} sex={hp.sex ?? 1} link gender="small" />
                  <TitleBadge title={hp.title ?? ""} classic={hp.classic} />
                </>
              ) : (
                hp.name
              )}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
