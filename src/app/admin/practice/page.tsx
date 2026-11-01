// 管理后台 · 练习数据详情（2026-10-27 张老师定）
// 从仪表盘「今日练习」KPI 点击进入：30 天趋势（总/初/中/高/自）+ 级别占比饼图
// + 24 小时分布（近 7 天聚合）+ 近 7 天明细列表。
// 配色（张老师定）：总盘亮灰 #b1b1a4、自定义紫 #ae81ff、初中高复用前台
// 绿 #a6e22e / 橙 #f79646 / 金 #fdc61d（同 admin_tag.lv_* 与前台 hover 配色）。

import { AdminCard } from "@/components/admin/Widgets";
import { BarList, ColumnChart, Donut, TrendChart, type Series } from "@/components/admin/Charts";
import { LatencyMap } from "@/components/admin/LatencyMap";
import { RegionTodayTable } from "@/components/admin/RegionTodayTable";
import { ServerStatusPanel } from "@/components/admin/ServerStatusPanel";
import { getPracticeDays, getPracticeHourly, getPracticeModes, getPracticeSwitches, getPracticeTrend, getRankedLatencyMap, getRegionToday, PRACTICE_LEVEL_COLORS, LEVEL_CLEAN_SINCE } from "@/lib/admin/practice";

export const dynamic = "force-dynamic";
export const metadata = { title: "练习数据 | 管理后台" };

export default async function AdminPracticePage() {
  const [trend, hourly, days, modes, switches, rttMap, regionToday] = await Promise.all([
    getPracticeTrend(30),
    getPracticeHourly(7),
    getPracticeDays(7),
    getPracticeModes(7),
    getPracticeSwitches(7),
    getRankedLatencyMap(7),
    getRegionToday(),
  ]);
  const C = PRACTICE_LEVEL_COLORS;

  const series: Series[] = [
    { key: "total", label: "总盘数", color: C.total, values: trend.total },
    { key: "beg", label: "初级", color: C.beg, values: trend.beg },
    { key: "int", label: "中级", color: C.int, values: trend.int },
    { key: "exp", label: "高级", color: C.exp, values: trend.exp },
    { key: "cus", label: "自定义", color: C.cus, values: trend.cus },
  ];

  const d30Total = trend.total.reduce((a, b) => a + b, 0);
  const weekPlays = days.reduce((a, d) => a + d.plays, 0);
  // 近 30 天级别占比（色值与趋势图序列一致）；分母=四段之和（已记级别的盘数，
  // 10-27 起记日当天 cus 计 0——差额不可分离，其余三列即真值）
  const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
  const lvBeg = sum(trend.beg), lvInt = sum(trend.int), lvExp = sum(trend.exp), lvCus = sum(trend.cus);
  const lvTotal = lvBeg + lvInt + lvExp + lvCus;
  const levelItems = [
    { label: "初级", value: lvBeg, color: C.beg },
    { label: "中级", value: lvInt, color: C.int },
    { label: "高级", value: lvExp, color: C.exp },
    { label: "自定义", value: lvCus, color: C.cus },
  ];

  return (
    <>
      <div className="admin_page_head">
        <h1>练习数据</h1>
        <span className="sub">
          近 30 天 {d30Total.toLocaleString("zh-CN")} 盘 · 近 7 天 {weekPlays.toLocaleString("zh-CN")} 盘
        </span>
      </div>

      {/* 2026-11-01 张老师定稿：大板块＝左列「地图/负载」竖排 + 右列「地区明细」通高；
          大板块右侧竖排「级别占比/模式占比」；下面「练习趋势 + 24 小时分布」一行 */}
      <div style={{ display: "flex", gap: 14, alignItems: "stretch", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 840px", minWidth: 0, display: "flex" }}>
          <AdminCard className="h100 pc_big">
            {/* 两列 40/60（张老师定稿）：basis 0 + grow 2:3 等比分配，明细为空也保持列宽 */}
            <div style={{ display: "flex", gap: 14, alignItems: "stretch", flexWrap: "wrap" }}>
              <div style={{ flex: "2 1 0", minWidth: 300, display: "flex", flexDirection: "column", gap: 12 }}>
                <div>
                  <b style={{ fontSize: 14 }}>
                    排行延迟地图（近 7 天）
                    <span style={{ color: "#75715e", fontSize: 12, marginLeft: 8 }}>
                      {rttMap.length ? `${rttMap.length} 个地区有数据 · 共 ${rttMap.reduce((a, d) => a + d.games, 0).toLocaleString("zh-CN")} 局` : "数据自今日起记"}
                    </span>
                  </b>
                  <div style={{ marginTop: 6 }}>
                    {rttMap.length ? (
                      <LatencyMap data={rttMap} />
                    ) : (
                      <div className="admin_empty">暂无排行延迟数据（排行局结算后自动记入）</div>
                    )}
                  </div>
                </div>
                <div>
                  <ServerStatusPanel />
                </div>
              </div>
              {/* 右列：明细撑满大板块高度（pc_big 作用域放开 max-height，表头吸顶） */}
              <div style={{ flex: "3 1 0", minWidth: 300, display: "flex", flexDirection: "column" }}>
                <b style={{ fontSize: 14 }}>今日地区明细</b>
                <div style={{ flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
                  {regionToday.length ? (
                    <RegionTodayTable rows={regionToday} />
                  ) : (
                    <div className="admin_empty">今日暂无地区数据</div>
                  )}
                </div>
              </div>
            </div>
          </AdminCard>
        </div>
        <div style={{ flex: "0 0 300px", minWidth: 280, display: "flex", flexDirection: "column", gap: 14 }}>
          <AdminCard title="级别占比（近 30 天总量）" className="h100">
            <Donut items={levelItems} centerLabel={`已记 ${lvTotal.toLocaleString("zh-CN")} 盘`} mergeSmall={false} />
          </AdminCard>
          <AdminCard title="模式占比（近 7 天）" className="h100">
            {modes.items.some((m) => m.value > 0) ? (
              <BarList
                items={modes.items.map((m) => ({
                  label: `${m.label}（${modes.total > 0 ? Math.round((m.value / modes.total) * 100) : 0}%）`,
                  value: m.value,
                }))}
                color="linear-gradient(90deg,#75715e,#a6e22e)"
              />
            ) : (
              <div className="admin_empty">暂无模式数据</div>
            )}
          </AdminCard>
          {/* 开关占比（2026-11-01 张老师定）：设置浮窗六开关的打开盘数比例，
              分母=同期总盘数（老客户端缺省关，起记日前旧局稀释占比） */}
          <AdminCard title="开关占比（近 7 天）" className="h100">
            {switches.total > 0 ? (
              <BarList
                items={switches.items.map((s) => ({
                  label: `${s.label}（${Math.round((s.value / switches.total) * 100)}%）`,
                  value: s.value,
                }))}
                color="linear-gradient(90deg,#75715e,#66d9ef)"
              />
            ) : (
              <div className="admin_empty">暂无开关数据（自今日起记）</div>
            )}
          </AdminCard>
        </div>
      </div>

      <div className="admin_grid c2">
        <AdminCard title="练习趋势（近 30 天，点击图例可切换级别）">
          <TrendChart dates={trend.dates} series={series} />
        </AdminCard>
        <AdminCard title="24 小时分布（近 7 天聚合）" more="0-23 时按 +08:00，今日起记">
          <ColumnChart items={hourly} color="linear-gradient(180deg,#66d9ef,#2f6f8b)" height={150} />
        </AdminCard>
      </div>

      <AdminCard title="近 7 天明细" more={`人数含游客；${LEVEL_CLEAN_SINCE} 15:11 前级别维度未记（计 0）`}>
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
    </>
  );
}
