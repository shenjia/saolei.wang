// 比赛纪录图表（2026-11-18 晚张老师定：复刻纪录页 RecordsCurves 样式）——
// 金色 #fdc61a 折线 + 下方阴影（fillOpacity 0.13 面积），成绩标尺放右侧（无标尺名），
// 去掉左轴与「成绩(秒)/排名」文字标签；x 轴=排名（最右为 1），y 轴=成绩秒（越小越靠上）。
// 上方「最好成绩：xxx.xxx 姓名 军衔 创造于 xxx-xx-xx xx:xx」由 TourBlock 渲染（非本组件）。

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
}

export function TourChart({ points }: { points: CompChartPoint[] }) {
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

  // y 标尺刻度：4 条均分（数字在右侧，无轴名）
  const ticks = Array.from({ length: 4 }, (_, i) => lo + ((hi - lo) * i) / 3);
  // x 刻度：排名取整档（最多 6 档）
  const rankTicks: number[] = [];
  const step = Math.max(1, Math.ceil(maxRank / 5));
  for (let r = maxRank; r >= 1; r -= step) rankTicks.push(r);
  if (rankTicks[rankTicks.length - 1] !== 1) rankTicks.push(1);

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.rank).toFixed(1)},${y(p.score).toFixed(1)}`).join(" ");

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="comp_chart_svg" role="img" aria-label="比赛纪录图表">
      {/* 横向网格线（无文字） */}
      {ticks.map((t, i) => (
        <line key={`t${i}`} x1={PAD_L} y1={y(t)} x2={W - PAD_R} y2={y(t)} stroke="#49483e" strokeWidth="1" />
      ))}
      {/* 金色面积阴影（复刻 RecordsCurves fillOpacity 0.13）+ 金色折线 */}
      <path
        d={`${line} L${x(points[points.length - 1].rank)},${H - PAD_B} L${x(points[0].rank)},${H - PAD_B} Z`}
        fill="#fdc61a"
        fillOpacity="0.13"
      />
      <path d={line} fill="none" stroke="#fdc61a" strokeWidth="2" strokeLinejoin="round" />
      {/* 成绩标尺（右侧数字，无标尺名） */}
      {ticks.map((t, i) => (
        <text key={`r${i}`} x={W - PAD_R + 8} y={y(t) + 3} fontSize="10" fill="#75715e" textAnchor="start">
          {t.toFixed(0)}
        </text>
      ))}
      {/* 排名刻度（底部数字） */}
      {rankTicks.map((r) => (
        <text key={`rk${r}`} x={x(r)} y={H - PAD_B + 14} fontSize="10" fill="#75715e" textAnchor="middle">
          {r}
        </text>
      ))}
      {points.map((p, i) => (
        <circle key={`p${i}`} cx={x(p.rank)} cy={y(p.score)} r="3" fill={p.rank === 1 ? "#fdc61a" : "#e8e6d9"}>
          {p.name ? <title>{`${p.name} · 第${p.rank}名 · ${p.score}s`}</title> : null}
        </circle>
      ))}
    </svg>
  );
}
