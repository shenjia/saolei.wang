// 管理后台 · 论坛管理（2026-09-24）
// 主题检索 + 置顶/加精/锁定/移动板块/删除；带 ?post= 参数时下钻查看该主题回复并逐条删除。

import Link from "next/link";
import { Suspense } from "react";
import { BBS_BOARDS } from "@/lib/bbs";
import { getPostListAdmin, getReplyListAdmin } from "@/lib/admin/data";
import { AdminAction, AdminSelect } from "@/components/admin/AdminAction";
import { AdminFilters } from "@/components/admin/AdminFilters";
import { AdminCard, AdminPager } from "@/components/admin/Widgets";
import { formatDate, timeOpposite } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "论坛管理 | 管理后台" };

type SP = Record<string, string | undefined>;

export default async function AdminBbsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const [{ rows, total, pageSize }, detail] = await Promise.all([
    getPostListAdmin({ q: sp.q, board: sp.board, flag: sp.flag, status: sp.status, page }),
    sp.post ? getReplyListAdmin(parseInt(sp.post, 10)) : Promise.resolve({ post: null, rows: [] }),
  ]);

  return (
    <>
      <div className="admin_page_head">
        <h1>论坛管理</h1>
        <span className="sub">共 {total.toLocaleString("zh-CN")} 个主题命中当前条件</span>
      </div>

      <AdminCard tight>
        <Suspense fallback={<div className="admin_filterbar">筛选项加载中…</div>}>
          <AdminFilters
            fields={[
              { name: "q", type: "search", placeholder: "主题 ID / 作者 ID / 标题 / 正文" },
              {
                name: "board",
                type: "select",
                prefix: "板块",
                options: [["", "全部板块"], ...BBS_BOARDS.map((b) => [String(b.id), b.name] as [string, string])],
              },
              {
                name: "flag",
                type: "select",
                prefix: "属性",
                options: [
                  ["", "全部"],
                  ["pinned", "仅置顶"],
                  ["top", "仅高亮"],
                  ["nice", "仅精华"],
                  ["locked", "仅锁定"],
                ],
              },
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
                <th className="c">板块</th>
                <th>主题</th>
                <th>作者</th>
                <th className="num">回复</th>
                <th className="num">点击</th>
                <th className="c">属性</th>
                <th>最后回复</th>
                <th>发布</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className={p.status !== 0 ? "off" : undefined}>
                  <td className="c sub">{p.id}</td>
                  <td className="c">
                    <span className="admin_tag plain">{p.boardName}</span>
                  </td>
                  <td style={{ maxWidth: 320 }}>
                    <Link className="link" href={`/bbs/${p.id}`} target="_blank">
                      {p.title}
                    </Link>
                  </td>
                  <td>
                    <Link className="link" href={`/admin/users/${p.user}`}>
                      {p.author?.chineseName ?? `#${p.user}`}
                    </Link>
                  </td>
                  <td className="num">{p.replies}</td>
                  <td className="num">{p.clicks}</td>
                  <td className="c">
                    <span className="admin_tags">
                      {p.isPinned && <span className="admin_tag bad">置顶</span>}
                      {p.isTop && <span className="admin_tag bad">高亮</span>}
                      {p.isNice && <span className="admin_tag warn">精华</span>}
                      {p.isLocked && <span className="admin_tag plain">锁定</span>}
                      {!p.isPinned && !p.isTop && !p.isNice && !p.isLocked && <span className="sub">—</span>}
                    </span>
                  </td>
                  <td className="sub">{p.lastReplyTime ? timeOpposite(p.lastReplyTime) : "—"}</td>
                  <td className="sub">{formatDate(p.createTime, "Y-m-d H:i")}</td>
                  <td className="ops">
                    <Link className="admin_btn sm" href={`/admin/bbs?post=${p.id}`}>
                      回复
                    </Link>
                    <AdminAction
                      op="bbs.setPost"
                      params={{ id: p.id, isPinned: !p.isPinned }}
                      label={p.isPinned ? "取消置顶" : "置顶"}
                    />
                    <AdminAction
                      op="bbs.setPost"
                      params={{ id: p.id, isTop: !p.isTop }}
                      label={p.isTop ? "取消高亮" : "高亮"}
                    />
                    <AdminAction
                      op="bbs.setPost"
                      params={{ id: p.id, isNice: !p.isNice }}
                      label={p.isNice ? "取消精华" : "加精"}
                    />
                    <AdminAction
                      op="bbs.setPost"
                      params={{ id: p.id, isLocked: !p.isLocked }}
                      label={p.isLocked ? "解锁" : "锁定"}
                      confirm={p.isLocked ? undefined : "锁定后普通玩家无法再回复该主题。"}
                    />
                    <AdminAction
                      op="bbs.deletePost"
                      params={{ id: p.id }}
                      label="删除"
                      variant="danger"
                      confirm={`确认删除主题 #${p.id}「${p.title}」？其全部回复会一并隐藏。`}
                    />
                    <AdminSelect
                      op="bbs.setPost"
                      params={{ id: p.id }}
                      name="board"
                      title="移动板块"
                      value={String(p.board)}
                      confirm={`确认把主题 #${p.id} 移动到其他板块？`}
                      options={BBS_BOARDS.map((b) => [String(b.id), `移至${b.name}`] as [string, string])}
                    />
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={10}>
                    <div className="admin_empty">没有符合条件的主题</div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <AdminPager base="/admin/bbs" params={sp} page={page} total={total} pageSize={pageSize} />
      </AdminCard>

      {/* ---------- 回复下钻 ---------- */}
      {detail.post && (
        <AdminCard
          title={`回复管理 · #${detail.post.id} ${detail.post.title}`}
          more={<Link href="/admin/bbs">收起</Link>}
          tight
        >
          <div className="admin_scroll">
            <table className="admin_table">
              <thead>
                <tr>
                  <th className="c">ID</th>
                  <th>作者</th>
                  <th>内容</th>
                  <th className="c">状态</th>
                  <th>时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {detail.rows.map((r) => (
                  <tr key={r.id} className={r.status !== 0 ? "off" : undefined}>
                    <td className="c sub">{r.id}</td>
                    <td>
                      <Link className="link" href={`/admin/users/${r.user}`}>
                        {r.author?.chineseName ?? `#${r.user}`}
                      </Link>
                    </td>
                    {/* 回复内容为 UBB，这里用已解析的 HTML 展示（服务端已转义） */}
                    <td style={{ maxWidth: 520 }} dangerouslySetInnerHTML={{ __html: r.content }} />
                    <td className="c">
                      {r.status === 0 ? <span className="admin_tag ok">正常</span> : <span className="admin_tag bad">已删除</span>}
                    </td>
                    <td className="sub">{formatDate(r.createTime, "Y-m-d H:i")}</td>
                    <td className="ops">
                      {r.status === 0 && (
                        <AdminAction
                          op="bbs.deleteReply"
                          params={{ id: r.id }}
                          label="删除"
                          variant="danger"
                          confirm={`确认删除回复 #${r.id}？`}
                        />
                      )}
                    </td>
                  </tr>
                ))}
                {detail.rows.length === 0 && (
                  <tr>
                    <td colSpan={6}>
                      <div className="admin_empty">该主题还没有回复</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </AdminCard>
      )}

      <AdminCard title="板块与口径">
        <div className="admin_note">
          · 板块：{BBS_BOARDS.map((b) => `${b.id} ${b.name}`).join(" / ")}（公告板 0 仅管理员可发）。<br />
          · 删除主题/回复均为软删除（<code>status = -1</code>），前台不再展示；删除回复会同步把主题的回复数减 1。<br />
          · 「移至xx」下拉即把主题挪到目标板块，无需再进前台编辑。
        </div>
      </AdminCard>
    </>
  );
}
