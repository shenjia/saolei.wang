// 管理后台 · 对决统计（2026-11-11 张老师定）：VS 板块（/vs/:id）对决数据。
// 从仪表盘「今日对决」KPI（原「今日胜负」）点击进入：趋势图（近 30 天）+ 右侧「发起 Top10 /
// 被对决 Top10」+ 底部最近对决记录（发起时间 / 发起者 / 是否本人 /
// 挑战者 / 比分 | 结果 | 比分 三列 / 被挑战者 / 操作；结果列只放胜负平标签，比分列
// 表头置空：左=挑战者得分，右=被挑战者得分；「观看」直达 /vs/{挑战者}/
// {被挑战者} 旁观对局，旁观不落库）。
// 发起者口径（2026-11-14 修）：＝initiator_id（访问对决页的登录者），**不一定是
// 参赛双方**——指定 A、B 两人 PK 的旁观对决发起者仍是访问者本人（2026-11-13
// 张老师定口径；此前发起者/Top10/KPI 全按 user_id=参赛方1 显示，旁观行被误显示成参赛方1 发起）。
// 数据源 vs_duel（page_view 历史回填行比分/结果为 NULL，亮灰 —）。

import Link from "next/link";
import { AdminCard, AdminPager } from "@/components/admin/Widgets";
import { BarList, TrendChart, type Series } from "@/components/admin/Charts";
import { RelTime } from "@/components/RelTime";
import { formatDate } from "@/lib/format";
import { title as militaryTitle } from "@/lib/assess";
import { getThunderKingThreshold } from "@/lib/title-system";
import { TitleBadge } from "@/components/TitleBadge";
import { getVsDuelsOverview, getVsRecentDuels, getVsTopLaunchers, getVsTopTargets } from "@/lib/admin/vsstats";

export const dynamic = "force-dynamic";
export const metadata = { title: "对决统计 | 管理后台" };

type SP = Record<string, string | undefined>;

// Top10 统计范围筛选（2026-11-12 张老师）：今天 / 近 7 天 / 近 30 天，默认今天；
// 走 URL searchParams 便于分享与回退，两个 Top10 共用一档
const RANGES: number[] = [1, 7, 30];
const RANGE_LABEL: Record<number, string> = { 1: "今天", 7: "近 7 天", 30: "近 30 天" };

export default async function AdminVsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const rangeQ = parseInt(sp.range ?? "1", 10);
  const range = RANGES.includes(rangeQ) ? rangeQ : 1;
  const [ov, launchers, targets, recentPg, kTh] = await Promise.all([
    getVsDuelsOverview(),
    getVsTopLaunchers(range),
    getVsTopTargets(range),
    // 最近对决记录分页（2026-11-11 张老师：每页 50 条）
    getVsRecentDuels(page, 50),
    // 总司令动态阈值（军衔评定与全站同口径，单次查询）
    getThunderKingThreshold(),
  ]);
  const { rows: recent, total, pageSize } = recentPg;

  const series: Series[] = [
    { key: "duels", label: "对决次数", color: "#ae81ff", values: ov.trend, estimate: ov.todayEst },
  ];

  // 对决记录表玩家格（2026-11-11 09:56 张老师）：
  // · 发起者：只渲染「姓名 #ID」（不加性别/军衔），ID 放姓名后面；
  // · 挑战者/被挑战者：姓名 + 性别图标 + 军衔徽章（TitleBadge，军衔按
  //   user_scores.exp_time 快照评定，与全站同口径；总司令=快照快于动态阈值档）。
  // Top10 聚合榜非「对战双方」，保持原样
  const launcherUser = (uid: number, name: string) => (
    <span style={{ whiteSpace: "nowrap" }}>
      <Link className="link" href={`/admin/users/${uid}`}>
        {name}
      </Link>
      <span className="sub" style={{ marginLeft: 6 }}>
        #{uid}
      </span>
    </span>
  );
  const duelUser = (uid: number, name: string, sex: number, exp: number | null) => (
    <span style={{ whiteSpace: "nowrap" }}>
      <Link className="link" href={`/admin/users/${uid}`}>
        {name}
      </Link>
      <span
        className={`gender ${sex ? "male" : "female"} small`}
        style={{ margin: "0 4px 0 7px", verticalAlign: "-2px" }}
        aria-label={sex ? "男" : "女"}
      />
      <TitleBadge title={militaryTitle(exp, kTh)} />
    </span>
  );

  // 比分/结果展示（发起者视角）：回填行（NULL）亮灰 —。
  // 2026-11-11 09:55 张老师：比分拆开放在结果标签左右——左=挑战者得分（默认
  // 即发起者，故取 s1），右=被挑战者得分（s2）；胜方比分金色、负方亮灰
  // （平局双方不着色）。
  const fmtScore = (s: number | null) => (s === null ? "—" : s.toFixed(2));
  const GOLD = "#ffd700";
  const RESULT_TAG: Record<number, { cls: string; label: string }> = {
    1: { cls: "ok", label: "胜" },
    2: { cls: "bad", label: "负" },
    0: { cls: "plain", label: "平" },
  };
  /** 单个比分着色：win=true 胜方金 / false 负方灰 / null（平局或无结果）不着色 */
  const scoreSpan = (s: number | null, win: boolean | null) => {
    if (s === null) return <span className="gray">—</span>;
    if (win === null) return <span className="strong mono">{fmtScore(s)}</span>;
    return (
      <span className={`strong mono${win ? "" : " gray"}`} style={win ? { color: GOLD } : undefined}>
        {fmtScore(s)}
      </span>
    );
  };

  return (
    <>
      <div className="admin_page_head">
        <h1>对决统计</h1>
        <span className="sub">
          VS 板块（/vs/:id）对决数据 · 近 30 天 {ov.d30.toLocaleString("zh-CN")} 场 · KPI 口径：一次对决页访问 = 一次对决 · 趋势缓存 5 分钟
        </span>
        {/* Top10 范围筛选（2026-11-12 张老师）：上移至页头右端复用行高，不压缩下方板块高度；
            只作用于两个 Top10（趋势图固定近 30 天） */}
        <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <span className="sub" style={{ fontSize: 12 }}>Top10 范围</span>
          {RANGES.map((v) => (
            <Link
              key={v}
              href={`/admin/vs?range=${v}`}
              className={`admin_btn sm${v === range ? " primary" : ""}`}
            >
              {RANGE_LABEL[v]}
            </Link>
          ))}
        </span>
      </div>

      {/* ---------- 趋势图 + 两个 Top10 三板块并列一行（2026-11-11 10:26 张老师；
              14:44 张老师：趋势图水平宽度改 50%，Top10 弹性均分剩余宽度，窄屏自动换行；
              2026-11-12 张老师：Top10 加范围筛选（今天/7天/30天，默认今天），
              筛选器放页头右端不占板块高度，三板块保持平铺对齐 ---------- */}
      <div style={{ display: "flex", gap: 14, alignItems: "stretch", flexWrap: "wrap" }}>
        <div style={{ flex: "0 0 50%", minWidth: 0 }}>
          <AdminCard
            title="对决趋势（近 30 天）"
            more="今日点为按上周同时段预估（虚线）"
            className="h100"
          >
            <TrendChart dates={ov.dates} series={series} unit="场" />
          </AdminCard>
        </div>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <AdminCard title={`发起对决最多（${RANGE_LABEL[range]} Top10）`} className="h100">
            <BarList
              items={launchers.map((u) => ({
                label: u.name,
                value: u.count,
                href: `/admin/users/${u.uid}`,
                hint: `#${u.uid}`,
              }))}
              color="linear-gradient(90deg,#6b4f8b,#ae81ff)"
            />
          </AdminCard>
        </div>
        <div style={{ flex: "1 1 220px", minWidth: 0 }}>
          <AdminCard title={`被对决最多（${RANGE_LABEL[range]} Top10）`} className="h100">
            <BarList
              items={targets.map((u) => ({
                label: u.name,
                value: u.count,
                href: `/admin/users/${u.uid}`,
                hint: `#${u.uid}`,
              }))}
              color="linear-gradient(90deg,#8b4f6f,#e34f8c)"
            />
          </AdminCard>
        </div>
      </div>

      {/* ---------- 最近对决记录 ---------- */}
      <AdminCard
        title="最近对决记录"
        more={`共 ${total.toLocaleString("zh-CN")} 场 · 每页 ${pageSize} 条 · 比分/结果为发起当时快照（左分=挑战者，右分=被挑战者）；发起者＝访问对决页的登录者（旁观他人对决也算）；历史回填行亮灰 —`}
        tight
      >
        <div className="admin_scroll">
          {/* 10:39/11:21 张老师：空列前加「操作」列（观看按钮直达
              /vs/{挑战者}/{被挑战者} 旁观，旁观不落库）；空列吸收余宽 30%，
              窄屏隐藏（admin_table.vs_recent，行线延伸与趋势卡右缘对齐）。
              12:16 张老师：比分与结果拆成三列——左比分（挑战者）+ 结果标签
              （只放胜负平）+ 右比分（被挑战者），比分列表头置空。
              14:13 张老师：发起者列与发起时间列互换（发起者在前），发起时间暗灰。
              14:55 张老师：挑战者左加「是否本人」列（发起者∈对决双方判定，亮绿是/
              暗灰否；指定匹配上线后发起者可能是第三人，判定已按数据驱动预留）。
              15:49 张老师：发起时间与发起者对调（发起时间在前） */}
          <table className="admin_table vs_recent">
            <thead>
              <tr>
                <th>发起时间</th>
                <th>发起者</th>
                <th className="c">是否本人</th>
                <th>挑战者</th>
                <th className="c"></th>
                <th className="c">结果</th>
                <th className="c"></th>
                <th>被挑战者</th>
                <th className="c">操作</th>
                <th className="sp"></th>
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 && (
                <tr>
                  <td colSpan={10} className="gray">
                    暂无对决记录（VS 页访问后开始落库）
                  </td>
                </tr>
              )}
              {recent.map((d) => {
                const tag = d.result === null ? null : RESULT_TAG[d.result];
                // 是否本人（14:55 张老师）：发起者是否对决双方之一——是=亮绿，否=暗灰。
                // 2026-11-13 起发起者＝访问者，指定 A、B 两人 PK 的旁观对决自然为「否」
                const isOwn = d.ini === d.u1 || d.ini === d.u2;
                return (
                  <tr key={d.id}>
                    {/* 发起时间（15:49 张老师对调：发起时间在前）：暗灰显示 */}
                    <td className="gray" title={formatDate(d.time, "Y-m-d H:i:s")}>
                      <RelTime time={d.time} />
                    </td>
                    {/* 发起者（09:56 张老师）：只渲染姓名 + #ID，不带性别/军衔；
                        2026-11-14 修：取 initiator_id（访问者），不再恒等于参赛方1 */}
                    <td>{launcherUser(d.ini, d.ni)}</td>
                    {/* 是否本人（14:55 张老师）：亮绿「是」/ 暗灰「否」 */}
                    <td className="c">
                      {isOwn ? (
                        <span className="strong" style={{ color: "#a6e22e" }}>是</span>
                      ) : (
                        <span className="gray">否</span>
                      )}
                    </td>
                    {/* 挑战者＝参赛方1（页面左）：与发起者解耦（旁观对决发起者是第三人） */}
                    <td>{duelUser(d.u1, d.n1, d.sex1, d.exp1)}</td>
                    <td className="c">{scoreSpan(d.s1, tag === null || tag.cls === "plain" ? null : tag.cls === "ok")}</td>
                    {/* 结果（12:16 张老师）：只放胜负平标签，比分拆到两侧列 */}
                    <td className="c">
                      {tag ? (
                        <span className={`admin_tag ${tag.cls}`}>{tag.label}</span>
                      ) : (
                        <span className="gray">—</span>
                      )}
                    </td>
                    <td className="c">{scoreSpan(d.s2, tag === null || tag.cls === "plain" ? null : tag.cls === "bad")}</td>
                    <td>{duelUser(d.u2, d.n2, d.sex2, d.exp2)}</td>
                    {/* 观看（11:21 张老师）：直达双方对决页旁观（/vs/[id]/[bid]，不落库） */}
                    <td className="c">
                      <Link
                        className="admin_btn sm"
                        href={`/vs/${d.u1}/${d.u2}`}
                        target="_blank"
                        rel="noopener"
                        prefetch={false}
                      >
                        观看
                      </Link>
                    </td>
                    <td className="sp"></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {/* 分页（2026-11-11 张老师）：searchParams 传页码，与后台其他列表页同款 AdminPager；
            range 一并透传，翻页时保持 Top10 范围 */}
        <AdminPager base="/admin/vs" params={{ range }} page={page} total={total} pageSize={pageSize} />
      </AdminCard>
    </>
  );
}
