// 消息列表（移植 2008 版 Message/Box.asp + List.asp）
// 2026-09-24 改版（张老师要求）：「收件箱」改名「消息」，版式参考论坛文章列表

import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { isManager } from "@/lib/config";
import { getMessageList, messageAuthorsWithTitles } from "@/lib/message";
import { timeOpposite, TIME_NEVER } from "@/lib/format";
import { Pager } from "@/components/Pager";
import { AvatarCell, TitleBadge } from "@/components/Cells";
import { BroadcastForm, ClearButton, SendMessageForm } from "@/components/MessageForms";

export const dynamic = "force-dynamic";
export const metadata = { title: "消息 | 扫雷网" };

export default async function MessagePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await getSession();
  if (!session) redirect("/account/login");

  const sp = await searchParams;
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const to = parseInt(sp.to ?? "", 10) || undefined;
  const toName = to
    ? (await messageAuthorsWithTitles([to])).get(to)?.chineseName
    : undefined;

  const { messages, total, pageSize } = await getMessageList(session.uid, page);

  return (
    <div id="page" className="main message_list">
      <div className="box">
        <div className="page_head">
          <h1 className="page_title">消息</h1>
          <ClearButton />
        </div>
        <table cellPadding={0} cellSpacing={0} className="table full bbs_list">
          <thead>
            <tr>
              <th className="cat">类型</th>
              <th className="topic">内容</th>
              <th className="author">发件人</th>
              <th className="time">时间</th>
            </tr>
          </thead>
          <tbody>
            {messages.map((m) => (
              <tr key={m.id} className={m.isRead ? "" : "unread"}>
                <td>
                  <span className="board_tag">{m.isSystem ? "系统" : "私信"}</span>
                </td>
                <td>
                  <Link className="bbs_title" href={`/message/${m.id}`}>
                    {m.content.length > 40 ? m.content.slice(0, 40) + "…" : m.content}
                  </Link>
                  {!m.isRead && (
                    <span className="bbs_star" data-tip="未读">
                      ★
                    </span>
                  )}
                </td>
                <td className="user">
                  {m.isSystem ? (
                    <span className="avatar_link">【系统广播】</span>
                  ) : m.from ? (
                    <>
                      <AvatarCell id={m.from.id} name={m.from.chineseName} sex={m.from.sex} gender="small" link />
                      <TitleBadge title={m.from.title} link />
                    </>
                  ) : (
                    "?"
                  )}
                </td>
                <td className="time">{timeOpposite(m.createTime, TIME_NEVER)}</td>
              </tr>
            ))}
            {messages.length === 0 && (
              <tr>
                <td colSpan={4}>还没有消息。</td>
              </tr>
            )}
          </tbody>
        </table>
        <Pager base="/message" params={{}} page={page} total={total} pageSize={pageSize} />
      </div>
      {to && (
        <div className="box">
          <h2>发消息</h2>
          <SendMessageForm to={to} toName={toName} />
        </div>
      )}
      {isManager(session.role) && (
        <div className="box">
          <BroadcastForm />
        </div>
      )}
    </div>
  );
}
