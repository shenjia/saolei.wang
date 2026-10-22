// 首页右栏统计盒（移植 2008 版 Main/Satus.asp，原版标题「雷界统计」）
// 2026-09-27 张老师要求：数字亮灰加粗；今日有新数据时绿色显示增量（全站统一）。
// 2026-10-13 张老师要求：①增量不写「今日」二字；②增量单独占一列（三列：标签 | 数值 | 增量），
//   原先「数值（+N）」挤在一格，各行数值位数不同就对齐不了；③增量带括号且靠右边缘。
// 2026-10-13 二轮（张老师要求）：①行名统一为「动作」口径——录像总数→上传录像、
//   论坛主题→发布主题、评论总数→发布评论；②「发布评论」移到最底行（顺序见下）。
// 2026-10-13 三轮：标题「雷界统计」→「数据统计」（与 /video 右栏同标题）。
// 2026-10-22 张老师要求：行名回正——「发布主题」→「论坛主题」、「发布评论」→「论坛评论」
//   （数据源同步换 bbs_reply）；「上传录像」下新增一行「录像评论」（原 comment 表数据
//   各归各位）。行序：录像评论紧贴上传录像、论坛评论固定最底行。
// 排行人数无「今日」增量——user_scores.create_time 是注册时间非上榜时间，历史数据不干净。

import { getSiteStats } from "@/lib/queries";

function StatRow({ label, total, today }: { label: string; total: number; today?: number }) {
  const hasDelta = today !== undefined && today > 0;
  return (
    <tr>
      <td className="label">{label}</td>
      <td className="num">
        <em>{total}</em>
      </td>
      <td className="delta">{hasDelta ? `（+${today}）` : ""}</td>
    </tr>
  );
}

export async function SiteStats() {
  const s = await getSiteStats();
  return (
    <div id="site_stats" className="box">
      <h2>数据统计</h2>
      <table cellPadding={0} cellSpacing={0} className="table full">
        <tbody>
          <StatRow label="雷友总数" total={s.userTotal} today={s.userToday} />
          <StatRow label="排行人数" total={s.rankedTotal} />
          <StatRow label="上传录像" total={s.videoTotal} today={s.videoToday} />
          {/* 2026-10-22 张老师要求：新增「录像评论」（原「发布评论」的 comment 表数据归此处） */}
          <StatRow label="录像评论" total={s.commentTotal} today={s.commentToday} />
          <StatRow label="论坛主题" total={s.bbsTotal} today={s.bbsToday} />
          {/* 论坛评论固定在最底行（2026-10-13 张老师要求；2026-10-22 换数据源 bbs_reply） */}
          <StatRow label="论坛评论" total={s.bbsReplyTotal} today={s.bbsReplyToday} />
        </tbody>
      </table>
    </div>
  );
}
