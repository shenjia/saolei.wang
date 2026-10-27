// 管理后台 · 练习数据详情（2026-10-27 张老师定）
// 从仪表盘「今日练习」KPI 点击进入：30 天趋势（总/初/中/高/自）+ 24 小时分布
// （近 7 天聚合）+ 近 7 天明细列表。

import { AdminCard } from "@/components/admin/Widgets";
import { ColumnChart, TrendChart, type Series } from "@/components/admin/Charts";
import { getPracticeDays, getPracticeHourly, getPracticeTrend, LEVEL_COLS_SINCE } from "@/lib/admin/practice";

export const dynamic = "force-dynamic";
export const metadata = { title: "练习数据 | 管理后台" };

export default async function AdminPracticePage() {
  const [trend, hourly, days] = await Promise.all([getPracticeTrend(30), getPracticeHourly(7), getPracticeDays(7)]);

  const series: Series[] = [
    { key: "total", label: "总盘数", color: "#a6e22e", values: trend.total },
    { key: "exp", label: "高级", color: "#f79646", values: trend.exp },
    { key: "int", label: "中级", color: "#66d9ef", values: trend.int },
    { key: "beg", label: "初级", color: "#e6db74", values: trend.beg },
    { key: "cus", label: "自定义", color: "#ae81ff", values: trend.cus },
  ];

  const d30Total = trend.total.reduce((a, b) => a + b, 0);
  const d30Wins = days.reduce((a, d) => a + d.wins, 0); // 近 7 天完成数（列表面板用）
  void d30Wins;
  const weekPlays = days.reduce((a, d) => a + d.plays, 0);

  return (
    <>
      <div className="admin_page_head">
        <h1>练习数据</h1>
        <span className="sub">
          近 30 天 {d30Total.toLocaleString("zh-CN")} 盘 · 近 7 天 {weekPlays.toLocaleString("zh-CN")} 盘
        </span>
      </div>

      <AdminCard title="练习趋势（近 30 天，点击图例可切换级别）" more={`「自定义」含 ${LEVEL_COLS_SINCE} 级别列起记前的历史盘`}>
        <TrendChart dates={trend.dates} series={series} />
      </AdminCard>

      <div className="admin_grid c2">
        <AdminCard title="24 小时分布（近 7 天聚合）" more="0-23 时按 +08:00，今日起记">
          <ColumnChart items={hourly} color="linear-gradient(180deg,#66d9ef,#2f6f8b)" height={150} />
        </AdminCard>
        <AdminCard title="近 7 天明细" more={`人数含游客（${LEVEL_COLS_SINCE} 前级别为 0 是未记，差额归「自定义」）`}>
          <div className="admin_scroll">
            <table className="admin_table">
              <thead>
                <tr>
                  <th>日期</th>
                  <th className="num">盘数</th>
                  <th className="num">完成</th>
                  <th className="num">初</th>
                  <th className="num">中</th>
                  <th className="num">高</th>
                  <th className="num">自</th>
                  <th className="num">人数</th>
                </tr>
              </thead>
              <tbody>
                {days.map((d) => (
                  <tr key={d.date}>
                    <td className="strong">{d.date}</td>
                    <td className="num">{d.plays.toLocaleString("zh-CN")}</td>
                    <td className="num">{d.wins.toLocaleString("zh-CN")}</td>
                    <td className="num">{d.beg.toLocaleString("zh-CN")}</td>
                    <td className="num">{d.int.toLocaleString("zh-CN")}</td>
                    <td className="num">{d.exp.toLocaleString("zh-CN")}</td>
                    <td className="num">{d.cus.toLocaleString("zh-CN")}</td>
                    <td className="num">{d.players}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AdminCard>
      </div>
    </>
  );
}
