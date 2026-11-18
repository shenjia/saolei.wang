// 比赛纪录图表（x 轴=排名，最右为 1；y 轴=成绩，秒越小越靠上）
// 本期成绩采集未接入：points 为空时由页面渲染占位文案；组件留好数据口子，
// 下一期把「比赛成绩」按排名散点传进来即可渲染折线。

const W = 760;
const H = 210;
const PAD_L = 50;
const PAD_R = 30;
const PAD_T = 24;
const PAD_B = 40;

export interface CompChartPoint {
  rank: number; // 1 = 第一名
  score: number; // 成绩（秒，越小越好）
  name?: string;
}

export function CompChart({ points }: { points: CompChartPoint[] }) {
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

  // y 轴刻度：5 条均分
  const ticks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4);
  // x 轴刻度：排名取整档（最多 6 档）
  const rankTicks: number[] = [];
  const step = Math.max(1, Math.ceil(maxRank / 5));
  for (let r = maxRank; r >= 1; r -= step) rankTicks.push(r);
  if (rankTicks[rankTicks.length - 1] !== 1) rankTicks.push(1);

  const poly = points.map((p) => `${x(p.rank).toFixed(1)},${y(p.score).toFixed(1)}`).join(" ");

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="comp_chart_svg" role="img" aria-label="比赛纪录图表">
      <text x="8" y="16" fontSize="10" fill="#75715e">
        成绩(秒)
      </text>
      {ticks.map((t, i) => (
        <g key={`t${i}`}>
          <line x1={PAD_L} y1={y(t)} x2={W - PAD_R} y2={y(t)} stroke="#49483e" strokeWidth="1" />
          <text x={PAD_L - 6} y={y(t) + 3} fontSize="10" fill="#75715e" textAnchor="end">
            {t.toFixed(0)}
          </text>
        </g>
      ))}
      <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={H - PAD_B} stroke="#49483e" strokeWidth="1" />
      {rankTicks.map((r) => (
        <text key={`r${r}`} x={x(r)} y={H - PAD_B + 14} fontSize="10" fill="#75715e" textAnchor="middle">
          {r}
        </text>
      ))}
      <text x={W - PAD_R + 4} y={H - PAD_B + 14} fontSize="10" fill="#75715e" textAnchor="start">
        排名
      </text>
      <polyline points={poly} fill="none" stroke="#a6e22e" strokeWidth="2" />
      {points.map((p, i) => (
        <circle key={`p${i}`} cx={x(p.rank)} cy={y(p.score)} r="3" fill={p.rank === 1 ? "#fdc61a" : "#a6e22e"}>
          {p.name ? <title>{`${p.name} · 第${p.rank}名 · ${p.score}s`}</title> : null}
        </circle>
      ))}
    </svg>
  );
}
