// BBS 主题列表（页头 + 表格整体客户端壳）+「加载更多 + 页码滑条」（页码语义；
// 2026-10-14 加滑条与递增批量，同 RankingFeed 语义：换页严格一页/缓存回跳/
// 松手立即加载/序号作废在途请求）
// 2026-09-26（张老师）：已读主题整行变灰——点击/访问详情页后 localStorage 记 id，
//   BbsRow 挂 read 类（标题+计数列 #75715e，同消息页已读语义）
// 2026-10-22（张老师需求）：「精华」从分类筛选项改为正交开关（对齐录像页 NF——
//   NfToggle 同款钮 label=★，开启=只看精华、与板块叠加：选技术区+开精华=只看
//   技术区精华）。开关收进本组件就地重拉第 1 页（乐观高亮 + replaceState 同步
//   nice=1，默认关删参）；板块切换仍走 tabs 链接软导航（链接携带当前 nice 态，
//   key=筛选串强制重挂载换服务端数据）。为此页头（tabs/搜索/发布按钮）从 RSC
//   page.tsx 收拢进本客户端壳（同 VideoListSection 模式：RSC 不能传函数 prop）。
//   搜索态（q）优先于板块/精华，tabs 区收起时开关一并隐藏（沿用原互斥口径）。

"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import Link from "next/link";
import { BBS_BOARDS, BBS_BOARD_NAMES } from "@/lib/bbs";
import { timeOpposite, TIME_NEVER } from "@/lib/format";
import type { BbsPostItem } from "@/lib/bbs";
import { AvatarCell, TitleBadge } from "./Cells";
import { NfToggle } from "./NfToggle";
import { Tabs } from "./Pager";
import { PageSlider, nextBatchSize, PageCache } from "./PageSlider";
import { TotalCount } from "./TotalCount";
import { captureViewportAnchor, restoreViewportAnchor } from "./useNoJump";
import { markBbsRead, useBbsReadSet } from "./BbsRead";
import { BbsSearch } from "./BbsSearch";

/** 搜索态标题关键字高亮（2026-10-15 张老师）：标题中命中的关键字（大小写不敏感子串，
    与后端 contains 匹配口径一致）包 search_kw 绿显。q 为空或标题未命中时原样返回；
    行是「作者名命中」进结果时标题无关键字，不高亮属正常 */
function hlTitle(title: string, kw?: string): ReactNode {
  const k = (kw ?? "").trim();
  if (!k) return title;
  const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = title.split(new RegExp(`(${escaped})`, "gi"));
  if (parts.length === 1) return title;
  return parts.map((seg, i) =>
    i % 2 === 1 ? (
      <span key={i} className="search_kw">
        {seg}
      </span>
    ) : (
      seg
    ),
  );
}

/** 已读后标题保持亮灰不变的帖子（2026-10-23 张老师：取消高亮后口径统一）——
 *  公告（board=0）与精华（isNice）已读后标题降至亮灰 #bbbbbb，不随已读降暗灰，
 *  与原「公告/高亮帖已读」规则同语义，仅换载体类名 */
function isReadKeep(p: BbsPostItem): boolean {
  return p.board === 0 || p.isNice;
}

export function BbsRow({
  p,
  showBoard,
  hlKw,
}: {
  p: BbsPostItem;
  showBoard: boolean;
  /** 搜索关键字：命中片段在标题中绿显（非搜索态不传） */
  hlKw?: string;
}) {
  const readIds = useBbsReadSet();
  const isRead = readIds.has(p.id);
  return (
    <tr className={isRead ? "read" : undefined}>
      <td>
        {/* 七轮：分类标签与标题同行同格（未选具体板块时显示），标签在标题前。
            topic_line 用 flex 收缩——超长标题出省略号时星标/置顶/锁标不被挤掉 */}
        <span className="topic_line">
          {/* 八轮：公告标签醒目黄；九轮：改灰底圆角徽章，去【】括号；
              十三轮：四板块各自配色（公告黄/技术绿/问答蓝/杂谈灰，均取 Monokai 色板） */}
          {showBoard && (
            <span
              className={
                "board_tag" +
                (p.board === 0
                  ? " notice"
                  : p.board === 1
                    ? " tech"
                    : p.board === 3
                      ? " qa"
                      : "")
              }
            >
              {BBS_BOARD_NAMES[p.board]}
            </span>
          )}
          {/* 2026-10-23（张老师）：取消论坛高亮设定——标题一律不加 highlight 类，
              管理员高亮操作入口一并移除；公告/精华已读标题保持亮灰（keep 类） */}
          <Link
            className={"bbs_title" + (isReadKeep(p) ? " keep" : "")}
            href={`/bbs/${p.id}`}
            target="_blank"
            onClick={() => markBbsRead(p.id)}
          >
            {hlTitle(p.title, hlKw)}
          </Link>
          {p.isNice && (
            <span className="bbs_star" data-tip="精华">
              ★
            </span>
          )}
          {p.isPinned && (
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
            <TitleBadge title={p.author.title} classic={p.author.old} link />
          </>
        )}
      </td>
      {/* 计数「x / y」：x=评论（亮灰 #bbbbbb）、y=阅读（暗灰 #75715e），
          斜杠分隔与表头「评论 / 阅读」呼应；配色规则在 globals.css .bbs_list 作用域，
          已读帖不再改变计数颜色（2026-10-14 张老师） */}
      <td>
        <em className="bbs_replies">{p.replies}</em>
        <span className="bbs_count"> / {p.clicks}</span>
      </td>
      <td className="time">{timeOpposite(p.lastReplyTime, TIME_NEVER)}</td>
    </tr>
  );
}

/** 论坛页主体（页头 + 列表）客户端壳：2026-10-22 页头自 RSC 收拢进来（精华开关
 *  需与列表就地联动），初始数据/筛选仍全部由服务端 page.tsx 解析传入 */
export function BbsSection({
  initial,
  initialHasMore,
  total: initialTotal,
  query,
  canPost,
  emptyMsg = "还没有主题，来发第一帖吧。",
}: {
  initial: BbsPostItem[];
  initialHasMore: boolean;
  /** 当前筛选条件下的主题总数（左下角总数行） */
  total: number;
  /** 服务端解析的筛选（board / nice / q），client 内部状态以此为初始值 */
  query: Record<string, string>;
  /** 已登录（发布按钮显隐） */
  canPost: boolean;
  /** 空态文案（搜索态传「没有找到相关主题」） */
  emptyMsg?: string;
}) {
  const [items, setItems] = useState(initial);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [total, setTotal] = useState(initialTotal);
  const [loading, setLoading] = useState(false);
  const [batchStep, setBatchStep] = useState(0); // 递增批量序号（驱动按钮文案，2026-10-14）
  // 精华开关态（2026-10-22）：服务端由 URL nice=1 解析进 query；开启=只看精华，
  // 与板块（query.board）正交叠加；搜索态（query.q）下不渲染开关（沿用互斥口径）
  const q = query.q ?? "";
  const board = query.board;
  const [nice, setNice] = useState(query.nice === "1");

  // ---- 滑条窗口状态（2026-10-14；BBS_PAGESIZE=19，base 由初始行数推）----
  const pageSize = 19;
  const tableRef = useRef<HTMLTableElement>(null);
  // 窗口起点显式跟踪（2026-10-16 修复「跳远页后拖不回第 1 页」，同 VideoListFeed）
  const [winStart, setWinStart] = useState(1);
  const winEnd = Math.max(winStart, Math.ceil(items.length / pageSize));
  const [curPage, setCurPage] = useState(1);
  const pageCache = useRef(new PageCache<BbsPostItem[]>());
  const reqSeq = useRef(0);
  const maxPage = Math.max(1, Math.ceil(total / pageSize));

  useEffect(() => {
    pageCache.current.set(1, initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 精华开关 URL 同步（2026-10-22）：replaceState 原样传回 history.state（Next 16
   *  app-router patch 了 replaceState，传 null 会 dispatch ACTION_RESTORE 异步跳顶，
   *  2026-10-16 实证铁律）；默认关删参，URL 即状态可分享 */
  function syncNiceUrl(on: boolean) {
    const url = new URL(window.location.href);
    if (on) url.searchParams.set("nice", "1");
    else url.searchParams.delete("nice");
    window.history.replaceState(window.history.state, "", url);
  }

  /** 精华开关就地重拉第 1 页（2026-10-22，对齐录像页 NF 乐观更新通道）：点击立即
   *  setNice + syncNiceUrl（按钮即时高亮、URL 即时同步），数据回来整表替换 + 视口
   *  锚定（captureViewportAnchor 不跳动）+ 分页状态归零；失败静默回滚开关态与 URL。
   *  board 维持服务端 query（板块切换走 tabs 链接软导航，key 重挂载换新数据，
   *  tabs 链接携带 nice 态保证开关跨板块不丢）。 */
  async function toggleNice(next: boolean) {
    if (loading) return;
    const seq = ++reqSeq.current;
    setLoading(true);
    setNice(next);
    syncNiceUrl(next);
    try {
      const qs = new URLSearchParams();
      if (board) qs.set("board", board);
      if (q) qs.set("q", q);
      qs.set("page", "1");
      if (next) qs.set("nice", "1");
      const res = await fetch(`/api/bbs/more?${qs}`);
      if (seq !== reqSeq.current) return;
      if (!res.ok) throw new Error("加载失败");
      const data = (await res.json()) as { posts: BbsPostItem[]; hasMore: boolean; total?: number };
      pageCache.current = new PageCache<BbsPostItem[]>();
      pageCache.current.set(1, data.posts);
      const anchor = captureViewportAnchor(tableRef.current);
      flushSync(() => {
        setItems(data.posts);
        setWinStart(1);
        setCurPage(1);
        setBatchStep(0);
        setHasMore(data.hasMore);
        if (typeof data.total === "number") setTotal(data.total);
      });
      restoreViewportAnchor(tableRef.current, anchor);
    } catch {
      /* 网络异常静默回滚：开关态与 URL 还原，表格数据未变，可重试 */
      if (seq === reqSeq.current) {
        setNice(!next);
        syncNiceUrl(!next);
      }
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  function moreUrl(page: number, size?: number) {
    const qs = new URLSearchParams();
    if (board) qs.set("board", board);
    if (q) qs.set("q", q);
    qs.set("page", String(page));
    if (nice) qs.set("nice", "1");
    if (size && size > pageSize) qs.set("size", String(size));
    return `/api/bbs/more?${qs}`;
  }

  async function loadMore() {
    if (loading) return;
    setLoading(true);
    const seq = ++reqSeq.current;
    try {
      const page = winStart + Math.floor(items.length / pageSize);
      const size = nextBatchSize(batchStep, pageSize);
      const res = await fetch(moreUrl(page, size));
      if (seq !== reqSeq.current) return;
      const data = (await res.json()) as { posts: BbsPostItem[]; hasMore: boolean; total?: number };
      const prevCount = items.length;
      setItems((prev) => [...prev, ...data.posts]);
      // 新覆盖的整页入缓存
      const totalNow = prevCount + data.posts.length;
      for (let pg = Math.floor(prevCount / pageSize); pg < Math.ceil(totalNow / pageSize); pg++) {
        const from = pg * pageSize;
        const to = from + pageSize;
        if (from >= prevCount && to <= totalNow) {
          pageCache.current.set(winStart + pg, data.posts.slice(from - prevCount, to - prevCount));
        }
      }
      setBatchStep((s) => s + 1);
      setHasMore(data.hasMore);
      if (typeof data.total === "number") setTotal(data.total);
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  /** 滑条换页（严格一页语义）：窗口内滚动定位 / 缓存零请求 / 拉一页替换 */
  async function gotoPage(p: number) {
    if (loading) return;
    p = Math.min(maxPage, Math.max(1, p));
    if (p === curPage) return;
    if (p >= winStart && p <= winEnd) {
      const first = (p - winStart) * pageSize;
      if (items[first]) {
        setCurPage(p);
        const tr = tableRef.current?.tBodies[0]?.children[first] as HTMLElement | undefined;
        tr?.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center" });
        return;
      }
    }
    setCurPage(p);
    const cached = pageCache.current.get(p);
    if (cached) {
      const anchor = captureViewportAnchor(tableRef.current);
      flushSync(() => {
        setItems(cached);
        setWinStart(p);
      });
      restoreViewportAnchor(tableRef.current, anchor);
      setBatchStep(0);
      setHasMore(p * pageSize < total);
      return;
    }
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const res = await fetch(moreUrl(p));
      if (seq !== reqSeq.current) return;
      const data = (await res.json()) as { posts: BbsPostItem[]; hasMore: boolean; total?: number };
      if (!data.posts.length) {
        setHasMore(false);
        return;
      }
      pageCache.current.set(p, data.posts);
      const anchor = captureViewportAnchor(tableRef.current);
      flushSync(() => {
        setItems(data.posts);
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

  return (
    <>
      {/* 页头（2026-10-22 自 page.tsx 收拢进客户端壳）：h1 左、分类 tabs 紧随、
          精华开关贴 tabs 右侧、发布主题/搜索框动作组贴行尾——DOM 与原服务端
          渲染版完全一致（.box > .page_head > h1 + .bbs_head_nav） */}
      <div className="page_head">
        <h1 className="page_title">论坛</h1>
        <div className="bbs_head_nav">
          {q ? (
            /* 搜索态：tabs 收起，显示结果条 + 清除返回（筛选与搜索互斥，q 优先，
               精华开关一并隐藏） */
            <div className="bbs_search_bar">
              <span className="bbs_search_kw">
                搜索 <em>“{q}”</em> 的结果
              </span>
              <TotalCount total={total} unit="帖" />
              <Link className="button small" href="/bbs">
                清除搜索
              </Link>
            </div>
          ) : (
            <>
              {/* 2026-10-22：tabs 去掉「精华」项（改正交开关）；链接携带当前 nice 态
                  （params），软导航换板块后开关态经 URL 保留 */}
              <Tabs
                base="/bbs"
                params={{ nice: nice ? "1" : undefined }}
                name="board"
                current={board === undefined ? "all" : board}
                options={[
                  ["all", "全部"],
                  ...BBS_BOARDS.map((b) => [String(b.id), b.name] as [string, string]),
                ]}
              />
              {/* 精华开关（2026-10-22 张老师需求）：NfToggle 同款钮 label=★（与行内
                  精华标记同符号，激活黄同语义），点击就地重拉不导航不跳顶 */}
              <NfToggle
                active={nice}
                onToggle={toggleNice}
                label="★"
                tip="只显示精华主题"
              />
            </>
          )}
          {/* 动作组（2026-09-26 二轮张老师：发布按钮移到搜索框左边、垂直居中对齐）：
              组内 align-items:center——按钮随搜索胶囊居中，整体贴行尾 */}
          <div className="bbs_actions">
            {canPost && (
              <Link className="button active small bbs_post_btn" href="/bbs/post">
                {/* 书写图标（2026-10-14 张老师：「发布主题」改「写文章」+ 前置笔形矢量图） */}
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  style={{ verticalAlign: "-2px", marginRight: 4 }}
                >
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                </svg>
                写文章
              </Link>
            )}
            <BbsSearch initialQ={q} />
          </div>
        </div>
      </div>
      <table ref={tableRef} cellPadding={0} cellSpacing={0} className="table full bbs_list">
        <thead>
          <tr>
            <th className="topic">分类 / 主题</th>
            <th className="author">作者</th>
            <th className="num">评论 / 阅读</th>
            <th className="time">最后更新</th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => (
            <BbsRow key={p.id} p={p} showBoard={true} hlKw={q || undefined} />
          ))}
          {items.length === 0 && (
            <tr>
              <td colSpan={4}>{nice && !q ? "还没有精华主题" : emptyMsg}</td>
            </tr>
          )}
          {/* 2026-10-15 张老师要求：单页也显示翻页行（PageSlider single 态全灰不可点）。
              空列表（还没有帖子）仍整行隐藏——空态没有翻页语义 */}
          {(hasMore || items.length > 0) && (
            <tr className="bbs_more_row">
              <td colSpan={4}>
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
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
