// 实力雷达图：纯 SVG 实现，替代 2013 版的 Highcharts polar area
// 顶点标注等级（按原版配色），hover 顶点/标签时该维度高亮放大，
// 并在标签处弹「超过 xx% 的玩家」气泡（2026-10-14 张老师要求，视觉与录像分析 vr_tip 同款）。
// ⚠️ 2026-10-15 气泡改用 beatPct（真实排位百分位）：percent 是等级档位插值
//    （A 档恒 69~79% 区间），只作绘图半径——档位值配上「超过 xx% 的玩家」文案
//    会把全国前 30 名显示成 79%，逻辑漏洞已修。
// ⚠️ 气泡是 HTML 绝对定位 div：SVG 内部元素不支持 CSS 伪元素（同 VideoAnalysis 的约束），
//    出血尺寸因此挪到 .radar_tip_wrap 上（globals.css），svg 本体 width:100%。
"use client";

import { useState } from "react";
import type { RadarPoint } from "@/lib/radar";
// 等级配色（移植 _radar.php 的 initScript，+/- 后缀共用基础色）：
// 与录像分析 VideoAnalysis.tsx、在线玩 OnlinePlay.tsx 同一份，统一在 lib/videoscore.ts 维护
import { gradeColor } from "@/lib/videoscore";

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

// 标签字号（2026-10-14 张老师要求加大，13/8 → 15/10；与 VideoAnalysis.tsx 同源勿单独改）
// 名称 10px 时左右水平轴标签恰好贴住 222 视口边缘（hover 放大后出血 ~7px），配套 .chart overflow:visible
const LABEL_GRADE_FS = 15;
const LABEL_NAME_FS = 10;
// 轴名基线相对等级基线的下移量（≈ 等级字号，视觉行距与旧版 13/13 一致）
const LABEL_NAME_DY = 15;

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
  const tip = hover === null ? null : data[hover];
  // 气泡定位：锚在外侧标签（等级+维度名两行整体），**恒在标签下方**（2026-10-14 张老师定：
  // 所有气泡固定在标签下面，不再翻上方；底部标签气泡会略出盒，见 globals.css 说明）。
  // 横向与标签中心严格居中对齐（张老师要求）。锚点=标签，与录像分析 vr_tip 恒下方形态一致。
  const tipStyle =
    hover === null
      ? undefined
      : (() => {
          const [lx, ly] = polar(hover, n, LABEL_RADIUS);
          return {
            left: `${(lx / SIZE) * 100}%`,
            top: `${(ly / SIZE) * 100}%`,
            transform: "translate(-50%, 24px)",
          } as const;
        })();

  return (
    <div className="radar_tip_wrap">
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
            {/* 原生 <title> 已删（2026-10-14）：hover 信息改由气泡承担，避免双重提示 */}
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
        <div className="radar_tip" style={tipStyle}>
          {tip.grade === "?" ? (
            "暂无成绩"
          ) : tip.beatPct >= 100 ? (
            // 2026-10-15 张老师定：「全网第一」整条金色（.tip_first，globals.css，与 vr_tip 统一）；
            // 判定用真实排位（beatPct：无人更优），非绘图用的档位插值 percent
            <span className="tip_first">全网第一</span>
          ) : (
            <>
              超过 <em>{tip.beatPct}%</em> 的玩家
            </>
          )}
        </div>
      )}
    </div>
  );
}
