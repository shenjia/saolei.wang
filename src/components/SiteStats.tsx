// 雷界统计（移植 2008 版 Main/Satus.asp）：首页右栏统计盒

import { getSiteStats } from "@/lib/queries";
import { scoreTime } from "@/lib/format";

export async function SiteStats() {
  const s = await getSiteStats();
  return (
    <div id="site_stats" className="box">
      <h2>雷界统计</h2>
      <table cellPadding={0} cellSpacing={0} className="table full">
        <tbody>
          <tr>
            <td>雷友总数</td>
            <td className="num">
              <em>{s.userTotal}</em>
            </td>
          </tr>
          <tr>
            <td>排行人数</td>
            <td className="num">
              <em>{s.rankedTotal}</em>
            </td>
          </tr>
          <tr>
            <td>本月新人</td>
            <td className="num">
              <em>{s.newbieThisMonth}</em>
            </td>
          </tr>
          <tr>
            <td>录像总数</td>
            <td className="num">
              <em>{s.videoTotal}</em>
            </td>
          </tr>
          <tr>
            <td>今日上传</td>
            <td className="num">
              <em>{s.videoToday}</em>
            </td>
          </tr>
          <tr>
            <td>评论总数</td>
            <td className="num">
              <em>{s.commentTotal}</em>
            </td>
          </tr>
          <tr>
            <td>平均成绩</td>
            <td className="num">
              <em>
                {scoreTime(s.avgBeg)} / {scoreTime(s.avgInt)} / {scoreTime(s.avgExp)}
              </em>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
