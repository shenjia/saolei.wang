// 动态列表 + 等级筛选 + 「加载更多/页码滑条」（移植 views/common/more 的 cursor 加载逻辑）
// 初始数据由服务端渲染传入，点更多/切筛选走 /api/news/more 取 JSON 增量渲染
// 2026-09-24 二轮：底部改左右布局（左=总数 右=按钮），点击加载保持滚动位置
// 2026-10-14 二轮：用户主页场景（userId 存在）加 PageSlider 翻页条
//   （页码模式 ?page=N&base=15；首页新闻流保持纯加载更多——无翻页诉求）

"use client";

import { useRef, useState, useEffect, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { NewsItem } from "@/lib/queries";
import { NewsCellView } from "./NewsCellView";
import { PageSlider, nextBatchSize, PageCache } from "./PageSlider";
import { captureViewportAnchor, restoreViewportAnchor } from "./useNoJump";

export interface NewsFeedItem {
  news: NewsItem;
  title: string;
}

// 2026-10-13 张老师要求：加「论坛」tab，发表主题（NEWS_TYPE.ARTICLE=40）和评论（COMMENT=52）都算。
// 论坛筛选与等级筛选互斥：选中论坛时按 type in (40,52) 过滤，不再匹配 details.lv
const LEVEL_TABS: { key: string; label: string }[] = [
  { key: "", label: "全部" },
  { key: "beg", label: "初级" },
  { key: "int", label: "中级" },
  { key: "exp", label: "高级" },
  { key: "forum", label: "论坛" },
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
}) {
  const [items, setItems] = useState(initial);
  const [cursor, setCursor] = useState(initial.length ? initial[initial.length - 1].news.id : 0);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [total, setTotal] = useState(initialTotal);
  const [loading, setLoading] = useState(false);
  const [level, setLevel] = useState("");
  const [switching, setSwitching] = useState(false);
  const [batchStep, setBatchStep] = useState(0); // 递增批量序号（驱动按钮文案，2026-10-14；切筛选重置）

  // ---- 翻页条状态（2026-10-14 四轮：首页+用户主页统一带翻页条，全走页码模式）----
  const [curPage, setPage] = useState(1);
  const tableRef = useRef<HTMLTableElement>(null);
  const pageCache = useRef(new PageCache<NewsFeedItem[]>());
  const reqSeq = useRef(0);
  const maxPage = Math.max(1, Math.ceil(total / pageSize));

  useEffect(() => {
    pageCache.current.set(1, initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchPage(lv: string, cur: number, size?: number) {
    const url =
      `/api/news/more?cursor=${cur}&size=${size ?? pageSize}` +
      (userId ? `&user=${userId}` : "") +
      (lv && lv !== "forum" ? `&level=${lv}` : "") +
      (lv === "forum" ? "&type=forum" : "") +
      (homeOnly ? "&home=1" : "");
    const res = await fetch(url);
    return (await res.json()) as { items: NewsFeedItem[]; cursor: number; count: number; total: number };
  }

  /** 页码模式请求（翻页条；home 口径透传）：?page=N&base=pageSize */
  async function fetchByPage(lv: string, page: number, size?: number) {
    const url =
      `/api/news/more?page=${page}&base=${pageSize}&size=${size ?? pageSize}` +
      (userId ? `&user=${userId}` : "") +
      (lv && lv !== "forum" ? `&level=${lv}` : "") +
      (lv === "forum" ? "&type=forum" : "") +
      (homeOnly ? "&home=1" : "");
    const res = await fetch(url);
    return (await res.json()) as { items: NewsFeedItem[]; cursor: number; count: number; total: number };
  }

  async function loadMore() {
    if (loading) return;
    setLoading(true);
    const seq = ++reqSeq.current;
    try {
      const size = nextBatchSize(batchStep, pageSize);
      const data = await fetchByPage(level, Math.floor(items.length / pageSize) + 1, size);
      if (seq !== reqSeq.current) return;
      setItems((prev) => [...prev, ...data.items]);
      setCursor(data.cursor);
      setBatchStep((s) => s + 1);
      if (typeof data.total === "number") setTotal(data.total);
      if (data.count < size) setHasMore(false);
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  /** 滑条换页（严格一页语义）：已加载窗口内滚动定位 / 缓存零请求 / 拉一页替换 */
  async function gotoPage(p: number) {
    if (loading) return;
    p = Math.min(maxPage, Math.max(1, p));
    if (p === curPage) return;
    const winEnd = Math.max(1, Math.ceil(items.length / pageSize));
    if (p <= winEnd) {
      const first = (p - 1) * pageSize;
      if (items[first]) {
        setPage(p);
        const tr = tableRef.current?.tBodies[0]?.children[first] as HTMLElement | undefined;
        tr?.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center" });
        return;
      }
    }
    setPage(p);
    const cached = pageCache.current.get(p);
    if (cached) {
      const anchor = captureViewportAnchor(tableRef.current);
      flushSync(() => setItems(cached));
      restoreViewportAnchor(tableRef.current, anchor);
      setBatchStep(0);
      setHasMore(cached.length < total);
      return;
    }
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const data = await fetchByPage(level, p);
      if (seq !== reqSeq.current) return;
      if (!data.items.length) {
        setHasMore(false);
        return;
      }
      pageCache.current.set(p, data.items);
      const anchor = captureViewportAnchor(tableRef.current);
      flushSync(() => setItems(data.items));
      restoreViewportAnchor(tableRef.current, anchor);
      setCursor(data.cursor);
      setBatchStep(0);
      setHasMore(p * pageSize < total);
      if (typeof data.total === "number") setTotal(data.total);
    } catch {
      /* 失败静默，重试可再拖 */
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  // 切换等级筛选：重置列表并取该等级第一页（批量序列/翻页状态同步重置）
  async function switchLevel(lv: string) {
    if (lv === level || switching) return;
    setSwitching(true);
    setLevel(lv);
    setBatchStep(0);
    setPage(1);
    try {
      const data = await fetchPage(lv, 0);
      setItems(data.items);
      setCursor(data.cursor);
      pageCache.current.set(1, data.items);
      if (typeof data.total === "number") setTotal(data.total);
      setHasMore(data.count >= pageSize);
    } finally {
      setSwitching(false);
    }
  }

  // 「论坛」tab 只在用户主页出现：首页新闻流口径（NEWS_HOME_TYPES）本来就不含发帖/评论动态
  const tabs = (userId ? LEVEL_TABS : LEVEL_TABS.filter((t) => t.key !== "forum")).map((t) =>
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
          {/* 2026-09-27 张老师要求：筛选器与排行/录像页同款大号版对齐
              （去 side 小号变体与无定义的死类 head，标题+tabs 成等高标签带） */}
          <div className="news_tabs ranking_tabs">{tabs}</div>
        </div>
      ) : (
        <div className="news_tabs ranking_tabs side">{tabs}</div>
      )}
      <table ref={tableRef} cellPadding={0} cellSpacing={0} className="table">
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
      {/* 翻页条一行合一（2026-10-14 四轮：首页+用户主页统一；··· + 滑轨 + 页码）
          2026-10-15 张老师要求：单页也显示（PageSlider single 态全灰不可点） */}
      <div className="list_footer">
        <PageSlider
          page={curPage}
          pages={maxPage}
          loading={loading || switching}
          onGoto={gotoPage}
          hasMore={hasMore}
          onMore={loadMore}
        />
      </div>
    </>
  );
}
