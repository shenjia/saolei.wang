// 录像列表页「加载更多 + 页码滑条」交互（2026-09-24 张老师要求：/video 老式翻页改加载更多；
// 2026-10-14 加滑条翻页 + 递增批量，同 RankingFeed 语义，设计稿 design/page-slider-v1.html v1.4）：
// 页码语义（与 getVideoList 一致：level/order/author 全筛选组合），复用 VideoRows 行渲染；
// 底部两行（上=PageSlider 滑条，下=按钮+总数），滑条换页严格一页、缓存回跳零请求、
// 松手立即加载（在途请求序号作废）；加载更多按整页批量 +20→+40→+80→+100 封顶。
// 筛选切换仍走链接整页刷新（URL 即状态，保留分享语义）。

"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { VideoListItem } from "@/lib/queries";
import { VideoHead, VideoRowLine } from "./VideoRows";
import { noFocusJump } from "./useKeepScroll";
import { TotalCount } from "./TotalCount";
import { PageSlider, nextBatchSize, PageCache } from "./PageSlider";

export function VideoListFeed({
  initial,
  total,
  pageSize,
  query,
  highlight,
  pager = true,
}: {
  initial: VideoListItem[];
  /** 当前筛选条件下的录像总数 */
  total: number;
  pageSize: number;
  /** 筛选参数（level/order/author，构造增量请求用） */
  query: { level: string; order: string; author?: number };
  /** 排序命中列高亮（按成绩/按3BV/s 时对应列整列黄，2026-09-27） */
  highlight?: "time" | "3bvs";
  /** 是否显示页码滑条（/video 列表页 true；用户主页录像版块 false——只享受递增批量，不翻页） */
  pager?: boolean;
}) {
  const [items, setItems] = useState(initial);
  const [hasMore, setHasMore] = useState(initial.length < total);
  const [loading, setLoading] = useState(false);
  const [batchStep, setBatchStep] = useState(0); // 递增批量序号（驱动按钮文案，2026-10-14）

  // ---- 滑条窗口状态（2026-10-14）----
  const tableRef = useRef<HTMLTableElement>(null);
  const winStart = 1; // 列表从第 1 页顺序加载（无 ?page= 深链）
  const winEnd = Math.max(1, Math.ceil(items.length / pageSize));
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
    // 每页条数：递增批量（首击=一页 base），默认与初始页一致（列表页 20 / 用户主页 10）
    qs.set("size", String(size ?? pageSize));
    return `/api/video/more?${qs}`;
  }

  async function loadMore() {
    if (loading || !hasMore) return;
    setLoading(true);
    const seq = ++reqSeq.current;
    try {
      const page = Math.floor(items.length / pageSize) + 1;
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
          pageCache.current.set(pg + 1, data.videos.slice(from - prevCount, to - prevCount));
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
    if (p <= winEnd) {
      const first = (p - 1) * pageSize;
      if (items[first]) {
        setCurPage(p);
        // 滚到该页首行（录像行无 id_ 锚点，用表格行定位）
        const tr = tableRef.current?.tBodies[0]?.children[first] as HTMLElement | undefined;
        tr?.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
    }
    setCurPage(p);
    const cached = pageCache.current.get(p);
    if (cached) {
      flushSync(() => setItems(cached));
      setBatchStep(0);
      setHasMore(cached.length < total);
      tableRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
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
      flushSync(() => setItems(data.videos));
      setBatchStep(0);
      // 整表替换后窗口=1 页；还有更多可由滑条或「加载更多」继续（序列已重置为首击=一页）
      setHasMore(p * pageSize < total);
      tableRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch {
      /* 失败静默，重试可再拖 */
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  const nextBatch = hasMore ? nextBatchSize(batchStep, pageSize) : 0;

  return (
    <>
      <table ref={tableRef} cellPadding={0} cellSpacing={0} className="ranking_table video_table">
        <VideoHead />
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
        {pager && (
          <PageSlider
            page={curPage}
            pages={maxPage}
            winStart={winStart}
            winEnd={winEnd}
            loading={loading}
            onGoto={gotoPage}
          />
        )}
        <div className="more_loader">
          {hasMore ? (
            <button
              type="button"
              className="button small"
              disabled={loading}
              onMouseDown={noFocusJump}
              onClick={loadMore}
            >
              {loading ? "加载中…" : nextBatch > 0 ? `加载更多 +${nextBatch}` : "加载更多"}
            </button>
          ) : (
            items.length > 0 && <span className="all_loaded">已加载全部</span>
          )}
          {/* 2026-09-26 张老师要求：显示剩余条数而非总数 */}
          <TotalCount total={total} loaded={items.length} unit="个" />
        </div>
      </div>
    </>
  );
}
