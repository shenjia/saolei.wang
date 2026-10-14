// 录像详情页「录像分析」雷达图：本局六维表现（综合 / 速度 / 效率 / 精准 / 手速 / 移动）
// 视觉沿用侧栏「实力」雷达（RadarChart.tsx）：222 视口 / 68 半径 / 8 环网格 / 等级配色，
// 只是数据从「长期实力 8 维」换成「单局表现 6 维」，并把明细挪进 hover 气泡。
//
// ⚠️ 气泡是 HTML 绝对定位 div，不能用 data-tip 的 ::after 方案：
//    SVG 内部元素不支持 CSS 伪元素（content: attr() 取不到），这是 2026-10-14 实现时确认的约束。
"use client";

import { useState } from "react";
import type { VideoAnalysisPoint } from "@/lib/videoanalysis";

// 等级配色（与 RadarChart.tsx 同源，勿单独维护）
const GRADE_COLORS: Record<string, string> = {
  SSS: "#E6DB74",
  SS: "#E6DB74",
  S: "#E6DB74",
  A: "#ff0080",
  B: "#df00a6",
  C: "#bf00cc",
  D: "#a000e5",
  E: "#8000ff",
  F: "#6600cc",
};
const UNKNOWN_COLOR = "#636359";

const SIZE = 222;
const CENTER = SIZE / 2;
const RADIUS = 68;
const GRID_RINGS = [15, 35, 50, 60, 70, 80, 90, 100];
const GRID_COLOR = "#565549";
const GRID_OUTER_COLOR = "#6a685c";
const LABEL_RADIUS = RADIUS + 20;

function gradeColor(grade: string): string {
  return GRADE_COLORS[grade.replace(/[+-]$/, "")] ?? UNKNOWN_COLOR;
}

// 坐标保留两位：Node(SSR) 与 Chrome(水合) 的三角函数末位可能不同，不一致会触发 hydration mismatch
const f = (v: number) => Math.round(v * 100) / 100;

function polar(index: number, total: number, r: number): [number, number] {
  const angle = (Math.PI * 2 * index) / total - Math.PI / 2;
  return [f(CENTER + r * Math.cos(angle)), f(CENTER + r * Math.sin(angle))];
}

// 顶点 i 的扇形热区：覆盖整个视口的楔块，进入该角度范围即 hover
function wedgePath(index: number, total: number): string {
  const step = (Math.PI * 2) / total;
  const a0 = (Math.PI * 2 * index) / total - Math.PI / 2 - step / 2;
  const a1 = a0 + step;
  const r = SIZE;
  const x0 = f(CENTER + r * Math.cos(a0));
  const y0 = f(CENTER + r * Math.sin(a0));
  const x1 = f(CENTER + r * Math.cos(a1));
  const y1 = f(CENTER + r * Math.sin(a1));
  return `M ${CENTER} ${CENTER} L ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1} Z`;
}

function polygonPoints(n: number, r: number): string {
  return Array.from({ length: n }, (_, i) => polar(i, n, r).join(",")).join(" ");
}

export function VideoAnalysisRadar({ data }: { data: VideoAnalysisPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const n = data.length;
  const points = data.map((d, i) => polar(i, n, (d.percent / 100) * RADIUS));
  const tip = hover === null ? null : data[hover];
  // 气泡定位：跟随顶点，靠上自动翻到下方（222 视口 → 百分比换算），横向钳位避免出盒
  const tipStyle =
    hover === null
      ? undefined
      : (() => {
          const [x, y] = points[hover];
          const below = y < SIZE * 0.45; // 顶点在上半区 → 气泡放下方
          return {
            left: `${Math.min(Math.max((x / SIZE) * 100, 26), 74)}%`,
            top: `${(y / SIZE) * 100}%`,
            transform: below ? "translate(-50%, 14px)" : "translate(-50%, calc(-100% - 14px))",
          } as const;
        })();

  return (
    <div className="vr_wrap">
      <svg
        className="chart"
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="img"
        aria-label="录像分析雷达图"
      >
        {GRID_RINGS.map((p) => (
          <polygon
            key={p}
            points={polygonPoints(n, (p / 100) * RADIUS)}
            fill="none"
            stroke={p === 100 ? GRID_OUTER_COLOR : GRID_COLOR}
            strokeWidth={p === 100 ? 1.2 : 0.7}
          />
        ))}
        {data.map((_, i) => {
          const [x, y] = polar(i, n, RADIUS);
          return <line key={i} x1={CENTER} y1={CENTER} x2={x} y2={y} stroke={GRID_COLOR} strokeWidth={0.7} />;
        })}
        <polygon
          points={points.map((p) => p.join(",")).join(" ")}
          fill="rgba(102,217,239,0.18)"
          stroke="#66d9ef"
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
        {data.map((d, i) => {
          const active = hover === i;
          const [x, y] = points[i];
          const [lx, ly] = polar(i, n, LABEL_RADIUS);
          return (
            <g
              key={d.key}
              style={{ cursor: "pointer" }}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              <path d={wedgePath(i, n)} fill="transparent" pointerEvents="all" />
              <circle
                cx={x}
                cy={y}
                r={active ? 4 : 2.5}
                fill={active ? "#9cecff" : "#66d9ef"}
                style={{
                  transition: "r .15s ease, fill .15s ease",
                  filter: active ? "drop-shadow(0 0 4px #66d9ef)" : undefined,
                }}
              />
              <text
                x={lx}
                y={ly - 2}
                textAnchor="middle"
                style={{
                  transformBox: "fill-box",
                  transformOrigin: "center",
                  transform: active ? "scale(1.25)" : "none",
                  transition: "transform .15s ease",
                }}
              >
                <tspan fill={gradeColor(d.grade)} fontSize={13} fontWeight="bold">
                  {d.grade}
                </tspan>
                <tspan x={lx} dy={13} fill={active ? "#a6e22e" : "#8a8878"} fontSize={8}>
                  {d.name}
                </tspan>
              </text>
            </g>
          );
        })}
      </svg>
      {tip && (
        <div className="vr_tip" style={tipStyle}>
          <p className="vr_tip_grade" style={{ color: gradeColor(tip.grade) }}>
            {tip.grade}
            <span>{tip.name}</span>
          </p>
          <p className="vr_tip_val">{tip.disp}</p>
          <p className="vr_tip_pct">
            超越 <em>{tip.percent}%</em> 的玩家
          </p>
        </div>
      )}
    </div>
  );
}
