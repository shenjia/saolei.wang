// 消息列表（移植 2008 版 Message/Box.asp + List.asp）
// 2026-09-24 改版（张老师要求）：「收件箱」改名「消息」，版式参考论坛文章列表
// 2026-09-24 二轮：未读绿「新」字、已读内容变灰、右上角「全部已读」、
//   底部加载更多+总条数（首屏 15 条，Pager 移除）

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { isManager } from "@/lib/config";
import { getMessageList, messageAuthorsWithTitles, MESSAGE_PAGESIZE } from "@/lib/message";
import { MessageFeed } from "@/components/MessageFeed";
import { BroadcastForm, ClearButton, MarkAllReadButton, SendMessageForm } from "@/components/MessageForms";

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
  const to = parseInt(sp.to ?? "", 10) || undefined;
  const toName = to ? (await messageAuthorsWithTitles([to])).get(to)?.chineseName : undefined;

  const { messages, total } = await getMessageList(session.uid, 1);

  return (
    <div id="page" className="main message_list">
      <div className="box">
        <div className="page_head">
          <h1 className="page_title">消息</h1>
          <div className="msg_head_btns">
            <MarkAllReadButton />
            <ClearButton />
          </div>
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
            <MessageFeed
              initial={messages}
              initialHasMore={total > MESSAGE_PAGESIZE}
              total={total}
            />
          </tbody>
        </table>
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
