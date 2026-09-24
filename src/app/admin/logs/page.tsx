// 管理后台 · 操作日志（2026-09-24）
// 后台所有写操作的留痕：谁、何时、对谁、做了什么、来源 IP。可按动作与关键词筛。

import Link from "next/link";
import { Suspense } from "react";
import { getAdminLogs, getLogActions } from "@/lib/admin/data";
import { opLabel } from "@/lib/admin/log";
import { AdminFilters } from "@/components/admin/AdminFilters";
import { AdminCard, AdminPager } from "@/components/admin/Widgets";
import { formatDate, timeOpposite } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "操作日志 | 管理后台" };

type SP = Record<string, string | undefined>;

export default async function AdminLogsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const [{ rows, total, pageSize }, actions] = await Promise.all([
    getAdminLogs({ q: sp.q, action: sp.action, page }),
    getLogActions(),
  ]);

  return (
    <>
      <div className="admin_page_head">
        <h1>操作日志</h1>
        <span className="sub">共 {total.toLocaleString("zh-CN")} 条记录 · 后台所有写操作均在留痕</span>
      </div>

      <AdminCard tight>
        <Suspense fallback={<div className="admin_filterbar">筛选项加载中…</div>}>
          <AdminFilters
            fields={[
              { name: "q", type: "search", placeholder: "操作人 ID / 目标 ID / 说明关键词" },
              {
                name: "action",
                type: "select",
                prefix: "动作",
                options: [
                  ["", "全部动作"],
                  ...actions.map((a) => [a.action, `${opLabel(a.action)}（${a.count}）`] as [string, string]),
                ],
              },
            ]}
          />
        </Suspense>

        <div className="admin_scroll">
          <table className="admin_table">
            <thead>
              <tr>
                <th className="c">ID</th>
                <th>时间</th>
                <th>操作人</th>
                <th>动作</th>
                <th>说明</th>
                <th>目标</th>
                <th>来源 IP</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => (
                <tr key={l.id}>
                  <td className="c sub">{l.id}</td>
                  <td className="sub" title={formatDate(l.createTime, "Y-m-d H:i:s")}>
                    {timeOpposite(l.createTime, 7 * 86400, "Y-m-d H:i")}
                  </td>
                  <td>
                    {l.author ? (
                      <Link className="link" href={`/admin/users/${l.user}`}>
                        {l.author.chineseName}
                      </Link>
                    ) : (
                      <span className="sub">#{l.user}</span>
                    )}
                  </td>
                  <td>
                    <span className="admin_tag plain">{opLabel(l.action)}</span>
                  </td>
                  <td style={{ maxWidth: 460 }}>{l.detail || "—"}</td>
                  <td className="sub">
                    {l.target ? (
                      <>
                        {l.target}
                        {l.targetId ? ` #${l.targetId}` : ""}
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="sub mono">{l.ip || "—"}</td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <div className="admin_empty">还没有操作记录</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <AdminPager base="/admin/logs" params={sp} page={page} total={total} pageSize={pageSize} />
      </AdminCard>

      <AdminCard title="已埋点的动作">
        <div className="admin_tags">
          {actions.length === 0 && <span className="sub">暂无</span>}
          {actions.map((a) => (
            <Link
              key={a.action}
              href={`/admin/logs?action=${encodeURIComponent(a.action)}`}
              className="admin_tag info"
            >
              {opLabel(a.action)} × {a.count}
            </Link>
          ))}
        </div>
      </AdminCard>

      <AdminCard title="说明">
        <div className="admin_note">
          · 日志写入失败不会阻断主操作（后台可用性优先），因此极端情况下可能出现「操作成功但无日志」。<br />
          · 来源 IP 取 nginx 反代透传的 <code>X-Forwarded-For</code> 首段；直连场景可能为空。<br />
          · 日志表只增不改，长期运行体积会增长，可按需归档（后台不提供删除入口，避免误删审计证据）。
        </div>
      </AdminCard>
    </>
  );
}
