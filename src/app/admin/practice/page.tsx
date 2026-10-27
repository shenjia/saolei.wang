// 管理后台 · 练习数据详情（2026-10-27 张老师定）
// 从仪表盘「今日练习」KPI 点击进入：30 天趋势（总/初/中/高/自）+ 级别占比饼图
// + 24 小时分布（近 7 天聚合）+ 近 7 天明细列表。
// 配色（张老师定）：总盘亮灰 #b1b1a4、自定义紫 #ae81ff、初中高复用前台
// 绿 #a6e22e / 橙 #f79646 / 金 #fdc61d（同 admin_tag.lv_* 与前台 hover 配色）。

import { AdminCard } from "@/components/admin/Widgets";
import { ColumnChart, Donut, TrendChart, type Series } from "@/components/admin/Charts";
import { getPracticeDays, getPracticeHourly, getPracticeTrend, LEVEL_COLS_SINCE } from "@/lib/admin/practice";

export const dynamic = "force-dynamic";
export const metadata = { title: "练习数据 | 管理后台" };

export default async function AdminPracticePage() {
  const [trend, hourly, days] = await Promise.all([getPracticeTrend(30), getPracticeHourly(7), getPracticeDays(7)]);

  const series: Series[] = [
    { key: "total", label: "总盘数", color: "#b1b1a4", values: trend.total },
    { key: "beg", label: "初级", color: "#a6e22e", values: trend.beg },
    { key: "int", label: "中级", color: "#f79646", values: trend.int },
    { key: "exp", label: "高级", color: "#fdc61d", values: trend.exp },
    { key: "cus", label: "自定义", color: "#ae81ff", values: trend.cus },
  ];

  const d30Total = trend.total.reduce((a, b) => a + b, 0);
  const weekPlays = days.reduce((a, d) => a + d.plays, 0);
  // 近 30 天级别占比（与趋势图同窗口的总量口径）
  const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
  const levelItems = [
    { label: "初级", value: sum(trend.beg) },
    { label: "中级", value: sum(trend.int) },
    { label: "高级", value: sum(trend.exp) },
    { label: "自定义", value: sum(trend.cus) },
  ];

  return (
    <>
      <div className="admin_page_head">
        <h1>练习数据</h1>
        <span className="sub">
          近 30 天 {d30Total.toLocaleString("zh-CN")} 盘 · 近 7 天 {weekPlays.toLocaleString("zh-CN")} 盘
        </span>
      </div>

      <div className="admin_grid trend_pie">
        <AdminCard title="练习趋势（近 30 天，点击图例可切换级别）" more={`「自定义」含 ${LEVEL_COLS_SINCE} 级别列起记前的历史盘`}>
          <TrendChart dates={trend.dates} series={series} />
        </AdminCard>
        <AdminCard title="级别占比（近 30 天总量）" more="与趋势图同窗口；「自定义」含起记前历史盘">
          <Donut items={levelItems} centerLabel={`总 ${d30Total.toLocaleString("zh-CN")} 盘`} />
        </AdminCard>
      </div>

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
