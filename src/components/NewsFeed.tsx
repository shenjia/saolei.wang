// 动态列表 + 「加载更多」（移植 views/common/more 的 cursor 加载逻辑）
// 初始数据由服务端渲染传入，点更多走 /api/news/more 取 JSON 增量渲染

"use client";

import { useState } from "react";
import type { NewsItem } from "@/lib/queries";
import { NewsCellView } from "./NewsCellView";

export interface NewsFeedItem {
  news: NewsItem;
  title: string;
}

export function NewsFeed({
  initial,
  userId,
  pageSize,
  initialHasMore,
}: {
  initial: NewsFeedItem[];
  userId?: number;
  pageSize: number;
  initialHasMore: boolean;
}) {
  const [items, setItems] = useState(initial);
  const [cursor, setCursor] = useState(initial.length ? initial[initial.length - 1].news.id : 0);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loading, setLoading] = useState(false);

  async function loadMore() {
    setLoading(true);
    try {
      const url =
        `/api/news/more?cursor=${cursor}&size=${pageSize}` + (userId ? `&user=${userId}` : "");
      const res = await fetch(url);
      const data = (await res.json()) as { items: NewsFeedItem[]; cursor: number; count: number };
      setItems((prev) => [...prev, ...data.items]);
      setCursor(data.cursor);
      if (data.count < pageSize) setHasMore(false);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <table cellPadding={0} cellSpacing={0} className="table">
        <tbody>
          {items.map(({ news, title }) => (
            <NewsCellView key={news.id} news={news} title={title} />
          ))}
        </tbody>
      </table>
      {hasMore && (
        <div className="more_loader">
          <button type="button" className="button small" data-cursor={cursor} disabled={loading} onClick={loadMore}>
            {loading ? "加载中…" : "加载更多"}
          </button>
        </div>
      )}
    </>
  );
}
