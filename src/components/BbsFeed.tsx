// BBS 主题列表 + 「加载更多」（页码语义；对齐 NewsFeed/Comments 的 more_loader 模式）
// 初始数据由服务端渲染传入，点更多追加行；筛选切换仍走链接整页刷新

"use client";

import { useState } from "react";
import Link from "next/link";
import { BBS_BOARD_NAMES } from "@/lib/bbs";
import { timeOpposite, TIME_NEVER } from "@/lib/format";
import type { BbsPostItem } from "@/lib/bbs";
import { AvatarCell, TitleBadge } from "./Cells";
import { noFocusJump } from "./useKeepScroll";
import { TotalCount } from "./TotalCount";

export function BbsRow({ p, showBoard }: { p: BbsPostItem; showBoard: boolean }) {
  return (
    <tr>
      <td>
        {/* 七轮：分类标签与标题同行同格（未选具体板块时显示），标签在标题前。
            topic_line 用 flex 收缩——超长标题出省略号时星标/置顶/锁标不被挤掉 */}
        <span className="topic_line">
          {/* 八轮：公告标签醒目黄（#fdc61a 全站高亮语义），其余板块保持灰 */}
          {showBoard && (
            <span className={"board_tag" + (p.board === 0 ? " notice" : "")}>
              【{BBS_BOARD_NAMES[p.board]}】
            </span>
          )}
          <Link className="bbs_title" href={`/bbs/${p.id}`} target="_blank">
            {p.title}
          </Link>
          {p.isNice && (
            <span className="bbs_star" data-tip="精华">
              ★
            </span>
          )}
          {p.isTop && (
            <span className="bbs_top" data-tip="置顶">
              ▲
            </span>
          )}
          {p.isLocked && <span className="bbs_flag locked">锁</span>}
        </span>
      </td>
      <td className="user">
        {p.author && (
          <>
            <AvatarCell id={p.author.id} name={p.author.chineseName} sex={p.author.sex} gender="small" link />
            <TitleBadge title={p.author.title} link />
          </>
        )}
      </td>
      <td>
        <em>{p.replies}</em> / {p.clicks}
      </td>
      <td className="time">{timeOpposite(p.lastReplyTime, TIME_NEVER)}</td>
    </tr>
  );
}

export function BbsFeed({
  initial,
  initialHasMore,
  total: initialTotal,
  query,
  showBoard,
}: {
  initial: BbsPostItem[];
  initialHasMore: boolean;
  /** 当前筛选条件下的主题总数（左下角总数行） */
  total: number;
  query: Record<string, string>;
  showBoard: boolean;
}) {
  const [items, setItems] = useState(initial);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [total, setTotal] = useState(initialTotal);
  const [loading, setLoading] = useState(false);

  async function loadMore() {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ ...query, page: String(Math.floor(items.length / 19) + 1) });
      const res = await fetch(`/api/bbs/more?${qs}`);
      const data = (await res.json()) as { posts: BbsPostItem[]; hasMore: boolean; total?: number };
      setItems((prev) => [...prev, ...data.posts]);
      setHasMore(data.hasMore);
      if (typeof data.total === "number") setTotal(data.total);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {items.map((p) => (
        <BbsRow key={p.id} p={p} showBoard={showBoard} />
      ))}
      {items.length === 0 && (
        <tr>
          <td colSpan={4}>还没有主题，来发第一帖吧。</td>
        </tr>
      )}
      {hasMore && (
        <tr className="bbs_more_row">
          <td colSpan={4}>
            <div className="more_loader">
              <button
                type="button"
                className="button small"
                disabled={loading}
                onMouseDown={noFocusJump}
                onClick={loadMore}
              >
                {loading ? "加载中…" : "加载更多"}
              </button>
              <TotalCount total={total} unit="帖" />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
