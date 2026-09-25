// 动态列表 + 等级筛选 + 「加载更多」（移植 views/common/more 的 cursor 加载逻辑）
// 初始数据由服务端渲染传入，点更多/切筛选走 /api/news/more 取 JSON 增量渲染
// 2026-09-24 二轮：底部改左右布局（左=总数 右=按钮），点击加载保持滚动位置

"use client";

import { useState, type ReactNode } from "react";
import type { NewsItem } from "@/lib/queries";
import { NewsCellView } from "./NewsCellView";
import { noFocusJump } from "./useKeepScroll";
import { TotalCount } from "./TotalCount";

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
  titleClassName,
  homeOnly,
  timeFirst,
}: {
  initial: NewsFeedItem[];
  userId?: number;
  pageSize: number;
  initialHasMore: boolean;
  /** 当前筛选条件下的动态总数（左下角总数行） */
  initialTotal: number;
  /** 标题节点；传入时筛选 tabs 收进标题行右侧（首页版块布局） */
  title?: ReactNode;
  /** 标题附加类名（首页「录像」版块传 gray 走灰色次级标题，2026-09-24 张老师要求） */
  titleClassName?: string;
  /** 首页新闻流口径：加载更多/等级筛选只取 NEWS_HOME_TYPES（2026-09-24） */
  homeOnly?: boolean;
  /** 时间列放最左（首页试验版式，2026-09-25） */
  timeFirst?: boolean;
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
      (lv ? `&level=${lv}` : "") +
      (homeOnly ? "&home=1" : "");
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
          {/* 标题节点直接渲染：首页传字符串保持 h1（26px 定稿），用户页「动态」
              传 <h2> 与其他板块标题同款（2026-09-24 张老师要求：不要变大、不要黄） */}
          {typeof title === "string" ? (
            <h1 className={titleClassName}>{title}</h1>
          ) : (
            title
          )}
          <div className="news_tabs ranking_tabs side head">{tabs}</div>
        </div>
      ) : (
        <div className="news_tabs ranking_tabs side">{tabs}</div>
      )}
      <table cellPadding={0} cellSpacing={0} className="table">
        <tbody>
          {items.map(({ news, title: itemTitle }) => (
            <NewsCellView key={news.id} news={news} title={itemTitle} timeFirst={timeFirst} />
          ))}
          {items.length === 0 && (
            <tr>
              {timeFirst && <td></td>}
              <td className="text">{switching ? "加载中…" : "还没有记录。"}</td>
              {!timeFirst && <td></td>}
            </tr>
          )}
        </tbody>
      </table>
      <div className="more_loader">
        {hasMore ? (
          <button
            type="button"
            className="button small"
            data-cursor={cursor}
            disabled={loading}
            onMouseDown={noFocusJump}
            onClick={loadMore}
          >
            {loading ? "加载中…" : "加载更多"}
          </button>
        ) : (
          items.length > 0 && <span className="all_loaded">已加载全部</span>
        )}
        <TotalCount total={total} unit="条" />
      </div>
    </>
  );
}
