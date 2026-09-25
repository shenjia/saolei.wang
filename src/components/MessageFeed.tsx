// 消息列表 + 「加载更多」（页码语义，模式同 BbsFeed）
// 初始数据服务端渲染传入；「全部已读」后 router.refresh() 推送新 initial，
// useEffect 同步重置列表（软导航下 useState(initial) 不重置的坑，见 BbsFeed 注释）

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { timeOpposite, TIME_NEVER } from "@/lib/format";
import type { MessageItem } from "@/lib/message";
import { AvatarCell, TitleBadge } from "./Cells";
import { noFocusJump } from "./useKeepScroll";
import { TotalCount } from "./TotalCount";

/** 首屏/每页条数（与 lib/message.ts MESSAGE_PAGESIZE 一致；不 import 值防 prisma 进 bundle） */
const PAGE_SIZE = 15;

export function MessageRow({ m }: { m: MessageItem }) {
  return (
    <tr className={m.isRead ? "read" : "unread"}>
      <td>
        <span className="board_tag">{m.isSystem ? "系统" : "私信"}</span>
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
      <td>
        <Link className="bbs_title" href={`/message/${m.id}`}>
          {m.content.length > 40 ? m.content.slice(0, 40) + "…" : m.content}
        </Link>
        {!m.isRead && <span className="msg_new">新</span>}
      </td>
      <td className="time">{timeOpposite(m.createTime, TIME_NEVER)}</td>
    </tr>
  );
}

export function MessageFeed({
  initial,
  initialHasMore,
  total: initialTotal,
}: {
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
      const res = await fetch(`/api/message?${qs}`);
      const data = (await res.json()) as { messages: MessageItem[]; hasMore: boolean; total: number };
      setItems((prev) => [...prev, ...data.messages]);
      setHasMore(data.hasMore);
      setTotal(data.total);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {items.map((m) => (
        <MessageRow key={m.id} m={m} />
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
            <TotalCount total={total} unit="条" />
          </div>
        </td>
      </tr>
    </>
  );
}
