// 进步榜「加载更多 + 页码滑条」交互（2026-09-24 张老师要求：玩家展示样式与雷界排行一致；
// 2026-10-14 加滑条翻页 + 递增批量，同 RankingFeed 语义）：
// 表格复用 RankingRows 行渲染（排名=今日总计时间名次、姓名+军衔+8 列成绩、尾列=日升降），
// 底部两行：PageSlider 滑条（严格一页换页/缓存回跳/松手立即加载）+ 递增批量加载更多。
// 无搜索框/「我在哪里」（榜序按升降幅度，不走定位）。

"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { GrowRow } from "@/lib/ranksnap";
import { noFocusJump } from "./useKeepScroll";
import { TotalCount } from "./TotalCount";
import { PageSlider, nextBatchSize, PageCache } from "./PageSlider";
import { RANKING_COLS, RankingRowLine, type TitledRow } from "./RankingRows";

type GrowTitledRow = GrowRow & { title: string };

export function GrowFeed({
  initial,
  total,
  pageSize,
}: {
  initial: (GrowRow & { title: string })[];
  total: number;
  pageSize: number;
}) {
  const [rows, setRows] = useState(initial);
  const [nextPage, setNextPage] = useState(2);
  const [batchStep, setBatchStep] = useState(0); // 递增批量序号（驱动按钮文案，换页重置）
  const [loadedAll, setLoadedAll] = useState(initial.length >= total);
  const [loading, setLoading] = useState(false);
  const [hint, setHint] = useState("");

  // ---- 滑条窗口状态（2026-10-14）----
  const tableRef = useRef<HTMLTableElement>(null);
  const winStart = 1; // 进步榜行没有全局 rank 字段，窗口起点恒为已加载首行页=1（从首页顺序加载）
  const winEnd = Math.max(1, Math.ceil(rows.length / pageSize));
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
    setHint("");
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
      setRows((prev) => [...prev, ...added]);
      // 新覆盖的整页入缓存（本批从 prevCount 起拼接）
      const totalNow = prevCount + added.length;
      for (let pg = Math.floor(prevCount / pageSize); pg < Math.ceil(totalNow / pageSize); pg++) {
        const from = pg * pageSize;
        const to = from + pageSize;
        if (from >= prevCount && to <= totalNow) {
          pageCache.current.set(pg + 1, added.slice(from - prevCount, to - prevCount));
        }
      }
      setBatchStep((s) => s + 1);
      setNextPage((p) => p + Math.ceil(added.length / pageSize));
      if (totalNow >= total) setLoadedAll(true);
    } catch {
      setHint("加载失败，请重试");
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  /** 滑条换页（严格一页）：进步榜只支持从缓存或拉取（无窗口内滚动——行数即窗口） */
  async function gotoPage(p: number) {
    if (loading) return;
    p = Math.min(maxPage, Math.max(1, p));
    if (p === curPage) return;
    // 已加载窗口内（<=winEnd）：滚动定位到该页首行
    if (p <= winEnd) {
      setCurPage(p);
      const first = (p - 1) * pageSize;
      const row = rows[first];
      const el = row ? document.getElementById(`id_${row.id}`) : null;
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
    }
    setCurPage(p);
    const cached = pageCache.current.get(p);
    if (cached) {
      flushSync(() => setRows(cached));
      setBatchStep(0);
      setNextPage(p + 1);
      setLoadedAll(cached.length >= total || p >= maxPage);
      tableRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      setHint(`已翻到第 ${p} 页（缓存）`);
      setTimeout(() => setHint(""), 1600);
      return;
    }
    const seq = ++reqSeq.current;
    setLoading(true);
    setHint("");
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
      flushSync(() => setRows(added));
      setBatchStep(0);
      setNextPage(p + 1);
      setLoadedAll(added.at(-1) !== undefined && p * pageSize >= total);
      tableRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      setHint(`已翻到第 ${p} 页`);
      setTimeout(() => setHint(""), 1600);
    } catch {
      setHint("加载失败，请重试");
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  return (
    <>
      <table ref={tableRef} cellPadding={0} cellSpacing={0} className="ranking_table">
        <thead>
          <tr>
            <th>排名</th>
            <th>姓名</th>
            <th>军衔</th>
            {RANKING_COLS.map((c) => (
              <th key={c.by}>{c.label}</th>
            ))}
            {/* 榜序按日升降幅度（非成绩列排序），升降表头黄标 */}
            <th className="current">升降</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => (
            /* by 传 null：进步榜不按成绩列排序，任何成绩列都不做排序高亮 */
            <RankingRowLine key={u.id} row={u} by={null} delta={u.delta} showDelta />
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={12} style={{ textAlign: "center" }}>
                快照数据积累两天后开始有进步排行。
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="list_footer">
        <PageSlider
          page={curPage}
          pages={maxPage}
          winStart={winStart}
          winEnd={winEnd}
          loading={loading}
          onGoto={gotoPage}
        />
        <div className="more_loader ranking_loader">
          {loadedAll ? (
            <span className="all_loaded">已加载全部</span>
          ) : (
            <button
              type="button"
              className="button small"
              disabled={loading}
              onMouseDown={noFocusJump}
              onClick={loadMore}
            >
              {loading ? "加载中…" : `加载更多 +${nextBatchSize(batchStep, pageSize)}`}
            </button>
          )}
          {/* 2026-09-26 张老师要求：显示剩余条数而非总数 */}
          <TotalCount total={total} loaded={rows.length} unit="位" />
          {hint && <span className="loader_hint">{hint}</span>}
        </div>
      </div>
    </>
  );
}
