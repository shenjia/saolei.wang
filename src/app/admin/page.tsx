// 管理后台 · 仪表盘（2026-09-24；2026-10-16 加流量统计区块）
// 一屏掌握：规模指标（KPI）→ 30 天趋势 → 流量统计 → 待办与分布 → 最新动态。

import Link from "next/link";
import { getAnomalies, getOverview, getTrend, TREND_METRICS } from "@/lib/admin/stats";
import { getTrafficOverview, DEVICE_NAMES, REFERRER_NAMES, type ExitPage } from "@/lib/admin/traffic";
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
  const [ov, trend, dist, traffic] = await Promise.all([
    getOverview(),
    getTrend(30),
    getDashboardDistributions(),
    getTrafficOverview(),
  ]);
  const [anomalies, latestUsers, latestVideos] = await Promise.all([
    getAnomalies(),
    getLatestUsers(8),
    getLatestVideosBrief(8),
  ]);
  const { titles, areas, softwares } = dist;

  const series: Series[] = [
    // 流量两序列排最前（2026-10-16 张老师定：与业务趋势合并为一张图，默认只亮 UV/PV/新玩家/新录像）
    { key: "uv", label: "UV", color: "#ae81ff", values: traffic.trend.uv },
    { key: "pv", label: "PV", color: "#f8f8f2", values: traffic.trend.pv },
    ...TREND_METRICS.map((m) => ({
      key: m.key,
      label: m.label,
      color: m.color,
      values: trend.series[m.key],
    })),
  ];
  // 默认只激活 UV / PV / 新增玩家 / 上传录像，其余序列图例可手动点亮
  const defaultHidden = ["reviewed", "banned", "news", "comments", "bbs", "clicks"];

  const rankedRate = ov.userTotal ? Math.round((ov.rankedTotal / ov.userTotal) * 100) : 0;
  const { oldestPendingDays: pendingDays } = ov;

  // 流量对比 foot：涨绿跌红（.down）
  const cmpFoot = (today: number, yday: number) => {
    if (!yday) return `昨日 0 · 首日统计`;
    const pct = Math.round(((today - yday) / yday) * 1000) / 10;
    const sign = pct >= 0 ? "+" : "";
    return (
      <>
        昨日 {yday.toLocaleString("zh-CN")} · 较昨日{" "}
        <b className={pct < 0 ? "down" : undefined}>
          {sign}
          {pct}%
        </b>
      </>
    );
  };

  // 停留毫秒 → 人类可读（12s / 3m05s）
  const fmtDur = (ms: number | null) => {
    if (ms === null) return "—";
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  };

  // 流失诊断 → 标签配色
  const DIAGNOSIS_TAG: Record<string, string> = {
    bounce: "bad",
    shallow: "warn",
    read_leave: "info",
    normal: "plain",
    collecting: "plain",
  };
  const ExitRow = ({ e }: { e: ExitPage }) => (
    <tr>
      <td className="mono" title={e.path}>
        {e.path}
      </td>
      <td className="num">{e.pv.toLocaleString("zh-CN")}</td>
      <td className="num strong">{(e.exitRate * 100).toFixed(0)}%</td>
      <td className="num">{fmtDur(e.medianMs)}</td>
      <td className="num">{e.medianScrollPct === null ? "—" : `${e.medianScrollPct}%`}</td>
      <td>
        <span className={`admin_tag ${DIAGNOSIS_TAG[e.diagnosis.type]}`} title={e.diagnosis.hint}>
          {e.diagnosis.label}
        </span>
      </td>
    </tr>
  );

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
              今日 <b>+{ov.videoToday}</b> · 通过率 <b>{ov.passRate}%</b>
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
          foot={
            <>
              今日 <b>+{ov.commentToday}</b> · 未删除合计
            </>
          }
        />
        <Kpi
          label="论坛主题"
          value={ov.bbsPostTotal}
          tone="cyan"
          trend={trend.series.bbs}
          href="/admin/bbs"
          foot={
            <>
              今日 <b>+{ov.bbsPostToday}</b> · 回复 {ov.bbsReplyTotal.toLocaleString("zh-CN")} 条
            </>
          }
        />
        <Kpi
          label="人气点击"
          value={ov.clickTotal}
          tone="green"
          trend={trend.series.clicks}
          foot="看地盘去重计数"
        />
        {/* 流量 KPI（2026-10-16）：page_view 埋点，管理员浏览已剔除 */}
        <Kpi
          label="今日 PV"
          value={traffic.today.pv}
          tone="cyan"
          trend={traffic.trend.pv}
          foot={cmpFoot(traffic.today.pv, traffic.yesterday.pv)}
        />
        <Kpi
          label="今日 UV"
          value={traffic.today.uv}
          tone="purple"
          trend={traffic.trend.uv}
          foot={cmpFoot(traffic.today.uv, traffic.yesterday.uv)}
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

      {/* ---------- 趋势（2026-10-16 合并业务趋势与 PV/UV 访问趋势，x 轴同为 +08:00 切天） ---------- */}
      <AdminCard
        title="近 30 天趋势"
        more={
          <>
            <span className="sub">PV/UV 为 page_view 埋点 · 已剔除管理员浏览</span>
            <Link href="/admin/stats">深入分析 →</Link>
          </>
        }
      >
        <TrendChart dates={trend.dates} series={series} unit="" defaultHidden={defaultHidden} />
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

      {/* ---------- 流量统计（2026-10-16）：来源 / 落地页 / 设备 / 热门录像 ---------- */}
      <div className="admin_grid c2">
        <AdminCard title="入口来源" more="近 30 天 · 会话入口的 referrer">
          <BarList
            items={traffic.referrers.map((r) => ({
              label: REFERRER_NAMES[r.source] ?? r.source,
              value: r.visits,
            }))}
            color="linear-gradient(90deg,#1f6f8b,#66d9ef)"
          />
        </AdminCard>

        <AdminCard title="落地页 Top" more="近 7 天 · 会话首个页面（录像 ID 已归类）">
          <BarList
            items={traffic.entryPages.d7.map((e) => ({
              label: e.path,
              value: e.entries,
            }))}
            color="linear-gradient(90deg,#6b4f8b,#ae81ff)"
          />
        </AdminCard>
      </div>

      <div className="admin_grid c2">
        <AdminCard title="设备分布" more="近 30 天 · 按 UA 粗分类">
          <BarList
            items={traffic.devices.map((d) => ({
              label: DEVICE_NAMES[d.uaClass] ?? d.uaClass,
              value: d.pv,
            }))}
            color="linear-gradient(90deg,#4f7a3a,#a6e22e)"
          />
        </AdminCard>

        <AdminCard title="热门录像页" more="近 7 天 · /video/:id 访问榜" tight>
          <div className="admin_scroll">
            <table className="admin_table">
              <thead>
                <tr>
                  <th>录像</th>
                  <th className="c">级别</th>
                  <th className="num">PV</th>
                  <th className="num">UV</th>
                </tr>
              </thead>
              <tbody>
                {traffic.topVideos.d7.length === 0 && (
                  <tr>
                    <td colSpan={4} className="gray">
                      暂无数据
                    </td>
                  </tr>
                )}
                {traffic.topVideos.d7.map((v) => (
                  <tr key={v.path}>
                    <td>
                      <Link className="link" href={v.path} target="_blank">
                        {v.label}
                      </Link>
                    </td>
                    <td className="c">
                      <LevelTag level={v.level} />
                    </td>
                    <td className="num strong">{v.pv.toLocaleString("zh-CN")}</td>
                    <td className="num">{v.uv.toLocaleString("zh-CN")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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

      {/* ---------- 高流失页（2026-10-16）：会话末页诊断 ---------- */}
      <AdminCard
        title="高流失页"
        more="近 7 天 · 会话末页占比（录像详情页看完即走属正常，未计入；PV ≥ 5 才入榜）"
        tight
      >
        <div className="admin_scroll">
          <table className="admin_table">
            <thead>
              <tr>
                <th>页面</th>
                <th className="num">PV</th>
                <th className="num">退出占比</th>
                <th className="num">中位停留</th>
                <th className="num">中位滚动</th>
                <th>诊断</th>
              </tr>
            </thead>
            <tbody>
              {traffic.exits.d7.length === 0 && (
                <tr>
                  <td colSpan={6} className="gray">
                    暂无数据（埋点上线后随访问量积累）
                  </td>
                </tr>
              )}
              {traffic.exits.d7.map((e) => (
                <ExitRow key={e.path} e={e} />
              ))}
            </tbody>
          </table>
        </div>
      </AdminCard>
    </>
  );
}
