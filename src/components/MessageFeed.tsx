// 消息列表 + 「加载更多」（页码语义，模式同 BbsFeed）
// 初始数据服务端渲染传入；「全部已读」后 router.refresh() 推送新 initial，
// useEffect 同步重置列表（软导航下 useState(initial) 不重置的坑，见 BbsFeed 注释）
// 2026-10-17（张老师要求）：完整正文直接上列表、详情页下线——点击正文即标已读，
// 评论消息里的《文章标题》内嵌链接可直接点击跳文章页；私信末尾附「回复」入口

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { timeOpposite, TIME_NEVER, parseMessageParts } from "@/lib/format";
import type { MessageItem } from "@/lib/message";
import { AvatarCell, TitleBadge } from "./Cells";
import { noFocusJump } from "./useKeepScroll";
import { TotalCount } from "./TotalCount";

/** 首屏/每页条数（与 lib/message.ts MESSAGE_PAGESIZE 一致；不 import 值防 prisma 进 bundle） */
const PAGE_SIZE = 15;

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

export function MessageRow({ m, onRead }: { m: MessageItem; onRead: (id: number) => void }) {
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
            <TitleBadge title={m.from.title} link />
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
          <Link className="msg_reply_link" href={`/message?to=${m.from.id}`}>
            回复
          </Link>
        )}
      </td>
      <td className="time">{timeOpposite(m.createTime, TIME_NEVER)}</td>
    </tr>
  );
}

export function MessageFeed({
  type = "all",
  initial,
  initialHasMore,
  total: initialTotal,
}: {
  /** 类型筛选（2026-10-14）：加载更多按同一口径翻页；key=筛选串由页面侧强制重挂载 */
  type?: "all" | "system" | "private";
  initial: MessageItem[];
  initialHasMore: boolean;
  total: number;
}) {
  const [items, setItems] = useState(initial);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [total, setTotal] = useState(initialTotal);
  const [loading, setLoading] = useState(false);

  // 「全部已读」/清空后 router.refresh() 会推送新 initial——同步重置本地列表
  useEffect(() => {
    setItems(initial);
    setHasMore(initialHasMore);
    setTotal(initialTotal);
  }, [initial, initialHasMore, initialTotal]);

  async function loadMore() {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ action: "more", page: String(Math.floor(items.length / PAGE_SIZE) + 1) });
      if (type !== "all") qs.set("type", type);
      const res = await fetch(`/api/message?${qs}`);
      const data = (await res.json()) as { messages: MessageItem[]; hasMore: boolean; total: number };
      setItems((prev) => [...prev, ...data.messages]);
      setHasMore(data.hasMore);
      setTotal(data.total);
    } finally {
      setLoading(false);
    }
  }

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
        <MessageRow key={m.id} m={m} onRead={markRead} />
      ))}
      {items.length === 0 && (
        <tr>
          <td colSpan={4}>还没有消息。</td>
        </tr>
      )}
      <tr className="bbs_more_row">
        <td colSpan={4}>
          {/* 按钮右侧跟总数（张老师三轮要求）；加载完全部后按钮消失、总数保留居中 */}
          <div className="more_loader">
            {hasMore && (
              <button
                type="button"
                className="button small"
                disabled={loading}
                onMouseDown={noFocusJump}
                onClick={loadMore}
              >
                {loading ? "加载中…" : "加载更多"}
              </button>
            )}
            {/* 2026-09-26 张老师要求：显示剩余条数而非总数 */}
            <TotalCount total={total} loaded={items.length} unit="条" />
          </div>
        </td>
      </tr>
    </>
  );
}
