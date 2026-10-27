// BV 收集榜表格 + 「加载更多」（2026-10-13 张老师需求，设计稿 design/ranking-bv.html v3）。
// 列：排名 | 姓名 | 军衔 | 初级 | 中级 | 高级 | 总计——基础三列复刻 RankingRowLine 的真实渲染
// （第 N 位 / 白链+性别图标 / TitleBadge 徽章+气泡），成绩列为 pbar 进度条（2026-10-14
// 起改用个人主页同款：上收集数、下 3px 细条；默认灰，仅当前排序列金黄 #fdc61d）。
// 表头即排序切换（同雷界榜列头 Link 模式，当前列金黄）；表头纯级别名，不带区间数字
// （2026-10-14 张老师：不对齐很难看，加过括号又整体去掉）。
//
// 2026-10-14 搜索定位（C 方案，设计稿 design/ranking-bv-search.html）：
//   · 搜索框（RankingNav）经 ranking:locate 自定义事件委托本组件定位；
//   · 目标已在已加载行内 → 滚动 + 持续高亮；否则整页跳 whereami（view=bv，#id_ 锚点）——
//     BV 榜 505 页，不沿用成绩榜「30 页内并发拉缺失页」策略；
//   · 落地态显示「已定位到第 N 位（第 P 页）」提示条 + 「回到榜首」出口（否则用户被丢在深页）；
//   · 顺带修一个 bug：nextPage 原先硬编码为 2，`?page=N` 直接落地后点「加载更多」会去拉
//     第 2 页（重复 + 乱序）——改为按已加载末行 rank 推算。
// 数据 1 小时缓存，页脚注明。

"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { BvRankingRow } from "@/lib/queries";
import { LEVEL_NAMES, type BvRankingBy, type VideoLevel } from "@/lib/config";
import { RankingName, TitleBadge } from "./Cells";
import { SystemText } from "./SystemText";
import { PageSlider, nextBatchSize, PageCache } from "./PageSlider";
import { captureViewportAnchor, restoreViewportAnchor } from "./useNoJump";
import { toast, toastLoadingDone } from "./Toast";

export type BvTitledRow = BvRankingRow & { title: string; classic?: { name: string; color: string } | null };

const SORT_COLS: BvRankingBy[] = ["beg", "int", "exp", "total"];

// BV/STNB 榜列宽钉死（2026-10-26 张老师要求：NF 开关列宽零变化）。
// table-layout:fixed 下列宽只由 colgroup 决定、与内容无关；前 3 列 ≥ 实测最小内容宽
// （1px 钉宽 + scrollWidth 实测 [71,58,85,98,98,98,98]），4 个进度条列均分余量。
export const BV_COL_WIDTHS = [73, 108, 105, 132, 132, 132, 131];

/** 进度条单元格：个人主页 3BV 收集同款形态（2026-10-14 张老师要求试做）——
    上面收集数 n（2026-10-14 张老师：去掉分母，分母移到 title 气泡）、下面 3px 细进度条；
    默认灰，当前排序列金黄 #fdc61d */
function BvBar({ n, den, active }: { n: number; den: number; active: boolean }) {
  const pct = den > 0 ? (n / den) * 100 : 0;
  return (
    <td>
      <span className={`pbar${active ? " current" : ""}`} title={`收集进度 ${n}/${den}`}>
        <span className="pnum">
          <em>{n}</em>
        </span>
        <span className="ptrack">
          <span className="pfill" style={{ width: `${pct}%` }} />
        </span>
      </span>
    </td>
  );
}

export function BvRankingFeed({
  initial,
  by,
  pageSize,
  total,
  den,
  totalDen,
  initialHl,
  nf = false,
}: {
  initial: BvTitledRow[];
  by: BvRankingBy;
  pageSize: number;
  total: number;
  den: Record<VideoLevel, number>;
  totalDen: number;
  /** 定位落地行（whereami 302 携带 hl=<uid>，SSR 即高亮，无 JS 也可见） */
  initialHl?: number;
  /** 仅统计 NF 录像 */
  nf?: boolean;
}) {
  const router = useRouter();
  const nfQuery = nf ? "&nf=1" : "";
  function rankingHref(sort: BvRankingBy) {
    const qs = new URLSearchParams({ view: "bv" });
    if (sort !== "total") qs.set("by", sort);
    if (nf) qs.set("nf", "1");
    return `/ranking?${qs}`;
  }
  const [rows, setRows] = useState(initial);
  // 下页 = 已加载末行的下一页（`?page=N` 直接落地时首行不是第 1 位，硬编码 2 会拉错页）
  const nextPage = useRef(Math.floor((initial.at(-1)?.rank ?? 0) / pageSize) + 1);
  const [loadedAll, setLoadedAll] = useState(initial.length >= total);
  const [loading, setLoading] = useState(false);
  const [locating, setLocating] = useState(false);
  const [hlUid, setHlUid] = useState<number | undefined>(initialHl);

  // ---- 滑条窗口状态（2026-10-14，同 RankingFeed 语义）----
  const tableRef = useRef<HTMLTableElement>(null);
  const winStart = Math.floor(((rows[0]?.rank ?? 1) - 1) / pageSize) + 1;
  const winEnd = rows.length ? Math.floor((rows.at(-1)!.rank - 1) / pageSize) + 1 : winStart;
  const [curPage, setCurPage] = useState(Math.floor(((initial[0]?.rank ?? 1) - 1) / pageSize) + 1);
  const [batchStep, setBatchStep] = useState(0); // 递增批量序号（驱动按钮文案，换页重置）
  const pageCache = useRef(new PageCache<BvTitledRow[]>());
  const reqSeq = useRef(0);
  const maxPage = Math.max(1, Math.ceil(total / pageSize));

  useEffect(() => {
    const pg = Math.floor(((initial[0]?.rank ?? 1) - 1) / pageSize) + 1;
    pageCache.current.set(pg, initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hlRow = hlUid === undefined ? undefined : rows.find((r) => r.id === hlUid);
  // 已加载窗口的首位名次：>1 说明当前不在榜首（落地深页或往下翻过），需要「回到榜首」出口
  const startRank = rows[0]?.rank ?? 1;

  function scrollToRow(id: number): boolean {
    const el = document.getElementById(`id_${id}`);
    if (!el) return false;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    return true;
  }

  async function loadMore() {
    if (loading || loadedAll) return;
    setLoading(true);
    const seq = ++reqSeq.current;
    try {
      const size = nextBatchSize(batchStep, pageSize);
      const res = await fetch(
        `/api/ranking/bv/more?by=${by}&page=${nextPage.current}&size=${size}${nfQuery}`
      );
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { rows: BvTitledRow[] };
      if (seq !== reqSeq.current) return;
      if (!data.rows.length) {
        setLoadedAll(true);
        return;
      }
      setRows((prev) => [...prev, ...data.rows]);
      // 新覆盖的整页入缓存
      const firstPage = nextPage.current;
      for (let pg = firstPage; pg <= Math.floor(data.rows.at(-1)!.rank / pageSize); pg++) {
        const off = (pg - firstPage) * pageSize;
        if (off + pageSize <= data.rows.length) {
          pageCache.current.set(pg, data.rows.slice(off, off + pageSize));
        }
      }
      setBatchStep((s) => s + 1);
      nextPage.current += Math.ceil(data.rows.length / pageSize);
      const lastRank = data.rows.at(-1)!.rank;
      if (lastRank >= total) setLoadedAll(true);
    } catch {
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  /** 滑条换页（严格一页语义，2026-10-14 张老师定）：窗口内滚动定位 / 缓存零请求 / 拉一页替换 */
  async function gotoPage(p: number) {
    if (loading) return;
    p = Math.min(maxPage, Math.max(1, p));
    if (p === curPage) return;
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
    const cached = pageCache.current.get(p);
    if (cached) {
      const anchor = captureViewportAnchor(tableRef.current);
      flushSync(() => setRows(cached));
      restoreViewportAnchor(tableRef.current, anchor);
      setBatchStep(0);
      nextPage.current = p + 1;
      return;
    }
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const res = await fetch(`/api/ranking/bv/more?by=${by}&page=${p}${nfQuery}`);
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { rows: BvTitledRow[] };
      if (seq !== reqSeq.current) return;
      if (!data.rows.length) {
        setLoadedAll(true);
        return;
      }
      pageCache.current.set(p, data.rows);
      const anchor = captureViewportAnchor(tableRef.current);
      flushSync(() => setRows(data.rows));
      restoreViewportAnchor(tableRef.current, anchor);
      setBatchStep(0);
      nextPage.current = p + 1;
      setLoadedAll(data.rows.at(-1)!.rank >= total);
    } catch {
      /* 失败静默，重试可再拖 */
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  // 302 接口需要整页导航语义（带 page 与 # 锚点、可分享可回退），用 router.push 走客户端路由
  function jumpToWhereami(uid: number) {
    const qs = new URLSearchParams({ id: String(uid), view: "bv" });
    if (by !== "total") qs.set("by", by);
    if (nf) qs.set("nf", "1");
    router.push(`/ranking/whereami?${qs}`);
  }

  /** 定位到指定玩家：已在已加载行内 → 滚动高亮；否则问 whereami 要页码后整页跳过去 */
  async function locateRow(uid: number) {
    if (locating) return;
    setHlUid(uid);
    // 搜索等待气泡（2026-10-27 张老师要求）：RankingNav 定位前已 toastLoading()；
    // 已加载行直接滚动 / 未入榜这两种「不跳转」分支在此收气泡，走 whereami 整页导航的
    // 分支由 URL 变化自动渐隐（navigated 标记区分）
    let navigated = false;
    if (scrollToRow(uid)) {
      toastLoadingDone();
      return;
    }
    setLocating(true);
    try {
      const qs = new URLSearchParams({ id: String(uid), view: "bv", format: "json" });
      if (by !== "total") qs.set("by", by);
      if (nf) qs.set("nf", "1");
      const res = await fetch(`/ranking/whereami?${qs}`);
      if (!res.ok) throw new Error();
      const { page } = (await res.json()) as { page: number };
      if (page <= 0) {
        // 全局居中气泡（与成绩榜「暂无成绩」同款交互），不跳转
        toast("该玩家暂无已通过审核的录像，未加入 BV 排行");
        setHlUid(undefined);
        toastLoadingDone();
        return;
      }
      navigated = true;
      jumpToWhereami(uid);
    } catch {
      navigated = true;
      jumpToWhereami(uid); // 探测失败走导航兜底
    } finally {
      setLocating(false);
      if (!navigated) toastLoadingDone();
    }
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
  }, [rows, locating, by, nf]);

  // 落地补一次滚动：whereami 302 带 hl + #id_ 锚点，硬导航靠锚点、软导航下补滚动更稳
  useEffect(() => {
    if (initialHl) scrollToRow(initialHl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      {hlRow && (
        <div className="locate_bar">
          <span>
            已定位到 <em>第 {hlRow.rank} 位</em>（第 {Math.ceil(hlRow.rank / pageSize)} 页）·{" "}
            <em>{hlRow.chineseName}</em>
          </span>
          {startRank > 1 && (
            <Link
              className="back"
              href={rankingHref(by)}
              title="返回 BV 排行第一页"
            >
              回到榜首
            </Link>
          )}
        </div>
      )}
      {/* rank_scroll：同 RankingFeed——表格与翻页控件同宽，窄屏盒内横滑时一起滚 */}
      <div className="rank_scroll">
        <table
          ref={tableRef}
          cellPadding={0}
          cellSpacing={0}
          className="ranking_table rank_fixed"
          style={{ tableLayout: "fixed" }}
        >
          {/* 列宽钉死（2026-10-26 张老师要求：NF 开关列宽零变化）；进度条 pfill 按百分比填充，轨道伸缩不失真 */}
          <colgroup>
            {BV_COL_WIDTHS.map((w, i) => (
              <col key={i} style={{ width: w }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th>排名</th>
              <th className="name">姓名</th>
              <th>
                <SystemText />
              </th>
              {SORT_COLS.map((c) => (
                <th key={c}>
                  <Link
                    href={rankingHref(c)}
                    className={c === by ? "current" : ""}
                    title={`按${c === "total" ? "总计" : LEVEL_NAMES[c]}收集进度排列`}
                  >
                    {c === "total" ? "总计" : LEVEL_NAMES[c]}
                  </Link>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id} id={`id_${u.id}`} className={u.id === hlUid ? "hl" : undefined}>
                <td className="rank">
                  第&nbsp;<em>{u.rank}</em>&nbsp;位
                </td>
                <td className="name">
                  <RankingName id={u.id} name={u.chineseName} sex={u.sex} avatar={u.avatar} />
                </td>
                <td className="miltitle">
                  <TitleBadge title={u.title} classic={u.classic} link />
                </td>
                <BvBar n={u.beg} den={den.beg} active={by === "beg"} />
                <BvBar n={u.int} den={den.int} active={by === "int"} />
                <BvBar n={u.exp} den={den.exp} active={by === "exp"} />
                <BvBar n={u.total} den={totalDen} active={by === "total"} />
              </tr>
            ))}
            {rows.length === 0 && (
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
            hasMore={!loadedAll}
            onMore={loadMore}
          />
        </div>
      </div>
      {/* 排行规则板块已移至页面层独立 box（2026-10-15 张老师要求），不再由本组件渲染 */}
    </>
  );
}
