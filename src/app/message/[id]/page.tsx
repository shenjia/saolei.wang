// 读信（移植 2008 版 Message/Show.asp：读后标记已读）

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { readMessage } from "@/lib/message";
import { timeOpposite, TIME_NEVER } from "@/lib/format";
import { SendMessageForm } from "@/components/MessageForms";

export const dynamic = "force-dynamic";
export const metadata = { title: "读信 | 扫雷网" };

export default async function MessageShowPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect("/account/login");

  const { id } = await params;
  const message = await readMessage(parseInt(id, 10) || 0, session.uid);
  if (!message) notFound();

  return (
    <div id="page" className="main">
      <div className="box text">
        <h1>{message.isSystem ? "系统广播" : `${message.from?.chineseName ?? "?"} 的来信`}</h1>
        <p className="time">{timeOpposite(message.createTime, TIME_NEVER)}</p>
        <hr />
        <p>{message.content}</p>
        <hr />
        <Link href="/message" className="button">
          返回收件箱
        </Link>
      </div>
      {!message.isSystem && message.from && (
        <div className="box">
          <h2>回复</h2>
          <SendMessageForm to={message.from.id} toName={message.from.chineseName} />
        </div>
      )}
    </div>
  );
}
