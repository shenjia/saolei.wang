// BBS 主题楼层流 + 「加载更多」+ 回复表单
// 2026-10-13 张老师要求：详情页底部回复由「翻页」改「加载更多」（全站统一 more_loader 口径）
//   · 楼层号不落库：1 楼是主题，回复按序号 i+2 推得（与旧版分页码语义一致）
//   · 回复成功后就地接上新楼层（原本靠整页刷新，客户端列表不会自动更新）
//   · 删楼层后按序号重排楼层号（服务端同样是按位置推得的派生值）

"use client";

import { useState } from "react";
import { BBS_REPLY_PAGESIZE } from "@/lib/bbs";
import type { BbsReplyItem } from "@/lib/bbs";
import { timeOpposite, TIME_NEVER } from "@/lib/format";
import { AvatarCell, TitleBadge } from "./Cells";
import { LoginLink } from "./LoginLink";
import { noFocusJump } from "./useKeepScroll";
import { TotalCount } from "./TotalCount";
import { ReplyDelete, ReplyForm } from "./BbsOps";

export function BbsReplySection({
  postId,
  initial,
  initialTotal,
  canReply,
  locked,
  viewerUid,
  postAuthorId,
  isAdmin,
}: {
  postId: number;
  initial: BbsReplyItem[];
  initialTotal: number;
  /** 已登录（表单可见） */
  canReply: boolean;
  /** 主题锁定且当前用户非管理员 */
  locked: boolean;
  /** 当前登录用户 id（游客 null） */
  viewerUid: number | null;
  /** 楼主 id（楼主可删本主题下任意楼层） */
  postAuthorId: number | null;
  isAdmin: boolean;
}) {
  const [items, setItems] = useState(initial);
  const [cursor, setCursor] = useState(initial.length ? initial[initial.length - 1].id : 0);
  const [hasMore, setHasMore] = useState(initial.length < initialTotal);
  const [total, setTotal] = useState(initialTotal);
  const [loading, setLoading] = useState(false);

  /** 取下一批楼层；返回本批条数 */
  async function loadMore(): Promise<number> {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/bbs/reply/more?post=${postId}&cursor=${cursor}&size=${BBS_REPLY_PAGESIZE}`
      );
      if (!res.ok) return 0;
      const data = (await res.json()) as {
        items: BbsReplyItem[];
        cursor: number;
        count: number;
        total: number;
      };
      setItems((prev) => [...prev, ...data.items]);
      setCursor(data.cursor);
      if (typeof data.total === "number") {
        setTotal(data.total);
        setHasMore(data.total > items.length + data.items.length);
      }
      return data.items.length;
    } finally {
      setLoading(false);
    }
  }

  /** 回帖成功后：已翻到底时新楼层就是下一批，直接取回来（否则点击「加载更多」自会看到） */
  function onPosted() {
    if (!hasMore) void loadMore();
  }

  /** 删除某楼层：本地摘除（楼层号按序号重排，总数同步 -1） */
  function onDeleted(id: number) {
    setItems((prev) => prev.filter((r) => r.id !== id));
    setTotal((t) => Math.max(0, t - 1));
  }

  function canDelete(r: BbsReplyItem) {
    if (!viewerUid) return false;
    return isAdmin || viewerUid === r.author?.id || viewerUid === postAuthorId;
  }

  return (
    <>
      {items.map((r, i) => (
        <div key={r.id} className="box bbs_post">
          <p className="bbs_meta">
            <em>{i + 2} 楼</em>{" "}
            {r.author && (
              <>
                <AvatarCell id={r.author.id} name={r.author.chineseName} sex={r.author.sex} gender="small" link />{" "}
                <TitleBadge title={r.author.title} link />{" "}
              </>
            )}
            {timeOpposite(r.createTime, TIME_NEVER)}
            {canDelete(r) && (
              <span className="bbs_ops">
                {" "}
                <ReplyDelete replyId={r.id} onDeleted={() => onDeleted(r.id)} />
              </span>
            )}
          </p>
          <div className="bbs_content" dangerouslySetInnerHTML={{ __html: r.html }} />
        </div>
      ))}

      {/* 无回复时不显示计数行（与评论区口径一致，2026-09-26 张老师要求） */}
      {items.length > 0 && (
        <div className="more_loader">
          {hasMore ? (
            <button
              type="button"
              className="button small"
              disabled={loading}
              onMouseDown={noFocusJump}
              onClick={() => void loadMore()}
            >
              {loading ? "加载中…" : "加载更多"}
            </button>
          ) : (
            <span className="all_loaded">已加载全部</span>
          )}
          <TotalCount total={total} loaded={items.length} unit="条评论" />
        </div>
      )}

      <div className="box">
        <h2>回复主题</h2>
        {canReply ? (
          <ReplyForm postId={postId} locked={locked} onPosted={onPosted} />
        ) : (
          <p className="text login_hint">
            <LoginLink>登录</LoginLink> 后才能回复。
          </p>
        )}
      </div>
    </>
  );
}
