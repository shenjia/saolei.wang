// 雷界统计（移植 2008 版 Main/Satus.asp）：首页右栏统计盒
// 2026-09-27 张老师要求：数字亮灰加粗；今日有新数据时右侧绿色显示「今日 +N」（全站统一）；
// 新增「论坛主题」行（口径同论坛列表页：status=0）。
// 排行人数无「今日」增量——user_scores.create_time 是注册时间非上榜时间，历史数据不干净。

import { getSiteStats } from "@/lib/queries";

function StatCell({ total, today }: { total: number; today?: number }) {
  return (
    <td className="num">
      <em>{total}</em>
      {today !== undefined && today > 0 && <span className="stat_today">（今日 +{today}）</span>}
    </td>
  );
}

export async function SiteStats() {
  const s = await getSiteStats();
  return (
    <div id="site_stats" className="box">
      <h2>雷界统计</h2>
      <table cellPadding={0} cellSpacing={0} className="table full">
        <tbody>
          <tr>
            <td>雷友总数</td>
            <StatCell total={s.userTotal} today={s.userToday} />
          </tr>
          <tr>
            <td>排行人数</td>
            <StatCell total={s.rankedTotal} />
          </tr>
          <tr>
            <td>录像总数</td>
            <StatCell total={s.videoTotal} today={s.videoToday} />
          </tr>
          <tr>
            <td>评论总数</td>
            <StatCell total={s.commentTotal} today={s.commentToday} />
          </tr>
          <tr>
            <td>论坛主题</td>
            <StatCell total={s.bbsTotal} today={s.bbsToday} />
          </tr>
        </tbody>
      </table>
    </div>
  );
}
