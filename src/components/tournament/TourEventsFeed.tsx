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
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PageSlider, nextBatchSize } from "@/components/PageSlider";
import { RelTime } from "@/components/RelTime";
import { AvatarCell } from "@/components/Cells";
import { TitleBadge } from "@/components/TitleBadge";
import { compEventText, type TourEventRow } from "@/lib/tournament";
import { scoreTime } from "@/lib/format";

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
        setRows(data.rows);
        setTotal(data.total);
        setTotalPages(data.totalPages);
        setStep((s) => s + 1);
      }
    } finally {
      setLoading(false);
    }
  }

  function gotoPage(p: number) {
    startTransition(() => {
      // scroll:false（张老师 2026-11-18 晚反馈「翻页时页面跳动」）：详情页右栏翻页
      // 不应把视口拽到页顶，保持当前滚动位置只更新板块内容
      router.push(
        `/tournaments/${compId}?page=${videosPage}${p > 1 ? `&ep=${p}` : ""}`,
        { scroll: false }
      );
    });
  }

  return (
    <>
      {rows.length > 0 ? (
        <ul className="comp_events">
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
                  {compEventText(e.type)}
                  {/* 成绩动态（2026-11-18 晚定）：合并组显示 ×N，带组内最好成绩具体数值 */}
                  {e.type === 4 && e.count > 1 && ` ×${e.count}`}
                  {e.type === 4 && e.scoreMs !== null && (
                    <b className="comp_ev_score">（最好 {scoreTime(e.scoreMs)}s）</b>
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
