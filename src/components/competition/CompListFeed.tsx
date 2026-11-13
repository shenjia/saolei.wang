// 比赛列表客户端壳（2026-11-13 三轮张老师定：列表页翻页换通用「加载更多+滑轨」翻页器，
// 与全站 more_loader 口径一致——PageSlider + 递增批量翻倍 100 封顶）。
//
// 语义：
// · 滑轨/◀▶ 换页 → router.push(?page=N)，URL 即状态，服务端 RSC 重渲染（严格一页窗口）；
// · 「···加载更多」→ 取全局排序前缀 rows+批量（整批替换而非追加：比赛按状态排序会随
//   时间漂移，前缀锚定保证窗口无重复无跳行；等价 82ff927「OFFSET 按 base 页基锚定」），
//   就地追加不导航；hasMore 按「已加载 < total」判；
// · 首屏数据由服务端 RSC 传入（SSR 可见、无 JS 降级仍能看首屏与 URL 换页）。

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PageSlider, nextBatchSize } from "@/components/PageSlider";
import { CompBlock } from "./CompBlock";
import { COMP_PAGE_SIZE, type CompRow } from "@/lib/competition";

export function CompListFeed({
  initialRows,
  initialPage,
  initialTotal,
  initialTotalPages,
  now,
  loggedIn,
}: {
  initialRows: CompRow[];
  initialPage: number;
  initialTotal: number;
  initialTotalPages: number;
  now: number;
  loggedIn: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<CompRow[]>(initialRows);
  const [total, setTotal] = useState(initialTotal);
  const [totalPages, setTotalPages] = useState(initialTotalPages);
  // 「加载更多」递增步（首击=一页，此后翻倍封顶 100——nextBatchSize 站内口径）
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [pending, startTransition] = useTransition();

  const hasMore = rows.length < total;

  async function loadMore() {
    if (loading || !hasMore) return;
    setLoading(true);
    try {
      const size = rows.length + nextBatchSize(step, COMP_PAGE_SIZE);
      const res = await fetch(`/api/competition/list?page=1&size=${size}`, { cache: "no-store" });
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
      router.push(p <= 1 ? "/competitions" : `/competitions?page=${p}`);
    });
  }

  if (total === 0) {
    return (
      <div className="box comp_item">
        <div className="comp_chart_empty">暂时没有比赛，敬请期待</div>
      </div>
    );
  }

  return (
    <>
      {rows.map((c) => (
        <CompBlock key={c.id} c={c} now={now} loggedIn={loggedIn} />
      ))}
      {/* 通用翻页器（PageSlider）：单页也渲染（single 态全灰），换页走 URL、加载更多走 API */}
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
