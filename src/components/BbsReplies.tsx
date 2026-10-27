// BBS 主题楼层流 + 「加载更多/页码滑条」+ 回复表单
// 2026-10-13 张老师要求：详情页底部回复由「翻页」改「加载更多」（全站统一 more_loader 口径）
//   · 楼层号不落库：1 楼是主题，回复按序号推得（与旧版分页码语义一致）
//   · 回复成功后就地接上新楼层（原本靠整页刷新，客户端列表不会自动更新）
//   · 删楼层后按序号重排楼层号（服务端同样是按位置推得的派生值）
// 2026-10-22 张老师要求：多条评论支持滑动分页——升级全站通用 PageSlider 页码滑条
//   （同 NewsFeed/VideoListFeed 语义：···加载更多 + 滑轨换页严格一页/缓存回跳/
//   松手立即加载/序号作废在途请求；楼层号 = 窗口起点偏移推得，翻页后仍正确）
// 2026-10-15 评论回复（张老师要求）：已登录用户每楼带「回复」链接（位于删除链接之前），
//   点击后跳到底部表单并预填不可编辑引用框（用户名 + 评论前50字超出省略），随提交发送通知

"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { BBS_REPLY_PAGESIZE } from "@/lib/bbs";
import type { BbsReplyItem } from "@/lib/bbs";
import { timeOpposite, TIME_NEVER } from "@/lib/format";
import { BbsAuthorName, TitleBadge } from "./Cells";
import { LoginLink } from "./LoginLink";
import { PageSlider, nextBatchSize, PageCache } from "./PageSlider";
import { captureViewportAnchor, restoreViewportAnchor } from "./useNoJump";
import { ReplyDelete, ReplyForm } from "./BbsOps";

export function BbsReplySection({
  postId,
  initial,
  initialTotal,
  initialPage = 1,
  anchorReply = 0,
  canReply,
  locked,
  viewerUid,
  postAuthorId,
  isAdmin,
}: {
  postId: number;
  initial: BbsReplyItem[];
  initialTotal: number;
  /** 首屏渲染的页码（?reply= 深链时服务端定位的目标页；默认 1） */
  initialPage?: number;
  /** ?reply= 深链定位的回复 id（挂载后滚到锚点并高亮；0=无） */
  anchorReply?: number;
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
  const [hasMore, setHasMore] = useState(initialPage * BBS_REPLY_PAGESIZE < initialTotal);
  const [total, setTotal] = useState(initialTotal);
  const [loading, setLoading] = useState(false);
  const [batchStep, setBatchStep] = useState(0); // 递增批量序号（驱动 ··· 批量，2026-10-22）
  /** 引用目标楼层（2026-10-15）：null = 普通回复 */
  const [quote, setQuote] = useState<BbsReplyItem | null>(null);

  // ---- 滑条窗口状态（2026-10-22；BBS_REPLY_PAGESIZE=10，楼层流为 div 流参照 NewsFeed）----
  const pageSize = BBS_REPLY_PAGESIZE;
  const listRef = useRef<HTMLDivElement>(null);
  // 窗口起点显式跟踪（2026-10-16 修复「跳远页后拖不回第 1 页」，同 VideoListFeed）
  const [winStart, setWinStart] = useState(initialPage);
  const winEnd = Math.max(winStart, Math.ceil(items.length / pageSize));
  const [curPage, setCurPage] = useState(initialPage);
  const pageCache = useRef(new PageCache<BbsReplyItem[]>());
  const reqSeq = useRef(0);
  const maxPage = Math.max(1, Math.ceil(total / pageSize));

  useEffect(() => {
    pageCache.current.set(initialPage, initial);
    // ?reply= 深链定位（2026-10-22 张老师要求：点击评论动态/消息直达该评论）——
    // 服务端已把目标楼层所在页 SSR 进首屏，这里滚到锚点并加高亮动画（新楼层脱靶时
    // 页面无该锚点元素，静默回退——链接仍落在正确文章页）
    if (anchorReply) {
      requestAnimationFrame(() => {
        const el = document.getElementById(`reply-${anchorReply}`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.classList.add("reply_anchor_hit");
          setTimeout(() => el.classList.remove("reply_anchor_hit"), 2000);
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 页码模式请求（滑条翻页/递增批量共用）：?page=N&size=M */
  async function fetchByPage(page: number, size?: number) {
    const res = await fetch(
      `/api/bbs/reply/more?post=${postId}&page=${page}&size=${size ?? pageSize}`
    );
    if (!res.ok) throw new Error("加载失败");
    return (await res.json()) as {
      items: BbsReplyItem[];
      cursor: number;
      count: number;
      total: number;
    };
  }

  /** 加载更多（递增批量 10→20→40→50 封顶；新批追加到已加载窗口尾部） */
  async function loadMore() {
    if (loading || !hasMore) return;
    setLoading(true);
    const seq = ++reqSeq.current;
    try {
      const page = winStart + Math.floor(items.length / pageSize);
      const size = nextBatchSize(batchStep, pageSize);
      const data = await fetchByPage(page, size);
      if (seq !== reqSeq.current) return;
      if (!data.items.length) {
        setHasMore(false);
        return;
      }
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
      setHasMore(winStart * pageSize - pageSize + totalNow < data.total);
    } catch {
      /* 网络异常静默：按钮可重试 */
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  /** 滑条换页（严格一页语义）：已加载窗口内滚动定位 / 缓存零请求 / 拉一页替换
   *  楼层号由窗口起点偏移推得 ((winStart-1)*pageSize+i+2)，翻远页后依然正确 */
  async function gotoPage(p: number) {
    if (loading) return;
    p = Math.min(maxPage, Math.max(1, p));
    if (p === curPage) return;
    if (p >= winStart && p <= winEnd) {
      const first = (p - winStart) * pageSize;
      if (items[first]) {
        setCurPage(p);
        // 滚到该页首楼（楼层流无锚点 id，用容器子元素定位）
        const el = listRef.current?.children[first] as HTMLElement | undefined;
        el?.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center" });
        return;
      }
    }
    setCurPage(p);
    const cached = pageCache.current.get(p);
    if (cached) {
      const anchor = captureViewportAnchor(listRef.current);
      flushSync(() => {
        setItems(cached);
        setWinStart(p);
      });
      restoreViewportAnchor(listRef.current, anchor);
      setBatchStep(0);
      setHasMore(p * pageSize < total);
      return;
    }
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const data = await fetchByPage(p);
      if (seq !== reqSeq.current) return;
      if (!data.items.length) {
        setHasMore(false);
        return;
      }
      pageCache.current.set(p, data.items);
      const anchor = captureViewportAnchor(listRef.current);
      flushSync(() => {
        setItems(data.items);
        setWinStart(p);
      });
      restoreViewportAnchor(listRef.current, anchor);
      setBatchStep(0);
      // 整表替换后窗口=1 页；还有更多可由滑条或「···」继续（序列已重置为首击=一页）
      setHasMore(p * pageSize < total);
      if (typeof data.total === "number") setTotal(data.total);
    } catch {
      /* 失败静默，重试可再拖 */
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  /** 回帖成功后（2026-10-22 页码模式重写）：跳到最后一页看新楼层——回帖诉求就是
   *  看到自己刚发的楼层。maxPage 由 total 派生，回帖后 total+1，最后一页可能前移；
   *  直接按「新的最后一页」整页拉取（重拉也覆盖「已在最后一页」场景，缓存同步刷新） */
  async function onPosted() {
    if (loading) return;
    setTotal((t) => t + 1);
    const nextTotal = total + 1;
    const lastPage = Math.max(1, Math.ceil(nextTotal / pageSize));
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const data = await fetchByPage(lastPage);
      if (seq !== reqSeq.current) return;
      if (data.items.length) {
        pageCache.current.set(lastPage, data.items);
        const anchor = captureViewportAnchor(listRef.current);
        flushSync(() => {
          setItems(data.items);
          setWinStart(lastPage);
          setCurPage(lastPage);
          setBatchStep(0);
          if (typeof data.total === "number") setTotal(data.total);
          setHasMore(lastPage * pageSize < (typeof data.total === "number" ? data.total : nextTotal));
        });
        restoreViewportAnchor(listRef.current, anchor);
        // 末楼滚入视野（表单提交后视线在底部表单，新楼层就在下方）
        const last = listRef.current?.children[data.items.length - 1] as HTMLElement | undefined;
        last?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    } catch {
      /* 失败静默，刷新可见（router.refresh 由表单触发） */
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
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

  /** 点击「回复」：设引用目标并滚到底部表单（表单容器带 id 锚点；游客不渲染该链接） */
  function onQuoteReply(r: BbsReplyItem) {
    setQuote(r);
    document.getElementById("reply_form_anchor")?.scrollIntoView({ behavior: "smooth" });
  }

  return (
    <>
      {/* 楼层流容器（2026-10-22）：翻页整表替换的锚定参照（captureViewportAnchor 用），
          children[first] 即窗口内第 first 楼——不引入表格，样式零变化 */}
      <div ref={listRef}>
        {items.map((r, i) => (
          <div key={r.id} id={`reply-${r.id}`} className="box bbs_post">
            <p className="bbs_meta">
              <em>{(winStart - 1) * pageSize + i + 2} 楼</em>{" "}
              {r.author && (
                <>
                  <BbsAuthorName
                    id={r.author.id}
                    name={r.author.chineseName}
                    sex={r.author.sex}
                    avatar={r.author.avatar}
                  />{" "}
                  <TitleBadge title={r.author.title} classic={r.author.old} link />{" "}
                </>
              )}
              {timeOpposite(r.createTime, TIME_NEVER)}
              {/* 2026-10-27 张老师定：待审楼层对所有人可见；「审核中」徽章仅作者本人/管理员视角 */}
              {r.status === 5 && (isAdmin || viewerUid === r.author?.id) && (
                <span className="review_pending" data-tip="回复已公开展示，AI 存疑转人工复核中">
                  审核中
                </span>
              )}
              {viewerUid && !locked && (
                <span className="bbs_ops">
                  {" "}
                  <a
                    href="#reply_form_anchor"
                    onClick={(e) => {
                      e.preventDefault();
                      onQuoteReply(r);
                    }}
                  >
                    回复
                  </a>
                </span>
              )}
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
      </div>

      {/* 翻页滑条（2026-10-22 张老师要求：多条评论支持滑动分页，全站通用 PageSlider；
          单页也显示 single 态全灰不可点）。无回复时整行隐藏——空态没有翻页语义。
          计数不另设行：页头 meta 已有「x 条评论」、滑条自带「第 n / N 页」，
          与排行/录像/论坛列表等 PageSlider 标准形态一致（旧「剩余 N 条」为累积加载
          语义，与整页替换语义矛盾，随 more_loader 一并移除） */}
      {items.length > 0 && (
        <div className="list_footer">
          <PageSlider
            page={curPage}
            pages={maxPage}
            loading={loading}
            onGoto={gotoPage}
            hasMore={hasMore}
            onMore={loadMore}
          />
        </div>
      )}

      <div className="box" id="reply_form_anchor">
        <h2>回复主题</h2>
        {canReply ? (
          <ReplyForm
            postId={postId}
            locked={locked}
            onPosted={onPosted}
            authorId={viewerUid ?? 0}
            quote={
              quote
                ? {
                    replyId: quote.id,
                    authorName: quote.author?.chineseName ?? "?",
                    excerpt: quote.excerpt,
                  }
                : null
            }
            onQuoteCleared={() => setQuote(null)}
          />
        ) : (
          <p className="text login_hint">
            <LoginLink>登录</LoginLink> 后才能回复。
          </p>
        )}
      </div>
    </>
  );
}
