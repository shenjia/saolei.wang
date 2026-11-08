// 活跃排行「加载更多 + 页码滑条」交互（2026-11-08 张老师需求，复用进步榜同款骨架）：
// 列：排名 | 姓名 | 军衔 | 初级 | 中级 | 高级 | 评论 | 活跃指数。
// 初级/中级/高级 = 7 日（录像上传数 + 练习完成盘数）；评论 = 7 日评论条数；
// 活跃指数 = 练习 3BV 计点 + 录像级别加权分 + 评论数。默认按活跃指数降序，
// 初级/中级/高级/评论（及活跃指数）列点击表头切换排序（?by= 服务端重排，整页换 key 重挂）。

"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import Link from "next/link";
import type { ActiveRow } from "@/lib/activerank";
import { PageSlider, nextBatchSize, PageCache } from "./PageSlider";
import { captureViewportAnchor, restoreViewportAnchor } from "./useNoJump";
import { RankingName, TitleBadge } from "./Cells";
import { SystemText } from "./SystemText";
import { buildUrl } from "./Pager";

export type TitledActiveRow = ActiveRow & {
  title: string;
  classic?: { name: string; color: string } | null;
};

/** 可排序数据列（表头点击切换 ?by=；by=act 为默认不显式入链） */
const ACTIVE_COLS: { by: "act" | "beg" | "int" | "exp" | "cmt"; label: string; tip: string }[] = [
  { by: "beg", label: "初级", tip: "近7日初级录像上传数＋练习完成盘数" },
  { by: "int", label: "中级", tip: "近7日中级录像上传数＋练习完成盘数" },
  { by: "exp", label: "高级", tip: "近7日高级录像上传数＋练习完成盘数" },
  { by: "cmt", label: "评论", tip: "近7日发表评论数（录像评论＋论坛回复）" },
  { by: "act", label: "活跃指数", tip: "练习3BV计点＋录像级别加权分＋评论数" },
];

export function ActiveFeed({
  initial,
  total,
  pageSize,
  by,
}: {
  initial: TitledActiveRow[];
  total: number;
  pageSize: number;
  by: "act" | "beg" | "int" | "exp" | "cmt";
}) {
  const [rows, setRows] = useState(initial);
  const [nextPage, setNextPage] = useState(2);
  const [batchStep, setBatchStep] = useState(0);
  const [loadedAll, setLoadedAll] = useState(initial.length >= total);
  const [loading, setLoading] = useState(false);

  const tableRef = useRef<HTMLTableElement>(null);
  const [winStart, setWinStart] = useState(1);
  const winEnd = Math.max(winStart, Math.ceil(rows.length / pageSize));
  const [curPage, setCurPage] = useState(1);
  const pageCache = useRef(new PageCache<TitledActiveRow[]>());
  const reqSeq = useRef(0);
  const maxPage = Math.max(1, Math.ceil(total / pageSize));

  useEffect(() => {
    pageCache.current.set(1, initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchPage(page: number, size?: number) {
    const qs = new URLSearchParams({ page: String(page) });
    if (size) qs.set("size", String(size));
    if (by !== "act") qs.set("by", by);
    const res = await fetch(`/api/active/more?${qs}`);
    if (!res.ok) throw new Error();
    return (await res.json()) as { rows: TitledActiveRow[]; total: number; pageSize: number };
  }

  async function loadMore() {
    if (loading || loadedAll) return;
    setLoading(true);
    const seq = ++reqSeq.current;
    try {
      const size = nextBatchSize(batchStep, pageSize);
      const data = await fetchPage(nextPage, size);
      if (seq !== reqSeq.current) return;
      if (!data.rows.length) {
        setLoadedAll(true);
        return;
      }
      const added = data.rows;
      const prevCount = rows.length;
      setRows((prev) => [...prev, ...added]);
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

  async function gotoPage(p: number) {
    if (loading) return;
    p = Math.min(maxPage, Math.max(1, p));
    if (p === curPage) return;
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
      const data = await fetchPage(p);
      if (seq !== reqSeq.current) return;
      if (!data.rows.length) {
        setLoadedAll(true);
        return;
      }
      const added = data.rows;
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

  return (
    <div className="rank_scroll">
      <table ref={tableRef} cellPadding={0} cellSpacing={0} className="ranking_table active_table">
        <thead>
          <tr>
            <th>排名</th>
            <th className="name">姓名</th>
            <th>
              <SystemText />
            </th>
            {ACTIVE_COLS.map((c) => (
              <th key={c.by}>
                <Link
                  href={buildUrl("/ranking", { view: "active", by: c.by === "act" ? undefined : c.by })}
                  className={c.by === by ? "current" : ""}
                  title={`按${c.label}排列`}
                >
                  {c.label}
                </Link>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((u, i) => (
            <tr key={u.id} id={`id_${u.id}`}>
              <td className="rank">
                第&nbsp;<em>{(winStart - 1) * pageSize + i + 1}</em>&nbsp;位
              </td>
              <td className="name">
                <RankingName id={u.id} name={u.chineseName} englishName={u.englishName} sex={u.sex} avatar={u.avatar} />
              </td>
              <td className="miltitle">
                <TitleBadge title={u.title} classic={u.classic} link />
              </td>
              {ACTIVE_COLS.map((c) => (
                <td key={c.by} className={`num${c.by === by ? " current" : ""}`} title={c.tip}>
                  {(c.by === "act" ? u.act : u[c.by]) || "-"}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={8} style={{ textAlign: "center" }}>
                近 7 天还没有活跃数据（上传录像、练习、发表评论都会计入）。
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
          hasMore={!loadedAll}
          onMore={loadMore}
        />
      </div>
    </div>
  );
}
