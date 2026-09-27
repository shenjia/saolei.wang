// 录像统计（/video 右栏，2026-09-26 张老师要求）：
// 共有多少录像 + 本日/本周/本月新增，样式沿用首页「雷界统计」盒。

import type { VideoBoxStats } from "@/lib/queries";

export function VideoStats({ stats }: { stats: VideoBoxStats }) {
  return (
    <div id="video_stats" className="box">
      <h2>统计</h2>
      <table cellPadding={0} cellSpacing={0} className="table full">
        <tbody>
          <tr>
            <td>录像总数</td>
            <td className="num">
              <em>{stats.total}</em>
            </td>
          </tr>
          <tr>
            <td>本日新增</td>
            <td className="num">
              <em>{stats.today}</em>
            </td>
          </tr>
          <tr>
            <td>本周新增</td>
            <td className="num">
              <em>{stats.week}</em>
            </td>
          </tr>
          <tr>
            <td>本月新增</td>
            <td className="num">
              <em>{stats.month}</em>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
