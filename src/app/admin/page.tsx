// 管理后台 · 仪表盘（2026-09-24）
// 一屏掌握：规模指标（KPI）→ 30 天趋势 → 待办与分布 → 最新动态。

import Link from "next/link";
import { getAnomalies, getOverview, getTrend, TREND_METRICS } from "@/lib/admin/stats";
import { getDashboardDistributions } from "@/lib/admin/cache";
import { getLatestUsers, getLatestVideosBrief } from "@/lib/admin/data";
import { TrendChart, BarList, type Series } from "@/components/admin/Charts";
import { AdminCard, Kpi, LevelTag, StatusTag } from "@/components/admin/Widgets";
import { TitleBadge } from "@/components/Cells";
import { formatDate, scoreTime, timeOpposite } from "@/lib/format";
import { TITLE_COLORS } from "@/lib/config";

export const dynamic = "force-dynamic";
export const metadata = { title: "仪表盘 | 管理后台" };

export default async function AdminDashboard() {
  // 分两波取数：重的全表聚合走缓存且在内部串行，轻的实时查询并行
  const [ov, trend, dist] = await Promise.all([getOverview(), getTrend(30), getDashboardDistributions()]);
  const [anomalies, latestUsers, latestVideos] = await Promise.all([
    getAnomalies(),
    getLatestUsers(8),
    getLatestVideosBrief(8),
  ]);
  const { titles, areas, softwares } = dist;

  const series: Series[] = TREND_METRICS.map((m) => ({
    key: m.key,
    label: m.label,
    color: m.color,
    values: trend.series[m.key],
  }));

  const rankedRate = ov.userTotal ? Math.round((ov.rankedTotal / ov.userTotal) * 100) : 0;
  const { oldestPendingDays: pendingDays } = ov;

  const titleItems = titles.map((t) => ({
    label: t.title,
    value: t.count,
    color: TITLE_COLORS[t.title] ?? "#6c6c61",
  }));

  const todos: { label: string; value: number; href: string; hint?: string }[] = [
    { label: "待审核录像", value: ov.videoPending, href: "/admin/review", hint: pendingDays > 0 ? `最老 ${pendingDays} 天` : undefined },
    { label: "录像缺解析信息", value: anomalies.orphanVideos, href: "/admin/videos?q=", hint: "上传中断" },
    { label: "重复 hash 录像组", value: anomalies.duplicateHashGroups, href: "/admin/videos", hint: "疑似重复上传" },
    { label: "3BV 低于级别下限", value: anomalies.lowBoardVideos, href: "/admin/videos", hint: "历史数据可能误报" },
    { label: "有录像无成绩玩家", value: anomalies.scoreMissingUsers, href: "/admin/users", hint: "成绩异常" },
  ];

  return (
    <>
      <div className="admin_page_head">
        <h1>仪表盘</h1>
        <span className="sub">
          数据截至 {formatDate(ov.now, "Y-m-d H:i")} · 全部指标实时查询
        </span>
      </div>

      {/* ---------- 规模指标 ---------- */}
      <div className="admin_kpis">
        <Kpi
          label="注册玩家"
          value={ov.userTotal}
          tone="green"
          trend={trend.series.users}
          href="/admin/users"
          foot={
            <>
              今日 <b>+{ov.userToday}</b> · 近 7 天 +{ov.userWeek}
            </>
          }
        />
        <Kpi
          label="上榜玩家"
          value={ov.rankedTotal}
          unit={`/ ${rankedRate}%`}
          tone="yellow"
          href="/admin/users?ranked=1"
          foot="三级成绩齐全"
        />
        <Kpi
          label="录像总数"
          value={ov.videoTotal}
          tone="cyan"
          trend={trend.series.videos}
          href="/admin/videos"
          foot={
            <>
              通过率 <b>{ov.passRate}%</b>
            </>
          }
        />
        <Kpi
          label="待审核"
          value={ov.videoPending}
          tone="red"
          href="/admin/review"
          foot={ov.videoPending ? (pendingDays ? `最老积压 ${pendingDays} 天` : "均已下载") : "队列已清空"}
        />
        <Kpi
          label="近 7 天活跃上传"
          value={ov.activeUploaders7d}
          unit="人"
          tone="orange"
          foot={`近 30 天 ${ov.activeUploaders30d} 人`}
        />
        <Kpi
          label="成绩动态"
          value={ov.newsTotal}
          tone="purple"
          trend={trend.series.news}
          href="/admin/news"
          foot={
            <>
              今日 <b>+{ov.newsToday}</b>
            </>
          }
        />
        <Kpi
          label="评论"
          value={ov.commentTotal}
          tone="yellow"
          trend={trend.series.comments}
          href="/admin/comments"
          foot="未删除合计"
        />
        <Kpi
          label="论坛主题"
          value={ov.bbsPostTotal}
          tone="cyan"
          trend={trend.series.bbs}
          href="/admin/bbs"
          foot={`回复 ${ov.bbsReplyTotal.toLocaleString("zh-CN")} 条`}
        />
        <Kpi
          label="人气点击"
          value={ov.clickTotal}
          tone="green"
          trend={trend.series.clicks}
          foot="看地盘去重计数"
        />
        <Kpi label="站内信" value={ov.messageTotal} tone="grey" href="/admin/messages" foot="含系统广播" />
        <Kpi
          label="赞助累计"
          value={`¥${(ov.donateTotal / 100).toFixed(2)}`}
          tone="orange"
          foot={ov.avgAuditSeconds ? `平均审核耗时 ${Math.round(ov.avgAuditSeconds / 60)} 分钟` : "审核耗时暂无样本"}
        />
        <Kpi
          label="已屏蔽录像"
          value={ov.videoBanned}
          tone="grey"
          href="/admin/videos?status=0"
          foot="含历史封禁"
        />
      </div>

      {/* ---------- 趋势 ---------- */}
      <AdminCard
        title="近 30 天趋势"
        more={<Link href="/admin/stats">深入分析 →</Link>}
      >
        <TrendChart dates={trend.dates} series={series} unit="" />
      </AdminCard>

      {/* ---------- 待办 + 军衔分布 ---------- */}
      <div className="admin_grid c2">
        <AdminCard title="待办事项">
          <div className="admin_todo">
            {todos.map((t) => (
              <Link key={t.label} href={t.href}>
                <span>{t.label}</span>
                {t.hint && <span className="admin_hint">{t.hint}</span>}
                <span className={`badge${t.value === 0 ? " zero" : ""}`}>{t.value.toLocaleString("zh-CN")}</span>
              </Link>
            ))}
          </div>
          <div className="admin_hint" style={{ marginTop: 10 }}>
            提示：待审录像必须「先下载观看再审核」（防盲审），系统会拒绝未下载的审核请求。
          </div>
        </AdminCard>

        <AdminCard title="军衔分布" more={<Link href="/admin/rank">军衔阈值 →</Link>}>
          <BarList items={titleItems} />
        </AdminCard>
      </div>

      {/* ---------- 地区 / 软件分布 ---------- */}
      <div className="admin_grid c2">
        <AdminCard title="地区分布 Top 10" more="按注册资料">
          <BarList items={areas} />
        </AdminCard>
        <AdminCard title="录像软件分布" more="按录像解析">
          <BarList
            items={softwares.map((s) => ({ ...s, label: s.label || "未记录" }))}
            color="linear-gradient(90deg,#1f6f8b,#66d9ef)"
          />
        </AdminCard>
      </div>

      {/* ---------- 最新注册 / 最新上传 ---------- */}
      <div className="admin_grid c2">
        <AdminCard title="最新注册玩家" tight more={<Link href="/admin/users?order=reg">全部 →</Link>}>
          <div className="admin_scroll">
            <table className="admin_table">
              <thead>
                <tr>
                  <th>玩家</th>
                  <th>军衔</th>
                  <th className="num">总计</th>
                  <th>注册</th>
                </tr>
              </thead>
              <tbody>
                {latestUsers.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <Link className="link" href={`/admin/users/${u.id}`}>
                        {u.chineseName}
                      </Link>
                      <span className="sub"> #{u.id}</span>
                    </td>
                    <td>
                      <TitleBadge title={u.title} />
                    </td>
                    <td className="num">{u.sumTime ? scoreTime(u.sumTime) : "—"}</td>
                    <td>
                      <span className="sub">{u.createTime ? timeOpposite(u.createTime, 0, "Y-m-d") : "—"}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AdminCard>

        <AdminCard title="最新上传录像" tight more={<Link href="/admin/videos">全部 →</Link>}>
          <div className="admin_scroll">
            <table className="admin_table">
              <thead>
                <tr>
                  <th className="c">ID</th>
                  <th>玩家</th>
                  <th className="c">级别</th>
                  <th className="num">成绩</th>
                  <th className="c">状态</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {latestVideos.map((v) => (
                  <tr key={v.id}>
                    <td className="c">
                      <Link className="link" href={`/video/${v.id}`} target="_blank">
                        {v.id}
                      </Link>
                    </td>
                    <td>
                      <Link className="link" href={`/admin/users/${v.user}`}>
                        {v.authorName}
                      </Link>
                    </td>
                    <td className="c">
                      <LevelTag level={v.level} />
                    </td>
                    <td className="num strong">{v.realTime ? scoreTime(v.realTime) : "—"}</td>
                    <td className="c">
                      <StatusTag status={v.status} />
                    </td>
                    <td>
                      <span className="sub">{v.createTime ? timeOpposite(v.createTime) : "—"}</span>
                    </td>
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
