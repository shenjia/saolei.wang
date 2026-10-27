// 管理后台 · 仪表盘（2026-09-24；2026-10-16 加流量统计区块；2026-10-21 加称号体系偏好 + 占比图全面换环形 Donut；
// 2026-10-23 张老师定：KPI 首行收敛为 6 卡——流量同比只留百分比、练习两行（人参与/近7天盘数）、
// 注册两行（今日/近7天）、活跃只留今日、「上传录像」只留今日、论坛主题卡下线）
// 一屏掌握：规模指标（KPI）→ 30 天趋势 → 流量统计 → 待办与分布 → 最新动态。

import Link from "next/link";
import { getOverview, getTrend, TREND_METRICS } from "@/lib/admin/stats";
import { getTrafficOverview, DEVICE_NAMES, REFERRER_NAMES, type ExitPage } from "@/lib/admin/traffic";
import { practiceCusClean } from "@/lib/admin/practice";
import { getDashboardDistributionsSoftwares, getCachedAnomalies } from "@/lib/admin/cache";
import { getLatestUsers, getLatestVideosBrief } from "@/lib/admin/data";
import { TrendChart, BarList, Donut, type Series } from "@/components/admin/Charts";
import { AdminCard, Kpi, LevelTag, StatusTag } from "@/components/admin/Widgets";
import { TitleBadge } from "@/components/Cells";
import { formatDate, scoreTime, timeOpposite } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "仪表盘 | 管理后台" };

export default async function AdminDashboard() {
  // 分两波取数：重的全表聚合走缓存且在内部串行，轻的实时查询并行
  // （2026-10-21 称号/地区分布卡下线，dashboard-distributions 只剩软件分布 + 称号偏好）
  const [ov, trend, dist, traffic] = await Promise.all([
    getOverview(),
    getTrend(30),
    getDashboardDistributionsSoftwares(),
    getTrafficOverview(),
  ]);
  const [anomalies, latestUsers, latestVideos] = await Promise.all([
    getCachedAnomalies(),
    getLatestUsers(8),
    getLatestVideosBrief(8),
  ]);
  const { softwares, titlePrefs } = dist;

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

  const { oldestPendingDays: pendingDays } = ov;

  // 流量对比 foot：只显示同比（涨绿跌红 .down）；基数为上周同一日同时段（今日 00:00~现在 vs 上周同一日 00:00~上周此刻）
  const cmpFoot = (today: number, lastWeek: number) => {
    if (!lastWeek) return `暂无同比`;
    const pct = Math.round(((today - lastWeek) / lastWeek) * 1000) / 10;
    const sign = pct >= 0 ? "+" : "";
    return (
      <>
        同比{" "}
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

      {/* ---------- 规模指标（2026-10-16 张老师定：第一行七卡全带走势线） ---------- */}
      <div className="admin_kpis">
        <Kpi
          label="今日 PV"
          value={traffic.today.pv}
          tone="cyan"
          trend={traffic.trend.pv}
          foot={cmpFoot(traffic.today.pv, traffic.lastWeek.pv)}
        />
        <Kpi
          label="今日 UV"
          value={traffic.today.uv}
          tone="purple"
          trend={traffic.trend.uv}
          foot={cmpFoot(traffic.today.uv, traffic.lastWeek.uv)}
        />
        <Kpi
          label="今日练习"
          href="/admin/practice"
          value={
            <>
              {traffic.practice.today.toLocaleString("zh-CN")}
              <small> 局 / {traffic.practice.todayUsers} 人参与</small>
            </>
          }
          tone="cyan"
          trend={traffic.practice.trend}
          foot={
            <>
              {cmpFoot(traffic.practice.today, traffic.practice.lastWeek)}
              <br />
              {/* 2026-10-27 张老师定：foot 同比 / 初+中 / 高+自；
                  2026-10-28 改：去掉「自x%」，初/中/高 各占一行。
                  16:50 定：级别三列起记后即显真占比（分母=初中高自之和，
                  不掺生效前未记盘）；仅起记当日（10-27）「自定义」差额不可
                  分离计 0，次日全维度自然对齐。 */}
              {(() => {
                const { beg, int, exp } = traffic.practice.todayLevels;
                const cus = practiceCusClean() ? Math.max(0, traffic.practice.today - beg - int - exp) : 0;
                const total = beg + int + exp + cus;
                const pct = (n: number) => (total <= 0 ? 0 : Math.round((n / total) * 100));
                return (
                  <>
                    初级 {pct(beg)}%
                    <br />
                    中级 {pct(int)}%
                    <br />
                    高级 {pct(exp)}%
                  </>
                );
              })()}
            </>
          }
        />
        <Kpi
          label="注册玩家"
          value={ov.userTotal}
          tone="green"
          trend={trend.series.users}
          href="/admin/users"
          foot={
            <>
              今日 <b>+{ov.userToday}</b>
              <br />
              近 7 天 +{ov.userWeek}
            </>
          }
        />
        <Kpi
          label="活跃玩家"
          value={traffic.active.d7}
          unit="人"
          tone="orange"
          trend={traffic.active.trend}
          foot={
            <>
              今日 <b>{traffic.active.today}</b>
            </>
          }
        />
        <Kpi
          label="上传录像"
          value={ov.videoTotal}
          tone="yellow"
          trend={trend.series.videos}
          href="/admin/videos"
          foot={
            <>
              今日 <b>+{ov.videoToday}</b>
            </>
          }
        />
      </div>

      {/* ---------- 待人工审核（2026-10-16 张老师定：第二行只放需人工处理的队列，无则整行不显示） ---------- */}
      {(() => {
        const reviewItems = [
          {
            label: "录像待审",
            value: ov.videoPending,
            href: "/admin/review",
            foot: ov.videoPending ? (pendingDays ? `最老积压 ${pendingDays} 天` : "均已下载") : "",
          },
          { label: "评论待审", value: ov.commentPending, href: "/admin/comments?status=5", foot: "AI 复核存疑" },
          // 2026-10-27：论坛待审=主题+回复合计（同侧栏 badge 口径）；页面顶部即待审混合队列，无需 ?status=5
          { label: "论坛待审", value: ov.bbsPending, href: "/admin/bbs", foot: "AI 复核存疑" },
          { label: "头像待审", value: ov.avatarPending, href: "/admin/avatars", foot: "AI 判 review" },
        ].filter((p) => p.value > 0);
        if (reviewItems.length === 0) return null;
        return (
          <div className="admin_kpis">
            {reviewItems.map((p) => (
              <Kpi key={p.label} label={p.label} value={p.value} tone="red" href={p.href} foot={p.foot || "待处理"} />
            ))}
          </div>
        );
      })()}

      {/* ---------- 待办 + 趋势并排（2026-10-21 张老师定：待办在左） ---------- */}
      <div className="admin_grid todo_trend">
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

        {/* 趋势（2026-10-16 合并业务趋势与 PV/UV 访问趋势，x 轴同为 +08:00 切天） */}
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

      {/* ---------- 三个分布环形图并一行（2026-10-21 张老师定：设备/称号/软件；热门录像页板块下线） ---------- */}
      <div className="admin_grid pies3">
        <AdminCard title="设备分布" more="近 30 天 · 按 UA 粗分类">
          <Donut
            items={traffic.devices.map((d) => ({
              label: DEVICE_NAMES[d.uaClass] ?? d.uaClass,
              value: d.pv,
            }))}
            centerLabel="访问 PV"
          />
        </AdminCard>

        <AdminCard title="称号体系偏好" more="user_info.title_pref · 10 分钟缓存 · 点击图例查看玩家列表">
          <Donut
            items={titlePrefs.map((t) => ({
              ...t,
              href: t.label === "旧版人神界称号" ? "/admin/users?title=c&order=sum" : "/admin/users?title=m&order=sum",
            }))}
            centerLabel="已存偏好玩家"
            mergeSmall={false}
          />
          <div className="admin_hint" style={{ marginTop: 10 }}>
            口径：只统计资料保存过的账号（user_info 有行才建偏好；站内无会话表，无法按「已登录」精确圈定）。
            未设置偏好按军衔制渲染，因此「旧版」占比 = 主动切换旧版称号的玩家比例。
          </div>
        </AdminCard>

        <AdminCard title="录像软件分布" more="按录像解析">
          <Donut
            items={softwares.map((s) => ({ ...s, label: s.label || "未记录" }))}
            centerLabel="录像总数"
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
                  <th>称号</th>
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
