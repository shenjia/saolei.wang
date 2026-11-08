// 管理后台 · 更新历史维护（2026-11-02：/page/history 落库 site_update 表）
// 登记（日期 + 内容）+ 清单（编辑/删除）；前台更新历史页读同一份数据。

import { getSession } from "@/lib/auth";
import { getSiteUpdates } from "@/lib/site-updates";
import { AdminAction } from "@/components/admin/AdminAction";
import { RowEditButton } from "@/components/admin/RowEditButton";
import { AdminCard } from "@/components/admin/Widgets";
import { SiteUpdateForm } from "@/components/admin/SiteUpdateForm";

export const dynamic = "force-dynamic";
export const metadata = { title: "更新历史 | 管理后台" };

export default async function AdminSiteUpdatesPage() {
  const [rows, session] = await Promise.all([getSiteUpdates(), getSession()]);

  return (
    <>
      <div className="admin_page_head">
        <h1>更新历史</h1>
        <span className="sub">
          前台 <a href="/page/history" target="_blank" rel="noopener noreferrer">saolei.wang/page/history</a>{" "}
          展示同一份数据 · 共 {rows.length} 条
        </span>
      </div>

      <AdminCard title="登记更新">
        <div className="admin_note" style={{ marginBottom: 10 }}>
          站点重大新功能上线后在此登记一条（日常修 bug 不登记）；日期按事件当天填写，清单与前台均按日期倒序排列。
        </div>
        <SiteUpdateForm rows={rows} authorId={session?.uid ?? 0} />
      </AdminCard>

      <AdminCard title="更新清单" tight>
        <div className="admin_scroll">
          <table className="admin_table">
            <thead>
              <tr>
                <th className="c">ID</th>
                <th>日期</th>
                <th>内容</th>
                <th className="ops">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="c sub">{r.id}</td>
                  <td className="mono" style={{ whiteSpace: "nowrap" }}>{r.date}</td>
                  <td>{r.content}</td>
                  <td className="ops">
                    {/* 编辑：派发事件给上方表单回填进入编辑模式 */}
                    <RowEditButton
                      event="sl-siteupdate-edit"
                      detail={{ id: r.id, date: r.date, content: r.content }}
                    />{" "}
                    <AdminAction
                      op="siteupdate.delete"
                      params={{ id: r.id }}
                      label="删除"
                      variant="danger"
                      confirm={`确认删除这条更新历史？\n${r.date} ${r.content}（记录 #${r.id}，不可恢复）`}
                    />
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4}>
                    <div className="admin_empty">还没有更新历史记录</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </AdminCard>
    </>
  );
}
