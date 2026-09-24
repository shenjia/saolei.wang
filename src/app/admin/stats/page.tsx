// 管理后台 · 数据分析（2026-09-24）
// 增长 / 审核漏斗 / 纪录演变 / 活跃节律 / 分布 / 快照健康度。

import Link from "next/link";
import { usersByIds } from "@/lib/queries";
import { AdminAction } from "@/components/admin/AdminAction";
import { getAuditorWorkload, getGrowth, getSnapshotHealth, getTrend, TREND_METRICS } from "@/lib/admin/stats";
import { getCachedCurrentRecords, getRecordCurves, getStatsDistributions } from "@/lib/admin/cache";
import { BarList, ColumnChart, Donut, TrendChart, type Series } from "@/components/admin/Charts";
import { AdminCard, Kpi } from "@/components/admin/Widgets";
import { score3bvs, scoreTime, timeOpposite } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "数据分析 | 管理后台" };

export default async function AdminStatsPage() {
  // 波次取数：轻量实时查询 → 缓存聚合（慢查询集中在缓存函数里串行跑）
  const [trend, growth, snapshot, workload] = await Promise.all([
    getTrend(30),
    getGrowth(90),
    getSnapshotHealth(),
    getAuditorWorkload(8),
  ]);
  const [curves, distributions, records] = await Promise.all([
    getRecordCurves(),
    getStatsDistributions(),
    getCachedCurrentRecords(),
  ]);
  const { expTime, expB3bvs, intTime, begTime } = curves;
  const { hourly, weekday, areas, sex, levels, nf, boards, softwares } = distributions;

  const auditors = await usersByIds(workload.map((w) => w.user));
  const recordUsers = await usersByIds(records.flatMap((r) => [r.timeUser, r.b3bvsUser]).filter(Boolean));

  const trendSeries: Series[] = TREND_METRICS.map((m) => ({
    key: m.key,
    label: m.label,
    color: m.color,
    values: trend.series[m.key],
  }));

  const growthSeries: Series[] = [
    { key: "daily", label: "每日新增", color: "#a6e22e", values: growth.daily },
    { key: "cum", label: "累计玩家", color: "#66d9ef", values: growth.cumulative },
  ];

  const recordSeries = (points: { date: string; value: number }[], label: string, color: string, scale: number): {
    dates: string[];
    series: Series[];
  } => ({
    dates: points.map((p) => p.date),
    series: [{ key: label, label, color, values: points.map((p) => Math.round(p.value / scale * 1000) / 1000) }],
  });

  const expT = recordSeries(expTime, "高级时间纪录（秒）", "#e6db74", 1000);
  const expB = recordSeries(expB3bvs, "高级 3BV/s 纪录", "#a6e22e", 1000);
  const intT = recordSeries(intTime, "中级时间纪录（秒）", "#66d9ef", 1000);
  const begT = recordSeries(begTime, "初级时间纪录（秒）", "#f79646", 1000);

  const growth30 = getGrowthTail(growth, 30);
  const avgDaily = growth30.daily.length
    ? Math.round(growth30.daily.reduce((a, b) => a + b, 0) / growth30.daily.length * 10) / 10
    : 0;
  const totalUploads = trend.totals.videos;
  const reviewedRate = totalUploads ? Math.round((trend.totals.reviewed / totalUploads) * 100) : 0;

  return (
    <>
      <div className="admin_page_head">
        <h1>数据分析</h1>
        <span className="sub">近 30 天窗口（增长曲线为 90 天）· 按 +08:00 切天</span>
        <div className="right">
          <span className={`admin_tag ${snapshot.todayDone ? "ok" : "bad"}`}>
            今日快照{snapshot.todayDone ? "已生成" : "未生成"}
          </span>
          <AdminAction op="rank.snapshot" label="重算排行快照" variant="primary" confirm="重算今日排行快照？会覆盖今日已生成的数据。" />
        </div>
      </div>

      {/* ---------- 顶层指标 ---------- */}
      <div className="admin_kpis">
        <Kpi label="近 30 天上传播放" value={totalUploads} trend={trend.series.videos} tone="cyan" foot={`日均 ${(totalUploads / 30).toFixed(1)} 条`} />
        <Kpi label="近 30 天通过率" value={`${reviewedRate}%`} tone="green" foot={`通过 ${trend.totals.reviewed} / 上传 ${totalUploads}`} />
        <Kpi label="近 30 天新增玩家" value={trend.totals.users} trend={trend.series.users} tone="yellow" foot={`日均 ${avgDaily} 人（90 天口径）`} />
        <Kpi label="近 30 天屏蔽" value={trend.totals.banned} tone="red" foot="含审核屏蔽与事后屏蔽" />
        <Kpi label="快照累计天数" value={snapshot.days} unit="天" tone="purple" foot={`最新 ${snapshot.latest}`} />
      </div>

      {/* ---------- 趋势 + 增长 ---------- */}
      <AdminCard title="近 30 天内容趋势（点击图例可切换指标）">
        <TrendChart dates={trend.dates} series={trendSeries} />
      </AdminCard>

      <AdminCard title="玩家增长（近 90 天）" more="默认展示每日新增，点图例可叠加累计曲线">
        <TrendChart dates={growth.dates} series={growthSeries} height={210} defaultHidden={["cum"]} />
      </AdminCard>

      {/* ---------- 当前纪录 ---------- */}
      <AdminCard title="各级别当前纪录" more="榜单口径 user_scores">
        <div className="admin_scroll">
          <table className="admin_table">
            <thead>
              <tr>
                <th>级别</th>
                <th>时间纪录</th>
                <th>持有人</th>
                <th>创造时间</th>
                <th>3BV/s 纪录</th>
                <th>持有人</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => {
                const tu = recordUsers.get(r.timeUser);
                const bu = recordUsers.get(r.b3bvsUser);
                return (
                  <tr key={r.level}>
                    <td className="strong">{r.levelName}</td>
                    <td>
                      <Link className="link" href={`/video/${r.timeVideo}`} target="_blank">
                        {scoreTime(r.time)} 秒
                      </Link>
                    </td>
                    <td>
                      {tu ? (
                        <Link className="link" href={`/admin/users/${tu.id}`}>
                          {tu.chineseName}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="sub">{r.timeDate ? timeOpposite(r.timeDate, 0, "Y-m-d") : "—"}</td>
                    <td>
                      <Link className="link" href={`/video/${r.b3bvsVideo}`} target="_blank">
                        {score3bvs(r.b3bvs)}
                      </Link>
                    </td>
                    <td>
                      {bu ? (
                        <Link className="link" href={`/admin/users/${bu.id}`}>
                          {bu.chineseName}
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </AdminCard>

      {/* ---------- 纪录演变 ---------- */}
      <div className="admin_grid c2">
        <AdminCard title="高级时间纪录演变" more="每刷新一次纪录取一点">
          <TrendChart dates={expT.dates} series={expT.series} height={200} unit=" 秒" />
        </AdminCard>
        <AdminCard title="高级 3BV/s 纪录演变">
          <TrendChart dates={expB.dates} series={expB.series} height={200} />
        </AdminCard>
      </div>
      <div className="admin_grid c2">
        <AdminCard title="中级时间纪录演变">
          <TrendChart dates={intT.dates} series={intT.series} height={190} unit=" 秒" />
        </AdminCard>
        <AdminCard title="初级时间纪录演变">
          <TrendChart dates={begT.dates} series={begT.series} height={190} unit=" 秒" />
        </AdminCard>
      </div>

      {/* ---------- 活跃节律 ---------- */}
      <div className="admin_grid c2">
        <AdminCard title="上传时段分布（0-23 时）" more="全量历史口径">
          <ColumnChart items={hourly} />
        </AdminCard>
        <AdminCard title="上传星期分布">
          <ColumnChart items={weekday} color="linear-gradient(180deg,#66d9ef,#2f6f8b)" />
        </AdminCard>
      </div>

      {/* ---------- 分布 ---------- */}
      <div className="admin_grid c2">
        <AdminCard title="性别分布">
          <Donut items={sex} centerLabel="玩家人数" />
        </AdminCard>
        <AdminCard title="录像级别分布">
          <Donut items={levels} centerLabel="录像总数" />
        </AdminCard>
      </div>
      <div className="admin_grid c2">
        <AdminCard title="标雷 / 无标（NF）比例">
          <Donut items={nf} centerLabel="录像总数" />
        </AdminCard>
        <AdminCard title="地图难度分布（3BV 分档）">
          <BarList items={boards} color="linear-gradient(90deg,#7a5c1f,#e6db74)" />
        </AdminCard>
      </div>
      <div className="admin_grid c2">
        <AdminCard title="地区分布 Top 12">
          <BarList items={areas} />
        </AdminCard>
        <AdminCard title="录像软件分布">
          <BarList items={softwares.map((s) => ({ ...s, label: s.label || "未记录" }))} color="linear-gradient(90deg,#1f6f8b,#66d9ef)" />
        </AdminCard>
      </div>

      {/* ---------- 审核员工作量 ---------- */}
      <AdminCard title="审核员工作量 Top 8" more="仅统计新站留痕的审核记录">
        <BarList
          items={workload.map((w) => ({
            label: auditors.get(w.user)?.chineseName ?? `#${w.user}`,
            value: w.count,
          }))}
          color="linear-gradient(90deg,#8a5a1f,#f79646)"
        />
      </AdminCard>

      {/* ---------- 军衔 / 快照说明 ---------- */}
      <AdminCard title="口径说明">
        <div className="admin_note">
          · 「通过率」= 窗口内通过录像数 / 上传录像数，反映的是审核速度而非质量；
          审核质量请看<Link href="/admin/review"> 审核管理 </Link>的屏蔽量。<br />
          · 纪录演变曲线只取「刷新纪录的那一刻」，因此点数等于历史破纪录次数；
          曲线台阶向下（时间越短越好）为正常。<br />
          · 时段 / 星期分布按 +08:00 折算，使用全量历史数据，不受 30 天窗口影响。<br />
          · 排行快照每日惰性生成一次（首次访问进步榜时），缺快照会导致进步榜整页空白。
        </div>
      </AdminCard>
    </>
  );
}

/** 取增长序列尾部 N 天（日均用） */
function getGrowthTail(g: { dates: string[]; daily: number[]; cumulative: number[] }, n: number) {
  return {
    dates: g.dates.slice(-n),
    daily: g.daily.slice(-n),
    cumulative: g.cumulative.slice(-n),
  };
}
