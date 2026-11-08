// 管理后台 · 开源网表态明细（2026-11-08 张老师需求）
// 仪表盘「开源网表态」卡点击进入：分「同意 / 不同意 / 未表态」三组列出
// openms_link 全部绑定用户（96 人量级，一页全量，无分页）。
// 未表态在 2026-11-13 同步执行时视为不同意（口径同前台 OpenmsConsentModal / 同步脚本）。
// guard 在 admin/layout.tsx（requireAdmin），本页不重复。

import Link from "next/link";
import { prisma } from "@/lib/db";
import { PlayerTip } from "@/components/Cells";
import { AdminCard, Kpi } from "@/components/admin/Widgets";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "开源网表态明细 | 管理后台" };

export default async function AdminOpenmsConsentPage() {
  const links = await prisma.openmsLink.findMany({
    select: { user: true, consent: true, consentTime: true, createTime: true },
  });
  const users = await prisma.user.findMany({
    where: { id: { in: links.map((l) => l.user) } },
    select: { id: true, chineseName: true, englishName: true },
  });
  const nameOf = new Map(users.map((u) => [u.id, u]));

  // 已表态按表态时间倒序（最新在前）；未表态按绑定时间倒序
  const agreed = links
    .filter((l) => l.consent === 1)
    .sort((a, b) => Number(b.consentTime - a.consentTime));
  const disagreed = links
    .filter((l) => l.consent === 2)
    .sort((a, b) => Number(b.consentTime - a.consentTime));
  const unans = links
    .filter((l) => l.consent === 0)
    .sort((a, b) => Number(b.createTime - a.createTime));

  const UserCell = ({ user }: { user: bigint }) => {
    const u = nameOf.get(user);
    return (
      <Link className="link" href={`/admin/users/${user}`}>
        {u?.chineseName ?? `#${user}`}
        <span className="pt_bubble">
          <PlayerTip id={Number(user)} name={u?.chineseName ?? `#${user}`} englishName={u?.englishName} />
        </span>
      </Link>
    );
  };

  const ListTable = ({
    rows,
    timeLabel,
    timeOf,
  }: {
    rows: { user: bigint; consentTime: bigint; createTime: bigint }[];
    timeLabel: string;
    timeOf: (r: { consentTime: bigint; createTime: bigint }) => bigint;
  }) => (
    <div className="admin_scroll">
      <table className="admin_table">
        <thead>
          <tr>
            <th className="num" style={{ width: 50 }}>
              #
            </th>
            <th>玩家</th>
            <th>{timeLabel}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.user}>
              <td className="num sub">{i + 1}</td>
              <td>
                <UserCell user={r.user} />
              </td>
              <td className="sub">
                {Number(timeOf(r)) > 0 ? formatDate(Number(timeOf(r)), "Y-m-d H:i") : "—"}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={3}>
                <div className="admin_empty">暂无</div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <div className="admin_page_head">
        <h1>开源网表态明细</h1>
        <span className="sub">
          开源扫雷网（openms.top）绑定用户的录像同步征求表态 · 共 {links.length} 人 · 实时数据 ·{" "}
          <Link className="link" href="/admin">
            返回仪表盘
          </Link>
        </span>
      </div>

      <div className="admin_kpis">
        <Kpi label="已表态" value={agreed.length + disagreed.length} tone="cyan" foot={`共 ${links.length} 人绑定`} />
        <Kpi label="同意" value={agreed.length} tone="green" foot="仅明确同意才同步" />
        <Kpi label="不同意" value={disagreed.length} tone="red" foot="历史录像不同步" />
        <Kpi label="未表态" value={unans.length} tone="grey" foot="11-13 同步时视为不同意" />
      </div>

      <AdminCard title={`同意（${agreed.length}）`}>
        <ListTable rows={agreed} timeLabel="表态时间" timeOf={(r) => r.consentTime} />
      </AdminCard>

      <AdminCard title={`不同意（${disagreed.length}）`}>
        <ListTable rows={disagreed} timeLabel="表态时间" timeOf={(r) => r.consentTime} />
      </AdminCard>

      <AdminCard title={`未表态（${unans.length}）· 11-13 同步时视为不同意`}>
        <ListTable rows={unans} timeLabel="绑定时间" timeOf={(r) => r.createTime} />
      </AdminCard>
    </>
  );
}
