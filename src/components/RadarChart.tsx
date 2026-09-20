// 实力雷达图：纯 SVG 实现，替代 2013 版的 Highcharts polar area
// 顶点标注等级（按原版配色），hover 显示维度名与成绩

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
const RADIUS = 70;

// 网格环取等级百分位边界（GRADE_PERCENTS 升序）
const GRID_RINGS = [15, 35, 50, 60, 70, 80, 90, 100];

function gradeColor(grade: string): string {
  const base = grade.replace(/[+-]$/, "");
  return GRADE_COLORS[base] ?? UNKNOWN_COLOR;
}

function polar(index: number, total: number, r: number): [number, number] {
  const angle = (Math.PI * 2 * index) / total - Math.PI / 2;
  return [CENTER + r * Math.cos(angle), CENTER + r * Math.sin(angle)];
}

function polygonPoints(n: number, r: number): string {
  return Array.from({ length: n }, (_, i) => polar(i, n, r).join(",")).join(" ");
}

export function RadarChart({ data }: { data: RadarPoint[] }) {
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
          stroke="#3e3d32"
          strokeWidth={p === 100 ? 1.2 : 0.6}
        />
      ))}
      {/* 轴线 */}
      {data.map((_, i) => {
        const [x, y] = polar(i, n, RADIUS);
        return <line key={i} x1={CENTER} y1={CENTER} x2={x} y2={y} stroke="#3e3d32" strokeWidth={0.6} />;
      })}
      {/* 数据多边形 */}
      <polygon
        points={points.map((p) => p.join(",")).join(" ")}
        fill="rgba(102,217,239,0.18)"
        stroke="#66d9ef"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
      {/* 顶点：圆点 + 等级 + 维度名 */}
      {data.map((d, i) => {
        const [x, y] = points[i];
        const [gx, gy] = polar(i, n, RADIUS + 16);
        const [nx, ny] = polar(i, n, RADIUS + 27);
        return (
          <g key={i}>
            <title>{`${d.name}：${d.score}`}</title>
            <circle cx={x} cy={y} r={2.5} fill="#66d9ef" />
            <text
              x={gx}
              y={gy}
              textAnchor="middle"
              dominantBaseline="middle"
              fill={gradeColor(d.grade)}
              fontSize={11}
              fontWeight="bold"
            >
              {d.grade}
            </text>
            <text
              x={nx}
              y={ny}
              textAnchor="middle"
              dominantBaseline="middle"
              fill="#75715e"
              fontSize={8}
            >
              {d.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
