// 消息列表（2026-11-04 三轮：底部换全站通用「页码滑条+加载更多」控件——
//   张老师要求，与排行/录像/论坛列表同款 PageSlider；表格整体移交本组件持有
//   （同 RankingFeed 模式，行在 tbody 内而滑条在表外，只能由同一组件一起渲染）。
//   滑条换页严格一页语义：窗口内 → 滚动定位零请求；LRU 缓存（≤30 页）→ 零请求
//   整表替换；窗口外 → 拉固定一页替换（窗口/批量序列重置）。加载更多按递增批量
//   追加（+15→+30→+60→+100 封顶；OFFSET 恒按 base 页锚定，铁律 82ff927）。
// 2026-10-24 二轮：底部曾走 Pager 服务端分页（?page= 承载状态，本轮被 PageSlider
//   取代——客户端翻页不再改 URL，分享链接仍支持 ?page= 深链直落对应页）
// 初始数据服务端渲染传入；「全部已读」后 router.refresh() 推送新 initial，
// useEffect 整体重置（软导航下 useState(initial) 不重置的坑，见 BbsFeed 注释）
// 2026-10-17（张老师要求）：完整正文直接上列表、详情页下线——点击正文即标已读，
// 评论消息里的《文章标题》内嵌链接可直接点击跳文章页；私信末尾附「回复」入口
// 2026-10-24（张老师要求）：「回复」由跳 /message?to=N 改为原位弹发信浮窗
//   （与用户主页对话气泡同款 SendMessageButton variant="text"）；authorId 自页面透传
// 2026-10-27（张老师要求）：「已发送」视角——发件人列显示收件人、正文尾附
//   「未读/已读」状态标（对方是否已读）；行不可点不置灰（无「我读没读」语义）
// 2026-10-27 二轮（张老师要求）：只有单独手写的私信才有「回复」入口——
//   评论/回复通知（含 2008 版迁移来的旧通知模板）不设按钮；已回复过的显示
//   灰色非链接「已回复」（判定口径见 lib/message.ts getMessageList）

"use client";

import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import Link from "next/link";
import { TIME_NEVER, parseMessageParts } from "@/lib/format";
import { RelTime } from "./RelTime";
import type { MessageItem } from "@/lib/message";
import { AvatarCell, TitleBadge } from "./Cells";
import { SendMessageButton } from "./SendMessageButton";
import { PageSlider, nextBatchSize, PageCache } from "./PageSlider";
import { captureViewportAnchor, restoreViewportAnchor } from "./useNoJump";

/** 正文渲染：链接段（《文章标题》跳文章页）与纯文本段交错（与下线的详情页同口径） */
function MessageContent({ content }: { content: string }) {
  return (
    <>
      {parseMessageParts(content).map((p, i) =>
        typeof p === "string" ? (
          <span key={i}>{p}</span>
        ) : (
          <Link key={i} href={p.href} className="msg_title_link">
            {p.text}
          </Link>
        )
      )}
    </>
  );
}

export function MessageRow({
  m,
  onRead,
  onReplied,
  authorId,
}: {
  m: MessageItem;
  onRead: (id: number) => void;
  /** 从本行浮窗发出回复成功：本行就地转「已回复」（不必等刷新） */
  onReplied: (id: number) => void;
  /** 当前登录用户 id：发信浮窗草稿键 pm:{uid}:{to} 与气泡/表单共用一份 */
  authorId: number;
}) {
  // 已发送视角：isRead=对方是否已读（正文尾状态标），无未读行交互、无「回复」入口；
  // 不套 read 类——「已读整行变灰」是收件视角语义，发出的消息行保持常规色
  if (m.sent) {
    return (
      <tr id={`msg_${m.id}`}>
        <td>
          <span className={`board_tag ${m.isSystem ? "msg_sys" : ""}`}>
            {m.isSystem ? "系统" : "私信"}
          </span>
        </td>
        <td className="user">
          {m.isSystem ? (
            <span className="avatar_link msg_sys">【系统广播】</span>
          ) : m.to ? (
            <>
              <AvatarCell id={m.to.id} name={m.to.chineseName} englishName={m.to.englishName} sex={m.to.sex} gender="small" link />
              <TitleBadge title={m.to.title} classic={m.to.classic} link />
            </>
          ) : (
            "?"
          )}
        </td>
        <td className={`msg_content ${m.isSystem ? "msg_sys" : ""}`}>
          <MessageContent content={m.content} />
          <span className={`msg_read_flag ${m.isRead ? "is_read" : ""}`}>
            {m.isRead ? "已读" : "未读"}
          </span>
        </td>
        <td className="time"><RelTime time={m.createTime} max={TIME_NEVER} /></td>
      </tr>
    );
  }
  return (
    <tr id={`msg_${m.id}`} className={m.isRead ? "read" : "unread"}>
      <td>
        <span className={`board_tag ${m.isSystem ? "msg_sys" : ""}`}>
          {m.isSystem ? "系统" : "私信"}
        </span>
      </td>
      <td className="user">
        {m.isSystem ? (
          <span className="avatar_link msg_sys">【系统广播】</span>
        ) : m.from ? (
          <>
            <AvatarCell id={m.from.id} name={m.from.chineseName} englishName={m.from.englishName} sex={m.from.sex} gender="small" link />
            <TitleBadge title={m.from.title} classic={m.from.classic} link />
          </>
        ) : (
          "?"
        )}
      </td>
      {/* 未读时整格可点击标记已读（链接点击冒泡至此一并已读）；系统消息正文黄 */}
      <td
        className={`msg_content ${m.isSystem ? "msg_sys" : ""}`}
        onClick={m.isRead ? undefined : () => onRead(m.id)}
      >
        <MessageContent content={m.content} />
        {!m.isRead && <span className="msg_new">新</span>}
        {/* 回复入口（2026-10-27 张老师要求）：只有手写私信才有——
            评论/回复通知（notice）不设按钮；已回复过的显示灰色非链接「已回复」 */}
        {!m.isSystem && m.from && !m.notice && (
          m.replied ? (
            <span className="msg_reply_done">已回复</span>
          ) : (
            <SendMessageButton
              variant="text"
              to={m.from.id}
              name={m.from.chineseName || `ID ${m.from.id}`}
              authorId={authorId}
              onSent={() => onReplied(m.id)}
            />
          )
        )}
      </td>
      <td className="time"><RelTime time={m.createTime} max={TIME_NEVER} /></td>
    </tr>
  );
}

export function MessageFeed({
  initial,
  authorId,
  type,
  total,
  page,
  pageSize,
}: {
  initial: MessageItem[];
  /** 当前登录用户 id（「回复」浮窗草稿键隔离用） */
  authorId: number;
  /** 类型筛选（all/system/private/sent；增量接口与空态文案共用） */
  type: string;
  /** 总条数（滑条总页数 / 加载更多封顶判断） */
  total: number;
  /** SSR 初始页（?page= 深链直落） */
  page: number;
  /** 每页条数（MESSAGE_PAGESIZE，服务端传参避免双份常量） */
  pageSize: number;
}) {
  const sent = type === "sent";
  const [items, setItems] = useState(initial);
  const [curPage, setCurPage] = useState(page);
  const [loading, setLoading] = useState(false);
  const [batchStep, setBatchStep] = useState(0); // 递增批量序号（驱动加载更多步长，换页重置）
  const [loadedAll, setLoadedAll] = useState((page - 1) * pageSize + initial.length >= total);
  const tableRef = useRef<HTMLTableElement>(null);
  // 已加载窗口 [winStart, winEnd]（页对齐：所有拉取 skip/take 均为 pageSize 整倍数）
  const winStart = useRef(page);
  // 下一未加载页锚点（loadMore 的 page 参数；winEnd = nextPage - 1）
  const nextPage = useRef(page + Math.ceil(initial.length / pageSize));
  const pageCache = useRef(new PageCache<MessageItem[]>()); // 页号 → 行数据（LRU≤30）
  const reqSeq = useRef(0); // 在途请求序号（并发护栏，只认最后一次）

  const maxPage = Math.max(1, Math.ceil(total / pageSize));

  // 「全部已读」/清空后 router.refresh() 推送新 initial——整体重置本地列表与翻页状态
  useEffect(() => {
    setItems(initial);
    setCurPage(page);
    setBatchStep(0);
    winStart.current = page;
    nextPage.current = page + Math.ceil(initial.length / pageSize);
    setLoadedAll((page - 1) * pageSize + initial.length >= total);
    pageCache.current = new PageCache<MessageItem[]>();
  }, [initial, page, total, pageSize]);

  async function fetchPage(p: number, size?: number): Promise<MessageItem[]> {
    const qs = new URLSearchParams({ action: "more", type, page: String(p) });
    if (size && size > pageSize) qs.set("size", String(size));
    const res = await fetch(`/api/message?${qs}`);
    if (!res.ok) throw new Error("加载失败");
    const data = (await res.json()) as { messages: MessageItem[] };
    return data.messages;
  }

  /** 整表替换（滑条换页终点）：视口锚点防跳动 + 窗口/批量序列重置 */
  function swapRows(rows: MessageItem[], p: number) {
    const anchor = captureViewportAnchor(tableRef.current);
    flushSync(() => setItems(rows));
    restoreViewportAnchor(tableRef.current, anchor);
    winStart.current = p;
    nextPage.current = p + 1;
    setBatchStep(0);
  }

  /** 滑条换页（严格一页语义）：窗口内 → 滚动定位零请求；缓存 → 零请求替换；否则拉一页替换 */
  async function gotoPage(p: number) {
    if (loading) return;
    p = Math.min(maxPage, Math.max(1, p));
    if (p === curPage) return;
    const winEnd = nextPage.current - 1;
    // 窗口内：滚动定位零请求（不换表）
    if (p >= winStart.current && p <= winEnd) {
      const row = items[(p - winStart.current) * pageSize];
      if (row) {
        setCurPage(p);
        document.getElementById(`msg_${row.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
    }
    setCurPage(p);
    // 缓存命中：零请求整表替换（视口零跳动）
    const cached = pageCache.current.get(p);
    if (cached) {
      swapRows(cached, p);
      return;
    }
    // 窗口外：严格拉固定一页整表替换
    const seq = ++reqSeq.current;
    setLoading(true);
    try {
      const rows = await fetchPage(p);
      if (seq !== reqSeq.current) return; // 已有更新的请求，丢弃本次响应
      if (!rows.length) {
        setLoadedAll(true);
        return;
      }
      pageCache.current.set(p, rows);
      swapRows(rows, p);
      setLoadedAll(p >= maxPage);
    } catch {
      /* 失败静默，重试可再拖 */
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  /** 加载更多（递增批量 +15→+30→+60→+100 封顶；新批追加到已加载窗口尾部） */
  async function loadMore() {
    if (loading || loadedAll) return;
    setLoading(true);
    const seq = ++reqSeq.current;
    try {
      const size = nextBatchSize(batchStep, pageSize);
      const p = nextPage.current;
      const rows = await fetchPage(p, size);
      if (seq !== reqSeq.current) return;
      if (!rows.length) {
        setLoadedAll(true);
        return;
      }
      // 加载即翻页（2026-11-12 张老师定）：点「···」后当前页码 +1 指向新加载的
      // 首个新页，并滚动定位到新页首条（同 NewsFeed，否则页码停在原页、点 ▶
      // 只滚不翻页）。定位口径与 gotoPage 窗口内分支同款（msg_ 锚点/smooth/start）。
      flushSync(() => {
        setItems((prev) => [...prev, ...rows]);
      });
      document
        .getElementById(`msg_${rows[0].id}`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
      setCurPage(p);
      // 新覆盖的整页入缓存（页锚点对齐处切片；尾页残段不入缓存）
      for (let i = 0; i + pageSize <= rows.length; i += pageSize) {
        pageCache.current.set(p + i / pageSize, rows.slice(i, i + pageSize));
      }
      nextPage.current = p + Math.ceil(rows.length / pageSize);
      setBatchStep((s) => s + 1);
      if ((nextPage.current - 1) * pageSize >= total) setLoadedAll(true);
    } catch {
      /* 失败静默 */
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }

  /** 点击正文标记已读（2026-10-17 详情页下线）：本地置灰 + API 落库 + 广播角标刷新 */
  async function markRead(id: number) {
    setItems((prev) => prev.map((m) => (m.id === id ? { ...m, isRead: true } : m)));
    try {
      await fetch("/api/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "read", id }),
      });
      window.dispatchEvent(new Event("message:changed"));
    } catch {
      // 网络异常静默：本地已置灰，角标随下次轮询对齐
    }
  }

  /** 本行浮窗发出回复成功：就地置「已回复」（灰色静态文字，不需要刷新） */
  function markReplied(id: number) {
    setItems((prev) => prev.map((m) => (m.id === id ? { ...m, replied: true } : m)));
  }

  return (
    <>
      <table ref={tableRef} cellPadding={0} cellSpacing={0} className="table full bbs_list">
        <thead>
          <tr>
            <th className="cat">类型</th>
            <th className="author">{sent ? "收件人" : "发件人"}</th>
            <th className="topic">内容</th>
            <th className="time">时间</th>
          </tr>
        </thead>
        <tbody>
          {items.map((m) => (
            <MessageRow key={m.id} m={m} onRead={markRead} onReplied={markReplied} authorId={authorId} />
          ))}
          {items.length === 0 && (
            <tr>
              <td colSpan={4}>{sent ? "还没有发送过消息。" : "还没有消息。"}</td>
            </tr>
          )}
        </tbody>
      </table>
      {/* 全站通用页脚：页码滑条 + 加载更多（list_footer 与排行/录像列表同款容器） */}
      <div className="list_footer">
        <PageSlider
          page={curPage}
          pages={maxPage}
          loading={loading}
          onGoto={gotoPage}
          hasMore={!loadedAll}
          onMore={loadMore}
        />
      </div>
    </>
  );
}
