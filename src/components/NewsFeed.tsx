// 动态列表 + 等级筛选 + 「加载更多」（移植 views/common/more 的 cursor 加载逻辑）
// 初始数据由服务端渲染传入，点更多/切筛选走 /api/news/more 取 JSON 增量渲染

"use client";

import { useState, type ReactNode } from "react";
import type { NewsItem } from "@/lib/queries";
import { moreLabel } from "@/lib/format";
import { NewsCellView } from "./NewsCellView";

export interface NewsFeedItem {
  news: NewsItem;
  title: string;
}

const LEVEL_TABS: { key: string; label: string }[] = [
  { key: "", label: "全部" },
  { key: "beg", label: "初级" },
  { key: "int", label: "中级" },
  { key: "exp", label: "高级" },
];

export function NewsFeed({
  initial,
  userId,
  pageSize,
  initialHasMore,
  initialTotal,
  title,
}: {
  initial: NewsFeedItem[];
  userId?: number;
  pageSize: number;
  initialHasMore: boolean;
  /** 当前筛选条件下的动态总数（「加载更多」括号内显示剩余条数用） */
  initialTotal: number;
  /** 标题节点；传入时筛选 tabs 收进标题行右侧（首页「雷界快讯」同款布局） */
  title?: ReactNode;
}) {
  const [items, setItems] = useState(initial);
  const [cursor, setCursor] = useState(initial.length ? initial[initial.length - 1].news.id : 0);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [total, setTotal] = useState(initialTotal);
  const [loading, setLoading] = useState(false);
  const [level, setLevel] = useState("");
  const [switching, setSwitching] = useState(false);

  async function fetchPage(lv: string, cur: number) {
    const url =
      `/api/news/more?cursor=${cur}&size=${pageSize}` +
      (userId ? `&user=${userId}` : "") +
      (lv ? `&level=${lv}` : "");
    const res = await fetch(url);
    return (await res.json()) as { items: NewsFeedItem[]; cursor: number; count: number; total: number };
  }

  async function loadMore() {
    setLoading(true);
    try {
      const data = await fetchPage(level, cursor);
      setItems((prev) => [...prev, ...data.items]);
      setCursor(data.cursor);
      if (typeof data.total === "number") setTotal(data.total);
      if (data.count < pageSize) setHasMore(false);
    } finally {
      setLoading(false);
    }
  }

  // 切换等级筛选：重置列表并取该等级第一页
  async function switchLevel(lv: string) {
    if (lv === level || switching) return;
    setSwitching(true);
    setLevel(lv);
    try {
      const data = await fetchPage(lv, 0);
      setItems(data.items);
      setCursor(data.cursor);
      if (typeof data.total === "number") setTotal(data.total);
      setHasMore(data.count >= pageSize);
    } finally {
      setSwitching(false);
    }
  }

  const tabs = LEVEL_TABS.map((t) =>
    t.key === level ? (
      <span key={t.key || "all"} className="current">
        {t.label}
      </span>
    ) : (
      <a
        key={t.key || "all"}
        href="#"
        onClick={(e) => {
          e.preventDefault();
          switchLevel(t.key);
        }}
      >
        {t.label}
      </a>
    )
  );

  return (
    <>
      {title ? (
        <div className="news_head">
          <h1>{title}</h1>
          <div className="news_tabs ranking_tabs side head">{tabs}</div>
        </div>
      ) : (
        <div className="news_tabs ranking_tabs side">{tabs}</div>
      )}
      <table cellPadding={0} cellSpacing={0} className="table">
        <tbody>
          {items.map(({ news, title: itemTitle }) => (
            <NewsCellView key={news.id} news={news} title={itemTitle} />
          ))}
          {items.length === 0 && (
            <tr>
              <td className="text">{switching ? "加载中…" : "还没有记录。"}</td>
              <td></td>
            </tr>
          )}
        </tbody>
      </table>
      {hasMore && (
        <div className="more_loader">
          <button type="button" className="button small" data-cursor={cursor} disabled={loading} onClick={loadMore}>
            {loading ? "加载中…" : moreLabel(total - items.length)}
          </button>
        </div>
      )}
    </>
  );
}
