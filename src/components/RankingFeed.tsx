// 排行榜「加载更多 + 页码滑条」交互（2026-09-24 张老师要求，替代老式分页；
// 2026-10-14 加滑条翻页 + 递增批量，设计稿 design/page-slider-v1.html v1.4）：
// 表格 + 底部两行（上=PageSlider 页码滑条，下=more_loader 加载更多）。
//   · 滑条换页（严格一页语义，2026-10-14 张老师定）：窗口外 → 只拉固定一页整表替换
//     （窗口/批量序列重置）；窗口内 → 滚动定位零请求；缓存命中（LRU≤30 页）→ 零请求替换。
//     松手立即加载（无防抖），在途请求 reqSeq 序号作废（只认最后一次）。
//   · 加载更多：窗口末尾按递增批量追加（+20→+40→+80→+100 封顶，整页倍数）。
//   （2026-10-15 张老师要求：页脚右侧「如何加入排行？」按钮撤下，移入各排行规则板块底部——
//    见 RankingRules.footer，由页面层判登录/入榜条件）
// 定位策略分三档（点击后跳到目标行）：
//   ① 已加载页内 → scrollIntoView 到 #id_{uid} 行
//   ② 未加载但在 30 页内 → 从当前页并发拉缺失页，插入后滚动定位
//   ③ 更远 → 302 跳 /ranking/whereami（带 page= 的整页导航，保留 URL 分享语义）
// 2026-09-24 四轮：定位能力泛化 locateRow(uid)——右上搜索框去按钮化后经
// ranking:locate 自定义事件委托本组件定位；落地行持续高亮（底色 #3e3d32 + 玩家名黄）。
// 行渲染与 /area 共享 RankingRows；军衔与升降由服务端（SSR/API）预算随行传入。

"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";
import type { RankingRow } from "@/lib/queries";
import type { RankingBy } from "@/lib/config";
import { RankingHead, RankingRowLine, RankingEmpty, type TitledRow } from "./RankingRows";
import { PageSlider, nextBatchSize, PageCache } from "./PageSlider";
import { captureViewportAnchor, restoreViewportAnchor } from "./useNoJump";
import { toast } from "./Toast";

export interface RankingFeedProps {
  initial: (RankingRow & { title: string })[];
  initialDeltas?: Map<number, number | null>;
  by: RankingBy;
  base: string;
  params: Record<string, string | number | undefined>;
  total: number;
  pageSize: number;
  /** 初始高亮行（whereami 302 携带 hl=<uid>，SSR 即高亮，无 JS 也可见） */
  initialHl?: number;
  /** 升降列占位（2026-10-14 张老师需求）：雷界榜切其它排序列时保留空列，版式不跳动；
      仅 /ranking 雷界榜传 true（NF/BV/进步/地区/世界无升降数据，不占位） */
  reserveDelta?: boolean;
  /** 页脚右侧扩展按钮（2026-10-15 地区内页「返回地区排行」）：有值时页脚转 flex 行，
      滑条吃余量、按钮贴右缘（同世界榜 world_pager 口径，CSS 见 globals.css pager_extra） */
  footerExtra?: ReactNode;
}

interface MoreJson {
  rows: TitledRow[];
  deltas?: [number, number | null][];
}

const NEARBY_PAGES = 30; // 未加载时最多并发拉取的页数（每页 20 行 ×30 = 600 行上限）

export function RankingFeed(props: RankingFeedProps) {
  const { by, base, params, total, pageSize, reserveDelta } = props;
  const [rows, setRows] = useState(props.initial);
  const [deltas, setDeltas] = useState<Map<number, number | null> | undefined>(props.initialDeltas);
  const nextPage = useRef(Math.floor((props.initial.at(-1)?.rank ?? 0) / pageSize) + 1);
  const [loadedAll, setLoadedAll] = useState(props.initial.length >= total);
  const [loading, setLoading] = useState(false);
  const [locating, setLocating] = useState(false);
  const [hlUid, setHlUid] = useState<number | undefined>(props.initialHl);
  const tableRef = useRef<HTMLTableElement>(null);
  const router = useRouter();

  // ---- 滑条窗口状态（2026-10-14）----
  // 已加载窗口 [winStart, winEnd]（页）由 rows 首末 rank 推得；curPage = 当前浏览页
  const winStart = Math.floor(((rows[0]?.rank ?? 1) - 1) / pageSize) + 1;
  const winEnd = rows.length ? Math.floor((rows.at(-1)!.rank - 1) / pageSize) + 1 : winStart;
  const [curPage, setCurPage] = useState(
    Math.floor(((props.initial[0]?.rank ?? 1) - 1) / pageSize) + 1
  );
  const [batchStep, setBatchStep] = useState(0); // 递增批量序号（驱动按钮文案，换页重置）
  const pageCache = useRef(new PageCache<TitledRow[]>()); // 页号 → 行数据（LRU≤30）
  const reqSeq = useRef(0); // 在途请求序号（松手立即加载的并发护栏）

  const maxPage = Math.max(1, Math.ceil(total / pageSize));

  // 初始窗口整页入缓存（SSR 行可能不满一页——按页对齐切片）
  useEffect(() => {
    const pg = Math.floor(((props.initial[0]?.rank ?? 1) - 1) / pageSize) + 1;
    pageCache.current.set(pg, props.initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showDelta = by === "sum_time" && deltas !== undefined;
  const deltaCol = reserveDelta === true;

  function scrollToRow(id: number) {
    const el = document.getElementById(`id_${id}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      return true;
    }
    return false;
  }

  async function fetchPage(p: number, size?: number): Promise<MoreJson> {
    const qs = new URLSearchParams({ by, page: String(p) });
    if (params.view) qs.set("view", String(params.view));
    if (params.nf) qs.set("nf", String(params.nf));
    // 地区内页（params.name=地区名）：增量接口同样限定地区人口（2026-10-15）
    if (params.name) qs.set("area", String(params.name));
    if (size && size > pageSize) qs.set("size", String(size));
    const res = await fetch(`/api/ranking/more?${qs}`);
    if (!res.ok) throw new Error("加载失败");
    return (await res.json()) as MoreJson;
    // cursor 由调用方从返回行的 rank 推算
  }

  /** 滑条换页（严格一页语义）：窗口内 → 滚动定位零请求；缓存 → 零请求替换；否则拉一页替换 */
  async function gotoPage(p: number) {
    if (loading) return;
    p = Math.min(maxPage, Math.max(1, p));
    if (p === curPage) return;
    // 窗口内：滚动定位零请求（不换表）
    if (p >= winStart && p <= winEnd) {
      const first = (p - winStart) * pageSize;
      const row = rows[first];
      if (row) {
        setCurPage(p);
        scrollToRow(row.id);
        return;
      }
    }
    setCurPage(p);
    // 缓存命中：零请求整表替换（视口零跳动）
    const cached = pageCache.current.get(p);
    if (cached) {
      const anchor = captureViewportAnchor(tableRef.current);
      flushSync(() => setRows(cached));
      restoreViewportAnchor(tableRef.current, anchor);
      setBatchStep(0);
      return;
    }
    // 窗口外：严格拉固定一页整表替换
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const data = await fetchPage(p);
      if (seq !== reqSeq.current) return; // 已有更新的请求，丢弃本次响应
      if (!data.rows.length) {
        setLoadedAll(true);
        return;
      }
      pageCache.current.set(p, data.rows);
      const anchor = captureViewportAnchor(tableRef.current);
      flushSync(() => {
        setRows(data.rows);
        if (data.deltas) {
          setDeltas((prev) => {
            const m = prev ? new Map(prev) : new Map();
            for (const [id, d] of data.deltas!) m.set(id, d);
            return m;
          });
        } else if (by === "sum_time" && deltas) {
          setDeltas(new Map()); // 换页无升降数据时清空（保持 showDelta 结构一致）
        }
      });
      restoreViewportAnchor(tableRef.current, anchor);
      setBatchStep(0); // 窗口重置，批量序列从头计
      nextPage.current = p + 1;
      setLoadedAll(data.rows.at(-1)!.rank >= total);
    } catch {
      /* 失败静默，重试可再拖 */
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  async function loadMore() {
    if (loading || loadedAll) return;
    setLoading(true);
    const seq = ++reqSeq.current;
    try {
      const size = nextBatchSize(batchStep, pageSize);
      const data = await fetchPage(nextPage.current, size);
      if (seq !== reqSeq.current) return;
      if (!data.rows.length) {
        setLoadedAll(true);
        return;
      }
      setRows((prev) => [...prev, ...data.rows]);
      if (data.deltas) {
        setDeltas((prev) => {
          const m = prev ? new Map(prev) : new Map();
          for (const [id, d] of data.deltas!) m.set(id, d);
          return m;
        });
      }
      // 新覆盖的整页入缓存（页锚点对齐处切片）
      const firstPage = nextPage.current;
      for (let pg = firstPage; pg <= Math.floor(data.rows.at(-1)!.rank / pageSize); pg++) {
        const off = (pg - firstPage) * pageSize;
        if (off + pageSize <= data.rows.length) {
          pageCache.current.set(pg, data.rows.slice(off, off + pageSize));
        }
      }
      setBatchStep((s) => s + 1);
      const lastRank = data.rows.at(-1)!.rank;
      nextPage.current = Math.floor(lastRank / pageSize) + 1;
      if (lastRank >= total) setLoadedAll(true);
    } catch {
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  // 定位到任意玩家（2026-09-24 泛化：搜索框推荐选中后触发）：
  // ① 已加载 → 滚动；② 30 页内 → 并发拉取后滚动；③ 更远 → 跳 whereami 整页导航
  // 落地后该行持续高亮（hlUid），玩家名变黄
  async function locateRow(uid: number) {
    if (locating) return;
    setHlUid(uid);
    if (scrollToRow(uid)) return;
    const targetPage = Math.ceil(((rowRankById(rows, uid) as number | undefined) ?? 0) / pageSize);
    void targetPage; // 行 rank 未知时按页数并发探测
    setLocating(true);
    try {
      const nextPageNum = nextPage.current;
      if (nextPageNum > maxPage) {
        jumpToWhereami(uid);
        return;
      }
      // 估算目标页：先问 whereami 服务端要页码（一次轻量 JSON），再决定拉取或跳转
      const qs = new URLSearchParams({ id: String(uid), by, format: "json" });
      if (params.view) qs.set("view", String(params.view));
      if (params.nf) qs.set("nf", String(params.nf));
      const res = await fetch(`/ranking/whereami?${qs}`);
      if (!res.ok) throw new Error();
      const { page } = (await res.json()) as { page: number };
      if (page <= 0) {
        // 全局居中醒目气泡（2026-09-24 张老师要求：顶部 hint 太不明显）
        toast("该玩家未加入排行榜（暂无成绩）");
            setHlUid(undefined);
        return;
      }
      const lastLoadedRank = rows.at(-1)?.rank ?? 0;
      const targetRank = (page - 1) * pageSize + 1;
      if (targetRank <= lastLoadedRank) {
        scrollToRow(uid);
            return;
      }
      if (page - Math.floor(lastLoadedRank / pageSize) > NEARBY_PAGES) {
        jumpToWhereami(uid);
        return;
      }
      // 并发拉取缺失页（从最后已加载页的下一页到目标页）
      const from = Math.floor(lastLoadedRank / pageSize) + 1;
      const pages: number[] = [];
      for (let p = from; p <= page; p++) pages.push(p);
      const datas = await Promise.all(pages.map(fetchPage));
      const newRows: TitledRow[] = [];
      const newDeltas: [number, number | null][] = [];
      for (const d of datas) {
        newRows.push(...d.rows);
        if (d.deltas) newDeltas.push(...d.deltas);
      }
      // flushSync 强制同步提交——rAF 可能先于 React commit 触发，导致新行未上屏就滚动失败
      // （2026-10-13 实证：搜索定位拉取缺失页后报「未找到该玩家的位置」）
      flushSync(() => {
        setRows((prev) => [...prev, ...newRows]);
        if (newDeltas.length) {
          setDeltas((prev) => {
            const m = prev ? new Map(prev) : new Map();
            for (const [id, d] of newDeltas) m.set(id, d);
            return m;
          });
        }
      });
      const lastRank = newRows.at(-1)?.rank ?? 0;
      if (lastRank) nextPage.current = Math.floor(lastRank / pageSize) + 1;
      if (lastRank >= total || page >= maxPage) setLoadedAll(true);
      // 新行已同步上屏，直接滚动
      if (!scrollToRow(uid)) toast("未找到该玩家的位置，请稍后重试");
      else void 0;
    } catch {
      jumpToWhereami(uid);
    } finally {
      setLocating(false);
    }
  }

  // 302 接口需要整页导航语义（带 page 与 # 锚点、可分享可回退），用 router.push 走客户端路由
  function jumpToWhereami(uid: number) {
    const qs = new URLSearchParams({ id: String(uid), by });
    if (params.view) qs.set("view", String(params.view));
    if (params.nf) qs.set("nf", String(params.nf));
    router.push(`/ranking/whereami?${qs}`);
  }

  // 搜索框事件（RankingNav 无按钮化后经自定义事件委托定位）
  useEffect(() => {
    function onLocate(e: Event) {
      const { id } = (e as CustomEvent<{ id: number }>).detail;
      void locateRow(id);
    }
    window.addEventListener("ranking:locate", onLocate);
    return () => window.removeEventListener("ranking:locate", onLocate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, locating, by, params.view, params.nf]);

  return (
    // rank_scroll：表格与页脚同宽容器（2026-10-15 张老师要求：翻页控件与最后一行
    // 数据左右对齐；窄屏盒内横滑时两者一起滚，右缘贴齐）。CSS 见 globals.css
    <div className="rank_scroll">
      <table ref={tableRef} cellPadding={0} cellSpacing={0} className="ranking_table">
        <RankingHead by={by} base={base} params={params} showDelta={showDelta} deltaCol={deltaCol} />
        <tbody>
          {rows.map((u) => (
            <RankingRowLine
              key={u.id}
              row={u}
              by={by}
              delta={deltas?.get(u.id)}
              showDelta={showDelta}
              deltaCol={deltaCol}
              hl={u.id === hlUid}
            />
          ))}
          {rows.length === 0 && <RankingEmpty showDelta={showDelta} deltaCol={deltaCol} />}
        </tbody>
      </table>
      <div className={"list_footer" + (props.footerExtra ? " pager_extra" : "")}>
        <PageSlider
          page={curPage}
          pages={maxPage}
          loading={loading || locating}
          onGoto={gotoPage}
          hasMore={!loadedAll}
          onMore={loadMore}
        />
        {props.footerExtra}
      </div>
    </div>
  );
}

function rowRankById(rows: RankingRow[], id: number): number | undefined {
  return rows.find((r) => r.id === id)?.rank;
}
