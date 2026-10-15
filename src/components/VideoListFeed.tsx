// 录像列表页「加载更多 + 页码滑条」交互（2026-09-24 张老师要求：/video 老式翻页改加载更多；
// 2026-10-14 加滑条翻页 + 递增批量，同 RankingFeed 语义，设计稿 design/page-slider-v1.html v1.4）：
// 页码语义（与 getVideoList 一致：level/order/author/time 全筛选组合），复用 VideoRows 行渲染；
// 底部两行（上=PageSlider 滑条，下=按钮+总数），滑条换页严格一页、缓存回跳零请求、
// 松手立即加载（在途请求序号作废）；加载更多按整页批量 +20→+40→+80→+100 封顶。
// 筛选切换仍走链接整页刷新（URL 即状态，保留分享语义）。
// 2026-10-15：query 增 time（时间成绩搜索）；headSort 有值时表头渲染排序链接（仅 /video 列表页）。

"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { VideoListItem } from "@/lib/queries";
import type { VideoListOrder } from "@/lib/config";
import { VideoHead, VideoRowLine, type VideoHighlight } from "./VideoRows";
import { PageSlider, nextBatchSize, PageCache } from "./PageSlider";
import { captureViewportAnchor, restoreViewportAnchor } from "./useNoJump";

export function VideoListFeed({
  initial,
  total,
  pageSize,
  query,
  highlight,
  headSort,
}: {
  initial: VideoListItem[];
  /** 当前筛选条件下的录像总数 */
  total: number;
  pageSize: number;
  /** 筛选参数（level/order/author/time，构造增量请求用） */
  query: { level: string; order: string; author?: number; time?: string };
  /** 排序命中列高亮（默认排序=上传时间不高亮，2026-10-15 扩展全部排序列） */
  highlight?: VideoHighlight;
  /** 表头排序链接（仅 /video 列表页传入；缺省=纯文本表头，首页/用户主页不变） */
  headSort?: { base: string; order: VideoListOrder };
}) {
  const [items, setItems] = useState(initial);
  const [hasMore, setHasMore] = useState(initial.length < total);
  const [loading, setLoading] = useState(false);
  const [batchStep, setBatchStep] = useState(0); // 递增批量序号（驱动按钮文案，2026-10-14）

  // ---- 滑条窗口状态（2026-10-14）----
  const tableRef = useRef<HTMLTableElement>(null);
  // 窗口起点必须显式跟踪（2026-10-16 修复「跳远页后拖不回第 1 页」）：滑条跳远页后
  // items 整表替换成第 p 页，若仍按「winStart=1、winEnd=items.length/pageSize」推窗口，
  // 拖回第 1 页会被误判为「窗口内滚动」只滚不换，表格停在远页数据。
  const [winStart, setWinStart] = useState(1);
  const winEnd = Math.max(winStart, Math.ceil(items.length / pageSize)); // 已加载窗口末页
  const [curPage, setCurPage] = useState(1);
  const pageCache = useRef(new PageCache<VideoListItem[]>());
  const reqSeq = useRef(0);
  const maxPage = Math.max(1, Math.ceil(total / pageSize));

  useEffect(() => {
    // 初始页（可能不满一页）入缓存
    pageCache.current.set(1, initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function moreUrl(page: number, size?: number) {
    const qs = new URLSearchParams({ level: query.level, order: query.order, page: String(page) });
    if (query.author) qs.set("author", String(query.author));
    if (query.time) qs.set("time", query.time);
    // 每页条数：递增批量（首击=一页 base），默认与初始页一致（列表页 20 / 用户主页 10）
    qs.set("size", String(size ?? pageSize));
    return `/api/video/more?${qs}`;
  }

  async function loadMore() {
    if (loading || !hasMore) return;
    setLoading(true);
    const seq = ++reqSeq.current;
    try {
      const page = winStart + Math.floor(items.length / pageSize);
      const size = nextBatchSize(batchStep, pageSize);
      const res = await fetch(moreUrl(page, size));
      if (!res.ok) throw new Error("加载失败");
      const data = (await res.json()) as { videos: VideoListItem[]; hasMore: boolean };
      if (seq !== reqSeq.current) return;
      if (!data.videos.length) {
        setHasMore(false);
        return;
      }
      const prevCount = items.length;
      setItems((prev) => [...prev, ...data.videos]);
      // 新覆盖的整页入缓存
      const totalNow = prevCount + data.videos.length;
      for (let pg = Math.floor(prevCount / pageSize); pg < Math.ceil(totalNow / pageSize); pg++) {
        const from = pg * pageSize;
        const to = from + pageSize;
        if (from >= prevCount && to <= totalNow) {
          pageCache.current.set(winStart + pg, data.videos.slice(from - prevCount, to - prevCount));
        }
      }
      setBatchStep((s) => s + 1);
      setHasMore(data.hasMore);
    } catch {
      /* 网络异常静默：按钮可重试 */
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  /** 滑条换页（严格一页语义）：窗口内滚动定位 / 缓存零请求 / 拉一页替换 */
  async function gotoPage(p: number) {
    if (loading) return;
    p = Math.min(maxPage, Math.max(1, p));
    if (p === curPage) return;
    if (p >= winStart && p <= winEnd) {
      const first = (p - winStart) * pageSize;
      if (items[first]) {
        setCurPage(p);
        // 滚到该页首行（录像行无 id_ 锚点，用表格行定位）
        const tr = tableRef.current?.tBodies[0]?.children[first] as HTMLElement | undefined;
        tr?.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center" });
        return;
      }
    }
    setCurPage(p);
    const cached = pageCache.current.get(p);
    if (cached) {
      const anchor = captureViewportAnchor(tableRef.current);
      flushSync(() => {
        setItems(cached);
        setWinStart(p);
      });
      restoreViewportAnchor(tableRef.current, anchor);
      setBatchStep(0);
      setHasMore(cached.length < total);
      return;
    }
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const res = await fetch(moreUrl(p));
      if (!res.ok) throw new Error("加载失败");
      const data = (await res.json()) as { videos: VideoListItem[]; hasMore: boolean };
      if (seq !== reqSeq.current) return;
      if (!data.videos.length) {
        setHasMore(false);
        return;
      }
      pageCache.current.set(p, data.videos);
      const anchor = captureViewportAnchor(tableRef.current);
      flushSync(() => {
        setItems(data.videos);
        setWinStart(p);
      });
      restoreViewportAnchor(tableRef.current, anchor);
      setBatchStep(0);
      // 整表替换后窗口=1 页；还有更多可由滑条或「加载更多」继续（序列已重置为首击=一页）
      setHasMore(p * pageSize < total);
    } catch {
      /* 失败静默，重试可再拖 */
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  return (
    <>
      <table ref={tableRef} cellPadding={0} cellSpacing={0} className="ranking_table video_table">
        <VideoHead
          sort={
            headSort
              ? {
                  base: headSort.base,
                  params: { level: query.level, author: query.author, time: query.time },
                  order: headSort.order,
                }
              : undefined
          }
        />
        <tbody>
          {items.map((v) => (
            <VideoRowLine key={v.id} video={v} highlight={highlight} />
          ))}
          {items.length === 0 && (
            <tr>
              <td colSpan={7} style={{ textAlign: "center" }}>
                暂无数据
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="list_footer">
        <PageSlider
          page={curPage}
          pages={maxPage}
          loading={loading}
          onGoto={gotoPage}
          hasMore={hasMore}
          onMore={loadMore}
        />
      </div>
    </>
  );
}
