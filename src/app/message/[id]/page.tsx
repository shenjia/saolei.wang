// 读信（移植 2008 版 Message/Show.asp：读后标记已读）
// 2026-09-24 改版（张老师要求）：版式对齐论坛文章页（bbs_meta 作者行 + hr + 正文）

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { readMessage } from "@/lib/message";
import { timeOpposite, TIME_NEVER, parseMessageParts } from "@/lib/format";
import { AvatarCell, TitleBadge } from "@/components/Cells";
import { SendMessageForm } from "@/components/MessageForms";

export const dynamic = "force-dynamic";
export const metadata = { title: "读信" };

/** h1 标题：链接标记剥为纯文字（正文内才是可点的） */
function contentPreviewTitle(content: string): string {
  return parseMessageParts(content)
    .map((p) => (typeof p === "string" ? p : p.text))
    .join("")
    .slice(0, 20);
}

export default async function MessageShowPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect("/account/login");

  const { id } = await params;
  const message = await readMessage(parseInt(id, 10) || 0, session.uid);
  if (!message) notFound();

  return (
    <div id="page" className="main">
      <div className="box text bbs_post">
        <h1>{message.isSystem ? "系统消息" : contentPreviewTitle(message.content)}</h1>
        <p className="bbs_meta">
          {message.isSystem ? (
            <span className="avatar_link msg_sys">【系统广播】</span>
          ) : message.from ? (
            <>
              <AvatarCell id={message.from.id} name={message.from.chineseName} sex={message.from.sex} link />{" "}
              <TitleBadge title={message.from.title} link />{" "}
            </>
          ) : (
            "? "
          )}
          发送于 {timeOpposite(message.createTime, TIME_NEVER)}
        </p>
        <hr />
        <div className="bbs_content">
          {/* 评论通知里的《文章标题》内嵌链接（2026-10-15）：解析标记渲染为可点击跳文章页 */}
          {parseMessageParts(message.content).map((p, i) =>
            typeof p === "string" ? (
              <span key={i}>{p}</span>
            ) : (
              <Link key={i} href={p.href} className="msg_title_link">
                {p.text}
              </Link>
            )
          )}
        </div>
        <hr />
        <Link href="/message" className="button small">
          返回消息
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
