// 评论区：单元格 + 加载更多 + 发表表单
// 2013 版 comment/_cell.php 未写完（半成品），按 NewsCell 风格补齐样式
//
// 2026-10-22 张老师要求：评论发出后立刻显示在发表者看到的评论列表里，不管有没有过审——
// · 列表 state 提升进 CommentSection 壳（此前表单提交只靠 router.refresh()，
//   而 CommentList 的 useState(initial) 在软刷新下不重置，新评论其实不会立刻出现）
// · 发表接口返回新评论行，就地插入列表顶部（参照 BbsReplySection 的 onPosted 模式）
// · AI 复审转待审（status=5）后内容前台保持公开（2026-10-27 张老师定：AI/人审一律后置），
//   仅作者本人视角在行上看到「审核中」徽章
//
// 2026-10-26 张老师需求：评论支持删除——发布者可删自己发的评论，
// 录像作者可删别人写在自己录像下的评论（权限铁闸在 /api/comment/delete 服务端）；
// 删除按钮只在有权限的行渲染，确认浮窗后就地移除列表行 + total-1

"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { COMMENT_CONTENT_LIMIT, COMMENT_PAGESIZE } from "@/lib/config";
import { timeOpposite, TIME_MONTH } from "@/lib/format";
import type { CommentItem } from "@/lib/queries";
import { AvatarCell, TitleBadge } from "./Cells";
import { LoginLink } from "./LoginLink";
import { noFocusJump } from "./useKeepScroll";
import { toast } from "./Toast";
import { confirmDialog } from "./Confirm";
import { TotalCount } from "./TotalCount";
import { nextBatchSize } from "./PageSlider";
import { useDraft } from "./useDraft";

/** 待审徽章（2026-10-27 起 status=5 前台对所有人可见；仅作者本人视角渲染此徽章，tip 提示处于人工复核） */
function PendingBadge() {
  return <span className="review_pending" data-tip="内容已公开展示，AI 存疑转人工复核中">审核中</span>;
}

/** 单条评论（移植 comment/_cell 的应有结构）
 *  2026-10-13 张老师要求：作者名后显示军衔徽章（与 BBS 楼层 bbs_meta 同款 AvatarCell + TitleBadge）
 *  2026-10-26：meta 行尾挂删除小按钮（canDelete 由上层按登录态判定传入） */
export function CommentCell({
  comment,
  isOwn,
  canDelete,
  deleting,
  onDelete,
}: {
  comment: CommentItem;
  /** 作者本人视角（status=5 行仅本人渲染「审核中」徽章；2026-10-27 起待审内容对所有人可见） */
  isOwn?: boolean;
  canDelete?: boolean;
  deleting?: boolean;
  onDelete?: (c: CommentItem) => void;
}) {
  return (
    <div className="comment_cell box" id={`comment-${comment.id}`}>
      <p className="meta">
        {comment.author && (
          <>
            <AvatarCell
              id={comment.author.id}
              name={comment.author.chineseName}
              englishName={comment.author.englishName}
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
        {isOwn && comment.status === 5 && <PendingBadge />}
        {/* 2026-10-26：删除按钮浮右（跟评论区 meta 同行，录像作者/发布者本人可见） */}
        {canDelete && (
          <button
            type="button"
            className="comment_del"
            disabled={deleting}
            onClick={() => onDelete?.(comment)}
          >
            {deleting ? "删除中…" : "删除"}
          </button>
        )}
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
  canDelete,
  deletingId,
  onDelete,
  viewerUid = 0,
}: {
  items: CommentItem[];
  hasMore: boolean;
  total: number;
  loading: boolean;
  batchStep: number;
  onLoadMore: () => void;
  canDelete?: (c: CommentItem) => boolean;
  deletingId?: number;
  onDelete?: (c: CommentItem) => void;
  /** 当前登录用户（「审核中」徽章仅作者本人可见，2026-10-27） */
  viewerUid?: number;
}) {
  return (
    <div className="comments">
      {items.map((c) => (
        <CommentCell
          key={c.id}
          comment={c}
          isOwn={viewerUid > 0 && c.authorId === viewerUid}
          canDelete={canDelete?.(c)}
          deleting={deletingId === c.id}
          onDelete={onDelete}
        />
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
 *  不再依赖整页刷新。
 *  2026-10-26：接入删除（发布者本人 ∪ 录像作者，服务端 /api/comment/delete 铁闸）；
 *  确认浮窗后就地移除行 + total-1，同时 router.refresh() 同步录像卡上的「评论 N」计数。
 *  2026-10-26 二轮：管理员前台也可删（isManager prop；管理员删除服务端写 admin_log 留痕） */
export function CommentSection({
  videoId,
  videoOwnerId,
  authorId,
  isManager: manager = false,
  initial,
  initialHasMore,
  initialTotal,
  anchorComment = 0,
}: {
  videoId: number;
  /** 录像上传者 uid（0=异常兑底；用于判定「录像作者删别人评论」权限） */
  videoOwnerId: number;
  /** 当前登录用户 id；0=未登录（不渲染表单与删除钮） */
  authorId: number;
  /** 当前登录用户是否管理员（role 10/100；前台删除全量放行） */
  isManager?: boolean;
  initial: CommentItem[];
  initialHasMore: boolean;
  initialTotal: number;
  /** ?comment= 深链定位的评论 id（0=无；消息通知「我评论了您的录像…」落地用） */
  anchorComment?: number;
}) {
  const [items, setItems] = useState(initial);
  const [cursor, setCursor] = useState(initial.length ? initial[initial.length - 1].id : 0);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [total, setTotal] = useState(initialTotal);
  const [loading, setLoading] = useState(false);
  const [batchStep, setBatchStep] = useState(0); // 递增批量序号（驱动按钮文案，2026-10-14）
  const [deletingId, setDeletingId] = useState(0); // 正在删除的评论 id（驱动行内按钮禁用态）
  const router = useRouter();

  // 渐进定位链专用 ref（2026-10-29）：setTimeout 链式调 loadMore 时闭包里是旧 state，
  // 用 ref 镜像最新值（batchStep/cursor/hasMore），链与按钮两条路共用同一 loadMore
  const batchStepRef = useRef(0);
  const cursorRef = useRef(cursor);
  const hasMoreRef = useRef(initialHasMore);
  const anchorPending = useRef(0);
  const loadingRef = useRef(false);
  batchStepRef.current = batchStep;
  cursorRef.current = cursor;
  hasMoreRef.current = hasMore;

  // 定位到锚点评论：滚到目标行 + 高亮动画（BBS reply_anchor_hit 同款，零新增 CSS）
  function scrollToAnchor(cid: number) {
    const el = document.getElementById(`comment-${cid}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("reply_anchor_hit");
      setTimeout(() => el.classList.remove("reply_anchor_hit"), 2000);
      return true;
    }
    return false;
  }

  async function loadMore() {
    if (loadingRef.current) return; // 渐进链与手点按钮互斥
    loadingRef.current = true;
    setLoading(true);
    try {
      const size = nextBatchSize(batchStepRef.current, COMMENT_PAGESIZE);
      const res = await fetch(`/api/comment/more?video=${videoId}&cursor=${cursorRef.current}&size=${size}`);
      const data = (await res.json()) as { items: CommentItem[]; cursor: number; count: number; total: number };
      setItems((prev) => [...prev, ...data.items]);
      setCursor(data.cursor);
      setBatchStep((s) => s + 1);
      batchStepRef.current += 1; // 链式路径不等 re-render，直接同步 ref
      cursorRef.current = data.cursor;
      if (typeof data.total === "number") setTotal(data.total);
      if (data.count < size) {
        setHasMore(false);
        hasMoreRef.current = false;
        anchorPending.current = 0; // 全部加载完仍未命中（目标已删）：静默落回
        return;
      }
      // 渐进定位（2026-10-29）：本批含锚点目标 → 滚动高亮并结束；
      // 未含 → 链式加载下一批（rAF 等 DOM 挂载后再滚/再拉）
      const target = anchorPending.current;
      if (target) {
        if (data.items.some((c) => c.id === target)) {
          anchorPending.current = 0;
          requestAnimationFrame(() => scrollToAnchor(target));
        } else {
          requestAnimationFrame(() => void loadMore());
        }
      }
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }

  // ?comment= 深链（2026-10-29 消息通知落地）：列表 id 倒序、旧评论在后面——
  // 首屏命中直接定位；未命中且还有未加载批时自动「加载更多」直到命中或加载完
  // （渐进定位，不加新接口）；目标已删/被吞则静默落回评论区头部（链接仍落在正确录像页）
  useEffect(() => {
    if (!anchorComment) return;
    if (initial.some((c) => c.id === anchorComment)) {
      requestAnimationFrame(() => scrollToAnchor(anchorComment));
      return;
    }
    if (!hasMoreRef.current) return;
    anchorPending.current = anchorComment;
    requestAnimationFrame(() => void loadMore());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 发表成功后就地插入：新评论 id 最大、插到列表头；total+1 */
  function onPosted(item: CommentItem) {
    setItems((prev) => (prev.some((c) => c.id === item.id) ? prev : [item, ...prev]));
    setTotal((t) => t + 1);
  }

  /** 删除权限（前端渲染判定，与 /api/comment/delete 服务端铁闸同口径）：
   *  登录 且（发布者本人 或 录像上传者 或 管理员——管理员全量放行）。
   *  待审行（status=5）只有发布者本人看得到，天然落在「本人」分支内 */
  function canDelete(c: CommentItem) {
    return authorId > 0 && (manager || c.authorId === authorId || videoOwnerId === authorId);
  }

  /** 删除：确认浮窗 → POST /api/comment/delete → 就地移除行 + total-1 + refresh 同步计数 */
  async function onDelete(c: CommentItem) {
    if (
      !(await confirmDialog({
        title: "删除评论",
        message: "确认删除这条评论？删除后其他人将不再可见（可在后台恢复）。",
        confirmText: "删除",
        danger: true,
      }))
    )
      return;
    setDeletingId(c.id);
    try {
      const res = await fetch("/api/comment/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: c.id }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        toast(data.error ?? "删除失败，请稍后再试", "error");
        return;
      }
      setItems((prev) => prev.filter((x) => x.id !== c.id));
      setTotal((t) => Math.max(0, t - 1));
      toast("评论已删除", "success");
      // 同步服务端数据：录像卡上的「评论 N」冗余计数随 refresh 更新
      router.refresh();
    } catch {
      toast("网络错误，请重试", "error");
    } finally {
      setDeletingId(0);
    }
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
        canDelete={canDelete}
        deletingId={deletingId}
        onDelete={onDelete}
        viewerUid={authorId}
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
