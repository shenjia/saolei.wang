// 评论区：单元格 + 加载更多 + 发表表单
// 2013 版 comment/_cell.php 未写完（半成品），按 NewsCell 风格补齐样式
//
// 2026-10-22 张老师要求：评论发出后立刻显示在发表者看到的评论列表里，不管有没有过审——
// · 列表 state 提升进 CommentSection 壳（此前表单提交只靠 router.refresh()，
//   而 CommentList 的 useState(initial) 在软刷新下不重置，新评论其实不会立刻出现）
// · 发表接口返回新评论行，就地插入列表顶部（参照 BbsReplySection 的 onPosted 模式）
// · AI 复审转待审（status=5）后本人仍可见（查询层按 viewerUid 放行），行上带「审核中」徽章

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { COMMENT_CONTENT_LIMIT, COMMENT_PAGESIZE } from "@/lib/config";
import { timeOpposite, TIME_MONTH } from "@/lib/format";
import type { CommentItem } from "@/lib/queries";
import { AvatarCell, TitleBadge } from "./Cells";
import { LoginLink } from "./LoginLink";
import { noFocusJump } from "./useKeepScroll";
import { toast } from "./Toast";
import { TotalCount } from "./TotalCount";
import { nextBatchSize } from "./PageSlider";
import { useDraft } from "./useDraft";

/** 待审徽章（仅本人视角会收到 status=5 的行，他人不可见该行） */
function PendingBadge() {
  return <span className="review_pending" data-tip="评论已发出，通过审核后其他人才能看到">审核中</span>;
}

/** 单条评论（移植 comment/_cell 的应有结构）
 *  2026-10-13 张老师要求：作者名后显示军衔徽章（与 BBS 楼层 bbs_meta 同款 AvatarCell + TitleBadge） */
export function CommentCell({ comment }: { comment: CommentItem }) {
  return (
    <div className="comment_cell box">
      <p className="meta">
        {comment.author && (
          <>
            <AvatarCell
              id={comment.author.id}
              name={comment.author.chineseName}
              sex={comment.author.sex}
              className="author"
              gender="small"
              link
            />{" "}
            <TitleBadge title={comment.authorTitle} classic={comment.authorClassic} link />{" "}
          </>
        )}
        {/* 2026-10-13 张老师要求：时间前加「评论于」；一个月以内显示相对时间，超过一个月显示具体日期 */}
        <span className="create_time">评论于 {timeOpposite(comment.createTime, TIME_MONTH)}</span>{" "}
        {comment.status === 5 && <PendingBadge />}
      </p>
      <p className="content">{comment.content}</p>
    </div>
  );
}

/** 评论列表 + 加载更多（移植 CommentController::actionMore 的 cursor 语义）
 *  2026-09-24 二轮：底部左右布局（左=评论总数 右=按钮），点击加载保持滚动位置
 *  2026-10-22：items/total 等 state 提升到 CommentSection（表单发表后就地插入列表头） */
export function CommentList({
  items,
  hasMore,
  total,
  loading,
  batchStep,
  onLoadMore,
}: {
  items: CommentItem[];
  hasMore: boolean;
  total: number;
  loading: boolean;
  batchStep: number;
  onLoadMore: () => void;
}) {
  return (
    <div className="comments">
      {items.map((c) => (
        <CommentCell key={c.id} comment={c} />
      ))}
      {/* 2026-09-26 张老师要求：无评论时不显示「共 0 条评论」整行隐藏 */}
      {items.length > 0 && (
        <div className="more_loader">
          {hasMore ? (
            <button
              type="button"
              className="button small"
              disabled={loading}
              onMouseDown={noFocusJump}
              onClick={onLoadMore}
            >
              {loading ? "加载中…" : `加载更多 +${nextBatchSize(batchStep, COMMENT_PAGESIZE)}`}
            </button>
          ) : (
            <span className="all_loaded">已加载全部</span>
          )}
          {/* 2026-09-26 张老师要求：显示剩余条数而非总数 */}
          <TotalCount total={total} loaded={items.length} unit="条评论" />
        </div>
      )}
    </div>
  );
}

/** 发表表单（移植 comment/_form，登录可见）
 *  2026-10-13 张老师要求：外观与论坛编辑器一致但不支持 UBB——
 *  输入框直接复用编辑器画布 .wys 的样式类（纯文本 textarea，无工具栏），
 *  提交按钮改走 .submit_row（居中，同论坛回帖的黄色主按钮布局）
 *  2026-10-22：成功后不依赖整页刷新——接口返回新评论行，交 onPosted(item) 就地插入列表 */
export function CommentForm({
  videoId,
  authorId,
  onPosted,
}: {
  videoId: number;
  authorId: number;
  onPosted?: (item: CommentItem) => void;
}) {
  // 草稿秒级备份：受控直绑 draft.value——水合后存稿自动回填输入框（2026-10-22 张老师要求）
  const draft = useDraft(`c:${authorId}:${videoId}`);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch("/api/comment/post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video: videoId, content: draft.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "发表失败");
        return;
      }
      draft.clear(); // 发布成功清空草稿
      toast("评论发表成功", "success");
      if (data.comment) {
        onPosted?.(data.comment as CommentItem);
        // 仍刷新一次服务端数据（录像卡上的「评论 N」计数随之更新；列表已就地插入，不受 state 不重置影响）
        router.refresh();
      } else {
        window.location.reload(); // 兜底：接口没回行数据时退回整页刷新
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form id="comment-form" onSubmit={submit}>
      <textarea
        className="wys"
        style={{ width: "100%", boxSizing: "border-box", display: "block", resize: "vertical" }}
        rows={3}
        maxLength={COMMENT_CONTENT_LIMIT}
        placeholder="我来说两句…（纯文本）"
        value={draft.value}
        onChange={(e) => draft.set(e.target.value)}
      />
      {error && <div className="error">{error}</div>}
      <p className="submit_row">
        <button type="submit" className="lp_submit_btn" disabled={submitting}>
          发表评论
        </button>
      </p>
    </form>
  );
}

/** 评论区整体壳（2026-10-22）：列表 + 加载更多 + 发表表单同一客户端 state 树。
 *  RSC 页面只与它对接；发表成功 → 新行插到列表头（列表按 id 倒序，新评论 id 最大）+ total+1，
 *  不再依赖整页刷新。 */
export function CommentSection({
  videoId,
  authorId,
  initial,
  initialHasMore,
  initialTotal,
}: {
  videoId: number;
  /** 当前登录用户 id；0=未登录（不渲染表单） */
  authorId: number;
  initial: CommentItem[];
  initialHasMore: boolean;
  initialTotal: number;
}) {
  const [items, setItems] = useState(initial);
  const [cursor, setCursor] = useState(initial.length ? initial[initial.length - 1].id : 0);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [total, setTotal] = useState(initialTotal);
  const [loading, setLoading] = useState(false);
  const [batchStep, setBatchStep] = useState(0); // 递增批量序号（驱动按钮文案，2026-10-14）

  async function loadMore() {
    setLoading(true);
    try {
      const size = nextBatchSize(batchStep, COMMENT_PAGESIZE);
      const res = await fetch(`/api/comment/more?video=${videoId}&cursor=${cursor}&size=${size}`);
      const data = (await res.json()) as { items: CommentItem[]; cursor: number; count: number; total: number };
      setItems((prev) => [...prev, ...data.items]);
      setCursor(data.cursor);
      setBatchStep((s) => s + 1);
      if (typeof data.total === "number") setTotal(data.total);
      if (data.count < size) setHasMore(false);
    } finally {
      setLoading(false);
    }
  }

  /** 发表成功后就地插入：新评论 id 最大、插到列表头；total+1 */
  function onPosted(item: CommentItem) {
    setItems((prev) => (prev.some((c) => c.id === item.id) ? prev : [item, ...prev]));
    setTotal((t) => t + 1);
  }

  return (
    <>
      <CommentList
        items={items}
        hasMore={hasMore}
        total={total}
        loading={loading}
        batchStep={batchStep}
        onLoadMore={loadMore}
      />
      {/* 「发表评论」盒子常驻（2026-10-13 张老师要求，参考论坛详情页底部的「回复主题」盒子）：
          登录用户见输入框，未登录见「登录 后才能发表评论。」（点击弹全局登录浮窗） */}
      <div className="post box">
        <h2>发表评论</h2>
        {authorId > 0 ? (
          <CommentForm videoId={videoId} authorId={authorId} onPosted={onPosted} />
        ) : (
          <p className="text login_hint">
            <LoginLink>登录</LoginLink> 后才能发表评论。
          </p>
        )}
      </div>
    </>
  );
}
