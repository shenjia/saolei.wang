// 管理后台 · 对决统计（2026-11-11 张老师定）：VS 板块（/vs/:id）对决数据。
// 从仪表盘「今日胜负」KPI 点击进入：趋势图（近 30 天）+ 右侧「发起 Top10 /
// 被对决 Top10」（近 7 天）+ 底部最近对决记录（发起时间 / 谁对谁 / 比分 / 结果）。
// 数据源 vs_duel（page_view 历史回填行比分/结果为 NULL，亮灰 —）。

import Link from "next/link";
import { AdminCard } from "@/components/admin/Widgets";
import { BarList, TrendChart, type Series } from "@/components/admin/Charts";
import { RelTime } from "@/components/RelTime";
import { formatDate } from "@/lib/format";
import { getVsDuelsOverview, getVsRecentDuels, getVsTopLaunchers, getVsTopTargets } from "@/lib/admin/vsstats";

export const dynamic = "force-dynamic";
export const metadata = { title: "对决统计 | 管理后台" };

export default async function AdminVsPage() {
  const [ov, launchers, targets, recent] = await Promise.all([
    getVsDuelsOverview(),
    getVsTopLaunchers(7),
    getVsTopTargets(7),
    getVsRecentDuels(50),
  ]);

  const series: Series[] = [
    { key: "duels", label: "对决次数", color: "#ae81ff", values: ov.trend, estimate: ov.todayEst },
  ];

  const userLink = (uid: number, name: string) => (
    <Link className="link" href={`/admin/users/${uid}`}>
      {name}
      <span className="sub"> #{uid}</span>
    </Link>
  );

  // 比分/结果展示（发起者视角）：回填行（NULL）亮灰 —
  const fmtScore = (s: number | null) => (s === null ? "—" : s.toFixed(2));
  const RESULT_TAG: Record<number, { cls: string; label: string }> = {
    1: { cls: "ok", label: "发起者胜" },
    2: { cls: "bad", label: "对方胜" },
    0: { cls: "plain", label: "平局" },
  };

  return (
    <>
      <div className="admin_page_head">
        <h1>对决统计</h1>
        <span className="sub">
          VS 板块（/vs/:id）对决数据 · 近 30 天 {ov.d30.toLocaleString("zh-CN")} 场 · KPI 口径：一次对决页访问 = 一次对决 · 趋势缓存 5 分钟
        </span>
      </div>

      {/* ---------- 趋势图 + 右侧两个 Top10 板块 ---------- */}
      <div style={{ display: "flex", gap: 14, alignItems: "stretch", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 640px", minWidth: 0 }}>
          <AdminCard
            title="对决趋势（近 30 天）"
            more="今日点为按上周同时段预估（虚线）"
            className="h100"
          >
            <TrendChart dates={ov.dates} series={series} unit="场" />
          </AdminCard>
        </div>
        <div style={{ flex: "0 0 340px", minWidth: 300, display: "flex", flexDirection: "column", gap: 14 }}>
          <AdminCard title="发起对决最多（近 7 天 Top10）" className="h100">
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
          <AdminCard title="被对决最多（近 7 天 Top10）" className="h100">
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
        more="最近 50 场 · 比分/结果为发起当时快照；历史回填行亮灰 —"
        tight
      >
        <div className="admin_scroll">
          <table className="admin_table">
            <thead>
              <tr>
                <th>发起时间</th>
                <th>发起者</th>
                <th>被挑战者</th>
                <th className="num">比分（发起 : 对方）</th>
                <th className="c">结果</th>
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 && (
                <tr>
                  <td colSpan={5} className="gray">
                    暂无对决记录（VS 页访问后开始落库）
                  </td>
                </tr>
              )}
              {recent.map((d) => {
                const tag = d.result === null ? null : RESULT_TAG[d.result];
                return (
                  <tr key={d.id}>
                    <td title={formatDate(d.time, "Y-m-d H:i:s")}>
                      <RelTime time={d.time} />
                    </td>
                    <td>{userLink(d.u1, d.n1)}</td>
                    <td>{userLink(d.u2, d.n2)}</td>
                    <td className="num strong mono">
                      {d.s1 === null || d.s2 === null ? (
                        <span className="gray">— : —</span>
                      ) : (
                        <>
                          {fmtScore(d.s1)} : {fmtScore(d.s2)}
                        </>
                      )}
                    </td>
                    <td className="c">
                      {tag ? (
                        <span className={`admin_tag ${tag.cls}`}>{tag.label}</span>
                      ) : (
                        <span className="gray">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </AdminCard>
    </>
  );
}
