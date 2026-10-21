// /video 列表页主栏的客户端壳（2026-10-16 晚，张老师拍板「切换」）：
// 切换级别筛选、点表头排序均就地生效（整表替换 + 视口锚定不跳动，与首页/用户主页
// 切换筛选同体验），不再整页导航/跳顶；中键或修饰键点击仍走真实链接（URL 即状态
// 兜底，可新标签打开分享）。搜索框（VideoSearch，改 author/time 筛选）仍走软导航：
// 其跳转会引起本组件重渲染，VideoListFeed 以 key=author-time 强制重挂载换入服务端
// 新数据（client 内部筛选状态随 initial/query 归位）。搜索框渲染在 head 渲染位内，
// level/order 传 ctx 实时值——就地切级别/排序后马上搜索，跳转 URL 不会回退旧筛选。
// DOM 结构与原服务端渲染版完全一致：.box.video_box > .page_head（h1+tabs+搜索框）。
// 2026-10-20（张老师需求）：搜索框右侧加 NF 筛选开关（NfToggle，样式复用练习页
// 右上角 NF 快捷钮；默认关，开启只显示 NF 录像）——ctx.setNf 就地切换不导航，
// URL 同步 nf=1；搜索软导航跳转保留 nf（key 扩 nf 维度强制重挂载换服务端数据）。

"use client";

import Link from "next/link";
import type { VideoListItem } from "@/lib/queries";
import { LEVEL_NAMES, type Level, type VideoListOrder } from "@/lib/config";
import { buildUrl } from "./Pager";
import { VideoSearch } from "./VideoSearch";
import { NfToggle } from "./NfToggle";
import { VideoListFeed } from "./VideoListFeed";

/** 级别筛选 tabs（与原 Tabs 组件同款 ul.tabs > li 结构，样式走 legacy CSS） */
const LEVEL_TABS: [string, string][] = [
  ["all", "全部"],
  ["beg", "初级"],
  ["int", "中级"],
  ["exp", "高级"],
];

export function VideoListSection({
  initial,
  total,
  pageSize,
  level,
  order,
  author,
  authorName,
  time,
  bv,
  nf,
}: {
  initial: VideoListItem[];
  /** 服务端解析的当前筛选条件下的录像总数 */
  total: number;
  pageSize: number;
  /** 服务端解析的初始筛选（URL 即状态：直链/分享进入时与链接语义一致） */
  level: string;
  order: VideoListOrder;
  /** 玩家筛选（用户 id）与回显姓名（搜索框初始状态 + 定向视图标题素材用） */
  author?: number;
  authorName?: string;
  /** 时间成绩搜索输入（回显用） */
  time?: string;
  /** 3BV 搜索输入（回显用，2026-10-20）；定向视图判定：authorName+bv 全带时
   *  标题随当前级别动态组装「张三的中级录像（3BV=42）」并禁 3BV 列排序（整列同值），
   *  其余情况保持恒定标题「录像」（搜索后也不变，张老师 2026-10-15 口径） */
  bv?: string;
  /** NF 筛选开关（2026-10-20）：服务端解析的初始态（URL nf=1），默认关 */
  nf?: boolean;
}) {
  return (
    <div className="box video_box">
      {/* key=author/time/3bv/nf：搜索软导航改变这四项时强制重挂载换服务端数据；
          就地切级别/排序/NF 不动这四项，key 稳定不重挂载（铁律的正确收窄用法） */}
      <VideoListFeed
        client
        key={`${author ?? ""}-${time ?? ""}-${bv ?? ""}-${nf ? "1" : ""}`}
        initial={initial}
        total={total}
        pageSize={pageSize}
        query={{ level, order, author, time, bv, nf }}
        headSort={{ base: "/video", order, authorInLinks: true }}
        noSort3bv={!!(authorName && bv)}
        head={(ctx) => (
          <div className="page_head">
            {/* 标题：定向视图（3BV 收集格子进入）显示「XXX的XX录像（3BV=XX）」并随
                ctx.level 实时变化，其余恒为「录像」（张老师 2026-10-15：搜索后标题不变，
                级别状态由 tabs 表达） */}
            <h1 className="page_title">
              {authorName && bv
                ? `${authorName}的${LEVEL_NAMES[ctx.level as Level | "all"] ?? ""}录像（3BV=${bv}）`
                : "录像"}
            </h1>
            <div className="video_nav">
              {/* 普通左键 → ctx.setLevel 就地切换（不导航不跳顶）；
                  修饰键/中键 → 真实链接兜底（新标签打开该筛选 URL） */}
              <ul className="tabs" data-name="level">
                {LEVEL_TABS.map(([value, label]) =>
                  value === ctx.level ? (
                    <li key={value} className="current">
                      <em className="active">{label}</em>
                    </li>
                  ) : (
                    <li key={value}>
                      <Link
                        href={buildUrl("/video", {
                          level: value,
                          order: ctx.order === "id" ? undefined : ctx.order,
                          author,
                          time,
                          "3bv": bv,
                          nf: ctx.nf ? "1" : undefined,
                          page: undefined,
                        })}
                        onClick={(e) => {
                          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                          e.preventDefault();
                          ctx.setLevel(value);
                        }}
                      >
                        {label}
                      </Link>
                    </li>
                  )
                )}
              </ul>
              {/* NF 筛选开关（2026-10-20 张老师需求，二轮位置修正）：筛选器「高级」
                  右侧、搜索框之前；点击 ctx.setNf 就地重拉（不导航不跳顶），
                  开关样式复用练习页 NF 钮 */}
              <NfToggle active={ctx.nf} onToggle={ctx.setNf} />
              <div className="video_search">
                <VideoSearch
                  level={ctx.level}
                  order={ctx.order}
                  author={author}
                  authorName={authorName}
                  time={time}
                  bv={bv}
                  nf={ctx.nf}
                />
              </div>
            </div>
          </div>
        )}
      />
    </div>
  );
}
