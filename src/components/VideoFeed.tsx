// 首页「最新录像」版块（2026-09-24 张老师要求）：
// 顶部标题行右侧级别选择器（全部/初级/中级/高级），底部「加载更多」——
// 交互与首页「动态」版块（NewsFeed）完全同构：初始数据由服务端渲染传入，
// 翻页与切级别走 /api/video/more 取 JSON 增量渲染。
// 行/表头渲染复用 VideoRows（与 /video 列表同源，保证两处版式一致）。

"use client";

import { useState, type ReactNode } from "react";
import type { VideoListItem } from "@/lib/queries";
import { VideoHead, VideoRowLine } from "./VideoRows";
import { noFocusJump } from "./useKeepScroll";
import { TotalCount } from "./TotalCount";

const LEVEL_TABS: { key: string; label: string }[] = [
  { key: "", label: "全部" },
  { key: "beg", label: "初级" },
  { key: "int", label: "中级" },
  { key: "exp", label: "高级" },
];

export function VideoFeed({
  initial,
  pageSize,
  initialHasMore,
  initialTotal,
  title,
  titleClassName,
}: {
  initial: VideoListItem[];
  pageSize: number;
  initialHasMore: boolean;
  /** 当前筛选条件下的录像总数（左下角总数行） */
  initialTotal: number;
  /** 标题节点；筛选 tabs 收进标题行右侧（首页版块布局） */
  title?: ReactNode;
  /** 标题附加类名（首页「录像」版块传 gray 走灰色次级标题，2026-09-24 张老师要求） */
  titleClassName?: string;
}) {
  const [items, setItems] = useState(initial);
  // 游标 = 已加载最后一条的录像 id（更早的记录 id 更小）
  const [cursor, setCursor] = useState(initial.length ? initial[initial.length - 1].id : 0);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [total, setTotal] = useState(initialTotal);
  const [loading, setLoading] = useState(false);
  const [level, setLevel] = useState("");
  const [switching, setSwitching] = useState(false);

  async function fetchPage(lv: string, cur: number) {
    const url = `/api/video/more?cursor=${cur}&size=${pageSize}` + (lv ? `&level=${lv}` : "");
    const res = await fetch(url);
    return (await res.json()) as {
      items: VideoListItem[];
      cursor: number;
      count: number;
      total: number;
    };
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

  // 切换级别：重置列表并取该级别第一页
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
          <h1 className={titleClassName}>{title}</h1>
          <div className="news_tabs ranking_tabs side head">{tabs}</div>
        </div>
      ) : (
        <div className="news_tabs ranking_tabs side">{tabs}</div>
      )}
      <table cellPadding={0} cellSpacing={0} className="ranking_table video_table">
        <VideoHead />
        <tbody>
          {items.map((v) => (
            <VideoRowLine key={v.id} video={v} />
          ))}
          {items.length === 0 && (
            <tr>
              <td className="text" colSpan={7}>
                {switching ? "加载中…" : "还没有记录。"}
              </td>
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
        <TotalCount total={total} unit="个" />
      </div>
    </>
  );
}
