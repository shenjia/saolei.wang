// 比赛详情页「动态」板块客户端壳（2026-11-13 五轮 20:31 张老师定：
// 标准翻页组件 = 首页同款 PageSlider「···加载更多 + 滑轨滚动翻页」，非页码式 Pager）。
//
// 语义（与 CompListFeed 同口径）：
// · 滑轨/◀▶ 换页 → router.push(?ep=N&page=对方页码)，URL 即状态、RSC 重渲染；
// · 「···加载更多」→ GET /api/competition/[id]/events?page=1&size=前缀长度
//   （动态最新在前、新事件会插到头部，前缀整批替换即「加载后最新快照」，无重复无跳行）；
//   hasMore 按「已加载 < total」判；
// · 首屏数据由服务端 RSC 传入（SSR 可见、无 JS 降级仍能看首屏与 URL 换页）。

"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PageSlider, nextBatchSize } from "@/components/PageSlider";
import { RelTime } from "@/components/RelTime";
import { compEventText, type CompEventRow } from "@/lib/competition";

export function CompEventsFeed({
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
  initialRows: CompEventRow[];
  initialPage: number;
  initialTotal: number;
  initialTotalPages: number;
  videosPage: number;
  pageSize: number;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<CompEventRow[]>(initialRows);
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
      const res = await fetch(`/api/competition/${compId}/events?page=1&size=${size}`, {
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
      router.push(
        `/competitions/${compId}?page=${videosPage}${p > 1 ? `&ep=${p}` : ""}`
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
                {e.userName && e.userId ? (
                  <Link className="comp_ev_user" href={`/user/${e.userId}`}>
                    {e.userName}
                  </Link>
                ) : null}
                <span className="comp_ev_text">{compEventText(e.type)}</span>
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
