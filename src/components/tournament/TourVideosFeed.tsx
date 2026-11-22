// 比赛详情页「录像」板块客户端壳（2026-11-13 五轮 20:31 张老师定：
// 标准翻页组件 = 首页同款 PageSlider「···加载更多 + 滑轨滚动翻页」，非页码式 Pager）。
//
// 语义（与 TourListFeed / 首页 VideoFeed 同口径）：
// · 滑轨/◀▶ 换页 → router.push(?page=N&ep=动态页码&level/order/dir 透传)，URL 即状态、RSC 重渲染；
// · 「···加载更多」→ GET /api/tournament/[id]/videos?page=1&size=前缀长度
//   （当前筛选+排序下取最新 N 条无重复无跳行）；hasMore 按「已加载 < total」判；
// · 行渲染复用 VideoRows（与首页录像流同源）；首屏数据由服务端 RSC 传入。
// 2026-11-22 张老师需求：级别筛选 tabs（仅比赛收录级别，全部+初/中/高级）与
// 表头排序（VideoHead sort 就地切换，同 /video 列表页交互）——筛选/排序变化走
// router.push 软导航（RSC 重渲染换入服务端新数据），换页/加载更多透传当前筛选。

"use client";

import { useState, useTransition, useRef } from "react";
import { useRouter } from "next/navigation";
import { PageSlider, nextBatchSize } from "@/components/PageSlider";
import { VideoHead, VideoRowLine } from "@/components/VideoRows";
import { VIDEO_LIST_DEFAULT_DIR, type VideoLevel, type VideoListOrder, type VideoListDir } from "@/lib/config";
import type { VideoListItem } from "@/lib/queries";
import type { TourMetricKey } from "@/lib/tour-metric";
import { replaceWithoutJump } from "@/components/useNoJump";
/** 级别筛选 tabs（动态组装：全部 + 比赛收录级别，仅开放级别有 tab） */
const LEVEL_LABELS: Record<VideoLevel, string> = { beg: "初级", int: "中级", exp: "高级" };

export function TourVideosFeed({
  compId,
  initialVideos,
  initialPage,
  initialTotal,
  initialTotalPages,
  /** 动态板块当前页码（URL ?ep=，换录像页时带上不丢对方状态） */
  eventsPage,
  pageSize,
  /** 比赛计分项（2026-11-22 张老师需求）：非 time/3bv/s/stnb 时录像表 3BV/s+STNB
   *  两列替换为一列计分项（惜步杯=Crossings）；缺省=time 行为不变 */
  tourMetric,
  /** 比赛收录级别（2026-11-22 张老师需求）：tabs 只渲染这些级别 */
  levels,
  /** 服务端解析的当前筛选/排序（URL 即状态） */
  level,
  order,
  dir,
  explicit,
}: {
  compId: number;
  initialVideos: VideoListItem[];
  initialPage: number;
  initialTotal: number;
  initialTotalPages: number;
  eventsPage: number;
  pageSize: number;
  tourMetric?: TourMetricKey;
  /** 比赛收录级别（2026-11-22 张老师需求）：tabs 只渲染这些级别（已钳到初/中/高） */
  levels: VideoLevel[];
  level: VideoLevel | "all";
  order: VideoListOrder;
  dir: VideoListDir;
  explicit: boolean;
}) {
  const router = useRouter();
  const listRef = useRef<HTMLTableElement>(null);
  const [videos, setVideos] = useState<VideoListItem[]>(initialVideos);
  const [total, setTotal] = useState(initialTotal);
  const [totalPages, setTotalPages] = useState(initialTotalPages);
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [pending, startTransition] = useTransition();

  const hasMore = videos.length < total;

  /** 本板块跳转 URL 组装（换页/切级别共用；ep=动态页码互带）。
   *  返回 [纯路径, query 参数表]：表头 sort.base 必须是纯路径（VideoHead 内部走
   *  buildUrl(base, params) 拼 order/dir，base 带 query 会出第二个 ?） */
  function tourParts(extra: { page?: number; level?: string; order?: string; dir?: string }): [
    string,
    Record<string, string | undefined>
  ] {
    const orderNow = (extra.order ?? order) as VideoListOrder;
    const params: Record<string, string | undefined> = {};
    if (extra.page && extra.page > 1) params.page = String(extra.page);
    if (eventsPage > 1) params.ep = String(eventsPage);
    const levelVal = (extra.level ?? level) !== "all" ? (extra.level ?? level) : undefined;
    if (levelVal) params.level = levelVal;
    const orderVal = orderNow !== "id" ? orderNow : undefined;
    if (orderVal) params.order = orderVal;
    const dirVal =
      (extra.dir ?? dir) !== VIDEO_LIST_DEFAULT_DIR[orderNow] ? (extra.dir ?? dir) : undefined;
    if (dirVal) params.dir = dirVal;
    return [`/tournaments/${compId}`, params];
  }

  /** 跳转 URL 字符串版（tabs/换页用） */
  function tourUrl(extra: Parameters<typeof tourParts>[0]): string {
    const [base, params] = tourParts(extra);
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    return qs ? `${base}?${qs}` : base;
  }

  async function loadMore() {
    if (loading || !hasMore) return;
    setLoading(true);
    try {
      const size = videos.length + nextBatchSize(step, pageSize);
      const params = new URLSearchParams({ page: "1", size: String(size) });
      if (level !== "all") params.set("level", level);
      if (order !== "id") params.set("order", order);
      if (dir !== VIDEO_LIST_DEFAULT_DIR[order]) params.set("dir", dir);
      const res = await fetch(`/api/tournament/${compId}/videos?${params.toString()}`, {
        cache: "no-store",
      });
      if (res.ok) {
        const data = await res.json();
        // 视口零跳动（useNoJump 权威方案）
        replaceWithoutJump(listRef.current, () => {
          setVideos(data.videos);
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
      // 保持滚动位置（张老师 2026-11-19 凌晨定「原地不动」，同 TourEventsFeed）：
      router.push(tourUrl({ page: p }), { scroll: false });
    });
  }

  return (
    <>
      {/* 级别筛选 tabs（2026-11-22 张老师需求：仅比赛收录级别，全部 + 各级别；样式同 /video 页头 ul.tabs） */}
      {levels.length > 0 && (
        <ul className="tabs comp_video_tabs" data-name="level">
          {[["all", "全部"] as [string, string], ...levels.map((l) => [l, LEVEL_LABELS[l]] as [string, string])].map(
            ([value, label]) =>
              value === level ? (
                <li key={value} className="current">
                  <em className="active">{label}</em>
                </li>
              ) : (
                <li key={value}>
                  <a
                    href={tourUrl({ level: value })}
                    onClick={(e) => {
                      // 就地软导航（RSC 换入服务端新数据，页码归 1）；修饰键/中键走真实链接兜底
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                      e.preventDefault();
                      startTransition(() => {
                        router.push(tourUrl({ level: value }), { scroll: false });
                      });
                    }}
                  >
                    {label}
                  </a>
                </li>
              )
          )}
        </ul>
      )}
      {videos.length > 0 ? (
        <table ref={listRef} cellPadding={0} cellSpacing={0} className="ranking_table video_table comp_video_table">
          <VideoHead
            hideIoe
            tourMetric={tourMetric}
            sort={{
              base: `/tournaments/${compId}`,
              params: { ...(eventsPage > 1 ? { ep: String(eventsPage) } : {}), ...(level !== "all" ? { level } : {}) },
              order,
              dir,
              explicit,
            }}
            onSort={(o, d) => {
              startTransition(() => {
                router.push(tourUrl({ order: o, dir: d }), { scroll: false });
              });
            }}
          />
          <tbody>
            {videos.map((v) => (
              <VideoRowLine key={v.id} video={v} hideIoe tourMetric={tourMetric} highlight={order !== "id" ? order : undefined} />
            ))}
          </tbody>
        </table>
      ) : (
        <div className="comp_section_empty">
          {level !== "all" ? `该级别还没有参赛录像` : "还没有参赛录像"}
        </div>
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
