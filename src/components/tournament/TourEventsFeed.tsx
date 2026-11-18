// 比赛详情页「动态」板块客户端壳（2026-11-13 五轮 20:31 张老师定：
// 标准翻页组件 = 首页同款 PageSlider「···加载更多 + 滑轨滚动翻页」，非页码式 Pager）。
//
// 语义（与 TourListFeed 同口径）：
// · 滑轨/◀▶ 换页 → router.push(?ep=N&page=对方页码)，URL 即状态、RSC 重渲染；
// · 「···加载更多」→ GET /api/tournament/[id]/events?page=1&size=前缀长度
//   （动态最新在前、新事件会插到头部，前缀整批替换即「加载后最新快照」，无重复无跳行）；
//   hasMore 按「已加载 < total」判；
// · 首屏数据由服务端 RSC 传入（SSR 可见、无 JS 降级仍能看首屏与 URL 换页）。

"use client";

import Link from "next/link";
import { useState, useTransition, useRef } from "react";
import { useRouter } from "next/navigation";
import { PageSlider, nextBatchSize } from "@/components/PageSlider";
import { RelTime } from "@/components/RelTime";
import { AvatarCell } from "@/components/Cells";
import { TitleBadge } from "@/components/TitleBadge";
import { DeltaArrow } from "@/components/RankingRows";
import { compEventText, type TourEventRow } from "@/lib/tournament";
import { scoreTime } from "@/lib/format";
import { replaceWithoutJump } from "@/components/useNoJump";

export function TourEventsFeed({
  compId,
  initialRows,
  initialPage,
  initialTotal,
  initialTotalPages,
  /** 录像板块当前页码（URL ?page=，换动态页时带上不丢对方状态） */
  videosPage,
  pageSize,
}: {
  compId: number;
  initialRows: TourEventRow[];
  initialPage: number;
  initialTotal: number;
  initialTotalPages: number;
  videosPage: number;
  pageSize: number;
}) {
  const router = useRouter();
  const listRef = useRef<HTMLUListElement>(null);
  const [rows, setRows] = useState<TourEventRow[]>(initialRows);
  const [total, setTotal] = useState(initialTotal);
  const [totalPages, setTotalPages] = useState(initialTotalPages);
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [pending, startTransition] = useTransition();

  const hasMore = rows.length < total;

  async function loadMore() {
    if (loading || !hasMore) return;
    setLoading(true);
    try {
      const size = rows.length + nextBatchSize(step, pageSize);
      const res = await fetch(`/api/tournament/${compId}/events?page=1&size=${size}`, {
        cache: "no-store",
      });
      if (res.ok) {
        const data = await res.json();
        // 视口零跳动（useNoJump 权威方案）：前缀整批替换会改变列表高度，锚定列表顶
        replaceWithoutJump(listRef.current, () => {
          setRows(data.rows);
          setTotal(data.total);
          setTotalPages(data.totalPages);
          setStep((s) => s + 1);
        });
      }
    } finally {
      setLoading(false);
    }
  }

  function gotoPage(p: number) {
    startTransition(() => {
      // scroll:false + key 重挂载后视口锚定由 SSR 侧接管（张老师 2026-11-19 反馈仍跳顶）：
      // router.push 的 scroll:false 只拦「Next 主动滚顶」，软导航 RSC 重渲染把
      // 两个板块整块替换（client 壳带 key 强制重挂载），内容高度突变仍会视觉跳——
      // 详情页两个板块在主栏上下排布，换页锚定到本板块顶部是符合直觉的目标态
      router.push(
        `/tournaments/${compId}?page=${videosPage}${p > 1 ? `&ep=${p}` : ""}`,
        { scroll: false }
      );
      // RSC 提交后把本板块顶部滚进视口（instant 无动画；若板块已在视口内则几乎无位移）
      requestAnimationFrame(() => {
        const el = listRef.current;
        if (!el) return;
        const top = el.getBoundingClientRect().top;
        if (top < 0 || top > window.innerHeight * 0.5) {
          window.scrollBy({ top: top - 76, behavior: "instant" as ScrollBehavior });
        }
      });
    });
  }

  return (
    <>
      {rows.length > 0 ? (
        <ul className="comp_events" ref={listRef}>
          {rows.map((e) => (
            <li key={e.id} className="comp_ev_row">
              <span className="comp_ev_main">
                {/* 事件主体玩家（2026-11-18 晚张老师定：人名+性别+军衔同首页动态——
                    AvatarCell gender=small + TitleBadge；全站事件 1/3/5 无主体不渲染） */}
                {e.userName && e.userId ? (
                  <>
                    <AvatarCell
                      id={e.userId}
                      name={e.userName}
                      englishName={e.englishName}
                      sex={e.sex}
                      gender="small"
                      link
                    />
                    <TitleBadge title={e.title} classic={e.classic} link />
                  </>
                ) : null}
                <span className="comp_ev_text">
                  {/* 官方事件（报名开始/正式开始/正式结束）金色渲染（张老师 2026-11-18 晚定） */}
                  {e.type === 1 || e.type === 3 || e.type === 5 ? (
                    <b className="comp_ev_official">{compEventText(e.type)}</b>
                  ) : (
                    compEventText(e.type)
                  )}
                  {/* 成绩动态（2026-11-18 深夜四轮定）：整段比赛同人成绩动态并成一行——
                      ×N=盘数；成绩亮灰=当时比赛总成绩（各级别最好N局+保底）；
                      非首次成绩动态后跟提升幅度（金色▼差值，同首页新闻破纪录） */}
                  {e.type === 4 && (
                    <>
                      {e.count > 1 && <span className="comp_ev_count">×{e.count}</span>}
                      {/* 成绩不可点（张老师 2026-11-19 反馈）：纯文本亮灰加粗 */}
                      {e.totalMs !== null && (
                        <b className="comp_ev_total">{scoreTime(e.totalMs)}</b>
                      )}
                      {e.prevTotalMs !== null && e.totalMs !== null && e.totalMs < e.prevTotalMs && (
                        <span className="delta">
                          <DeltaArrow dir="down" />
                          {((e.prevTotalMs - e.totalMs) / 1000).toFixed(3)}
                        </span>
                      )}
                    </>
                  )}
                </span>
              </span>
              <span className="comp_ev_time">
                <RelTime time={e.createTime} />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="comp_section_empty">暂无动态</div>
      )}
      <div className="list_footer">
        <PageSlider
          page={initialPage}
          pages={totalPages}
          loading={loading || pending}
          onGoto={gotoPage}
          hasMore={hasMore}
          onMore={loadMore}
        />
      </div>
    </>
  );
}
