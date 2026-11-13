// 管理后台 · 比赛管理（2026-11-13 张老师需求）
// 清单置顶（状态 tab 筛选：全部/进行中/未开始/已结束，URL ?st= 承载）+ 发起比赛表单。
// 状态配色（张老师 11-13 定）：进行中绿 / 未开始金 / 已结束灰。
// 前台 /competitions 读同一份数据；列表排序与前台一致＝进行中 → 未开始 → 已结束。

import Link from "next/link";
import { prisma } from "@/lib/db";
import { compStatus } from "@/lib/competition";
import { AdminAction } from "@/components/admin/AdminAction";
import { RowEditButton } from "@/components/admin/RowEditButton";
import { AdminCard } from "@/components/admin/Widgets";
import { CompetitionForm } from "@/components/admin/CompetitionForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "比赛管理 | 管理后台" };

type StatusKey = ReturnType<typeof compStatus>;

/** Unix 秒 → 北京时间 "YYYY-MM-DD HH:mm"（+8h 后按 UTC 取字段，免时区歧义） */
function cstStr(sec: number): string {
  const d = new Date((sec + 8 * 3600) * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

const STATUS_LABEL = { active: "进行中", upcoming: "未开始", ended: "已结束" } as const;
/** 状态配色（2026-11-13 张老师定）：进行中绿 #a6e22e / 未开始金 #fdc61a / 已结束灰 */
const STATUS_COLOR = { active: "#a6e22e", upcoming: "#fdc61a", ended: "#939387" } as const;

const ST_TABS: { key: string; label: string }[] = [
  { key: "", label: "全部" },
  { key: "active", label: "进行中" },
  { key: "upcoming", label: "未开始" },
  { key: "ended", label: "已结束" },
];

export default async function AdminCompetitionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const st = sp.st === "active" || sp.st === "upcoming" || sp.st === "ended" ? sp.st : "";

  const now = Math.floor(Date.now() / 1000);
  const [all, counts] = await Promise.all([
    prisma.competition.findMany({ orderBy: { startTime: "asc" } }),
    prisma.competitionEntry.groupBy({ by: ["competitionId"], _count: { competitionId: true } }),
  ]);
  const countMap = new Map(counts.map((c) => [c.competitionId.toString(), c._count.competitionId]));

  // 发起人姓名一次取齐（发起人为后台填写，量小；查无此人兜底显示 #ID）
  const creatorIds = [...new Set(all.map((r) => r.creatorId.toString()))];
  const creators = await prisma.user.findMany({
    where: { id: { in: creatorIds.map((s) => BigInt(s)) } },
    select: { id: true, chineseName: true },
  });
  const creatorMap = new Map(creators.map((u) => [u.id.toString(), u.chineseName]));

  // 排序与前台一致：进行中 → 未开始 → 已结束；再按 tab 筛选
  const order = { active: 0, upcoming: 1, ended: 2 } as const;
  const sorted = [...all].sort((a, b) => {
    const sa = compStatus(a.startTime, a.endTime, now);
    const sb = compStatus(b.startTime, b.endTime, now);
    if (sa !== sb) return order[sa] - order[sb];
    return Number(b.startTime) - Number(a.startTime);
  });
  const rows = st ? sorted.filter((r) => compStatus(r.startTime, r.endTime, now) === st) : sorted;

  return (
    <>
      <div className="admin_page_head">
        <h1>比赛管理</h1>
        <span className="sub">
          前台 <a href="/competitions" target="_blank" rel="noopener noreferrer">saolei.wang/competitions</a>{" "}
          展示同一份数据 · 共 {rows.length} 场
        </span>
      </div>

      <AdminCard title="比赛清单" tight>
        {/* 状态筛选 tab（URL ?st= 承载，玩家管理页签同款惯例） */}
        <div className="admin_filterbar">
          {ST_TABS.map(({ key, label }) => (
            <Link
              key={key || "all"}
              href={key ? `/admin/competitions?st=${key}` : "/admin/competitions"}
              className={`admin_btn${st === key ? " on" : ""}`}
            >
              {label}
            </Link>
          ))}
        </div>
        <div className="admin_scroll">
          <table className="admin_table">
            <thead>
              <tr>
                <th className="c">ID</th>
                <th>比赛全名</th>
                <th>简称</th>
                <th>发起人</th>
                <th>开始时间（北京）</th>
                <th>结束时间（北京）</th>
                <th className="c">状态</th>
                <th className="c">报名数</th>
                <th className="c">总奖金</th>
                <th className="ops">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const stKey = compStatus(r.startTime, r.endTime, now);
                return (
                  <tr key={r.id.toString()}>
                    <td className="c sub">{r.id.toString()}</td>
                    <td>{r.name}</td>
                    <td className="sub">{r.shortName}</td>
                    <td className="sub">{creatorMap.get(r.creatorId.toString()) ?? `#${r.creatorId}`}</td>
                    <td className="mono" style={{ whiteSpace: "nowrap" }}>
                      {cstStr(Number(r.startTime))}
                    </td>
                    <td className="mono" style={{ whiteSpace: "nowrap" }}>
                      {cstStr(Number(r.endTime))}
                    </td>
                    <td className="c">
                      <span style={{ color: STATUS_COLOR[stKey] }}>{STATUS_LABEL[stKey]}</span>
                    </td>
                    <td className="c">{countMap.get(r.id.toString()) ?? 0}</td>
                    <td className="c" style={{ color: "#fdc61a" }}>¥{r.prizeTotal.toLocaleString("en-US")}</td>
                    <td className="ops">
                      <RowEditButton
                        event="sl-comp-edit"
                        detail={{
                          id: Number(r.id),
                          name: r.name,
                          shortName: r.shortName,
                          rules: r.rules,
                          creatorId: Number(r.creatorId),
                          prizeTotal: r.prizeTotal,
                          prizePlan: r.prizePlan,
                          startSec: Number(r.startTime),
                          endSec: Number(r.endTime),
                        }}
                      />{" "}
                      <AdminAction
                        op="competition.delete"
                        params={{ id: r.id.toString() }}
                        label="删除"
                        variant="danger"
                        confirm={`确认删除这场比赛？\n${r.name}（#${r.id}，报名记录一并删除，不可恢复）`}
                      />
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={10}>
                    <div className="admin_empty">
                      {st ? "该状态下暂无比赛" : "还没有比赛，用下方表单发起第一场"}
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </AdminCard>

      <AdminCard title="发起比赛">
        <div className="admin_note" style={{ marginBottom: 10 }}>
          起止时间按北京时间填写；比赛标识创建时自动生成（前台开始前显示「待定」）。成绩采集与奖金发放为下一期功能。
        </div>
        <CompetitionForm />
      </AdminCard>
    </>
  );
}
