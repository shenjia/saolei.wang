// STNB 榜表格 + 「加载更多」（2026-10-20 张老师需求，展示形态仿 BvRankingFeed）。
// 列：排名 | 姓名 | 军衔 | 初级 | 中级 | 高级 | 总计——基础三列复刻 RankingRowLine 的
// 真实渲染（第 N 位 / 白链+性别图标 / TitleBadge 徽章+气泡），成绩列为 STNB 数值
// （与「判雷」轴同源；当前排序列金黄 #fdc61d，与 BV 榜进度条命中色一致）。
// 表头即排序切换（同 BV 榜列头 Link 模式）；总计=三级历史最高 STNB 之和，缺级不上总计榜。
// 定位/翻页/滑条全套沿用 BV 榜语义（2026-10-14 C 方案），仅数据源与单元格渲染不同。

"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { StnbBestVideo, StnbRankingRow } from "@/lib/queries";
import { LEVEL_NAMES, type BvRankingBy, type VideoLevel } from "@/lib/config";
import { timeOpposite, TIME_NEVER } from "@/lib/format";
import { TitleBadge } from "./Cells";
import { SystemText } from "./SystemText";
import { PageSlider, nextBatchSize, PageCache } from "./PageSlider";
import { captureViewportAnchor, restoreViewportAnchor } from "./useNoJump";
import { toast } from "./Toast";

export type StnbTitledRow = StnbRankingRow & { title: string; classic?: { name: string; color: string } | null };

const SORT_COLS: BvRankingBy[] = ["beg", "int", "exp", "total"];

/** 成绩秒数显示：xx.xx（秒，毫秒精确到百分位；与站内成绩显示同款） */
function stnbSeconds(timeMs: number): string {
  return (timeMs / 1000).toFixed(2);
}

/** hover 气泡文案（2026-10-20 张老师定格式）：「高级 xx.xx 秒 NF 3月前」
 *  ——级别 + 成绩秒；NF 盘插 NF 标记；结尾相对上传时间（timeOpposite 永久相对口径）。 */
function bestTip(level: VideoLevel, b: StnbBestVideo): string {
  return `${LEVEL_NAMES[level]} ${stnbSeconds(b.timeMs)} 秒${b.nf ? " NF" : ""} ${timeOpposite(b.ct, TIME_NEVER)}`;
}

/** STNB 数值单元格：有成绩 → 白链跳对应录像（/video/<id>，新标签页）+ hover 气泡；
 *  无成绩 → 灰「—」。当前排序列金黄（.snum.current，同 pbar.current 命中色）。 */
function StnbNum({ level, v, b, active }: { level: VideoLevel; v: number; b: StnbBestVideo | null; active: boolean }) {
  return (
    <td>
      <span className={`snum${active ? " current" : ""}`}>
        {v > 0 && b ? (
          <Link href={`/video/${b.vid}`} target="_blank" data-tip={bestTip(level, b)}>
            <em>{v.toFixed(1)}</em>
          </Link>
        ) : (
          <em>—</em>
        )}
      </span>
    </td>
  );
}

export function StnbRankingFeed({
  initial,
  by,
  pageSize,
  total,
  initialHl,
}: {
  initial: StnbTitledRow[];
  by: BvRankingBy;
  pageSize: number;
  total: number;
  /** 定位落地行（whereami 302 携带 hl=<uid>，SSR 即高亮，无 JS 也可见） */
  initialHl?: number;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  // 下页 = 已加载末行的下一页（`?page=N` 直接落地时首行不是第 1 位，硬编码 2 会拉错页）
  const nextPage = useRef(Math.floor((initial.at(-1)?.rank ?? 0) / pageSize) + 1);
  const [loadedAll, setLoadedAll] = useState(initial.length >= total);
  const [loading, setLoading] = useState(false);
  const [locating, setLocating] = useState(false);
  const [hlUid, setHlUid] = useState<number | undefined>(initialHl);

  // ---- 滑条窗口状态（同 BvRankingFeed 语义）----
  const tableRef = useRef<HTMLTableElement>(null);
  const winStart = Math.floor(((rows[0]?.rank ?? 1) - 1) / pageSize) + 1;
  const winEnd = rows.length ? Math.floor((rows.at(-1)!.rank - 1) / pageSize) + 1 : winStart;
  const [curPage, setCurPage] = useState(Math.floor(((initial[0]?.rank ?? 1) - 1) / pageSize) + 1);
  const [batchStep, setBatchStep] = useState(0); // 递增批量序号（驱动按钮文案，换页重置）
  const pageCache = useRef(new PageCache<StnbTitledRow[]>());
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
        `/api/ranking/stnb/more?by=${by}&page=${nextPage.current}&size=${size}`
      );
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { rows: StnbTitledRow[] };
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

  /** 滑条换页（严格一页语义）：窗口内滚动定位 / 缓存零请求 / 拉一页替换 */
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
      const res = await fetch(`/api/ranking/stnb/more?by=${by}&page=${p}`);
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { rows: StnbTitledRow[] };
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
    const qs = new URLSearchParams({ id: String(uid), view: "stnb" });
    if (by !== "total") qs.set("by", by);
    router.push(`/ranking/whereami?${qs}`);
  }

  /** 定位到指定玩家：已在已加载行内 → 滚动高亮；否则问 whereami 要页码后整页跳过去 */
  async function locateRow(uid: number) {
    if (locating) return;
    setHlUid(uid);
    if (scrollToRow(uid)) {
        return;
    }
    setLocating(true);
    try {
      const qs = new URLSearchParams({ id: String(uid), view: "stnb", format: "json" });
      if (by !== "total") qs.set("by", by);
      const res = await fetch(`/ranking/whereami?${qs}`);
      if (!res.ok) throw new Error();
      const { page } = (await res.json()) as { page: number };
      if (page <= 0) {
        // 全局居中气泡（与成绩榜「暂无成绩」同款交互），不跳转
        toast("该玩家暂无有效 STNB 成绩，未加入 STNB 排行");
            setHlUid(undefined);
        return;
      }
      jumpToWhereami(uid);
    } catch {
      jumpToWhereami(uid); // 探测失败走导航兜底
    } finally {
      setLocating(false);
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
  }, [rows, locating, by]);

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
              href={by === "total" ? "/ranking?view=stnb" : `/ranking?view=stnb&by=${by}`}
              title="返回 STNB 排行第一页"
            >
              回到榜首
            </Link>
          )}
        </div>
      )}
      {/* rank_scroll：同 BV 榜——表格与翻页控件同宽，窄屏盒内横滑时一起滚 */}
      <div className="rank_scroll">
        <table ref={tableRef} cellPadding={0} cellSpacing={0} className="ranking_table">
          <thead>
            <tr>
              <th>排名</th>
              <th>姓名</th>
              <th>
                <SystemText />
              </th>
              {SORT_COLS.map((c) => (
                <th key={c}>
                  <Link
                    href={c === "total" ? "/ranking?view=stnb" : `/ranking?view=stnb&by=${c}`}
                    className={c === by ? "current" : ""}
                    title={`按${c === "total" ? "总计" : LEVEL_NAMES[c]}STNB 排列`}
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
                  <Link href={`/user/${u.id}`} title="点击查看个人信息">
                    {u.chineseName}
                  </Link>
                  <span className={`gender ${u.sex ? "male" : "female"} small`}></span>
                </td>
                <td className="miltitle">
                  <TitleBadge title={u.title} classic={u.classic} link />
                </td>
                <StnbNum level="beg" v={u.beg} b={u.best.beg} active={by === "beg"} />
                <StnbNum level="int" v={u.int} b={u.best.int} active={by === "int"} />
                <StnbNum level="exp" v={u.exp} b={u.best.exp} active={by === "exp"} />
                <StnbNum level="exp" v={u.total} b={u.best.exp} active={by === "total"} />
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
      {/* 排行规则板块在页面层独立 box（同 BV 榜，2026-10-15 张老师要求），不由本组件渲染 */}
    </>
  );
}
