// 录像详情页「录像分析」雷达图：本局五维表现（综合 / 速度 / 效率 / 精准 / 手速）
// 视觉沿用侧栏「实力」雷达（RadarChart.tsx）：222 视口 / 68 半径 / 8 环网格 / 等级配色，
// 只是数据从「长期实力 8 维」换成「单局表现 5 维」，并把明细挪进 hover 气泡。
//
// 轴数是跟着 data.length 走的（n 自适应），加减轴只改 lib/videoradar.ts 的 AXIS_METRICS。
// 2026-10-14 张老师定：去掉「移动」轴（不重要），五围足够；
// 综合 = 其余四轴在「级别 × 模式」组内百分位的加权平均（不再用 STNB）。
//
// ⚠️ 气泡是 HTML 绝对定位 div，不能用 data-tip 的 ::after 方案：
//    SVG 内部元素不支持 CSS 伪元素（content: attr() 取不到），这是 2026-10-14 实现时确认的约束。
// 气泡形态（2026-10-14 张老师定）：锚在标签名下方、只显示一行（数值＋超过 xx% 的玩家，
// 满分显示「全网第一」，口径与「实力」雷达气泡统一）、字号与标签名一致；
// 宽度随内容变化，先隐藏渲染 → 实测宽后钳位定位再显示。
"use client";

import { useEffect, useRef, useState } from "react";
import type { VideoAnalysisPoint } from "@/lib/videoanalysis";
// 等级配色与「实力」雷达（RadarChart.tsx）同源：统一在 lib/videoscore.ts 维护，勿单独改
import { gradeColor } from "@/lib/videoscore";

const SIZE = 222;
const CENTER = SIZE / 2;
const RADIUS = 68;
const GRID_RINGS = [15, 35, 50, 60, 70, 80, 90, 100];
const GRID_COLOR = "#565549";
const GRID_OUTER_COLOR = "#6a685c";
const LABEL_RADIUS = RADIUS + 20;

// 标签字号（2026-10-14 张老师要求加大，13/8 → 15/10；与 RadarChart.tsx 同源勿单独改）
const LABEL_GRADE_FS = 15;
const LABEL_NAME_FS = 10;
// 轴名基线相对等级基线的下移量（≈ 等级字号，视觉行距与旧版 13/13 一致）
const LABEL_NAME_DY = 15;

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
  // 气泡定位：宽度随内容变化，挂载时先隐藏 → effect 实测气泡/容器宽后写入 left/top 并显示。
  // 用 key={hover} 让每次换轴都重新走一遍「隐藏→定位→显示」，避免换轴瞬间闪现在旧位置。
  // 直接写 DOM 而非 setState：定位是纯外部系统同步（react-hooks/set-state-in-effect）
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (hover === null) return;
    const wrap = wrapRef.current;
    const tip = tipRef.current;
    if (!wrap || !tip) return;
    const w = wrap.clientWidth; // 定位父级与 SVG 等宽同起点（出血 margin 挪在 .vr_wrap 上的原因）
    const [lx, ly] = polar(hover, data.length, LABEL_RADIUS);
    // 气泡顶 = 轴名基线下方 4px；左右按实测宽钳位不出容器
    tip.style.top = `${((ly + LABEL_NAME_DY + 4) / SIZE) * w}px`;
    tip.style.left = `${Math.min(Math.max((lx / SIZE) * w, tip.offsetWidth / 2 + 2), w - tip.offsetWidth / 2 - 2)}px`;
    tip.style.visibility = "visible";
  }, [hover, data.length]);

  const n = data.length;
  const points = data.map((d, i) => polar(i, n, (d.percent / 100) * RADIUS));
  const tip = hover === null ? null : data[hover];

  return (
    <div className="vr_wrap" ref={wrapRef}>
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
                y={ly - 3}
                textAnchor="middle"
                style={{
                  transformBox: "fill-box",
                  transformOrigin: "center",
                  transform: active ? "scale(1.25)" : "none",
                  transition: "transform .15s ease",
                }}
              >
                <tspan fill={gradeColor(d.grade)} fontSize={LABEL_GRADE_FS} fontWeight="bold">
                  {d.grade}
                </tspan>
                <tspan x={lx} dy={LABEL_NAME_DY} fill={active ? "#a6e22e" : "#8a8878"} fontSize={LABEL_NAME_FS}>
                  {d.name}
                </tspan>
              </text>
            </g>
          );
        })}
      </svg>
      {tip && (
        <div
          key={hover}
          ref={tipRef}
          className="vr_tip"
          style={{ visibility: "hidden" }}
        >
          {/* 2026-10-14 张老师定：与「实力」雷达气泡统一口径用「超过」；满分显示「全网第一」 */}
          {tip.percent >= 100 ? (
            "全网第一"
          ) : (
            <>
              {tip.disp}，超过 <em>{tip.percent}%</em> 的玩家
            </>
          )}
        </div>
      )}
    </div>
  );
}
