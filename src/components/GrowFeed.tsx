// 进步榜「加载更多 + 页码滑条」交互（2026-09-24 张老师要求：玩家展示样式与雷界排行一致；
// 2026-10-14 加滑条翻页 + 递增批量，同 RankingFeed 语义）：
// 表格复用 RankingRows 行渲染（排名=本进步榜内名次、姓名+军衔+8 列成绩、尾列=日升降），
// 榜内只列名次上升者（2026-10-16 张老师定）；.grow_table 标记类供升降列金色渲染区分雷界榜，
// 底部两行：PageSlider 滑条（严格一页换页/缓存回跳/松手立即加载）+ 递增批量加载更多。
// 2026-11-10 张老师要求：进步/活跃榜搜索与雷界榜一致——本组件监听 ranking:locate 事件
// 定位（页内滚动高亮 / whereami json 探测页码 / 远页整页导航 view=grow，落地 page+hl）。

"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useRouter } from "next/navigation";
import type { GrowRow } from "@/lib/ranksnap";
import { PageSlider, nextBatchSize, PageCache } from "./PageSlider";
import { captureViewportAnchor, restoreViewportAnchor } from "./useNoJump";
import { RANKING_COLS, RankingRowLine, type TitledRow } from "./RankingRows";
import { SystemText } from "./SystemText";
import { toast, toastLoadingDone } from "./Toast";

type GrowTitledRow = GrowRow & { title: string; classic?: { name: string; color: string } | null };

/** 未加载时定位最多逐页拉取的页数（同 RankingFeed.NEARBY_PAGES 口径） */
const NEARBY_PAGES = 30;

export function GrowFeed({
  initial,
  total,
  pageSize,
  initialHl,
}: {
  initial: (GrowRow & { title: string; classic?: { name: string; color: string } | null })[];
  total: number;
  pageSize: number;
  /** 定位落地行（whereami 302 携带 hl=<uid>，SSR 即高亮） */
  initialHl?: number;
}) {
  const [rows, setRows] = useState(initial);
  const [nextPage, setNextPage] = useState(2);
  const [batchStep, setBatchStep] = useState(0); // 递增批量序号（驱动按钮文案，换页重置）
  const [loadedAll, setLoadedAll] = useState(initial.length >= total);
  const [loading, setLoading] = useState(false);
  const [locating, setLocating] = useState(false);
  const [hlUid, setHlUid] = useState<number | undefined>(initialHl);
  const router = useRouter();

  // ---- 滑条窗口状态（2026-10-14）----
  const tableRef = useRef<HTMLTableElement>(null);
  // 窗口起点显式跟踪（2026-10-16 修复「跳远页后拖不回第 1 页」，同 VideoListFeed）
  const [winStart, setWinStart] = useState(1);
  const winEnd = Math.max(winStart, Math.ceil(rows.length / pageSize));
  const [curPage, setCurPage] = useState(1);
  const pageCache = useRef(new PageCache<GrowTitledRow[]>());
  const reqSeq = useRef(0);
  const maxPage = Math.max(1, Math.ceil(total / pageSize));

  useEffect(() => {
    pageCache.current.set(1, initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadMore() {
    if (loading || loadedAll) return;
    setLoading(true);
    const seq = ++reqSeq.current;
    try {
      const size = nextBatchSize(batchStep, pageSize);
      const res = await fetch(`/api/grow/more?page=${nextPage}&size=${size}`);
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { rows: TitledRow[] };
      if (seq !== reqSeq.current) return;
      if (!data.rows.length) {
        setLoadedAll(true);
        return;
      }
      const added = data.rows as GrowTitledRow[];
      const prevCount = rows.length;
      // 加载即翻页（2026-11-12 张老师定）：点「···」后当前页码 +1 指向新加载的
      // 首个新页，并滚动定位到新页首行（同 NewsFeed，否则页码停在原页、点 ▶
      // 只滚不翻页）。行锚点 id_ 与 gotoPage 窗口内分支同口径。
      flushSync(() => {
        setRows((prev) => [...prev, ...added]);
      });
      document
        .getElementById(`id_${added[0].id}`)
        ?.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center" });
      setCurPage(nextPage);
      // 新覆盖的整页入缓存（本批从 prevCount 起拼接）
      const totalNow = prevCount + added.length;
      for (let pg = Math.floor(prevCount / pageSize); pg < Math.ceil(totalNow / pageSize); pg++) {
        const from = pg * pageSize;
        const to = from + pageSize;
        if (from >= prevCount && to <= totalNow) {
          pageCache.current.set(winStart + pg, added.slice(from - prevCount, to - prevCount));
        }
      }
      setBatchStep((s) => s + 1);
      setNextPage((p) => p + Math.ceil(added.length / pageSize));
      if (totalNow >= total) setLoadedAll(true);
    } catch {
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  /** 滑条换页（严格一页）：进步榜只支持从缓存或拉取（无窗口内滚动——行数即窗口） */
  async function gotoPage(p: number) {
    if (loading) return;
    p = Math.min(maxPage, Math.max(1, p));
    if (p === curPage) return;
    // 已加载窗口内（winStart..winEnd）：滚动定位到该页首行
    if (p >= winStart && p <= winEnd) {
      setCurPage(p);
      const first = (p - winStart) * pageSize;
      const row = rows[first];
      const el = row ? document.getElementById(`id_${row.id}`) : null;
      if (el) {
        el.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center" });
        return;
      }
    }
    setCurPage(p);
    const cached = pageCache.current.get(p);
    if (cached) {
      const anchor = captureViewportAnchor(tableRef.current);
      flushSync(() => {
        setRows(cached);
        setWinStart(p);
      });
      restoreViewportAnchor(tableRef.current, anchor);
      setBatchStep(0);
      setNextPage(p + 1);
      setLoadedAll(cached.length >= total || p >= maxPage);
      return;
    }
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const res = await fetch(`/api/grow/more?page=${p}`);
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { rows: TitledRow[] };
      if (seq !== reqSeq.current) return;
      if (!data.rows.length) {
        setLoadedAll(true);
        return;
      }
      const added = data.rows as GrowTitledRow[];
      pageCache.current.set(p, added);
      const anchor = captureViewportAnchor(tableRef.current);
      flushSync(() => {
        setRows(added);
        setWinStart(p);
      });
      restoreViewportAnchor(tableRef.current, anchor);
      setBatchStep(0);
      setNextPage(p + 1);
      setLoadedAll(added.at(-1) !== undefined && p * pageSize >= total);
    } catch {
      /* 失败静默，重试可再拖 */
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  // ---- 搜索定位（2026-11-10 张老师要求：与雷界榜一致）----
  // 已加载行（含缓存整表替换后的当前窗口）→ 滚动高亮；否则问 whereami 要页码：
  // 近页（30 页内）逐页拉到目标页后滚动；远页整页导航 view=grow（302 回带 page+hl）。
  function scrollToRow(id: number): boolean {
    const el = document.getElementById(`id_${id}`);
    if (!el) return false;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    return true;
  }

  function jumpToWhereami(uid: number) {
    router.push(`/ranking/whereami?id=${uid}&view=grow`);
  }

  async function locateRow(uid: number) {
    if (locating) return;
    setHlUid(uid);
    // 搜索等待气泡（同雷界榜 2026-10-27 口径）：不跳转分支 finally 收，跳转分支 URL 变化渐隐
    let navigated = false;
    if (scrollToRow(uid)) {
      toastLoadingDone();
      return;
    }
    setLocating(true);
    try {
      const res = await fetch(`/ranking/whereami?id=${uid}&view=grow&format=json`);
      if (!res.ok) throw new Error();
      const { page } = (await res.json()) as { page: number };
      if (page <= 0) {
        // 全局居中气泡（与雷界榜「暂无成绩」同款交互），不跳转
        toast("该玩家近 30 天名次无提升，未加入进步排行");
        setHlUid(undefined);
        return;
      }
      if (page - winStart + 1 > NEARBY_PAGES) {
        navigated = true;
        jumpToWhereami(uid);
        return;
      }
      // 逐页拉到目标页（进步榜 API 一次一页；winStart..winEnd 递增推进）
      let cur = winStart + Math.ceil(rows.length / pageSize) - 1; // 已加载末页
      let win = winStart;
      let first = rows;
      if (page <= cur) {
        scrollToRow(uid);
        return;
      }
      while (cur < page) {
        const res2 = await fetch(`/api/grow/more?page=${cur + 1}`);
        if (!res2.ok) throw new Error();
        const data = (await res2.json()) as { rows: TitledRow[] };
        if (!data.rows.length) break;
        const added = data.rows as GrowTitledRow[];
        pageCache.current.set(cur + 1, added);
        first = added;
        win = cur + 1;
        cur += 1;
      }
      // 目标页整表替换后滚动（flushSync 保证新行上屏后再滚）
      flushSync(() => {
        setRows(first);
        setWinStart(win);
        setNextPage(win + 1);
        setBatchStep(0);
        setCurPage(page); // 滑条同步到目标页（否则滑条停在旧页与内容错位）
      });
      if (!scrollToRow(uid)) toast("未找到该玩家的位置，请稍后重试");
    } catch {
      navigated = true;
      jumpToWhereami(uid); // 探测失败走导航兜底
    } finally {
      setLocating(false);
      if (!navigated) toastLoadingDone();
    }
  }

  // 搜索框事件（RankingNav 经 ranking:locate 自定义事件委托本组件定位）
  useEffect(() => {
    function onLocate(e: Event) {
      const { id } = (e as CustomEvent<{ id: number }>).detail;
      void locateRow(id);
    }
    window.addEventListener("ranking:locate", onLocate);
    return () => window.removeEventListener("ranking:locate", onLocate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, locating, winStart]);

  // 落地补一次滚动：whereami 302 带 hl + #id_ 锚点，硬导航靠锚点、软导航下补滚动更稳
  useEffect(() => {
    if (initialHl) scrollToRow(initialHl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    // rank_scroll：同 RankingFeed——表格与翻页控件同宽，窄屏盒内横滑时一起滚
    <div className="rank_scroll">
      <table ref={tableRef} cellPadding={0} cellSpacing={0} className="ranking_table grow_table">
        <thead>
          <tr>
            <th>排名</th>
            <th>姓名</th>
            <th>
              <SystemText />
            </th>
            {/* 2026-11-10 张老师要求：活跃列仅地区内页显示，进步榜剔除 act */}
            {RANKING_COLS.filter((c) => c.by !== "act").map((c) => (
              <th key={c.by}>{c.label}</th>
            ))}
            {/* 榜序按日升降幅度（非成绩列排序），升降表头黄标 */}
            <th className="current">升降</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => (
            /* by 传 null：进步榜不按成绩列排序，任何成绩列都不做排序高亮 */
            <RankingRowLine key={u.id} row={u} by={null} delta={u.delta} showDelta hl={u.id === hlUid} />
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={12} style={{ textAlign: "center" }}>
                当前窗口内暂无名次上升的玩家（快照基准至少需要积累两天数据）。
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="list_footer">
        <PageSlider
          page={curPage}
          pages={maxPage}
          loading={loading || locating}
          onGoto={gotoPage}
          hasMore={!loadedAll}
          onMore={loadMore}
        />
      </div>
    </div>
  );
}
