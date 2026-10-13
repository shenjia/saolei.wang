// 录像统计（/video 右栏，2026-09-26 张老师要求）：
// 共有多少录像 + 今日新增，样式与首页「雷界统计」盒完全统一。
// 2026-10-13 张老师要求：①标题「统计」→「数据统计」；②增初级/中级/高级录像细分行
//   （口径与总数一致＝仅已通过）；③去掉「本日/本周/本月新增」三行，改为在四行右侧
//   统一挂「今日新增」增量列——绿色括号「（+N）」，无新增不显示，排版同首页；
//   ④三轮：末行增「评论总数」（口径同首页「发布评论」，增量按评论发布时间）。

import type { VideoBoxStats } from "@/lib/queries";

/** 数值行：标签 | 数值（亮灰加粗）| 今日增量（绿色「（+N）」，0 时留空） */
function StatRow({ label, value, today }: { label: string; value: number; today: number }) {
  const hasDelta = today > 0;
  return (
    <tr>
      <td className="label">{label}</td>
      <td className="num">
        <em>{value}</em>
      </td>
      <td className="delta">{hasDelta ? `（+${today}）` : ""}</td>
    </tr>
  );
}

export function VideoStats({ stats }: { stats: VideoBoxStats }) {
  return (
    <div id="video_stats" className="box">
      <h2>数据统计</h2>
      <table cellPadding={0} cellSpacing={0} className="table full">
        <tbody>
          <StatRow label="初级录像" value={stats.beg} today={stats.begToday} />
          <StatRow label="中级录像" value={stats.int} today={stats.intToday} />
          <StatRow label="高级录像" value={stats.exp} today={stats.expToday} />
          <StatRow label="录像总数" value={stats.total} today={stats.totalToday} />
          <StatRow label="评论总数" value={stats.commentTotal} today={stats.commentToday} />
        </tbody>
      </table>
    </div>
  );
}
