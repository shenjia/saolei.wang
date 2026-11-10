// 活跃排行「加载更多 + 页码滑条」交互（2026-11-08 张老师需求，复用进步榜同款骨架）：
// 列：排名 | 地区 | 姓名 | 军衔 | 初级 | 中级 | 高级 | 观看 | 评论 | 登录 | 活跃指数。
// 地区 = user.area（展示经 areaDisplay 合规化，2026-11-09 张老师要求加在姓名前）；
// 初级/中级/高级 = 7 日（录像上传数 + 练习完成盘数）；
// 观看 = 7 日观看录像时长折点（每满 1 分钟 1 点，2026-11-10 张老师定，评论列前）；
// 评论 = 7 日评论条数；登录 = 7 日访问天数（每日访问雷网记 1 点活跃值）；
// 活跃指数 = 练习 3BV 计点 + 录像级别加权分 + 评论数 + 登录点 + 观看点。
// 默认按活跃指数降序，数据列点击表头切换排序（?by= 服务端重排，整页换 key 重挂）；
// 各排序列表头带 hover 气泡说明（2026-11-10 张老师定文案）。
// 2026-11-10 张老师要求：进步/活跃榜搜索与雷界榜一致——本组件监听 ranking:locate 事件
// 定位（页内滚动高亮 / whereami json 探测页码 / 远页整页导航 view=active，落地 page+hl）。

"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ActiveRow } from "@/lib/activerank";
import { areaDisplay } from "@/lib/config";
import { PageSlider, nextBatchSize, PageCache } from "./PageSlider";
import { captureViewportAnchor, restoreViewportAnchor } from "./useNoJump";
import { RankingName, TitleBadge } from "./Cells";
import { SystemText } from "./SystemText";
import { buildUrl } from "./Pager";
import { toast, toastLoadingDone } from "./Toast";

export type TitledActiveRow = ActiveRow & {
  title: string;
  classic?: { name: string; color: string } | null;
};

/** 未加载时定位最多逐页拉取的页数（同 RankingFeed.NEARBY_PAGES 口径） */
const NEARBY_PAGES = 30;

/** 可排序数据列（表头点击切换 ?by=；by=act 为默认不显式入链）。
 *  tip = 表头 hover 气泡（2026-11-10 张老师定文案：初中高级「7日内练习次数 + 7日内
 *  上传录像数」、评论「7日内发表录像评论 / 文章评论」、观看「7日内观看录像时长
 *  （分钟）」、登录「7日内累计登录天数」、活跃指数为全口径汇总）。 */
const ACTIVE_COLS: { by: "act" | "beg" | "int" | "exp" | "cmt" | "watch" | "login"; label: string; tip: string }[] = [
  { by: "beg", label: "初级", tip: "7日内练习次数 + 7日内上传录像数（初级）" },
  { by: "int", label: "中级", tip: "7日内练习次数 + 7日内上传录像数（中级）" },
  { by: "exp", label: "高级", tip: "7日内练习次数 + 7日内上传录像数（高级）" },
  { by: "watch", label: "观看", tip: "7日内观看录像时长（分钟）" },
  { by: "cmt", label: "评论", tip: "7日内发表录像评论 / 文章评论" },
  { by: "login", label: "登录", tip: "7日内累计登录天数" },
  { by: "act", label: "活跃指数", tip: "练习3BV计点＋录像级别加权分＋观看时长＋评论数＋登录点" },
];

export function ActiveFeed({
  initial,
  total,
  pageSize,
  by,
  initialHl,
}: {
  initial: TitledActiveRow[];
  total: number;
  pageSize: number;
  by: "act" | "beg" | "int" | "exp" | "cmt" | "watch" | "login";
  /** 定位落地行（whereami 302 携带 hl=<uid>，SSR 即高亮） */
  initialHl?: number;
}) {
  const [rows, setRows] = useState(initial);
  const [nextPage, setNextPage] = useState(2);
  const [batchStep, setBatchStep] = useState(0);
  const [loadedAll, setLoadedAll] = useState(initial.length >= total);
  const [loading, setLoading] = useState(false);
  const [locating, setLocating] = useState(false);
  const [hlUid, setHlUid] = useState<number | undefined>(initialHl);
  const router = useRouter();

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

  // ---- 搜索定位（2026-11-10 张老师要求：与雷界榜一致）----
  function scrollToRow(id: number): boolean {
    const el = document.getElementById(`id_${id}`);
    if (!el) return false;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    return true;
  }

  function jumpToWhereami(uid: number) {
    const qs = new URLSearchParams({ id: String(uid), view: "active" });
    if (by !== "act") qs.set("by", by);
    router.push(`/ranking/whereami?${qs}`);
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
      const qs = new URLSearchParams({ id: String(uid), view: "active", format: "json" });
      if (by !== "act") qs.set("by", by);
      const res = await fetch(`/ranking/whereami?${qs}`);
      if (!res.ok) throw new Error();
      const { page } = (await res.json()) as { page: number };
      if (page <= 0) {
        // 全局居中气泡（与雷界榜「暂无成绩」同款交互），不跳转
        toast("该玩家近 7 天无活跃记录，未加入活跃排行");
        setHlUid(undefined);
        return;
      }
      if (page - winStart + 1 > NEARBY_PAGES) {
        navigated = true;
        jumpToWhereami(uid);
        return;
      }
      // 逐页拉到目标页后整表替换滚动（flushSync 保证新行上屏后再滚）
      let cur = winStart + Math.ceil(rows.length / pageSize) - 1; // 已加载末页
      let win = winStart;
      let first = rows;
      if (page <= cur) {
        scrollToRow(uid);
        return;
      }
      while (cur < page) {
        const data = await fetchPage(cur + 1);
        if (!data.rows.length) break;
        pageCache.current.set(cur + 1, data.rows);
        first = data.rows;
        win = cur + 1;
        cur += 1;
      }
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
  }, [rows, locating, winStart, by]);

  // 落地补一次滚动：whereami 302 带 hl + #id_ 锚点，硬导航靠锚点、软导航下补滚动更稳
  useEffect(() => {
    if (initialHl) scrollToRow(initialHl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="rank_scroll">
      <table ref={tableRef} cellPadding={0} cellSpacing={0} className="ranking_table active_table">
        {/* 全列定宽（2026-11-10 张老师要求：切排序表宽不跳；二轮定「各列均匀」）——
            table-layout:fixed 下列宽只由 col 决定，与单元格内容解耦；数据列统一 64px
            （预留 4 位数字 31.2px 绰绰有余，与原摊宽 70 观感接近），排名 72（容 4 位
            名次「第 9999 位」实测 70.9）、地区 64、军衔 116；姓名列不设宽吃剩余空间
            （桌面 ~222），min-width 780（globals）保证窄屏横滑时姓名不压没 */}
        <colgroup>
          <col style={{ width: 72 }} />
          <col style={{ width: 64 }} />
          <col />
          <col style={{ width: 116 }} />
          {ACTIVE_COLS.filter((c) => c.by !== "act").map((c) => (
            <col key={c.by} style={{ width: 64 }} />
          ))}
          <col style={{ width: 64 }} />
        </colgroup>
        <thead>
          <tr>
            <th>排名</th>
            <th>地区</th>
            <th className="name">姓名</th>
            <th>
              <SystemText />
            </th>
            {ACTIVE_COLS.map((c) => (
              <th key={c.by}>
                <Link
                  href={buildUrl("/ranking", { view: "active", by: c.by === "act" ? undefined : c.by })}
                  className={c.by === by ? `current${c.by === "act" ? " act_cur" : ""}` : ""}
                  data-tip={c.tip}
                >
                  {c.label}
                </Link>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((u, i) => (
            <tr key={u.id} id={`id_${u.id}`} className={u.id === hlUid ? "hl" : undefined}>
              <td className="rank">
                第&nbsp;<em>{(winStart - 1) * pageSize + i + 1}</em>&nbsp;位
              </td>
              <td className="ucell_area">
                {u.area ? (
                  <Link
                    href={buildUrl("/ranking", { view: "area", name: u.area })}
                    title={`查看${areaDisplay(u.area)}雷友排行`}
                  >
                    {areaDisplay(u.area)}
                  </Link>
                ) : (
                  "-"
                )}
              </td>
              <td className="name">
                <RankingName id={u.id} name={u.chineseName} englishName={u.englishName} sex={u.sex} avatar={u.avatar} />
              </td>
              <td className="miltitle">
                <TitleBadge title={u.title} classic={u.classic} link />
              </td>
              {ACTIVE_COLS.map((c) => (
                <td
                  key={c.by}
                  className={`num${c.by === by ? ` current${c.by === "act" ? " act_cur" : ""}` : ""}`}
                  title={c.tip}
                >
                  {(c.by === "act" ? u.act : u[c.by]) || "-"}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={11} style={{ textAlign: "center" }}>
                近 7 天还没有活跃数据（每日访问、观看录像、上传录像、练习、发表评论都会计入）。
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
