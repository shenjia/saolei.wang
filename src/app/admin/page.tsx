// 管理后台 · 仪表盘（2026-09-24；2026-10-16 加流量统计区块；2026-10-21 加称号体系偏好 + 占比图全面换环形 Donut；
// 2026-10-23 张老师定：KPI 首行收敛为 6 卡——流量同比只留百分比、练习两行（人参与/近7天盘数）、
// 注册两行（今日/近7天）、活跃只留今日、「上传录像」只留今日、论坛主题卡下线；
// 2026-11-01 张老师定：首行加第 7 卡「API 调用」；PV/UV 剔除爬虫（零行为访客，口径见 traffic.ts 头注）；
// 2026-11-04 概览 KPI + 30 天趋势挂 5 分钟缓存（getOverview/getTrend 冷跑数秒是进页慢的根因）；
// 2026-11-06 张老师定：待审类「审核即消费」数字不进缓存，getPendingOverview 实时取）
// 一屏掌握：规模指标（KPI）→ 30 天趋势 → 流量统计 → 待办与分布 → 最新动态。

import Link from "next/link";
import { PlayerTip } from "@/components/Cells";
import { TREND_METRICS } from "@/lib/admin/stats";
import { getTrafficOverview, getApiUsage, DEVICE_NAMES, REFERRER_NAMES, type ExitPage } from "@/lib/admin/traffic";
import { practiceCusClean } from "@/lib/admin/practice";
import { getDashboardDistributionsSoftwares, getCachedAnomalies, getCachedOverview, getCachedTrend30, getCachedIpGroupSummary } from "@/lib/admin/cache";
import { getPendingOverview } from "@/lib/admin/stats";
import { getVsDuelsOverview } from "@/lib/admin/vsstats";
import { getOpenmsSyncStatus } from "@/lib/admin/openms-sync";
import { OpenmsSyncCard } from "@/components/admin/OpenmsSyncCard";
import { getLatestUsers, getLatestVideosBrief } from "@/lib/admin/data";
import { TrendChart, BarList, Donut, type Series } from "@/components/admin/Charts";
import { AdminCard, Kpi, LevelTag, StatusTag } from "@/components/admin/Widgets";
import { TitleBadge } from "@/components/Cells";
import { formatDate, scoreTime } from "@/lib/format";
import { RelTime } from "@/components/RelTime";

export const dynamic = "force-dynamic";
export const metadata = { title: "仪表盘 | 管理后台" };

export default async function AdminDashboard() {
  // 分两波取数：重的全表聚合走缓存且在内部串行，轻的实时查询并行
  // （2026-10-21 称号/地区分布卡下线，dashboard-distributions 只剩软件分布 + 称号偏好）
  // 2026-11-04 张老师要求：仪表盘进页要几秒 → 概览 KPI + 30 天趋势也挂 5 分钟缓存，
  // 与分布/流量/API/异常一致；轻量「最新注册/最新上传」仍实时
  // 2026-11-06 张老师定：待审类「审核即消费」的数字（录像/评论/论坛/头像待审 + 最老积压）
  // 不进缓存，getPendingOverview 实时取后与缓存核心合并——审完回页数字立即消
  const [core, trend, dist, traffic, api, pending, vsDuels, openmsSync] = await Promise.all([
    getCachedOverview(),
    getCachedTrend30(),
    getDashboardDistributionsSoftwares(),
    getTrafficOverview(),
    getApiUsage(),
    getPendingOverview(),
    // VS 对决 KPI（2026-11-11 张老师定）：vs_duel 权威表口径，见 lib/admin/vsstats.ts
    getVsDuelsOverview(),
    // 2026-11-10 张老师定：同步状态卡实时取（不进 unstable_cache），首帧 RSC + 客户端 10s 轮询校准
    getOpenmsSyncStatus(),
  ]);
  const ov = { ...core, ...pending };
  const [anomalies, latestUsers, latestVideos, ipSummary] = await Promise.all([
    getCachedAnomalies(),
    getLatestUsers(8),
    getLatestVideosBrief(8),
    getCachedIpGroupSummary(),
  ]);
  const { softwares, titlePrefs } = dist;

  const series: Series[] = [
    // 流量两序列排最前（2026-10-16 张老师定：与业务趋势合并为一张图，默认只亮 UV/PV/新玩家/新录像）
    // 2026-11-02 加末点预估：今日未满一天按上周同时段占比外推全天，免得趋势图天天假跌
    { key: "uv", label: "UV", color: "#ae81ff", values: traffic.trend.uv, estimate: traffic.todayEst.uv },
    { key: "pv", label: "PV", color: "#f8f8f2", values: traffic.trend.pv, estimate: traffic.todayEst.pv },
    ...TREND_METRICS.map((m) => ({
      key: m.key,
      label: m.label,
      color: m.color,
      values: trend.series[m.key],
      estimate: trend.estimates[m.key],
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
    { label: "重复 hash 录像组", value: anomalies.duplicateHashGroups, href: "/admin/videos?dup=1", hint: "疑似重复上传" },
    { label: "有录像无成绩玩家", value: anomalies.scoreMissingUsers, href: "/admin/users", hint: "成绩异常" },
    // 2026-11-11 张老师定：同 IP 账号组列入待办（人工参考，不自动处置）；计数取最近登录 IP 维度 ≥2 组
    { label: "同 IP 账号组", value: ipSummary.groups2, href: "/admin/ipgroups", hint: "疑似小号·人工参考" },
  ];

  return (
    <>
      <div className="admin_page_head">
        <h1>仪表盘</h1>
        <span className="sub">
          数据截至 {formatDate(ov.now, "Y-m-d H:i")} · KPI 与趋势缓存 5 分钟 · 待审数字实时
        </span>
      </div>

      {/* ---------- 规模指标（2026-10-16 张老师定：第一行全带走势线；2026-11-01 加第 7 卡 API 调用；
          2026-11-11 张老师定：「开源扫雷网表态」卡下线（已正式绑定开始同步），
          「今日练习」后加「今日对决」卡（原「今日胜负」，14:16 张老师改名）——VS 板块对决统计；
          同日定：待人工审核卡并入本行、排在「API 调用」之前，独立第二行取消） ---------- */}
      <div className="admin_kpis">
        <Kpi
          label="今日 PV"
          value={traffic.today.pv}
          tone="cyan"
          trend={traffic.trend.pv}
          trendEstimate={traffic.todayEst.pv}
          foot={cmpFoot(traffic.today.pv, traffic.lastWeek.pv)}
        />
        <Kpi
          label="今日 UV"
          value={traffic.today.uv}
          tone="purple"
          trend={traffic.trend.uv}
          trendEstimate={traffic.todayEst.uv}
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
          trendEstimate={traffic.practice.todayEst}
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
        {/* 今日对决（2026-11-11 张老师定，14:16 改名）：VS 板块对决统计——一次 /vs/:id 页有效
            访问 = 一次对决（vs_duel 表，10 分钟窗口去重）；发起人数=去重发起者；
            点击进 /admin/vs 对决统计页 */}
        <Kpi
          label="今日对决"
          href="/admin/vs"
          value={
            <>
              {vsDuels.today.toLocaleString("zh-CN")}
              <small> 次 / {vsDuels.todayLaunchers} 人发起</small>
            </>
          }
          tone="purple"
          trend={vsDuels.trend}
          trendEstimate={vsDuels.todayEst}
          foot={cmpFoot(vsDuels.today, vsDuels.lastWeek)}
        />
        <Kpi
          label="注册玩家"
          value={ov.userTotal}
          tone="green"
          trend={trend.series.users}
          trendEstimate={trend.estimates.users}
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
          trendEstimate={trend.estimates.videos}
          href="/admin/videos"
          foot={
            <>
              今日 <b>+{ov.videoToday}</b>
            </>
          }
        />
        {/* 待人工审核（2026-10-16 张老师定：只放需人工处理的队列，0 则不显示；
            2026-11-11 张老师定：并入首行、排在「API 调用」之前） */}
        {[
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
        ]
          .filter((p) => p.value > 0)
          .map((p) => (
            <Kpi key={p.label} label={p.label} value={p.value} tone="red" href={p.href} foot={p.foot || "待处理"} />
          ))}
        {/* API 调用（2026-11-01 张老师定）：合作方 API 分时用量，与 PV/UV 口径互不相干
            （埋点端拒收 /api/ 路径，API 从不进 page_view）；走势 30 天，foot 同比 + 在用 key 数 */}
        <Kpi
          label="API 调用"
          href="/admin/apikeys"
          value={api.today}
          tone="grey"
          trend={api.trend}
          trendEstimate={api.todayEst}
          foot={
            <>
              {cmpFoot(api.today, api.lastWeek)}
              <br />
              {api.todayKeys} 个 key 在用
            </>
          }
        />
      </div>

      {/* ---------- 开源扫雷网录像同步状态（2026-11-10 张老师定：只做首页概览卡、
          10 秒轮询、纯只读无干预操作；插在 KPI 行之后；2026-11-11 待审核行并入首行后紧随其后） ---------- */}
      <OpenmsSyncCard initial={openmsSync} />

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
            提示：待审录像必须「先下载观看再审核」（防盲审），系统会拒绝未下载的审核请求；免核定录像通过除外（批量/单个均免看）。
          </div>
        </AdminCard>

        {/* 趋势（2026-10-16 合并业务趋势与 PV/UV 访问趋势，x 轴同为 +08:00 切天） */}
        <AdminCard
          title="近 30 天趋势"
          more={
            <>
              <span className="sub">
                PV/UV 为 page_view 埋点 · 已剔除管理员与爬虫（零行为访客）· 今日点为按上周同时段预估（虚线）
              </span>
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

        <AdminCard title="落地页 Top" more="近 7 天 · 会话首个页面（动态 ID 已归类）">
          <BarList
            items={traffic.entryPages.d7.map((e) => ({
              label: e.path,
              value: e.entries,
            }))}
            color="linear-gradient(90deg,#6b4f8b,#ae81ff)"
          />
        </AdminCard>

        {/* 访问页 Top（2026-11-11 张老师定）：近 7 天全站页面 PV，去参数裸 URI 聚合 */}
        <AdminCard title="访问页 Top" more="近 7 天 · 全站页面 PV（去参数裸 URI，动态 ID 已归类）">
          <BarList
            items={traffic.topPages.map((p) => ({
              label: p.path,
              value: p.pv,
            }))}
            color="linear-gradient(90deg,#8b6b3d,#f0c040)"
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

        <AdminCard title="称号体系偏好" more="近 30 天登录玩家 · 10 分钟缓存 · 点击图例查看玩家列表">
          <Donut
            items={titlePrefs.map((t) => ({
              ...t,
              href: t.label === "旧版人神界称号" ? "/admin/users?title=c&order=sum" : "/admin/users?title=m&order=sum",
            }))}
            centerLabel="近30天登录"
            mergeSmall={false}
          />
          <div className="admin_hint" style={{ marginTop: 10 }}>
            口径：只统计近 30 天登录过（user.last_login_time）且资料保存过的账号（user_info 有行才建偏好）。
            未设置偏好按军衔制渲染，因此「旧版」占比 = 主动切换旧版称号的玩家比例。
          </div>
        </AdminCard>

        <AdminCard title="录像软件分布" more="近 7 天 · 按录像解析">
          <Donut
            items={softwares.map((s) => ({ ...s, label: s.label || "未记录" }))}
            centerLabel="最近1000盘"
          />
        </AdminCard>
      </div>

      {/* ---------- 最新注册 / 最新上传 ---------- */}
      {/* 2026-10-28 张老师要求：最新上传录像玩家列名字后加军衔（同左表称号口径） */}
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
                        <span className="pt_bubble">
                          <PlayerTip id={u.id} name={u.chineseName} englishName={u.englishName} />
                        </span>
                      </Link>
                      <span className="sub"> #{u.id}</span>
                      {u.status !== 0 && (
                        <span
                          className="admin_tag bad"
                          title={u.banUntil > 0 ? `至 ${formatDate(u.banUntil, "Y-m-d H:i")} 自动解禁` : "永久封禁"}
                        >
                          已封禁
                        </span>
                      )}
                    </td>
                    <td>
                      <TitleBadge title={u.title} />
                    </td>
                    <td className="num">{u.sumTime ? scoreTime(u.sumTime) : "—"}</td>
                    <td>
                      <span className="sub">{u.createTime ? <RelTime time={u.createTime} max={0} format="Y-m-d" /> : "—"}</span>
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
                      <Link className="link" href={`/video/${v.id}`} target="_blank" prefetch={false}>
                        {v.id}
                      </Link>
                    </td>
                    <td>
                      <Link className="link" href={`/admin/users/${v.user}`}>
                        {v.authorName}
                        <span className="pt_bubble">
                          <PlayerTip id={v.user} name={v.authorName} englishName={v.author?.englishName} />
                        </span>
                      </Link>{" "}
                      <TitleBadge title={v.authorTitle} />
                    </td>
                    <td className="c">
                      <LevelTag level={v.level} />
                    </td>
                    <td className="num strong">{v.realTime ? scoreTime(v.realTime) : "—"}</td>
                    <td className="c">
                      <StatusTag status={v.status} />
                    </td>
                    <td>
                      <span className="sub">{v.createTime ? <RelTime time={v.createTime} /> : "—"}</span>
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
