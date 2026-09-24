// 管理后台 · 评论管理（2026-09-24）
// 全站评论检索与处置：删除（status=-1）会同步回退录像评论计数，恢复则加回。

import Link from "next/link";
import { Suspense } from "react";
import { getCommentListAdmin } from "@/lib/admin/data";
import { AdminAction } from "@/components/admin/AdminAction";
import { AdminFilters } from "@/components/admin/AdminFilters";
import { AdminCard, AdminPager, LevelTag } from "@/components/admin/Widgets";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "评论管理 | 管理后台" };

type SP = Record<string, string | undefined>;

export default async function AdminCommentsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const { rows, total, pageSize } = await getCommentListAdmin({ q: sp.q, status: sp.status, page });

  return (
    <>
      <div className="admin_page_head">
        <h1>评论管理</h1>
        <span className="sub">共 {total.toLocaleString("zh-CN")} 条命中当前条件</span>
      </div>

      <AdminCard tight>
        <Suspense fallback={<div className="admin_filterbar">筛选项加载中…</div>}>
          <AdminFilters
            fields={[
              { name: "q", type: "search", placeholder: "评论 ID / 玩家 ID / 录像 ID / 内容" },
              {
                name: "status",
                type: "select",
                prefix: "状态",
                options: [
                  ["", "全部状态"],
                  ["0", "正常"],
                  ["1", "已删除"],
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
                <th>作者</th>
                <th>所属录像</th>
                <th>内容</th>
                <th className="c">状态</th>
                <th>时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className={c.status !== 0 ? "off" : undefined}>
                  <td className="c sub">{c.id}</td>
                  <td>
                    <Link className="link" href={`/admin/users/${c.user}`}>
                      {c.author?.chineseName ?? `#${c.user}`}
                    </Link>
                  </td>
                  <td>
                    <Link className="link" href={`/video/${c.video}`} target="_blank">
                      #{c.video}
                    </Link>
                    {c.videoLevel && (
                      <span style={{ marginLeft: 6 }}>
                        <LevelTag level={c.videoLevel} />
                      </span>
                    )}
                    <div className="sub">
                      上传者{" "}
                      <Link className="link" href={`/admin/users/${c.videoUser}`}>
                        #{c.videoUser}
                      </Link>
                    </div>
                  </td>
                  <td style={{ maxWidth: 420 }}>{c.content || <span className="sub">（空）</span>}</td>
                  <td className="c">
                    {c.status === 0 ? <span className="admin_tag ok">正常</span> : <span className="admin_tag bad">已删除</span>}
                  </td>
                  <td className="sub">{formatDate(c.createTime, "Y-m-d H:i")}</td>
                  <td className="ops">
                    {c.status === 0 ? (
                      <AdminAction
                        op="comment.setStatus"
                        params={{ id: c.id, status: -1 }}
                        label="删除"
                        variant="danger"
                        confirm={`确认删除评论 #${c.id}？`}
                      />
                    ) : (
                      <AdminAction
                        op="comment.setStatus"
                        params={{ id: c.id, status: 0 }}
                        label="恢复"
                        variant="primary"
                        confirm={`确认恢复评论 #${c.id}？`}
                      />
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <div className="admin_empty">没有符合条件的评论</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <AdminPager base="/admin/comments" params={sp} page={page} total={total} pageSize={pageSize} />
      </AdminCard>

      <AdminCard title="口径说明">
        <div className="admin_note">
          · 删除是<b>软删除</b>（<code>comment.status = -1</code>），前台不再展示，可随时恢复；同时会把所在录像的评论计数减 1，恢复则加回。<br />
          · 录像被彻底删除时，其评论会被一并物理清理（见录像管理）。
        </div>
      </AdminCard>
    </>
  );
}
