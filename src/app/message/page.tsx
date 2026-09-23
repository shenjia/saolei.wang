// 收件箱（移植 2008 版 Message/Box.asp + List.asp）

import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { isManager } from "@/lib/config";
import { getMessageList } from "@/lib/message";
import { usersByIds } from "@/lib/queries";
import { timeOpposite, TIME_NEVER } from "@/lib/format";
import { Pager } from "@/components/Pager";
import { BroadcastForm, ClearButton, SendMessageForm } from "@/components/MessageForms";

export const dynamic = "force-dynamic";
export const metadata = { title: "短消息 | 扫雷网" };

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
  const toName = to ? (await usersByIds([to])).get(to)?.chineseName : undefined;

  const { messages, total, pageSize } = await getMessageList(session.uid, page);

  return (
    <div id="page" className="main">
      <div className="box">
        <h1>收件箱</h1>
        <ClearButton />
        <table cellPadding={0} cellSpacing={0} className="table full">
          <tbody>
            {messages.map((m) => (
              <tr key={m.id} className={m.isRead ? "" : "unread"}>
                <td className="user">
                  {m.isSystem ? (
                    <span className="avatar_link">【系统广播】</span>
                  ) : m.from ? (
                    <Link href={`/user/${m.from.id}`} target="_blank">
                      {m.from.chineseName}
                    </Link>
                  ) : (
                    "?"
                  )}
                </td>
                <td>
                  <Link href={`/message/${m.id}`}>
                    {m.isRead ? "" : "【新】"}
                    {m.content.length > 40 ? m.content.slice(0, 40) + "…" : m.content}
                  </Link>
                </td>
                <td className="time">{timeOpposite(m.createTime, TIME_NEVER)}</td>
              </tr>
            ))}
            {messages.length === 0 && (
              <tr>
                <td>收件箱是空的。</td>
              </tr>
            )}
          </tbody>
        </table>
        <Pager base="/message" params={{}} page={page} total={total} pageSize={pageSize} />
      </div>
      {to && (
        <div className="box">
          <h2>发短消息</h2>
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
