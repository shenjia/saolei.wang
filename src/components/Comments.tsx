// 评论区：单元格 + 加载更多 + 发表表单
// 2013 版 comment/_cell.php 未写完（半成品），按 NewsCell 风格补齐样式

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { COMMENT_CONTENT_LIMIT, COMMENT_PAGESIZE } from "@/lib/config";
import { timeOpposite } from "@/lib/format";
import type { CommentItem } from "@/lib/queries";
import { AvatarCell } from "./Cells";
import { noFocusJump } from "./useKeepScroll";
import { toast } from "./Toast";
import { TotalCount } from "./TotalCount";

/** 单条评论（移植 comment/_cell 的应有结构） */
export function CommentCell({ comment }: { comment: CommentItem }) {
  return (
    <div className="comment_cell box">
      <p className="meta">
        {comment.author && (
          <AvatarCell
            id={comment.author.id}
            name={comment.author.chineseName}
            sex={comment.author.sex}
            className="author"
            gender="small"
            link
          />
        )}
        <span className="create_time">{timeOpposite(comment.createTime)}</span>
      </p>
      <p className="content">{comment.content}</p>
    </div>
  );
}

/** 评论列表 + 加载更多（移植 CommentController::actionMore 的 cursor 语义）
 *  2026-09-24 二轮：底部左右布局（左=评论总数 右=按钮），点击加载保持滚动位置 */
export function CommentList({
  videoId,
  initial,
  initialHasMore,
  initialTotal,
}: {
  videoId: number;
  initial: CommentItem[];
  initialHasMore: boolean;
  /** 本录像评论总数（左下角总数行） */
  initialTotal: number;
}) {
  const [items, setItems] = useState(initial);
  const [cursor, setCursor] = useState(initial.length ? initial[initial.length - 1].id : 0);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [total, setTotal] = useState(initialTotal);
  const [loading, setLoading] = useState(false);

  async function loadMore() {
    setLoading(true);
    try {
      const res = await fetch(`/api/comment/more?video=${videoId}&cursor=${cursor}&size=${COMMENT_PAGESIZE}`);
      const data = (await res.json()) as { items: CommentItem[]; cursor: number; count: number; total: number };
      setItems((prev) => [...prev, ...data.items]);
      setCursor(data.cursor);
      if (typeof data.total === "number") setTotal(data.total);
      if (data.count < COMMENT_PAGESIZE) setHasMore(false);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="comments">
      {items.map((c) => (
        <CommentCell key={c.id} comment={c} />
      ))}
      <div className="more_loader">
        {hasMore ? (
          <button
            type="button"
            className="button small"
            disabled={loading}
            onMouseDown={noFocusJump}
            onClick={loadMore}
          >
            {loading ? "加载中…" : "加载更多"}
          </button>
        ) : (
          items.length > 0 && <span className="all_loaded">已加载全部</span>
        )}
        <TotalCount total={total} unit="条评论" />
      </div>
    </div>
  );
}

/** 发表表单（移植 comment/_form，登录可见） */
export function CommentForm({ videoId }: { videoId: number }) {
  const router = useRouter();
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch("/api/comment/post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video: videoId, content }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "发表失败");
        return;
      }
      setContent("");
      toast("评论发表成功", "success");
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form id="comment-form" onSubmit={submit}>
      <table className="form" cellPadding={0} cellSpacing={0}>
        <tbody>
          <tr>
            <td>
              <div>
                <textarea
                  style={{ width: 420, marginRight: 15 }}
                  rows={4}
                  maxLength={COMMENT_CONTENT_LIMIT}
                  placeholder="我来说两句…（纯文本）"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                />
              </div>
              {error && <div className="error">{error}</div>}
            </td>
            <td style={{ verticalAlign: "top" }}>
              <button type="submit" className="lp_submit_btn" disabled={submitting}>
                发表评论
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </form>
  );
}
