// 消息列表（移植 2008 版 Message/Box.asp + List.asp）
// 2026-09-24 改版（张老师要求）：「收件箱」改名「消息」，版式参考论坛文章列表
// 2026-09-24 二轮：未读绿「新」字、已读内容变灰、右上角「全部已读」、
//   底部加载更多+总条数（首屏 15 条，Pager 移除）
// 2026-10-14（张老师要求）：类型筛选 tabs（全部/系统/私信）——复用论坛页 Tabs
//   链接形态（?type= 承载状态，可分享可后退）；筛选值走服务端过滤，
//   MessageFeed 加 key=筛选串（软导航下 useState(initial) 不重置的老坑，见 BbsFeed）
// 2026-10-24 二轮（张老师要求）：底部换回标准翻页控件（Pager 服务端分页 ?page=，
//   与录像审核页同款；「加载更多+剩余条数」下线——Tabs 的 page: undefined 保证
//   切筛选时翻页归 1）

import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { isManager } from "@/lib/config";
import { getMessageList, messageAuthorsWithTitles, MESSAGE_PAGESIZE, type MessageTypeFilter } from "@/lib/message";
import { MessageFeed } from "@/components/MessageFeed";
import { Pager, Tabs } from "@/components/Pager";
import { BroadcastForm, ClearButton, MarkAllReadButton, SendMessageForm } from "@/components/MessageForms";

export const dynamic = "force-dynamic";
export const metadata = { title: "消息" };

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

  // 类型筛选（非法值视作全部；params 只透传 type，不给 Tabs 带 to 等无关参数）
  const type: MessageTypeFilter = sp.type === "system" || sp.type === "private" ? sp.type : "all";
  // 翻页（2026-10-24 二轮）：标准 Pager 服务端分页，?page= 承载状态
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);

  const { messages, total } = await getMessageList(session.uid, page, type);

  return (
    <div id="page" className="main message_list">
      <div className="box">
        <div className="page_head">
          <h1 className="page_title">消息</h1>
          <Tabs
            base="/message"
            params={{}}
            name="type"
            current={type}
            options={[
              ["all", "全部"],
              ["system", "系统"],
              ["private", "私信"],
            ]}
          />
          <div className="msg_head_btns">
            <MarkAllReadButton />
            <ClearButton />
          </div>
        </div>
        <table cellPadding={0} cellSpacing={0} className="table full bbs_list">
          <thead>
            <tr>
              <th className="cat">类型</th>
              <th className="author">发件人</th>
              <th className="topic">内容</th>
              <th className="time">时间</th>
            </tr>
          </thead>
          <tbody>
            <MessageFeed
              key={`${type}_${page}`}
              initial={messages}
              authorId={session.uid}
            />
          </tbody>
        </table>
        <Pager
          base="/message"
          params={type === "all" ? {} : { type }}
          page={page}
          total={total}
          pageSize={MESSAGE_PAGESIZE}
        />
      </div>
      {to && (
        <div className="box">
          <h2>发消息</h2>
          <SendMessageForm to={to} toName={toName} authorId={session.uid} />
        </div>
      )}
      {isManager(session.role) && (
        <div className="box">
          <BroadcastForm authorId={session.uid} />
        </div>
      )}
    </div>
  );
}
