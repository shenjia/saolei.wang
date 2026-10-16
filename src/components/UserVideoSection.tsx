// 用户主页「录像」版块的客户端壳（2026-10-16 张老师要求）：
// 切换级别筛选、点表头排序均就地生效（整表替换 + 视口锚定不跳动，与首页切换筛选同体验），
// 不再整页导航/跳顶；中键或修饰键点击仍走真实链接（URL 即状态兜底，可新标签打开分享）。
// DOM 结构与原服务端渲染版完全一致：.box > .video_head_box（标题+tabs+上传按钮）+ 表格 + 底部分页。

"use client";

import Link from "next/link";
import type { VideoListItem } from "@/lib/queries";
import type { VideoListOrder } from "@/lib/config";
import { VideoListFeed } from "./VideoListFeed";

/** 录像版块级别筛选 tabs（2026-09-27 张老师要求，与动态筛选同款 ranking_tabs 大号版） */
const VIDEO_LEVEL_TABS: [string, string][] = [
  ["all", "全部"],
  ["beg", "初级"],
  ["int", "中级"],
  ["exp", "高级"],
];

export function UserVideoSection({
  userId,
  isSelf,
  initial,
  total,
  pageSize,
  level,
  order,
}: {
  userId: number;
  /** 是否本人主页（决定「上传录像」按钮显隐） */
  isSelf: boolean;
  initial: VideoListItem[];
  total: number;
  pageSize: number;
  /** 服务端解析的初始筛选（URL 即状态：直链/分享进入时与链接语义一致） */
  level: string;
  order: VideoListOrder;
}) {
  return (
    <div className="box" id="user_videos">
      <VideoListFeed
        client
        initial={initial}
        total={total}
        pageSize={pageSize}
        query={{ level, order, author: userId }}
        headSort={{ base: `/user/${userId}`, order }}
        head={(ctx) => (
          <div className="video_head_box">
            <h1 className="gray">录像</h1>
            {/* 与动态板块筛选同构：div.ranking_tabs > a/span（结构一致保证样式一致）。
                普通左键 → ctx.setLevel 就地切换（不导航不跳顶）；
                修饰键/中键 → 真实链接兜底（新标签打开该筛选 URL） */}
            <div className="ranking_tabs user_video_tabs">
              {VIDEO_LEVEL_TABS.map(([value, label]) => {
                const qs = new URLSearchParams({ level: value });
                if (ctx.order !== "id") qs.set("order", ctx.order);
                return value === ctx.level ? (
                  <span key={value} className="current">
                    {label}
                  </span>
                ) : (
                  <Link
                    key={value}
                    scroll={false}
                    href={`/user/${userId}?${qs}`}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                      e.preventDefault();
                      ctx.setLevel(value);
                    }}
                  >
                    {label}
                  </Link>
                );
              })}
            </div>
            {isSelf && (
              <Link href="/video/upload" className="button active small video_upload_btn">
                上传录像
              </Link>
            )}
          </div>
        )}
      />
    </div>
  );
}
