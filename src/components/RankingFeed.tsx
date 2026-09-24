// 排行榜「加载更多」交互（2026-09-24 张老师要求，替代老式分页）：
// 表格 + 底部 more_loader「加载更多」+（登录态）其右侧「我在哪里」按钮。
// 定位策略分三档（点击后跳到目标行）：
//   ① 已加载页内 → scrollIntoView 到 #id_{uid} 行
//   ② 未加载但在 30 页内 → 从当前页并发拉缺失页，插入后滚动定位
//   ③ 更远 → 302 跳 /ranking/whereami（带 page= 的整页导航，保留 URL 分享语义）
// 2026-09-24 四轮：定位能力泛化 locateRow(uid)——右上搜索框去按钮化后经
// ranking:locate 自定义事件委托本组件定位；落地行持续高亮（底色 #3e3d32 + 玩家名黄）。
// 行渲染与 /area 共享 RankingRows；军衔与升降由服务端（SSR/API）预算随行传入。

"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { RankingRow } from "@/lib/queries";
import type { RankingBy } from "@/lib/config";
import { totalLabel } from "@/lib/format";
import { RankingHead, RankingRowLine, RankingEmpty, type TitledRow } from "./RankingRows";
import { noFocusJump } from "./useKeepScroll";
import { toast } from "./Toast";

export interface RankingFeedProps {
  initial: (RankingRow & { title: string })[];
  initialDeltas?: Map<number, number | null>;
  by: RankingBy;
  base: string;
  params: Record<string, string | number | undefined>;
  total: number;
  pageSize: number;
  myUid?: number;
  /** 登录用户是否已加入当前排行：true→「我在哪里」；false→「如何加入排行？」 */
  inRanking: boolean;
  /** 初始高亮行（whereami 302 携带 hl=<uid>，SSR 即高亮，无 JS 也可见） */
  initialHl?: number;
}

interface MoreJson {
  rows: TitledRow[];
  deltas?: [number, number | null][];
}

const NEARBY_PAGES = 30; // 未加载时最多并发拉取的页数（每页 20 行 ×30 = 600 行上限）

export function RankingFeed(props: RankingFeedProps) {
  const { by, base, params, total, pageSize, myUid, inRanking } = props;
  const [rows, setRows] = useState(props.initial);
  const [deltas, setDeltas] = useState<Map<number, number | null> | undefined>(props.initialDeltas);
  const nextPage = useRef(Math.floor((props.initial.at(-1)?.rank ?? 0) / pageSize) + 1);
  const [loadedAll, setLoadedAll] = useState(props.initial.length >= total);
  const [loading, setLoading] = useState(false);
  const [locating, setLocating] = useState(false);
  const [hint, setHint] = useState("");
  const [hlUid, setHlUid] = useState<number | undefined>(props.initialHl);
  const tableRef = useRef<HTMLTableElement>(null);
  const router = useRouter();

  const showDelta = by === "sum_time" && deltas !== undefined;
  const maxPage = Math.max(1, Math.ceil(total / pageSize));

  function scrollToRow(id: number) {
    const el = document.getElementById(`id_${id}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      return true;
    }
    return false;
  }

  async function fetchPage(p: number): Promise<MoreJson> {
    const qs = new URLSearchParams({ by, page: String(p) });
    if (params.view) qs.set("view", String(params.view));
    const res = await fetch(`/api/ranking/more?${qs}`);
    if (!res.ok) throw new Error("加载失败");
    return (await res.json()) as MoreJson;
    // cursor 由调用方从返回行的 rank 推算
  }

  async function loadMore() {
    if (loading || loadedAll) return;
    setLoading(true);
    setHint("");
    try {
      const data = await fetchPage(nextPage.current);
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
      const lastRank = data.rows.at(-1)!.rank;
      nextPage.current = Math.floor(lastRank / pageSize) + 1;
      if (lastRank >= total) setLoadedAll(true);
    } catch {
      setHint("加载失败，请重试");
    } finally {
      setLoading(false);
    }
  }

  // 定位到任意玩家（2026-09-24 泛化：搜索框/「我在哪里」共用）：
  // ① 已加载 → 滚动；② 30 页内 → 并发拉取后滚动；③ 更远 → 跳 whereami 整页导航
  // 落地后该行持续高亮（hlUid），玩家名变黄
  async function locateRow(uid: number) {
    if (locating) return;
    setHlUid(uid);
    if (scrollToRow(uid)) return;
    const targetPage = Math.ceil(((rowRankById(rows, uid) as number | undefined) ?? 0) / pageSize);
    void targetPage; // 行 rank 未知时按页数并发探测
    setLocating(true);
    setHint("正在定位…");
    try {
      const nextPageNum = nextPage.current;
      if (nextPageNum > maxPage) {
        jumpToWhereami(uid);
        return;
      }
      // 估算目标页：先问 whereami 服务端要页码（一次轻量 JSON），再决定拉取或跳转
      const qs = new URLSearchParams({ id: String(uid), by, format: "json" });
      if (params.view) qs.set("view", String(params.view));
      const res = await fetch(`/ranking/whereami?${qs}`);
      if (!res.ok) throw new Error();
      const { page } = (await res.json()) as { page: number };
      if (page <= 0) {
        // 全局居中醒目气泡（2026-09-24 张老师要求：顶部 hint 太不明显）
        toast("该玩家未加入排行榜（暂无成绩）");
        setHint("");
        setHlUid(undefined);
        return;
      }
      const lastLoadedRank = rows.at(-1)?.rank ?? 0;
      const targetRank = (page - 1) * pageSize + 1;
      if (targetRank <= lastLoadedRank) {
        scrollToRow(uid);
        setHint("");
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
      setRows((prev) => [...prev, ...newRows]);
      if (newDeltas.length) {
        setDeltas((prev) => {
          const m = prev ? new Map(prev) : new Map();
          for (const [id, d] of newDeltas) m.set(id, d);
          return m;
        });
      }
      const lastRank = newRows.at(-1)?.rank ?? 0;
      if (lastRank) nextPage.current = Math.floor(lastRank / pageSize) + 1;
      if (lastRank >= total || page >= maxPage) setLoadedAll(true);
      // 等新行上屏后滚动
      requestAnimationFrame(() => {
        if (!scrollToRow(uid)) toast("未找到该玩家的位置，请稍后重试");
        else setHint("");
      });
    } catch {
      jumpToWhereami(uid);
    } finally {
      setLocating(false);
    }
  }

  // 「我在哪里」按钮：定位到自己
  function whereAmI() {
    if (myUid) void locateRow(myUid);
  }

  // 302 接口需要整页导航语义（带 page 与 # 锚点、可分享可回退），用 router.push 走客户端路由
  function jumpToWhereami(uid: number) {
    const qs = new URLSearchParams({ id: String(uid), by });
    if (params.view) qs.set("view", String(params.view));
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
  }, [rows, locating, by, params.view]);

  return (
    <>
      <table ref={tableRef} cellPadding={0} cellSpacing={0} className="ranking_table">
        <RankingHead by={by} base={base} params={params} showDelta={showDelta} />
        <tbody>
          {rows.map((u) => (
            <RankingRowLine
              key={u.id}
              row={u}
              by={by}
              delta={deltas?.get(u.id)}
              showDelta={showDelta}
              hl={u.id === hlUid}
            />
          ))}
          {rows.length === 0 && <RankingEmpty showDelta={showDelta} />}
        </tbody>
      </table>
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
            {loading ? "加载中…" : "加载更多"}
          </button>
        )}
        <span className="total_count">{totalLabel(total, "位")}</span>
        {myUid && inRanking && (
          <button
            type="button"
            className="button small whereami_btn"
            disabled={locating}
            onClick={whereAmI}
            title="定位到我在排行榜中的位置"
          >
            {locating ? "定位中…" : "我在哪里"}
          </button>
        )}
        {myUid && !inRanking && (
          <Link
            href="/page/help"
            className="button small join_btn"
            title="了解如何上传录像、加入排行榜"
          >
            如何加入排行？
          </Link>
        )}
        {hint && <span className="loader_hint">{hint}</span>}
      </div>
    </>
  );
}

function rowRankById(rows: RankingRow[], id: number): number | undefined {
  return rows.find((r) => r.id === id)?.rank;
}
