// 首页「今日练习」板块（2026-10-22 张老师要求）：加在「开始练习」按钮上方。
// 文案「今日已练习 xxx/yyy 局」（xxx=我的局数，绿色；yyy=全站局数）+
// 灰色小字「xx位雷友参与」；下缘 30 天走势迷你折线铺满整个模块宽度。
// 纯服务端展示件（无交互），走势折线复用后台 Sparkline 的同款纯 SVG 实现。
// 桌面侧栏与移动端置顶按钮各渲染一份（id 前缀区分，断点显隐与 #review_entry 同款）。

const GREEN = "#a6e22e"; // 站内标准绿（.logo a h1 hover / Sparkline 默认色）

/** 零依赖迷你折线（后台 admin/Charts Sparkline 同款算法，服务端直出） */
function Line({ values, color, height }: { values: number[]; color: string; height: number }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const step = 100 / (values.length - 1); // viewBox 横向铺满 0-100
  const d = values
    .map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(2)},${(height - (v / max) * (height - 3) - 1.5).toFixed(2)}`)
    .join(" ");
  return (
    <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" style={{ display: "block", width: "100%", height }} aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeOpacity="0.85" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function PracticeToday({
  prefix,
  mine,
  total,
  users,
  trend,
}: {
  /** DOM id 前缀：桌面侧栏 "practice_today" / 移动端 "practice_today_top" */
  prefix: string;
  mine: number;
  total: number;
  users: number;
  trend: number[];
}) {
  return (
    <div id={prefix} className="practice_today">
      <p className="pt_line">
        今日已练习{" "}
        <b className="mine">{mine}</b>
        <span className="sep">/</span>
        <b className="total">{total.toLocaleString("zh-CN")}</b> 局
      </p>
      <p className="pt_sub">{users}位雷友参与</p>
      <div className="pt_chart">
        <Line values={trend} color={GREEN} height={38} />
      </div>
    </div>
  );
}
