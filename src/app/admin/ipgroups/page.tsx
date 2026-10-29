// 管理后台 · 同 IP 账号组（2026-10-19 防小号）
// IP 关联仅人工参考，不做自动处置；学校机房/网吧/家庭同 IP 属正常现象。
// 维度默认「最近登录 IP」（存量账号随登录逐步积累），可切「注册 IP」；
// 点 IP 进入展开态看该组全量成员；筛选状态全走 URL（可分享、可后退）。

import Link from "next/link";
import { PlayerTip } from "@/components/Cells";
import { Suspense } from "react";
import { getSession } from "@/lib/auth";
import { getIpGroups } from "@/lib/admin/data";
import { AdminCard, AdminPager, Kpi } from "@/components/admin/Widgets";
import { AdminFilters } from "@/components/admin/AdminFilters";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "同 IP 账号组 | 管理后台" };

type SP = Record<string, string | undefined>;

export default async function AdminIpGroupsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const { rows, total, pageSize, stats, expanded } = await getIpGroups({
    dim: sp.dim,
    min: sp.min,
    q: sp.q,
    onlyUnranked: sp.only,
    page,
  });

  const baseParams = new URLSearchParams();
  for (const k of ["dim", "min", "only"] as const) {
    if (sp[k]) baseParams.set(k, sp[k] as string);
  }
  const groupBase = `/admin/ipgroups${baseParams.toString() ? `?${baseParams.toString()}` : ""}`;
  const dimLabel = sp.dim === "register" ? "注册 IP" : "最近登录 IP";

  return (
    <>
      <div className="admin_page_head">
        <h1>防小号 · 同 IP 账号组</h1>
        <span className="sub">
          IP 关联仅人工参考 · 学校机房 / 网吧 / 家庭同 IP 属正常现象 · 处置永远人工决定
        </span>
      </div>

      <div className="admin_kpis">
        <Kpi label="今日新注册" value={stats.todayNew} tone="green" />
        <Kpi label="今日新注册 IP" value={stats.todayIps} tone="cyan" />
        <Kpi label={`同 IP 组（≥2）· ${dimLabel}`} value={stats.groups2} tone="yellow" />
        <Kpi label={`同 IP 组（≥5）· ${dimLabel}`} value={stats.groups5} tone="orange" />
        <Kpi label="最大组账号数" value={stats.maxGroup} tone={stats.maxGroup >= 5 ? "red" : "grey"} />
      </div>

      <AdminCard tight>
        <Suspense fallback={<div className="admin_filterbar">筛选加载中…</div>}>
          <AdminFilters
            fields={[
              { name: "q", type: "search", placeholder: "输入完整 IPv4 精确查询" },
              {
                name: "dim",
                type: "select",
                prefix: "维度",
                options: [
                  ["", "最近登录 IP"],
                  ["register", "注册 IP"],
                ],
              },
              {
                name: "min",
                type: "select",
                prefix: "组内账号",
                options: [
                  ["", "≥ 2 个"],
                  ["3", "≥ 3 个"],
                  ["5", "≥ 5 个"],
                ],
              },
              {
                name: "only",
                type: "select",
                prefix: "范围",
                options: [
                  ["", "全部组"],
                  ["1", "只看全部无成绩的组"],
                ],
              },
            ]}
          />
        </Suspense>

        {expanded ? (
          <ExpandedGroup q={sp.q as string} data={rows} />
        ) : (
          <div className="admin_scroll">
            <table className="admin_table">
              <thead>
                <tr>
                  <th>IP</th>
                  <th className="num">账号数</th>
                  <th className="num">无成绩</th>
                  <th className="num">今日注册</th>
                  <th>注册跨度</th>
                  <th>组内账号</th>
                  <th>标签</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ group: g, members }) => {
                  const sameDay =
                    g.count >= 2 &&
                    formatDate(g.firstReg, "Y-m-d") === formatDate(g.lastReg, "Y-m-d");
                  const show = members.slice(0, 6);
                  const rest = members.length - show.length;
                  return (
                    <tr key={g.ip}>
                      <td className="mono">
                        <Link className="link" href={`${groupBase}${groupBase.includes("?") ? "&" : "?"}q=${encodeURIComponent(g.ip)}`}>
                          {g.ip}
                        </Link>
                      </td>
                      <td className="num strong">{g.count}</td>
                      <td className="num">{g.unranked}</td>
                      <td className="num">{g.today}</td>
                      <td className="sub">
                        {formatDate(g.firstReg, "Y-m-d")}
                        {formatDate(g.firstReg, "Y-m-d") !== formatDate(g.lastReg, "Y-m-d") &&
                          ` ~ ${formatDate(g.lastReg, "Y-m-d")}`}
                      </td>
                      <td>
                        {show.map((m) => (
                          <span key={m.id} style={{ marginRight: 8, whiteSpace: "nowrap" }}>
                            <Link className="link" href={`/admin/users/${m.id}`}>
                              {m.chineseName}
                              <span className="pt_bubble">
                                <PlayerTip id={m.id} name={m.chineseName} englishName={m.englishName} />
                              </span>
                            </Link>
                            {!m.ranked && <span className="sub" title="无成绩">*</span>}
                          </span>
                        ))}
                        {rest > 0 && <span className="sub">等 {members.length} 个</span>}
                      </td>
                      <td>
                        <span className="admin_tags">
                          {sameDay && <span className="admin_tag bad">同日 {g.count} 号</span>}
                          {g.count >= 5 && <span className="admin_tag bad">疑似批量</span>}
                          {g.unranked === g.count && <span className="admin_tag warn">全部无成绩</span>}
                          {!sameDay && g.count < 5 && g.unranked < g.count && (
                            <span className="admin_tag plain">跨度正常</span>
                          )}
                        </span>
                      </td>
                      <td className="ops">
                        <Link
                          className="admin_btn sm"
                          href={`${groupBase}${groupBase.includes("?") ? "&" : "?"}q=${encodeURIComponent(g.ip)}`}
                        >
                          查看
                        </Link>
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={8}>
                      <div className="admin_empty">没有命中的 IP 组</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        <AdminPager base="/admin/ipgroups" params={sp} page={page} total={total} pageSize={pageSize} />
      </AdminCard>

      <AdminCard title="口径说明">
        <div className="admin_note">
          · <b>维度</b>：「最近登录 IP」（<code>user.last_login_ip</code>）每次登录实时刷新，存量老账号随登录逐步积累，默认维度；「注册 IP」（<code>user.register_ip</code>）2026-10-19 起新注册才落库。<br />
          · <b>标签</b>：命中才显示——「同日 N 号」＝组内全部账号同一天注册；「疑似批量」＝组内 ≥5 号；「全部无成绩」＝组内没有任何上榜成绩。<br />
          · <b>同 IP ≠ 小号</b>：同一学校机房、网吧出口、家庭宽带都会同 IP；带 <span className="sub">*</span> 的账号表示无成绩，仅作排查参考。<br />
          · 注册侧配套：同 IP 每分钟 5 次注册尝试、每天 3 个账号上限（邮箱与扫码注册共用），详见 <Link className="link" href="/admin/logs">操作日志</Link>。
        </div>
      </AdminCard>
    </>
  );
}

/** 精确查询态：单组全量成员展开 */
function ExpandedGroup({ q, data }: { q: string; data: Awaited<ReturnType<typeof getIpGroups>>["rows"] }) {
  const members = data[0]?.members ?? [];
  return (
    <div className="admin_scroll">
      <div className="admin_note" style={{ margin: "10px 16px 0" }}>
        精确查询 <b className="mono">{q}</b> · 共 {members.length} 个账号（数据源：最近登录 IP / 注册 IP 维度见上方筛选）
      </div>
      <table className="admin_table" style={{ marginTop: 8 }}>
        <thead>
          <tr>
            <th className="c">ID</th>
            <th>玩家</th>
            <th>账号</th>
            <th>注册时间</th>
            <th>最近登录</th>
            <th className="c">成绩</th>
            <th className="c">状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id} className={m.status !== 0 ? "off" : undefined}>
              <td className="c sub">{m.id}</td>
              <td>
                <Link className="link" href={`/admin/users/${m.id}`}>
                  {m.chineseName}
                  <span className="pt_bubble">
                    <PlayerTip id={m.id} name={m.chineseName} englishName={m.englishName} />
                  </span>
                </Link>
                {m.englishName && <span className="sub"> {m.englishName}</span>}
              </td>
              <td className="sub">{m.username || "—"}</td>
              <td className="sub">{m.createTime ? formatDate(m.createTime, "Y-m-d H:i") : "—"}</td>
              <td className="sub">{m.lastLoginTime ? formatDate(m.lastLoginTime, "Y-m-d H:i") : "—"}</td>
              <td className="c">{m.ranked ? <span className="admin_tag ok">已上榜</span> : <span className="admin_tag plain">无</span>}</td>
              <td className="c">
                {m.status === 0 ? (
                  <span className="admin_tag ok">正常</span>
                ) : (
                  <span className="admin_tag bad">已封禁</span>
                )}
              </td>
              <td className="ops">
                <Link className="admin_btn sm" href={`/admin/users/${m.id}`}>
                  详情
                </Link>
              </td>
            </tr>
          ))}
          {members.length === 0 && (
            <tr>
              <td colSpan={8}>
                <div className="admin_empty">没有命中的账号</div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
