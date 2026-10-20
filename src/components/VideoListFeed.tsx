// 录像列表页「加载更多 + 页码滑条」交互（2026-09-24 张老师要求：/video 老式翻页改加载更多；
// 2026-10-14 加滑条翻页 + 递增批量，同 RankingFeed 语义，设计稿 design/page-slider-v1.html v1.4）：
// 页码语义（与 getVideoList 一致：level/order/author/time 全筛选组合），复用 VideoRows 行渲染；
// 底部两行（上=PageSlider 滑条，下=按钮+总数），滑条换页严格一页、缓存回跳零请求、
// 松手立即加载（在途请求序号作废）；加载更多按整页批量 +20→+40→+80→+100 封顶。
// 筛选切换仍走链接整页刷新（URL 即状态，保留分享语义）。
// 2026-10-15：query 增 time（时间成绩搜索）；headSort 有值时表头渲染排序链接（仅 /video 列表页）。
// 2026-10-16（张老师要求）：新增 client 模式（用户主页录像版块）——切级别、点表头排序
// 就地拉 /api/video/more 第 1 页整表替换，不导航不跳顶（与首页切换筛选同体验）；
// URL 用 history.replaceState 同步（不产生历史记录、不触发 RSC、不计主页人气），
// head 渲染位随内部筛选状态实时重渲染（tabs 高亮/链接实时更新）。
// 2026-10-16 晚：/video 列表页也切换 client 模式（张老师拍板「切换」）——级别 tabs 收进
// 客户端壳 VideoListSection（页头+搜索框一起就地重渲染）；搜索框（author/time 筛选）
// 仍走软导航，由 key=author-time 强制重挂载换入服务端新数据（client 内部状态随之归位）。

"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import type { VideoListItem } from "@/lib/queries";
import type { VideoListOrder } from "@/lib/config";
import { VideoHead, VideoRowLine, type VideoHighlight } from "./VideoRows";
import { PageSlider, nextBatchSize, PageCache } from "./PageSlider";
import { captureViewportAnchor, restoreViewportAnchor } from "./useNoJump";

/** client 模式 head 渲染位上下文：当前筛选状态 + 就地切换动作 */
export interface VideoListHeadCtx {
  level: string;
  order: VideoListOrder;
  setLevel: (lv: string) => void;
  setOrder: (o: VideoListOrder) => void;
}

export function VideoListFeed({
  initial,
  total,
  pageSize,
  query,
  headSort,
  client = false,
  head,
  noSort3bv,
}: {
  initial: VideoListItem[];
  /** 当前筛选条件下的录像总数 */
  total: number;
  pageSize: number;
  /** 筛选参数（level/order/author/time/3bv；client 模式下仅作初始值） */
  query: { level: string; order: string; author?: number; time?: string; bv?: string };
  /** 表头排序（/video：Link 导航；client 模式：href 仅作中键/新标签兜底，左键就地排序）。
   *  authorInLinks：client 模式兜底链接是否携带 author（/video 的 author 是真实筛选必须带；
   *  用户主页 author 隐含在路径 /user/{id}，默认剥掉） */
  headSort?: { base: string; order: VideoListOrder; authorInLinks?: boolean };
  /** 客户端筛选/排序模式（2026-10-16 用户主页）：切级别与表头排序就地生效不导航 */
  client?: boolean;
  /** head 渲染位（client 模式）：渲染在表格上方，随内部筛选状态实时重渲染 */
  head?: (ctx: VideoListHeadCtx) => ReactNode;
  /** 3BV 列禁排序（2026-10-20 定向视图：整列同值排序无意义），透传 VideoHead.noSort3bv */
  noSort3bv?: boolean;
}) {
  const [items, setItems] = useState(initial);
  const [hasMore, setHasMore] = useState(initial.length < total);
  const [loading, setLoading] = useState(false);
  const [batchStep, setBatchStep] = useState(0); // 递增批量序号（驱动按钮文案，2026-10-14）

  // ---- 客户端筛选状态（client 模式可就地切换；非 client 恒等于服务端 query）----
  const [curLevel, setCurLevel] = useState(query.level);
  const [curOrder, setCurOrder] = useState<VideoListOrder>(
    (query.order as VideoListOrder) || "id"
  );
  // 条件总数：client 模式切级别后随接口返回更新（total prop 只代表服务端初始条件）
  const [curTotal, setCurTotal] = useState(total);
  // 排序命中列高亮（默认排序=上传时间不高亮，2026-10-15 扩展全部排序列）
  const highlight: VideoHighlight | undefined =
    curOrder === "id" ? undefined : (curOrder as VideoHighlight);

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
  const maxPage = Math.max(1, Math.ceil(curTotal / pageSize));

  useEffect(() => {
    // 初始页（可能不满一页）入缓存
    pageCache.current.set(1, initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function moreUrl(page: number, size?: number) {
    const qs = new URLSearchParams({ level: curLevel, order: curOrder, page: String(page) });
    if (query.author) qs.set("author", String(query.author));
    if (query.time) qs.set("time", query.time);
    if (query.bv) qs.set("3bv", query.bv);
    // 每页条数：递增批量（首击=一页 base），默认与初始页一致（列表页 20 / 用户主页 10）
    qs.set("size", String(size ?? pageSize));
    return `/api/video/more?${qs}`;
  }

  /** URL 即状态（client 模式）：replaceState 同步 level/order（默认值删参）。
   *  必须把当前 history.state 原样传回（它带 __NA/_N 内部标记）：Next 16 的 app-router
   *  patch 了 window.history.replaceState——外部调用若不带内部标记会 dispatch ACTION_RESTORE
   *  并异步把视口滚到该 URL 的缓存滚动位（实测表现为「切筛选/排序后页面跳顶」）；
   *  带标记则直接透传原生 replaceState，Router 零介入、零滚动（2026-10-16 实证） */
  function syncUrl(next: { level?: string; order?: VideoListOrder }) {
    const url = new URL(window.location.href);
    if (next.level !== undefined) url.searchParams.set("level", next.level);
    if (next.order !== undefined) {
      if (next.order === "id") url.searchParams.delete("order");
      else url.searchParams.set("order", next.order);
    }
    window.history.replaceState(window.history.state, "", url);
  }

  /** 就地重拉第 1 页（client 模式切级别/切排序共用）：整表替换 + 分页状态归零 +
   *  视口锚定（captureViewportAnchor 保滚动位置，切换不跳动） */
  async function refetchFirstPage(nextLevel: string, nextOrder: VideoListOrder) {
    if (loading) return;
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        level: nextLevel,
        order: nextOrder,
        page: "1",
        size: String(pageSize),
      });
      if (query.author) qs.set("author", String(query.author));
      if (query.time) qs.set("time", query.time);
      if (query.bv) qs.set("3bv", query.bv);
      const res = await fetch(`/api/video/more?${qs}`);
      if (!res.ok) throw new Error("加载失败");
      const data = (await res.json()) as { videos: VideoListItem[]; total: number };
      if (seq !== reqSeq.current) return;
      pageCache.current = new PageCache<VideoListItem[]>();
      pageCache.current.set(1, data.videos);
      const anchor = captureViewportAnchor(tableRef.current);
      flushSync(() => {
        setItems(data.videos);
        setWinStart(1);
        setCurPage(1);
        setBatchStep(0);
        setCurLevel(nextLevel);
        setCurOrder(nextOrder);
        setCurTotal(data.total);
        setHasMore(data.videos.length < data.total);
      });
      restoreViewportAnchor(tableRef.current, anchor);
      syncUrl({ level: nextLevel, order: nextOrder });
    } catch {
      /* 网络异常静默：可重试 */
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  const changeLevel = (lv: string) => {
    if (lv !== curLevel) refetchFirstPage(lv, curOrder);
  };
  const changeOrder = (o: VideoListOrder) => {
    if (o !== curOrder) refetchFirstPage(curLevel, o);
  };

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
      setHasMore(cached.length < curTotal);
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
      setHasMore(p * pageSize < curTotal);
    } catch {
      /* 失败静默，重试可再拖 */
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  return (
    <>
      {head && head({ level: curLevel, order: curOrder, setLevel: changeLevel, setOrder: changeOrder })}
      <table ref={tableRef} cellPadding={0} cellSpacing={0} className="ranking_table video_table">
        <VideoHead
          noSort3bv={noSort3bv}
          sort={
            headSort
              ? {
                  base: headSort.base,
                  // client 模式兜底链接：author 按 authorInLinks 决定（用户主页剥掉，/video 保留）
                  params: client
                    ? {
                        level: curLevel,
                        author: headSort.authorInLinks ? query.author : undefined,
                        time: query.time,
                        "3bv": query.bv,
                      }
                    : { level: curLevel, author: query.author, time: query.time, "3bv": query.bv },
                  order: curOrder,
                }
              : undefined
          }
          onSort={client ? changeOrder : undefined}
        />
        <tbody>
          {items.map((v) => (
            <VideoRowLine key={v.id} video={v} highlight={highlight} />
          ))}
          {items.length === 0 && (
            <tr>
              <td colSpan={9} style={{ textAlign: "center" }}>
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
