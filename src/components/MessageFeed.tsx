// 消息列表（2026-10-24 二轮：底部「加载更多+剩余条数」换标准翻页控件——
//   张老师要求；Pager 由页面服务端渲染承载 ?page=，本组件退化为纯列表渲染 +
//   点击标已读（保留 use client 只因标已读交互），筛选/翻页全走 URL）
// 初始数据服务端渲染传入；「全部已读」后 router.refresh() 推送新 initial，
// useEffect 同步重置列表（软导航下 useState(initial) 不重置的坑，见 BbsFeed 注释）
// 2026-10-17（张老师要求）：完整正文直接上列表、详情页下线——点击正文即标已读，
// 评论消息里的《文章标题》内嵌链接可直接点击跳文章页；私信末尾附「回复」入口
// 2026-10-24（张老师要求）：「回复」由跳 /message?to=N 改为原位弹发信浮窗
//   （与用户主页对话气泡同款 SendMessageButton variant="text"）；authorId 自页面透传
// 2026-10-27（张老师要求）：「已发送」视角——发件人列显示收件人、正文尾附
//   「未读/已读」状态标（对方是否已读）；行不可点不置灰（无「我读没读」语义）

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { timeOpposite, TIME_NEVER, parseMessageParts } from "@/lib/format";
import type { MessageItem } from "@/lib/message";
import { AvatarCell, TitleBadge } from "./Cells";
import { SendMessageButton } from "./SendMessageButton";

/** 正文渲染：链接段（《文章标题》跳文章页）与纯文本段交错（与下线的详情页同口径） */
function MessageContent({ content }: { content: string }) {
  return (
    <>
      {parseMessageParts(content).map((p, i) =>
        typeof p === "string" ? (
          <span key={i}>{p}</span>
        ) : (
          <Link key={i} href={p.href} className="msg_title_link">
            {p.text}
          </Link>
        )
      )}
    </>
  );
}

export function MessageRow({
  m,
  onRead,
  authorId,
}: {
  m: MessageItem;
  onRead: (id: number) => void;
  /** 当前登录用户 id：发信浮窗草稿键 pm:{uid}:{to} 与气泡/表单共用一份 */
  authorId: number;
}) {
  // 已发送视角：isRead=对方是否已读（正文尾状态标），无未读行交互、无「回复」入口；
  // 不套 read 类——「已读整行变灰」是收件视角语义，发出的消息行保持常规色
  if (m.sent) {
    return (
      <tr>
        <td>
          <span className={`board_tag ${m.isSystem ? "msg_sys" : ""}`}>
            {m.isSystem ? "系统" : "私信"}
          </span>
        </td>
        <td className="user">
          {m.isSystem ? (
            <span className="avatar_link msg_sys">【系统广播】</span>
          ) : m.to ? (
            <>
              <AvatarCell id={m.to.id} name={m.to.chineseName} sex={m.to.sex} gender="small" link />
              <TitleBadge title={m.to.title} classic={m.to.classic} link />
            </>
          ) : (
            "?"
          )}
        </td>
        <td className={`msg_content ${m.isSystem ? "msg_sys" : ""}`}>
          <MessageContent content={m.content} />
          <span className={`msg_read_flag ${m.isRead ? "is_read" : ""}`}>
            {m.isRead ? "已读" : "未读"}
          </span>
        </td>
        <td className="time">{timeOpposite(m.createTime, TIME_NEVER)}</td>
      </tr>
    );
  }
  return (
    <tr className={m.isRead ? "read" : "unread"}>
      <td>
        <span className={`board_tag ${m.isSystem ? "msg_sys" : ""}`}>
          {m.isSystem ? "系统" : "私信"}
        </span>
      </td>
      <td className="user">
        {m.isSystem ? (
          <span className="avatar_link msg_sys">【系统广播】</span>
        ) : m.from ? (
          <>
            <AvatarCell id={m.from.id} name={m.from.chineseName} sex={m.from.sex} gender="small" link />
            <TitleBadge title={m.from.title} classic={m.from.classic} link />
          </>
        ) : (
          "?"
        )}
      </td>
      {/* 未读时整格可点击标记已读（链接点击冒泡至此一并已读）；系统消息正文黄 */}
      <td
        className={`msg_content ${m.isSystem ? "msg_sys" : ""}`}
        onClick={m.isRead ? undefined : () => onRead(m.id)}
      >
        <MessageContent content={m.content} />
        {!m.isRead && <span className="msg_new">新</span>}
        {!m.isSystem && m.from && (
          <SendMessageButton
            variant="text"
            to={m.from.id}
            name={m.from.chineseName || `ID ${m.from.id}`}
            authorId={authorId}
          />
        )}
      </td>
      <td className="time">{timeOpposite(m.createTime, TIME_NEVER)}</td>
    </tr>
  );
}

export function MessageFeed({
  initial,
  authorId,
  sent,
}: {
  initial: MessageItem[];
  /** 当前登录用户 id（「回复」浮窗草稿键隔离用） */
  authorId: number;
  /** 已发送视角（空态文案适配） */
  sent?: boolean;
}) {
  const [items, setItems] = useState(initial);

  // 「全部已读」/清空后 router.refresh() 会推送新 initial——同步重置本地列表
  useEffect(() => {
    setItems(initial);
  }, [initial]);

  /** 点击正文标记已读（2026-10-17 详情页下线）：本地置灰 + API 落库 + 广播角标刷新 */
  async function markRead(id: number) {
    setItems((prev) => prev.map((m) => (m.id === id ? { ...m, isRead: true } : m)));
    try {
      await fetch("/api/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "read", id }),
      });
      window.dispatchEvent(new Event("message:changed"));
    } catch {
      // 网络异常静默：本地已置灰，角标随下次轮询对齐
    }
  }

  return (
    <>
      {items.map((m) => (
        <MessageRow key={m.id} m={m} onRead={markRead} authorId={authorId} />
      ))}
      {items.length === 0 && (
        <tr>
          <td colSpan={4}>{sent ? "还没有发送过消息。" : "还没有消息。"}</td>
        </tr>
      )}
    </>
  );
}
