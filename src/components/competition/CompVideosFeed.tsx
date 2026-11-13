// 比赛详情页「录像」板块客户端壳（2026-11-13 五轮 20:31 张老师定：
// 标准翻页组件 = 首页同款 PageSlider「···加载更多 + 滑轨滚动翻页」，非页码式 Pager）。
//
// 语义（与 CompListFeed / 首页 VideoFeed 同口径）：
// · 滑轨/◀▶ 换页 → router.push(?page=N&ep=动态页码)，URL 即状态、RSC 重渲染；
// · 「···加载更多」→ GET /api/competition/[id]/videos?page=1&size=前缀长度
//   （录像时间正序、新录像追加尾部，前缀锚定无重复无跳行）；hasMore 按「已加载 < total」判；
// · 行渲染复用 VideoRows（与首页录像流同源）；首屏数据由服务端 RSC 传入。

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { PageSlider, nextBatchSize } from "@/components/PageSlider";
import { VideoHead, VideoRowLine } from "@/components/VideoRows";
import type { VideoListItem } from "@/lib/queries";

export function CompVideosFeed({
  compId,
  initialVideos,
  initialPage,
  initialTotal,
  initialTotalPages,
  /** 动态板块当前页码（URL ?ep=，换录像页时带上不丢对方状态） */
  eventsPage,
  pageSize,
}: {
  compId: number;
  initialVideos: VideoListItem[];
  initialPage: number;
  initialTotal: number;
  initialTotalPages: number;
  eventsPage: number;
  pageSize: number;
}) {
  const router = useRouter();
  const [videos, setVideos] = useState<VideoListItem[]>(initialVideos);
  const [total, setTotal] = useState(initialTotal);
  const [totalPages, setTotalPages] = useState(initialTotalPages);
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [pending, startTransition] = useTransition();

  const hasMore = videos.length < total;

  async function loadMore() {
    if (loading || !hasMore) return;
    setLoading(true);
    try {
      const size = videos.length + nextBatchSize(step, pageSize);
      const res = await fetch(`/api/competition/${compId}/videos?page=1&size=${size}`, {
        cache: "no-store",
      });
      if (res.ok) {
        const data = await res.json();
        setVideos(data.videos);
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
        `/competitions/${compId}?page=${p}${eventsPage > 1 ? `&ep=${eventsPage}` : ""}`
      );
    });
  }

  return (
    <>
      {videos.length > 0 ? (
        <table cellPadding={0} cellSpacing={0} className="ranking_table video_table comp_video_table">
          <VideoHead hideIoe />
          <tbody>
            {videos.map((v) => (
              <VideoRowLine key={v.id} video={v} hideIoe />
            ))}
          </tbody>
        </table>
      ) : (
        <div className="comp_section_empty">还没有参赛录像</div>
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
