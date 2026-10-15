// 首页「最新录像」版块（2026-09-24 张老师要求）：
// 顶部标题行右侧级别选择器（全部/初级/中级/高级），底部翻页条（2026-10-14 四轮，
// 与首页「新闻」版块同款：··· + 滑轨 + 页码；页码模式 ?feedPage=N&base=15，
// 松手/停顿 500ms 即加载、视口零跳动、零提示——与全站列表交互统一）。
// 行/表头渲染复用 VideoRows（与 /video 列表同源，保证两处版式一致）。

"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { VideoListItem } from "@/lib/queries";
import { VideoHead, VideoRowLine } from "./VideoRows";
import { PageSlider, nextBatchSize, PageCache } from "./PageSlider";
import { captureViewportAnchor, restoreViewportAnchor } from "./useNoJump";

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
  /** 当前筛选条件下的录像总数 */
  initialTotal: number;
  /** 标题节点；筛选 tabs 收进标题行右侧（首页版块布局） */
  title?: ReactNode;
  /** 标题附加类名（首页「录像」版块传 gray 走灰色次级标题，2026-09-24 张老师要求） */
  titleClassName?: string;
}) {
  const [items, setItems] = useState(initial);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [total, setTotal] = useState(initialTotal);
  const [loading, setLoading] = useState(false);
  const [level, setLevel] = useState("");
  const [switching, setSwitching] = useState(false);
  const [batchStep, setBatchStep] = useState(0); // 递增批量序号（切级别重置）

  // ---- 翻页条状态（2026-10-14 四轮）----
  const [curPage, setPage] = useState(1);
  const tableRef = useRef<HTMLTableElement>(null);
  const pageCache = useRef(new PageCache<VideoListItem[]>());
  const reqSeq = useRef(0);
  const maxPage = Math.max(1, Math.ceil(total / pageSize));

  useEffect(() => {
    pageCache.current.set(1, initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 页码模式请求：?feedPage=N&base=pageSize（id 倒序按页取） */
  async function fetchByPage(lv: string, page: number, size?: number) {
    const url =
      `/api/video/more?feedPage=${page}&base=${pageSize}&size=${size ?? pageSize}` +
      (lv ? `&level=${lv}` : "");
    const res = await fetch(url);
    return (await res.json()) as {
      items: VideoListItem[];
      cursor: number;
      count: number;
      total: number;
    };
  }

  async function loadMore() {
    if (loading) return;
    setLoading(true);
    const seq = ++reqSeq.current;
    try {
      const size = nextBatchSize(batchStep, pageSize);
      const data = await fetchByPage(level, Math.floor(items.length / pageSize) + 1, size);
      if (seq !== reqSeq.current) return;
      const prevCount = items.length;
      setItems((prev) => [...prev, ...data.items]);
      // 新覆盖的整页入缓存
      const totalNow = prevCount + data.items.length;
      for (let pg = Math.floor(prevCount / pageSize); pg < Math.ceil(totalNow / pageSize); pg++) {
        const from = pg * pageSize;
        const to = from + pageSize;
        if (from >= prevCount && to <= totalNow) {
          pageCache.current.set(pg + 1, data.items.slice(from - prevCount, to - prevCount));
        }
      }
      setBatchStep((s) => s + 1);
      if (typeof data.total === "number") setTotal(data.total);
      if (data.count < size) setHasMore(false);
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  /** 滑条换页（严格一页语义）：窗口内滚动定位 / 缓存零请求 / 拉一页替换（零跳动） */
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
      setBatchStep(0);
      setHasMore(p * pageSize < total);
      if (typeof data.total === "number") setTotal(data.total);
    } catch {
      /* 失败静默，重试可再拖 */
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  // 切换级别：重置列表并取该级别第一页（批量序列/翻页状态同步重置）
  async function switchLevel(lv: string) {
    if (lv === level || switching) return;
    setSwitching(true);
    setLevel(lv);
    setBatchStep(0);
    setPage(1);
    try {
      const data = await fetchByPage(lv, 1);
      setItems(data.items);
      pageCache.current.set(1, data.items);
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
          {/* 2026-09-27 张老师要求：筛选器与排行/录像页同款大号版对齐
              （去 side 小号变体与无定义的死类 head，标题+tabs 成等高标签带） */}
          <div className="news_tabs ranking_tabs">{tabs}</div>
        </div>
      ) : (
        <div className="news_tabs ranking_tabs side">{tabs}</div>
      )}
      <table ref={tableRef} cellPadding={0} cellSpacing={0} className="ranking_table video_table">
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
      {/* 2026-10-15 张老师要求：单页也显示翻页条（PageSlider single 态全灰不可点） */}
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
