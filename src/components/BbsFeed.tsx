// BBS 主题列表 + 「加载更多 + 页码滑条」（页码语义；2026-10-14 加滑条与递增批量，
// 同 RankingFeed 语义：换页严格一页/缓存回跳/松手立即加载/序号作废在途请求）
// 初始数据由服务端渲染传入，点更多追加行；筛选切换仍走链接整页刷新
// 2026-09-26（张老师）：已读主题整行变灰——点击/访问详情页后 localStorage 记 id，
//   BbsRow 挂 read 类（标题+计数列 #75715e，同消息页已读语义）

"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import Link from "next/link";
import { BBS_BOARD_NAMES } from "@/lib/bbs";
import { timeOpposite, TIME_NEVER } from "@/lib/format";
import type { BbsPostItem } from "@/lib/bbs";
import { AvatarCell, TitleBadge } from "./Cells";
import { PageSlider, nextBatchSize, PageCache } from "./PageSlider";
import { markBbsRead, useBbsReadSet } from "./BbsRead";

export function BbsRow({ p, showBoard }: { p: BbsPostItem; showBoard: boolean }) {
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
          <Link
            className={"bbs_title" + (p.isTop ? " highlight" : "")}
            href={`/bbs/${p.id}`}
            target="_blank"
            onClick={() => markBbsRead(p.id)}
          >
            {p.title}
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
            <TitleBadge title={p.author.title} link />
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

export function BbsFeed({
  initial,
  initialHasMore,
  total: initialTotal,
  query,
  showBoard,
  emptyMsg = "还没有主题，来发第一帖吧。",
}: {
  initial: BbsPostItem[];
  initialHasMore: boolean;
  /** 当前筛选条件下的主题总数（左下角总数行） */
  total: number;
  query: Record<string, string>;
  showBoard: boolean;
  /** 空态文案（搜索态传「没有找到相关主题」） */
  emptyMsg?: string;
}) {
  const [items, setItems] = useState(initial);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [total, setTotal] = useState(initialTotal);
  const [loading, setLoading] = useState(false);
  const [batchStep, setBatchStep] = useState(0); // 递增批量序号（驱动按钮文案，2026-10-14）

  // ---- 滑条窗口状态（2026-10-14；BBS_PAGESIZE=19，base 由初始行数推）----
  const pageSize = 19;
  // 外层 table 在服务端页面（bbs/page.tsx）里，客户端组件够不着 ref——用类名查询定位
  const getTable = () => document.querySelector<HTMLTableElement>("table.bbs_list");
  const winEnd = Math.max(1, Math.ceil(items.length / pageSize));
  const [curPage, setCurPage] = useState(1);
  const pageCache = useRef(new PageCache<BbsPostItem[]>());
  const reqSeq = useRef(0);
  const maxPage = Math.max(1, Math.ceil(total / pageSize));

  useEffect(() => {
    pageCache.current.set(1, initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function moreUrl(page: number, size?: number) {
    const qs = new URLSearchParams({ ...query, page: String(page) });
    if (size && size > pageSize) qs.set("size", String(size));
    return `/api/bbs/more?${qs}`;
  }

  async function loadMore() {
    if (loading) return;
    setLoading(true);
    const seq = ++reqSeq.current;
    try {
      const page = Math.floor(items.length / pageSize) + 1;
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
          pageCache.current.set(pg + 1, data.posts.slice(from - prevCount, to - prevCount));
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
    if (p <= winEnd) {
      const first = (p - 1) * pageSize;
      if (items[first]) {
        setCurPage(p);
        const tr = getTable()?.tBodies[0]?.children[first] as HTMLElement | undefined;
        tr?.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
    }
    setCurPage(p);
    const cached = pageCache.current.get(p);
    if (cached) {
      flushSync(() => setItems(cached));
      setBatchStep(0);
      setHasMore(p * pageSize < total);
      getTable()?.scrollIntoView({ behavior: "smooth", block: "start" });
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
      flushSync(() => setItems(data.posts));
      setBatchStep(0);
      setHasMore(p * pageSize < total);
      if (typeof data.total === "number") setTotal(data.total);
      getTable()?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch {
      /* 失败静默，重试可再拖 */
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  return (
    <>
      {items.map((p) => (
        <BbsRow key={p.id} p={p} showBoard={showBoard} />
      ))}
      {items.length === 0 && (
        <tr>
          <td colSpan={4}>{emptyMsg}</td>
        </tr>
      )}
      {hasMore && (
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
    </>
  );
}
