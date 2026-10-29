// 首页「最新录像」版块（2026-09-24 张老师要求）：
// 顶部标题行右侧筛选器 + 底部翻页条（2026-10-14 四轮，与首页「新闻」版块同款：
// ··· + 滑轨 + 页码；页码模式 ?feedPage=N&base=15，松手/停顿 500ms 即加载、
// 视口零跳动、零提示——与全站列表交互统一）。
// 行/表头渲染复用 VideoRows（与 /video 列表同源，保证两处版式一致）。
// 2026-10-20（张老师需求）：筛选器右侧加 NF 筛选开关（NfToggle，样式复用练习页
// 右上角 NF 快捷钮；默认关，开启只显示 NF 录像）——与切筛选同通道重拉第 1 页 +
// 翻页状态重置；NF 不进 URL（首页无筛选 URL 语义）。
// 2026-10-29 张老师定：级别 tabs 整体替换为「阶段筛选」（随观看者称号体系切换：
// 军衔 全部/将帅/校尉/士兵；人神界 全部/神界/人界；按录像行内快照分档，
// 口径见 lib/stage.ts）。

"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { VideoListItem } from "@/lib/queries";
import { VideoHead, VideoRowLine } from "./VideoRows";
import { NfToggle } from "./NfToggle";
import { PageSlider, nextBatchSize, PageCache } from "./PageSlider";
import { captureViewportAnchor, restoreViewportAnchor } from "./useNoJump";
import { useTitleSystem } from "./TitleSystemProvider";
import { STAGE_TABS_M, STAGE_TABS_C, STAGE_KEYS, type FeedStage } from "@/lib/stage";

export function VideoFeed({
  initial,
  pageSize,
  initialHasMore,
  initialTotal,
  title,
  titleClassName,
}: {
  initial: VideoListItem[];
  pageSize: number;
  initialHasMore: boolean;
  /** 当前筛选条件下的录像总数 */
  initialTotal: number;
  /** 标题节点；筛选 tabs 收进标题行右侧（首页版块布局） */
  title?: ReactNode;
  /** 标题附加类名（首页「录像」版块传 gray 走灰色次级标题，2026-09-24 张老师要求） */
  titleClassName?: string;
}) {
  const [items, setItems] = useState(initial);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [total, setTotal] = useState(initialTotal);
  const [loading, setLoading] = useState(false);
  const [level, setLevel] = useState("");
  const [switching, setSwitching] = useState(false);
  const [batchStep, setBatchStep] = useState(0); // 递增批量序号（切筛选重置）
  // NF 筛选开关（2026-10-20）：默认关；开启只显示 NF 录像（与切筛选同通道重拉）
  const [nf, setNf] = useState(false);
  // 观看者称号体系（2026-10-29）：阶段 tabs 跟随切换（与 TitleBadge 同源同机制）
  const { system } = useTitleSystem();

  // ---- 翻页条状态（2026-10-14 四轮）----
  const [curPage, setPage] = useState(1);
  const tableRef = useRef<HTMLTableElement>(null);
  // 窗口起点显式跟踪（2026-10-16 修复「跳远页后拖不回第 1 页」，同 VideoListFeed）
  const [winStart, setWinStart] = useState(1);
  const pageCache = useRef(new PageCache<VideoListItem[]>());
  const reqSeq = useRef(0);
  const maxPage = Math.max(1, Math.ceil(total / pageSize));

  useEffect(() => {
    pageCache.current.set(1, initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 页码模式请求：?feedPage=N&base=pageSize（id 倒序按页取）；nf=1 只取 NF 录像；
   *  stage=阶段筛选 key（2026-10-29，「全部」不传） */
  async function fetchByPage(lv: string, page: number, size?: number, nfOn = false) {
    const url =
      `/api/video/more?feedPage=${page}&base=${pageSize}&size=${size ?? pageSize}` +
      (lv ? `&stage=${lv}` : "") +
      (nfOn ? "&nf=1" : "");
    const res = await fetch(url);
    return (await res.json()) as {
      items: VideoListItem[];
      cursor: number;
      count: number;
      total: number;
    };
  }

  async function loadMore() {
    if (loading) return;
    setLoading(true);
    const seq = ++reqSeq.current;
    try {
      const size = nextBatchSize(batchStep, pageSize);
      const data = await fetchByPage(level, winStart + Math.floor(items.length / pageSize), size, nf);
      if (seq !== reqSeq.current) return;
      const prevCount = items.length;
      setItems((prev) => [...prev, ...data.items]);
      // 新覆盖的整页入缓存
      const totalNow = prevCount + data.items.length;
      for (let pg = Math.floor(prevCount / pageSize); pg < Math.ceil(totalNow / pageSize); pg++) {
        const from = pg * pageSize;
        const to = from + pageSize;
        if (from >= prevCount && to <= totalNow) {
          pageCache.current.set(winStart + pg, data.items.slice(from - prevCount, to - prevCount));
        }
      }
      setBatchStep((s) => s + 1);
      if (typeof data.total === "number") setTotal(data.total);
      if (data.count < size) setHasMore(false);
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  /** 滑条换页（严格一页语义）：窗口内滚动定位 / 缓存零请求 / 拉一页替换（零跳动） */
  async function gotoPage(p: number) {
    if (loading) return;
    p = Math.min(maxPage, Math.max(1, p));
    if (p === curPage) return;
    const winEnd = Math.max(winStart, Math.ceil(items.length / pageSize));
    if (p >= winStart && p <= winEnd) {
      const first = (p - winStart) * pageSize;
      if (items[first]) {
        setPage(p);
        const tr = tableRef.current?.tBodies[0]?.children[first] as HTMLElement | undefined;
        tr?.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center" });
        return;
      }
    }
    setPage(p);
    const cached = pageCache.current.get(p);
    if (cached) {
      const anchor = captureViewportAnchor(tableRef.current);
      flushSync(() => {
        setItems(cached);
        setWinStart(p);
      });
      restoreViewportAnchor(tableRef.current, anchor);
      setBatchStep(0);
      setHasMore(cached.length < total);
      return;
    }
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const data = await fetchByPage(level, p, undefined, nf);
      if (seq !== reqSeq.current) return;
      if (!data.items.length) {
        setHasMore(false);
        return;
      }
      pageCache.current.set(p, data.items);
      const anchor = captureViewportAnchor(tableRef.current);
      flushSync(() => {
        setItems(data.items);
        setWinStart(p);
      });
      restoreViewportAnchor(tableRef.current, anchor);
      setBatchStep(0);
      setHasMore(p * pageSize < total);
      if (typeof data.total === "number") setTotal(data.total);
    } catch {
      /* 失败静默，重试可再拖 */
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  // 切换筛选（阶段/NF）：重置列表并取第一页（批量序列/翻页状态同步重置）。
  // 2026-10-29：级别 tabs 换阶段 tabs——lv 即阶段 key，与 NF 同通道（切阶段保 NF 态，反之亦然）
  async function switchFeed(lv: string, nfOn: boolean) {
    if ((lv === level && nfOn === nf) || switching) return;
    setSwitching(true);
    setLevel(lv);
    setNf(nfOn);
    setBatchStep(0);
    setPage(1);
    setWinStart(1);
    try {
      const data = await fetchByPage(lv, 1, undefined, nfOn);
      setItems(data.items);
      pageCache.current = new PageCache();
      pageCache.current.set(1, data.items);
      if (typeof data.total === "number") setTotal(data.total);
      setHasMore(data.count >= pageSize);
    } finally {
      setSwitching(false);
    }
  }

  // 观看者切换称号体系后，当前选中阶段可能不在新 tabs 里（如「将帅」→人神界），回「全部」
  useEffect(() => {
    if (level && !STAGE_KEYS.includes(level as FeedStage)) {
      switchFeed("", nf);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [system]);

  const stageTabs = system === "c" ? STAGE_TABS_C : STAGE_TABS_M;
  const tabs = stageTabs.map((t) =>
    t.key === level ? (
      <span key={t.key || "all"} className="current">
        {t.label}
      </span>
    ) : (
      <a
        key={t.key || "all"}
        href="#"
        onClick={(e) => {
          e.preventDefault();
          switchFeed(t.key, nf);
        }}
      >
        {t.label}
      </a>
    )
  );

  return (
    <>
      {title ? (
        <div className="news_head">
          <h1 className={titleClassName}>{title}</h1>
          {/* 2026-09-27 张老师要求：筛选器与排行/录像页同款大号版对齐
              （去 side 小号变体与无定义的死类 head，标题+tabs 成等高标签带） */}
          <div className="news_tabs ranking_tabs">{tabs}</div>
          {/* NF 筛选开关（2026-10-20 张老师需求）：筛选器右侧、行尾；
              与 /video 列表页/用户主页录像版块同款（样式复用练习页 NF 钮） */}
          <NfToggle active={nf} onToggle={(next) => switchFeed(level, next)} />
        </div>
      ) : (
        <div className="news_tabs ranking_tabs side">
          {tabs}
          <NfToggle active={nf} onToggle={(next) => switchFeed(level, next)} />
        </div>
      )}
      <table ref={tableRef} cellPadding={0} cellSpacing={0} className="ranking_table video_table">
        {/* hideIoe（2026-10-28 张老师需求）：首页录像区去掉 IOE 列 */}
        <VideoHead hideIoe />
        <tbody>
          {items.map((v) => (
            <VideoRowLine key={v.id} video={v} hideIoe />
          ))}
          {items.length === 0 && (
            <tr>
              <td className="text" colSpan={9}>
                {switching ? "加载中…" : "还没有记录。"}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {/* 2026-10-15 张老师要求：单页也显示翻页条（PageSlider single 态全灰不可点） */}
      <div className="list_footer">
        <PageSlider
          page={curPage}
          pages={maxPage}
          loading={loading || switching}
          onGoto={gotoPage}
          hasMore={hasMore}
          onMore={loadMore}
        />
      </div>
    </>
  );
}
