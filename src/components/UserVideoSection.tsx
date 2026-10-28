// 用户主页「录像」版块的客户端壳（2026-10-16 张老师要求）：
// 切换级别筛选、点表头排序均就地生效（整表替换 + 视口锚定不跳动，与首页切换筛选同体验），
// 不再整页导航/跳顶；中键或修饰键点击仍走真实链接（URL 即状态兜底，可新标签打开分享）。
// DOM 结构与原服务端渲染版完全一致：.box > .video_head_box（标题+tabs+搜索框+NF 钮）+ 表格 + 底部分页。
// 2026-10-20 张老师要求：右上角「上传录像」按钮去掉（本人入口仍在导航栏/上传页），
// 换成搜索框（VideoSearch scope=user：按时间成绩/3BV/录像 ID 查询——作者锁定为
// 本主页用户，跳转回 /user/{id}?time=…；互斥三选一）+ 其后 NF 筛选开关
// （NfToggle，样式复用练习页右上角 NF 快捷钮；默认关，开启只显示 NF 录像）。

"use client";

import Link from "next/link";
import type { VideoListItem } from "@/lib/queries";
import { VIDEO_LIST_DEFAULT_DIR, type VideoListOrder, type VideoListDir } from "@/lib/config";
import { VideoListFeed } from "./VideoListFeed";
import { VideoSearch } from "./VideoSearch";
import { NfToggle } from "./NfToggle";

/** 录像版块级别筛选 tabs（2026-09-27 张老师要求，与动态筛选同款 ranking_tabs 大号版） */
const VIDEO_LEVEL_TABS: [string, string][] = [
  ["all", "全部"],
  ["beg", "初级"],
  ["int", "中级"],
  ["exp", "高级"],
];

export function UserVideoSection({
  userId,
  initial,
  total,
  pageSize,
  level,
  order,
  dir,
  explicit,
  time,
  bv,
  nf,
  self,
}: {
  userId: number;
  initial: VideoListItem[];
  total: number;
  pageSize: number;
  /** 服务端解析的初始筛选（URL 即状态：直链/分享进入时与链接语义一致） */
  level: string;
  order: VideoListOrder;
  /** 排序方向（2026-10-23 升降序切换）：URL dir 参数（服务端已归一） */
  dir: VideoListDir;
  /** URL 是否显式带 order/dir（显式态「上传时间」列高亮出箭头，默认进页不亮） */
  explicit: boolean;
  /** 时间成绩搜索输入（回显用，2026-10-20 搜索框） */
  time?: string;
  /** 3BV 搜索输入（回显用，2026-10-20 搜索框） */
  bv?: string;
  /** NF 筛选开关（2026-10-20）：服务端解析初始态（URL nf=1），默认关 */
  nf?: boolean;
  /** 是否本人视角（2026-10-23）：true 时录像版块放行自己的屏蔽盘（红 ✕ 标记） */
  self?: boolean;
}) {
  return (
    <div className="box" id="user_videos">
      <VideoListFeed
        client
        hideIoe
        initial={initial}
        total={total}
        pageSize={pageSize}
        query={{ level, order, dir, explicit, author: userId, time, bv, nf, ...(self ? { includeBanned: true } : {}) }}
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
                if (ctx.dir !== VIDEO_LIST_DEFAULT_DIR[ctx.order]) qs.set("dir", ctx.dir);
                if (time) qs.set("time", time);
                if (bv) qs.set("3bv", bv);
                if (ctx.nf) qs.set("nf", "1");
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
            {/* NF 筛选开关（2026-10-20 二轮位置修正）：筛选器「高级」右侧、搜索框之前
                （与 /video 列表页同款编排），就地切换不导航 */}
            <NfToggle active={ctx.nf} onToggle={ctx.setNf} />
            {/* 右上角（2026-10-20 张老师要求）：原「上传录像」按钮（仅本人可见）
                换成搜索框——scope=user 作者锁定本主页用户，支持 时间成绩/3BV/录像 ID
                三种查询（软导航跳回本主页 URL，key 变化重挂载换服务端数据），贴行尾 */}
            <div className="video_search user_video_search">
              <VideoSearch
                scope="user"
                userId={userId}
                level={ctx.level}
                order={ctx.order}
                dir={ctx.dir}
                time={time}
                bv={bv}
              />
            </div>
          </div>
        )}
      />
    </div>
  );
}
