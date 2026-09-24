// 实力雷达图：纯 SVG 实现，替代 2013 版的 Highcharts polar area
// 顶点标注等级（按原版配色），hover 顶点/标签时该维度高亮放大
"use client";

import { useState } from "react";
import type { RadarPoint } from "@/lib/radar";

// 移植 _radar.php 的 initScript 配色（+/- 后缀共用基础色）
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
// 半径略收（70→68），给外侧标签留出 hover 放大的余量
const RADIUS = 68;

// 网格环取等级百分位边界（GRADE_PERCENTS 升序）
const GRID_RINGS = [15, 35, 50, 60, 70, 80, 90, 100];

// 网格线颜色（2026-09-23 张老师反馈 #3e3d32 太暗，调亮）
const GRID_COLOR = "#565549";
const GRID_OUTER_COLOR = "#6a685c";

// 标签块中心到圆心的径向距离（等级 + 名称两行作为一个整体，避免相互重叠）
const LABEL_RADIUS = RADIUS + 20;

function gradeColor(grade: string): string {
  const base = grade.replace(/[+-]$/, "");
  return GRADE_COLORS[base] ?? UNKNOWN_COLOR;
}

// 坐标保留两位小数：Math.cos 在 Node(SSR) 与 Chrome(水合) 下末位浮点可能不同，
// 不一致的属性值会触发 React hydration mismatch 警告
const f = (v: number) => Math.round(v * 100) / 100;

function polar(index: number, total: number, r: number): [number, number] {
  const angle = (Math.PI * 2 * index) / total - Math.PI / 2;
  return [f(CENTER + r * Math.cos(angle)), f(CENTER + r * Math.sin(angle))];
}

// 顶点 i 的扇形热区：以该轴为中心、向两侧各偏半个步进角的楔块（覆盖到视口边缘）
function wedgePath(index: number, total: number): string {
  const step = (Math.PI * 2) / total;
  const a0 = (Math.PI * 2 * index) / total - Math.PI / 2 - step / 2;
  const a1 = a0 + step;
  const r = SIZE; // 超出视口部分会被裁掉，保证整个方形区域都被楔块铺满
  const [x0, y0] = [f(CENTER + r * Math.cos(a0)), f(CENTER + r * Math.sin(a0))];
  const [x1, y1] = [f(CENTER + r * Math.cos(a1)), f(CENTER + r * Math.sin(a1))];
  return `M ${CENTER} ${CENTER} L ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1} Z`;
}

function polygonPoints(n: number, r: number): string {
  return Array.from({ length: n }, (_, i) => polar(i, n, r).join(",")).join(" ");
}

export function RadarChart({ data }: { data: RadarPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const n = data.length;
  const points = data.map((d, i) => polar(i, n, (d.percent / 100) * RADIUS));

  return (
    <svg
      className="chart"
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      role="img"
      aria-label="实力雷达图"
    >
      {/* 网格环（八边形） */}
      {GRID_RINGS.map((p) => (
        <polygon
          key={p}
          points={polygonPoints(n, (p / 100) * RADIUS)}
          fill="none"
          stroke={p === 100 ? GRID_OUTER_COLOR : GRID_COLOR}
          strokeWidth={p === 100 ? 1.2 : 0.7}
        />
      ))}
      {/* 轴线 */}
      {data.map((_, i) => {
        const [x, y] = polar(i, n, RADIUS);
        return <line key={i} x1={CENTER} y1={CENTER} x2={x} y2={y} stroke={GRID_COLOR} strokeWidth={0.7} />;
      })}
      {/* 数据多边形 */}
      <polygon
        points={points.map((p) => p.join(",")).join(" ")}
        fill="rgba(102,217,239,0.18)"
        stroke="#66d9ef"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
      {/* 顶点：圆点 + 标签块（等级 + 维度名两行一体，hover 整体放大高亮） */}
      {data.map((d, i) => {
        const active = hover === i;
        const [x, y] = points[i];
        const [lx, ly] = polar(i, n, LABEL_RADIUS);
        return (
          <g
            key={i}
            style={{ cursor: "pointer" }}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          >
            <title>{`${d.name}：${d.score}`}</title>
            {/* 扇形热区：进入该维度对应角度范围即触发，不必精确对准点或标签 */}
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
  );
}
