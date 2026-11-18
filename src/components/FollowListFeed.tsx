// 关注/粉丝列表客户端壳（2026-11-18 张老师要求标准翻页控件）：
// PageSlider（首页同款 ··· + 滑轨 + 页码）翻页，服务端分页语义（页码换数据整表替换，
// 视口锚定不跳动，与 CompListFeed/VideoFeed 同模式）。行渲染复用 FollowListBody；
// 「关注的人的动态」口径无关，纯列表翻页无筛选。

"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import Link from "next/link";
import type { FollowListRow } from "@/lib/follow";
import { FollowListBody } from "./FollowListBody";
import { PageSlider, PageCache } from "./PageSlider";
import { captureViewportAnchor, restoreViewportAnchor } from "./useNoJump";
import { FOLLOW_LIST_PAGESIZE } from "@/lib/config";

export function FollowListFeed({
  initial,
  initialTotal,
  type,
  title,
  listOwner,
  viewerId,
  followingIds: initialFollowingIds,
}: {
  initial: FollowListRow[];
  initialTotal: number;
  /** following | followers（API 参数） */
  type: "following" | "followers";
  /** 标题文案（我的关注 / XXX的粉丝 等；（共XX人）下标壳内随 total 渲染） */
  title: string;
  /** 列表属主（缺省=观看者自己；他人列表翻页 API 带 uid） */
  listOwner?: number;
  /** 观看者 id（关注按钮初始态批量查） */
  viewerId: number;
  /** 服务端算好的第 1 页已关注集合（翻页后的页由客户端按需补查） */
  followingIds: number[];
}) {
  const [items, setItems] = useState(initial);
  const [total, setTotal] = useState(initialTotal);
  const [loading, setLoading] = useState(false);
  const [folSet, setFolSet] = useState<Set<number>>(new Set(initialFollowingIds));
  const tableRef = useRef<HTMLDivElement>(null);
  const [curPage, setPage] = useState(1);
  const pageCache = useRef(new PageCache<FollowListRow[]>());
  const reqSeq = useRef(0);
  const maxPage = Math.max(1, Math.ceil(total / FOLLOW_LIST_PAGESIZE));

  useEffect(() => {
    pageCache.current.set(1, initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 翻页后本页行的已关注态按需补查（避免全表关注集合预查） */
  async function fetchFollowingIds(rows: FollowListRow[]): Promise<Set<number>> {
    if (!viewerId || !rows.length) return new Set();
    try {
      const res = await fetch(
        `/api/follow/status?uids=${rows.map((r) => r.id).join(",")}`
      );
      if (!res.ok) return new Set();
      const data = (await res.json()) as { ids: number[] };
      return new Set(data.ids ?? []);
    } catch {
      return new Set();
    }
  }

  async function gotoPage(p: number) {
    if (loading) return;
    p = Math.min(maxPage, Math.max(1, p));
    if (p === curPage) return;
    setPage(p);
    const cached = pageCache.current.get(p);
    if (cached) {
      const anchor = captureViewportAnchor(tableRef.current);
      flushSync(() => setItems(cached));
      restoreViewportAnchor(tableRef.current, anchor);
      return;
    }
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const qs = new URLSearchParams({ type, page: String(p) });
      if (listOwner && listOwner !== viewerId) qs.set("uid", String(listOwner));
      const res = await fetch(`/api/follow/list?${qs}`);
      if (!res.ok) throw new Error("加载失败");
      const data = (await res.json()) as { rows: FollowListRow[]; total: number };
      if (seq !== reqSeq.current) return;
      pageCache.current.set(p, data.rows);
      const ids = await fetchFollowingIds(data.rows);
      if (seq !== reqSeq.current) return;
      const anchor = captureViewportAnchor(tableRef.current);
      flushSync(() => {
        setItems(data.rows);
        if (typeof data.total === "number") setTotal(data.total);
        setFolSet((prev) => {
          const next = new Set(prev);
          for (const id of ids) next.add(id);
          return next;
        });
      });
      restoreViewportAnchor(tableRef.current, anchor);
    } catch {
      /* 失败静默，重试可再拖 */
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  /** 「···加载更多」：追加下一页（严格一页语义，与 gotoPage 共用拉取通道） */
  async function loadMore() {
    if (loading) return;
    const next = curPage + 1;
    if (next > maxPage) return;
    // 与 gotoPage 不同：追加模式——拉到的行 append 到尾部，不整表替换
    if (loading) return;
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const qs = new URLSearchParams({ type, page: String(next) });
      if (listOwner && listOwner !== viewerId) qs.set("uid", String(listOwner));
      const res = await fetch(`/api/follow/list?${qs}`);
      if (!res.ok) throw new Error("加载失败");
      const data = (await res.json()) as { rows: FollowListRow[]; total: number };
      if (seq !== reqSeq.current) return;
      if (!data.rows.length) return;
      const ids = await fetchFollowingIds(data.rows);
      if (seq !== reqSeq.current) return;
      flushSync(() => {
        setItems((prev) => [...prev, ...data.rows]);
        if (typeof data.total === "number") setTotal(data.total);
        setPage(next);
        setFolSet((prev) => {
          const n = new Set(prev);
          for (const id of ids) n.add(id);
          return n;
        });
      });
      // 新页首行滚动定位（列表类同款）
      const first = tableRef.current?.querySelectorAll("tbody tr")[items.length];
      first?.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center" });
    } catch {
      /* 失败静默，重试可再拖 */
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  return (
    <>
      {/* 标题（共XX人）下标（23:42 张老师定）：h1 移入壳随 total 实时刷新 */}
      <div className="news_head">
        <h1>
          {title}
          <span className="fol_total">（ 共<span className="fol_total_num">{total}</span>人 ）</span>
        </h1>
      </div>
      <div ref={tableRef}>
        <FollowListBody
          rows={items}
          viewerId={viewerId}
          followingIds={[...folSet]}
        />
      </div>
      <div className="list_footer">
        <PageSlider
          page={curPage}
          pages={maxPage}
          loading={loading}
          onGoto={gotoPage}
          hasMore={curPage * FOLLOW_LIST_PAGESIZE < total}
          onMore={loadMore}
        />
      </div>
      {/* 关注上限规则（2026-11-19 00:21 张老师定）：列表页底部展示 + 赞助链接。
          00:38 张老师在自己主页他人视角页（/user/1/following）没看到——
          去 listOwner 限制，所有「关注」列表页都显示（粉丝列表页不放运营文案） */}
      {type === "following" && (
        <p className="fol_limit_note">
          每位玩家默认可关注 30 人，每赞助 1 元可提升 5 个关注位（最多 200 人）。
          <Link href="/page/donate" target="_blank" prefetch={false} className="fol_limit_donate">
            赞助本站
          </Link>
        </p>
      )}
    </>
  );
}
