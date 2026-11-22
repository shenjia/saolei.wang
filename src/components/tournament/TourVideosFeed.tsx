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
import { useRouter, usePathname } from "next/navigation";
import { PageSlider, nextBatchSize } from "@/components/PageSlider";
import { VideoHead, VideoRowLine } from "@/components/VideoRows";
import { VideoSearch } from "@/components/VideoSearch";
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
  vAuthor,
  vTime,
  vBv,
  /** 搜索框回显（标题行搬进壳后 VideoSearch 由本组件直接渲染——同为 client 组件无 RSC 边界） */
  searchAuthorName,
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
  /** 录像区搜索态（2026-11-22 张老师报「搜一个人再翻页变全部录像」bug）：
   *  vauthor/vtime/3bv 与级别/排序同为筛选维度——翻页/切级别/表头排序/
   *  加载更多必须透传，否则 URL 丢参回全部录像。author 与 time/3bv 互斥（搜索框口径） */
  vAuthor?: number;
  vTime?: string;
  vBv?: number;
  /** 搜索框作者筛选回显姓名（空串=无筛选） */
  searchAuthorName?: string;
}) {
  const router = useRouter();
  // 软导航沿用当前真实 pathname（2026-11-22 张老师报「第一次翻页跳动」根因修复，
  // 同 TourEventsFeed）：代号 URL 进入时 push /tournaments/<id> 会让 pathname 变化，
  // ScrollReset 按「跨页导航」滚顶——第一翻跳、之后不跳
  const pathname = usePathname();
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
    // 搜索态透传（2026-11-22 翻页丢筛选 bug 修复）：author 与 time/3bv 互斥（VideoSearch 口径）
    if (vAuthor) params.vauthor = String(vAuthor);
    if (vTime) params.vtime = vTime;
    if (vBv != null) params["3bv"] = String(vBv);
    return [pathname, params];
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
      // 搜索态透传（2026-11-22 翻页丢筛选 bug 修复，author 与 time/3bv 互斥）
      if (vAuthor) params.set("vauthor", String(vAuthor));
      if (vTime) params.set("vtime", vTime);
      if (vBv != null) params.set("3bv", String(vBv));
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

  /** 级别筛选 tabs（仅比赛收录级别，全部 + 各级别）。
   *  20:01 张老师定「紧靠 Title，跟首页录像区筛选一样」——弃 ul.tabs 小版式，
   *  改首页 .news_tabs.ranking_tabs 大号版同构（div 内平铺 a/span.current，
   *  底部细线 9px 18px 内距），紧贴 h2 右侧（comp_sec_head flex-end 底线对齐） */
  const levelTabs =
    levels.length > 0 ? (
      <div className="news_tabs ranking_tabs">
        {[["all", "全部"] as [string, string], ...levels.map((l) => [l, LEVEL_LABELS[l]] as [string, string])].map(
          ([value, label]) =>
            value === level ? (
              <span key={value} className="current">
                {label}
              </span>
            ) : (
              <a
                key={value}
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
            )
        )}
      </div>
    ) : null;

  return (
    <>
      {/* 标题行（20:01 张老师定：tabs 紧靠「录像」标题，同首页 .news_head 形态——
          h2 左、tabs 挨着、搜索框贴行尾；flex-end 底线对齐）。
          RSC 禁函数传参（render-prop 500 实证），标题行整个搬进本 client 壳；
          VideoSearch 同为 client 组件直接渲染，回显数据由页面 props 传入 */}
      <div className="comp_sec_head">
        <h2>录像</h2>
        {levelTabs}
        <div className="video_search">
          <VideoSearch
            scope="tour"
            tourId={compId}
            level=""
            order="id"
            author={vAuthor}
            authorName={searchAuthorName ?? ""}
            time={vTime}
            bv={vBv != null ? String(vBv) : undefined}
          />
        </div>
      </div>
      {videos.length > 0 ? (
        <table ref={listRef} cellPadding={0} cellSpacing={0} className="ranking_table video_table comp_video_table">
          <VideoHead
            hideIoe
            tourMetric={tourMetric}
            sort={{
              // base 必须用当前 pathname（2026-11-22 同上）：onSort 缺席兜底走真实链接
              // 时地址形态不变；纯路径要求见 VideoHead 内部 buildUrl 注释
              base: pathname,
              params: {
                ...(eventsPage > 1 ? { ep: String(eventsPage) } : {}),
                ...(level !== "all" ? { level } : {}),
                // 搜索态透传（修饰键/中键走真实链接的兜底路径也不能丢筛选）
                ...(vAuthor ? { vauthor: String(vAuthor) } : {}),
                ...(vTime ? { vtime: vTime } : {}),
                ...(vBv != null ? { "3bv": String(vBv) } : {}),
              },
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
