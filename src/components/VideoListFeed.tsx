// 录像列表页「加载更多」交互（2026-09-24 张老师要求：/video 老式翻页改加载更多）：
// 页码语义（与 getVideoList 一致：level/order/author 全筛选组合），复用 VideoRows 行渲染；
// 底部左右布局（左=当前筛选下录像总数 右=按钮），点击加载保持滚动位置。
// 筛选切换仍走链接整页刷新（URL 即状态，保留分享语义）。

"use client";

import { useState } from "react";
import type { VideoListItem } from "@/lib/queries";
import { VideoHead, VideoRowLine } from "./VideoRows";
import { noFocusJump } from "./useKeepScroll";
import { TotalCount } from "./TotalCount";

export function VideoListFeed({
  initial,
  total,
  pageSize,
  query,
}: {
  initial: VideoListItem[];
  /** 当前筛选条件下的录像总数 */
  total: number;
  pageSize: number;
  /** 筛选参数（level/order/author，构造增量请求用） */
  query: { level: string; order: string; author?: number };
}) {
  const [items, setItems] = useState(initial);
  const [hasMore, setHasMore] = useState(initial.length < total);
  const [loading, setLoading] = useState(false);

  async function loadMore() {
    if (loading || !hasMore) return;
    setLoading(true);
    try {
      const page = Math.floor(items.length / pageSize) + 1;
      const qs = new URLSearchParams({ level: query.level, order: query.order, page: String(page) });
      if (query.author) qs.set("author", String(query.author));
      // 每页条数与初始页一致（用户主页版块 10 / 列表页 20，2026-09-26）
      qs.set("size", String(pageSize));
      const res = await fetch(`/api/video/more?${qs}`);
      if (!res.ok) throw new Error("加载失败");
      const data = (await res.json()) as { videos: VideoListItem[]; hasMore: boolean };
      if (!data.videos.length) {
        setHasMore(false);
        return;
      }
      setItems((prev) => [...prev, ...data.videos]);
      setHasMore(data.hasMore);
    } catch {
      /* 网络异常静默：按钮可重试 */
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <table cellPadding={0} cellSpacing={0} className="ranking_table video_table">
        <VideoHead />
        <tbody>
          {items.map((v) => (
            <VideoRowLine key={v.id} video={v} />
          ))}
          {items.length === 0 && (
            <tr>
              <td colSpan={7} style={{ textAlign: "center" }}>
                暂无数据
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div className="more_loader">
        {hasMore ? (
          <button
            type="button"
            className="button small"
            disabled={loading}
            onMouseDown={noFocusJump}
            onClick={loadMore}
          >
            {loading ? "加载中…" : "加载更多"}
          </button>
        ) : (
          items.length > 0 && <span className="all_loaded">已加载全部</span>
        )}
        {/* 2026-09-26 张老师要求：显示剩余条数而非总数 */}
        <TotalCount total={total} loaded={items.length} unit="个" />
      </div>
    </>
  );
}
